export class AetherError extends Error {
  public readonly statusCode: number;
  public readonly requestId?: string;
  public readonly code?: string;

  constructor(message: string, statusCode: number, requestId?: string, code?: string) {
    super(message);
    this.name = "AetherError";
    this.statusCode = statusCode;
    this.requestId = requestId;
    this.code = code;
    Object.setPrototypeOf(this, AetherError.prototype);
  }
}
