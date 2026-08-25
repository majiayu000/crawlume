export const errorCodes = [
  "INVALID_URL",
  "INVALID_ARGUMENT",
  "SSRF_BLOCKED",
  "ROBOTS_DISALLOWED",
  "ROBOTS_UNAVAILABLE",
  "AUTH_REQUIRED",
  "PAYMENT_REQUIRED",
  "ACCESS_DENIED",
  "RATE_LIMITED",
  "UPSTREAM_ERROR",
  "FETCH_TIMEOUT",
  "UNSUPPORTED_CONTENT_TYPE",
  "RESPONSE_TOO_LARGE",
  "LOGIN_WALL_DETECTED",
  "HUMAN_VERIFICATION_REQUIRED",
  "SHELL_ONLY",
  "INCOMPLETE_CONTENT",
  "BROWSER_UNAVAILABLE",
  "PROFILE_NOT_FOUND",
  "CACHE_MISS",
  "SEARCH_PROVIDER_NOT_CONFIGURED",
  "SEARCH_PROVIDER_ERROR",
  "INTERNAL_ERROR",
] as const;

export type ReadErrorCode = (typeof errorCodes)[number];

export type ReadErrorDetails = Record<string, boolean | number | string | null>;

export class ReadError extends Error {
  readonly code: ReadErrorCode;
  readonly retryable: boolean;
  readonly details: ReadErrorDetails;

  constructor(
    code: ReadErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      details?: ReadErrorDetails;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ReadError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? {};
  }

  toJSON(): {
    status: "error";
    code: ReadErrorCode;
    message: string;
    retryable: boolean;
    details: ReadErrorDetails;
  } {
    return {
      status: "error",
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      details: this.details,
    };
  }
}

export function normalizeError(error: unknown): ReadError {
  if (error instanceof ReadError) {
    return error;
  }
  return new ReadError("INTERNAL_ERROR", "The web reader failed unexpectedly.", {
    cause: error,
  });
}

export function errorForHttpStatus(status: number, url: string): ReadError | null {
  const details = { httpStatus: status, url };
  if (status === 401) {
    return new ReadError("AUTH_REQUIRED", "The page requires authentication.", { details });
  }
  if (status === 402) {
    return new ReadError("PAYMENT_REQUIRED", "The page requires payment or a subscription.", {
      details,
    });
  }
  if (status === 403) {
    return new ReadError("ACCESS_DENIED", "The site denied access to the page.", { details });
  }
  if (status === 429) {
    return new ReadError("RATE_LIMITED", "The site rate-limited the request.", {
      retryable: true,
      details,
    });
  }
  if (status >= 500) {
    return new ReadError("UPSTREAM_ERROR", `The site returned HTTP ${status}.`, {
      retryable: true,
      details,
    });
  }
  if (status >= 400) {
    return new ReadError("ACCESS_DENIED", `The page returned HTTP ${status}.`, { details });
  }
  return null;
}
