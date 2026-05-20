export class AetherError extends Error {
  public readonly statusCode: number;
  public readonly requestId?: string;

  constructor(message: string, statusCode: number, requestId?: string) {
    super(message);
    this.name = "AetherError";
    this.statusCode = statusCode;
    this.requestId = requestId;
    Object.setPrototypeOf(this, AetherError.prototype);
  }
}
