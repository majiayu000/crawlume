import { crawlCancelledError, ReadError } from "../errors.js";
import type {
  BrowserReadinessPolicy,
  BrowserReadinessTarget,
  BrowserScrollInteraction,
} from "../types.js";

export type BrowserReadinessSnapshot = {
  readyState: "loading" | "interactive" | "complete";
  textCharacters: number;
  htmlCharacters: number;
  contentFingerprint?: number;
};

export type BrowserReadinessRuntime = {
  now: () => number;
  sample: () => Promise<BrowserReadinessSnapshot>;
  wait: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
};

export type BrowserTargetReadinessRuntime = BrowserReadinessRuntime & {
  countTarget: (target: NormalizedBrowserReadinessTarget) => Promise<number>;
  performInteraction: (interaction: NormalizedBrowserScrollInteraction) => Promise<void>;
};

type BrowserReadinessOptions = {
  timeoutMs: number;
  pollIntervalMs?: number;
  stableWindowMs?: number;
  minContentCharacters?: number;
  shortPageGraceMs?: number;
  signal?: AbortSignal;
};

type BrowserTargetReadinessOptions = {
  timeoutMs: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
};

export type BrowserReadinessResult = BrowserReadinessSnapshot & {
  reason: "meaningful-content-stable" | "short-page-grace-elapsed";
  waitedMs: number;
};

export type BrowserTargetReadinessResult = BrowserReadinessSnapshot & {
  reason: "target-condition-met";
  waitedMs: number;
  targetMatches: number;
  interactionSteps: number;
};

export type NormalizedBrowserReadinessTarget = {
  selector: string;
  state: "attached" | "visible";
  minCount: number;
};
export type NormalizedBrowserScrollInteraction = {
  type: "scroll-to-end";
  maxSteps: number;
  stepDelayMs: number;
};
export type NormalizedBrowserReadinessPolicy = {
  target: NormalizedBrowserReadinessTarget;
  interaction?: NormalizedBrowserScrollInteraction;
  timeoutMs?: number;
};

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new ReadError(
      "INVALID_ARGUMENT",
      `${name} must be an integer between ${minimum} and ${maximum}.`,
      { details: { name, value: resolved, minimum, maximum } },
    );
  }
  return resolved;
}

