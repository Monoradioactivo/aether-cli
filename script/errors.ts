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
