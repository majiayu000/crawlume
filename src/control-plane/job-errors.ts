// Errors raised by ControlPlaneJobService; re-exported from project-scope.ts.

export class JobIdempotencyConflictError extends Error {
  readonly code = "JOB_IDEMPOTENCY_CONFLICT";
  constructor() {
    super("The idempotency key is already bound to a different Job request.");
    this.name = "JobIdempotencyConflictError";
  }
}

export class JobNotFoundError extends Error {
  readonly code = "JOB_NOT_FOUND";
  constructor() {
    super("The Job does not exist in this project.");
    this.name = "JobNotFoundError";
  }
}

export class JobTransitionError extends Error {
  readonly code = "JOB_TRANSITION_INVALID";
  constructor() {
    super("The requested Job state transition is not valid.");
    this.name = "JobTransitionError";
  }
}

export class JobWorkerAccessDeniedError extends Error {
  readonly code = "JOB_WORKER_ACCESS_DENIED";
  constructor() {
    super("The Worker session cannot access this Project Job queue.");
    this.name = "JobWorkerAccessDeniedError";
  }
}

export class LeaseFencedError extends Error {
  readonly code = "JOB_LEASE_FENCED";
  constructor() {
    super("The Job lease is expired, revoked, or superseded by a newer generation.");
    this.name = "LeaseFencedError";
  }
}

export class JobTerminalValidationError extends Error {
  readonly code = "JOB_TERMINAL_INVALID";
  constructor() {
    super("The Job terminal payload is inconsistent with its status.");
    this.name = "JobTerminalValidationError";
  }
}
