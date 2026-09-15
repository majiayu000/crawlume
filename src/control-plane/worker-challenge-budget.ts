import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { ControlPlaneDatabase } from "./project-scope.js";

const challengeTtlSeconds = 2 * 60;
const challengeCooldownSeconds = 1;
const challengeLockNamespace = "diaoyan:worker-challenge-budget";
const workerSignatureContext = "dya-worker-session-v1\n";

type ChallengeIdentityRow = {
  project_id: string;
  public_key_id: string;
};

type ChallengeSlotRow = { expires_at: Date };

type ChallengeOutcome =
  | { kind: "created"; expiresAt: Date }
  | { kind: "rate-limited" };

export type BoundedWorkerChallenge = Readonly<{
  workerId: string;
  challenge: string;
  signingPayload: string;
  expiresAt: Date;
}>;

export class WorkerChallengeRateLimitedError extends Error {
  readonly code = "WORKER_CHALLENGE_RATE_LIMITED";
  readonly retryAfterSeconds = challengeCooldownSeconds;

  constructor() {
    super("Worker challenge creation is temporarily rate limited.");
    this.name = "WorkerChallengeRateLimitedError";
  }
}

export function workerSigningPayload(challenge: string): string {
  return `${workerSignatureContext}${challenge}`;
}

export async function createBoundedWorkerChallenge(
  database: ControlPlaneDatabase,
  workerId: string,
  invalidIdentity: () => Error,
): Promise<BoundedWorkerChallenge> {
  const challenge = `dya_wc_${randomBytes(32).toString("base64url")}`;
  const lockSubject = JSON.stringify([challengeLockNamespace, workerId]);
  const outcome = await database.transaction<ChallengeOutcome>(async (transaction) => {
    const lock = await transaction.query<{ acquired: boolean }>(`
      SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired
    `, [lockSubject]);
    if (lock.rows[0]?.acquired !== true) return { kind: "rate-limited" };

    const selected = await transaction.query<ChallengeIdentityRow>(`
      SELECT workers.project_id, worker_public_keys.id AS public_key_id
      FROM workers
      INNER JOIN worker_public_keys
        ON worker_public_keys.worker_id = workers.id
        AND worker_public_keys.project_id = workers.project_id
        AND worker_public_keys.revoked_at IS NULL
      WHERE workers.id = $1 AND workers.status = 'active'
    `, [workerId]);
    const identity = selected.rows[0];
    if (identity === undefined) throw invalidIdentity();

    const result = await transaction.query<ChallengeSlotRow>(`
      INSERT INTO worker_session_challenges(
        id, project_id, worker_id, public_key_id, challenge_hash, created_at, expires_at
      ) VALUES (
        $1, $2, $3, $4, $5, clock_timestamp(),
        clock_timestamp() + make_interval(secs => $6::integer)
      )
      ON CONFLICT ON CONSTRAINT worker_session_challenges_worker_unique DO UPDATE
      SET project_id = EXCLUDED.project_id,
        public_key_id = EXCLUDED.public_key_id,
        challenge_hash = EXCLUDED.challenge_hash,
        created_at = EXCLUDED.created_at,
        expires_at = EXCLUDED.expires_at,
        consumed_at = NULL
      WHERE worker_session_challenges.consumed_at IS NOT NULL
        OR worker_session_challenges.created_at <=
          clock_timestamp() - make_interval(secs => $7::integer)
      RETURNING expires_at
    `, [
      randomUUID(), identity.project_id, workerId, identity.public_key_id,
      createHash("sha256").update(challenge).digest(),
      challengeTtlSeconds, challengeCooldownSeconds,
    ]);
    const slot = result.rows[0];
    return slot === undefined
      ? { kind: "rate-limited" }
      : { kind: "created", expiresAt: slot.expires_at };
  });
  if (outcome.kind === "rate-limited") throw new WorkerChallengeRateLimitedError();
  return Object.freeze({
    workerId,
    challenge,
    signingPayload: workerSigningPayload(challenge),
    expiresAt: outcome.expiresAt,
  });
}
