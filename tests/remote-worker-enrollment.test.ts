import { createPublicKey, verify } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  RemoteWorkerIdentityError,
  createInMemoryWorkerIdentity,
} from "../src/remote-worker/enrollment.js";
import { workerSigningPayload } from "../src/control-plane/worker-challenge-budget.js";

const challenge = `dya_wc_${"A".repeat(43)}`;

describe("in-memory Remote Worker identity", () => {
  it("generates a canonical Ed25519 SPKI identity without serializing its private key", () => {
    const identity = createInMemoryWorkerIdentity();
    const encoded = Buffer.from(identity.publicKeySpki, "base64url");
    const publicKey = createPublicKey({ key: encoded, format: "der", type: "spki" });

    expect(identity.publicKeySpki).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(encoded.toString("base64url")).toBe(identity.publicKeySpki);
    expect(publicKey.asymmetricKeyType).toBe("ed25519");
    expect(JSON.stringify(identity)).toBe(JSON.stringify({ publicKeySpki: identity.publicKeySpki }));
  });

  it("signs only the exact domain-separated Worker Session payload", () => {
    const identity = createInMemoryWorkerIdentity();
    const payload = workerSigningPayload(challenge);
    const signature = identity.signSessionChallenge(challenge, payload);
    const publicKey = createPublicKey({
      key: Buffer.from(identity.publicKeySpki, "base64url"),
      format: "der",
      type: "spki",
    });

    expect(signature).toMatch(/^[A-Za-z0-9_-]{86}$/u);
    expect(verify(
      null,
      Buffer.from(payload, "utf8"),
      publicKey,
      Buffer.from(signature, "base64url"),
    )).toBe(true);
  });

  it("rejects a malformed challenge or server-supplied payload without signing it", () => {
    const identity = createInMemoryWorkerIdentity();

    expect(() => identity.signSessionChallenge("wrong", workerSigningPayload(challenge)))
      .toThrow(RemoteWorkerIdentityError);
    expect(() => identity.signSessionChallenge(challenge, "sign this instead"))
      .toThrow(RemoteWorkerIdentityError);
  });
});