export function normalizeBrowserReadinessPolicy(
  policy: BrowserReadinessPolicy,
): NormalizedBrowserReadinessPolicy {
  const selector = policy.target.selector.trim();
  if (selector.length === 0 || selector.length > 512) {
    throw new ReadError(
      "INVALID_ARGUMENT",
      "browserReadiness.target.selector must contain between 1 and 512 characters.",
      { details: { name: "browserReadiness.target.selector" } },
    );
  }
  const target: NormalizedBrowserReadinessTarget = {
    selector,
    state: policy.target.state ?? "attached",
    minCount: boundedInteger(
      policy.target.minCount,
      1,
      1,
      10_000,
      "browserReadiness.target.minCount",
    ),
  };
  const timeoutMs = policy.timeoutMs === undefined
    ? undefined
    : boundedInteger(
        policy.timeoutMs,
        policy.timeoutMs,
        100,
        120_000,
        "browserReadiness.timeoutMs",
      );
  if (policy.interaction === undefined) {
    return { target, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
  }
  const interaction: NormalizedBrowserScrollInteraction = {
    type: "scroll-to-end",
    maxSteps: boundedInteger(
      policy.interaction.maxSteps,
      policy.interaction.maxSteps,
      1,
      100,
      "browserReadiness.interaction.maxSteps",
    ),
    stepDelayMs: boundedInteger(
      policy.interaction.stepDelayMs,
      100,
      0,
      5_000,
      "browserReadiness.interaction.stepDelayMs",
    ),
  };
  return {
    target,
    interaction,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw crawlCancelledError();
  }
}

export async function waitForBrowserReadiness(
  runtime: BrowserReadinessRuntime,
  options: BrowserReadinessOptions,
): Promise<BrowserReadinessResult> {
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const stableWindowMs = options.stableWindowMs ?? 300;
  const minContentCharacters = options.minContentCharacters ?? 500;
  const shortPageGraceMs = options.shortPageGraceMs ?? 2_000;
  const startedAt = runtime.now();
  const deadline = startedAt + options.timeoutMs;
  let stableSince = startedAt;
  let previousSignature: string | null = null;

  while (true) {
    throwIfAborted(options.signal);
    const snapshot = await runtime.sample();
    const now = runtime.now();
    if (now > deadline) {
      throw new ReadError(
        "FETCH_TIMEOUT",
        "The browser page did not become stable before the readiness deadline.",
        { retryable: true, details: { timeoutMs: options.timeoutMs } },
      );
    }
    const signature = [
      snapshot.readyState,
      snapshot.textCharacters,
      snapshot.htmlCharacters,
      snapshot.contentFingerprint ?? 0,
    ].join(":");
    if (signature !== previousSignature) {
      previousSignature = signature;
      stableSince = now;
    }
    const waitedMs = now - startedAt;
    const stable = snapshot.readyState !== "loading" && now - stableSince >= stableWindowMs;
    if (stable && snapshot.textCharacters >= minContentCharacters) {
      return { ...snapshot, reason: "meaningful-content-stable", waitedMs };
    }
    if (stable && waitedMs >= shortPageGraceMs) {
      return { ...snapshot, reason: "short-page-grace-elapsed", waitedMs };
    }
    const remainingMs = deadline - now;
    if (remainingMs <= 0) {
      throw new ReadError(
        "FETCH_TIMEOUT",
        "The browser page did not become stable before the readiness deadline.",
        { retryable: true, details: { timeoutMs: options.timeoutMs } },
      );
    }
    await runtime.wait(Math.min(pollIntervalMs, remainingMs), options.signal);
  }
}

export async function waitForTargetReadiness(
  runtime: BrowserTargetReadinessRuntime,
  rawPolicy: BrowserReadinessPolicy | NormalizedBrowserReadinessPolicy,
  options: BrowserTargetReadinessOptions,
): Promise<BrowserTargetReadinessResult> {
  const policy = normalizeBrowserReadinessPolicy(rawPolicy);
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const startedAt = runtime.now();
  const deadline = startedAt + options.timeoutMs;
  let interactionSteps = 0;
  const deadlineError = (): ReadError => new ReadError(
    "FETCH_TIMEOUT",
    "The browser readiness target was not met before the readiness deadline.",
    {
      retryable: true,
      details: {
        timeoutMs: options.timeoutMs,
        interactionSteps,
      },
    },
  );

  while (true) {
    throwIfAborted(options.signal);
    if (runtime.now() > deadline) {
      throw deadlineError();
    }
    const targetMatches = await runtime.countTarget(policy.target);
    if (runtime.now() > deadline) {
      throw deadlineError();
    }
    if (targetMatches >= policy.target.minCount) {
      const snapshot = await runtime.sample();
      const sampledAt = runtime.now();
      if (sampledAt > deadline) {
        throw deadlineError();
      }
      return {
        ...snapshot,
        reason: "target-condition-met",
        waitedMs: sampledAt - startedAt,
        targetMatches,
        interactionSteps,
      };
    }

    if (policy.interaction !== undefined) {
      if (interactionSteps >= policy.interaction.maxSteps) {
        throw new ReadError(
          "FETCH_TIMEOUT",
          "The browser readiness target was not met before the interaction budget was exhausted.",
          {
            retryable: true,
            details: {
              timeoutMs: options.timeoutMs,
              interactionSteps,
              maxInteractionSteps: policy.interaction.maxSteps,
            },
          },
        );
      }
      await runtime.performInteraction(policy.interaction);
      interactionSteps += 1;
      const remainingMs = deadline - runtime.now();
      if (remainingMs <= 0) continue;
      await runtime.wait(
        Math.min(policy.interaction.stepDelayMs, remainingMs),
        options.signal,
      );
      continue;
    }

    const remainingMs = deadline - runtime.now();
    if (remainingMs <= 0) {
      throw deadlineError();
    }
    await runtime.wait(Math.min(pollIntervalMs, remainingMs), options.signal);
  }
}
