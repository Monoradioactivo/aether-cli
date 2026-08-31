export class AetherError extends Error {
  public readonly statusCode: number;
  public readonly requestId?: string;
  public readonly code?: string;
  public readonly requiredScopes?: string[];

  constructor(
    message: string,
    statusCode: number,
    requestId?: string,
    code?: string,
    requiredScopes?: string[]
  ) {
    super(message);
    this.name = "AetherError";
    this.statusCode = statusCode;
    this.requestId = requestId;
    this.code = code;
    this.requiredScopes = requiredScopes;
    Object.setPrototypeOf(this, AetherError.prototype);
  }
}

export interface ValidationFieldError {
  field: string;
  message: string;
}

function withSentenceHead(message: string): string {
  const trimmed = message.trimEnd();
  return trimmed.endsWith(".") ? trimmed : `${trimmed}.`;
}

export function readValidationErrors(parsed: unknown): ValidationFieldError[] | undefined {
  if (parsed === null || typeof parsed !== "object") {
    return undefined;
  }
  const value = (parsed as { errors?: unknown }).errors;
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const errors: ValidationFieldError[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object") {
      return undefined;
    }
    const field = (item as { field?: unknown }).field;
    const message = (item as { message?: unknown }).message;
    if (typeof field !== "string" || field.length === 0 || typeof message !== "string" || message.length === 0) {
      return undefined;
    }
    errors.push({ field, message });
  }
  return errors;
}

export function readRetryAfterSeconds(parsed: unknown): number | undefined {
  if (parsed === null || typeof parsed !== "object") {
    return undefined;
  }
  const value = (parsed as { retryAfterSeconds?: unknown }).retryAfterSeconds;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return undefined;
  }
  return value;
}

export function messageWithValidationErrors(message: string, errors?: ValidationFieldError[]): string {
  if (!errors || errors.length === 0) {
    return message;
  }
  const details = errors.map((entry) => `${entry.field}: ${entry.message}`).join(" ");
  return `${withSentenceHead(message)} ${details}`;
}

export function messageWithRetryAfterSeconds(message: string, retryAfterSeconds?: number): string {
  if (retryAfterSeconds === undefined) {
    return message;
  }
  return `${withSentenceHead(message)} Retry after ${retryAfterSeconds} seconds.`;
}
