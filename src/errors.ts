/**
 * Typed error hierarchy. Every variant carries a stable machine-readable `code`
 * and an `exitCode` so the CLI has a single, testable failure contract:
 *
 *   0  success
 *   2  usage / validation / bad input  (the caller can fix it)
 *   1  runtime / network / exchange rejection
 */
export type ErrorCode =
  | "USAGE"
  | "UNKNOWN_ASSET"
  | "INVALID_INPUT"
  | "NOT_CONFIGURED"
  | "API_ERROR"
  | "NETWORK_ERROR"
  | "EXCHANGE_REJECTED"
  | "UNSUPPORTED"
  | "INTERNAL";

export const EXIT_OK = 0;
export const EXIT_RUNTIME = 1;
export const EXIT_USAGE = 2;

export class HlCliError extends Error {
  readonly code: ErrorCode;
  readonly exitCode: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    exitCode: number,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }

  toJSON(): Record<string, unknown> {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

/** Bad flags, bad values, unknown assets - the caller can correct these. */
export class UsageError extends HlCliError {
  constructor(code: Extract<ErrorCode, "USAGE" | "UNKNOWN_ASSET" | "INVALID_INPUT" | "UNSUPPORTED">, message: string, details?: Record<string, unknown>) {
    super(code, message, EXIT_USAGE, details);
  }
}

/** Credentials are absent or incomplete. */
export class NotConfiguredError extends HlCliError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("NOT_CONFIGURED", message, EXIT_USAGE, details);
  }
}

/** Transport failed: DNS, TLS, timeout, non-2xx that is not an exchange verdict. */
export class NetworkError extends HlCliError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("NETWORK_ERROR", message, EXIT_RUNTIME, details);
  }
}

/** The API answered, but with an error. Body may be text/plain, not JSON. */
export class ApiError extends HlCliError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("API_ERROR", message, EXIT_RUNTIME, details);
  }
}

/** The exchange accepted the request but refused the action (insufficient margin, min notional, ...). */
export class ExchangeRejectedError extends HlCliError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("EXCHANGE_REJECTED", message, EXIT_RUNTIME, details);
  }
}

/** Normalise anything thrown into an HlCliError so output is always structured. */
export function toCliError(err: unknown): HlCliError {
  if (err instanceof HlCliError) return err;
  if (err instanceof Error) return new HlCliError("INTERNAL", err.message, EXIT_RUNTIME);
  return new HlCliError("INTERNAL", String(err), EXIT_RUNTIME);
}
