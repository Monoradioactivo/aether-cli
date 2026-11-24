import type { McpConfig } from "./config";

export const CLIENT_LIMITS = {
  callsPerToolInvocation: 3,
  callsPerMinute: 20,
  tenantRemainingFloor: 10,
  maxPauseMs: 60_000,
  unauthorizedLockMs: 60_000,
  requestTimeoutMs: 15_000,
};

const REQUEST_ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

export type JsonObject = Record<string, unknown>;
export type QueryValue = string | number;
export type GetJson = (path: string, query?: Record<string, QueryValue>) => Promise<JsonObject>;
export type FetchImpl = (input: URL, init: RequestInit) => Promise<Response>;

export class ApiError extends Error {
  public readonly status: number;
  public readonly requestId?: string;

  constructor(message: string, status: number, requestId?: string) {
    super(message);
    this.status = status;
    this.requestId = requestId;
  }
}

export class BudgetError extends Error {}

function describeStatus(status: number, code: string | undefined, retryAfterSeconds: number | undefined, host: string): string {
  if (status === 401) {
    return `The Aether API at ${host} rejected the API key: it is unknown, expired or revoked. Check that AETHER_MCP_API_URL names the server that issued the key.`;
  }
  if (status === 403 && code === "insufficient_scopes") return "The API key lacks the read scope this tool needs.";
  if (status === 403) return "Your role on this app does not allow this.";
  if (status === 404) return "App or deployment not found, or you are not a collaborator on it.";
  if (status === 429) return `The Aether API rate limit was reached; retry in ${retryAfterSeconds ?? 60} seconds.`;
  return `The Aether API answered ${status}.`;
}

interface ErrorShape {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  cause?: unknown;
}

function errorShape(value: unknown): ErrorShape {
  return value !== null && typeof value === "object" ? (value as ErrorShape) : {};
}

function describeTransportFailure(error: unknown, host: string): string {
  if (errorShape(error).name === "TimeoutError") {
    return `The Aether API at ${host} did not answer within ${CLIENT_LIMITS.requestTimeoutMs / 1000} seconds.`;
  }
  if (errorShape(errorShape(error).cause).message === "unexpected redirect") {
    return `The Aether API at ${host} answered with a redirect, which this server never follows.`;
  }
  return `The Aether API at ${host} could not be reached.`;
}

export function transportFailureCode(error: unknown): string {
  const { name, cause } = errorShape(error);
  const code = errorShape(cause).code;
  if (typeof code === "string") return code;
  return typeof name === "string" ? name : "unknown";
}

function readInteger(value: string | null): number | undefined {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export interface ApiClientOptions {
  config: McpConfig;
  userAgent: string;
  cliVersion: string;
  fetchImpl?: FetchImpl;
  now?: () => number;
  log?: (text: string) => void;
}

export function createApiClient(options: ApiClientOptions): (signal?: AbortSignal) => GetJson {
  const { config, userAgent, cliVersion, fetchImpl = fetch, now = Date.now, log = () => {} } = options;
  const recentCalls: number[] = [];
  let pausedUntil = 0;
  let unauthorizedUntil = 0;
  let unauthorizedMessage = "";

  function spendBudget(): void {
    const at = now();
    if (at < unauthorizedUntil) {
      throw new BudgetError(
        `${unauthorizedMessage} This server waits until ${new Date(unauthorizedUntil).toISOString()} before it tries the key again.`
      );
    }
    if (at < pausedUntil) {
      throw new BudgetError(
        `The tenant's API budget is nearly spent, so this MCP server is pausing until ${new Date(
          pausedUntil
        ).toISOString()} to leave it to CI.`
      );
    }
    while (recentCalls.length > 0 && recentCalls[0] <= at - 60_000) {
      recentCalls.shift();
    }
    if (recentCalls.length >= CLIENT_LIMITS.callsPerMinute) {
      throw new BudgetError(
        `This MCP server makes at most ${CLIENT_LIMITS.callsPerMinute} Aether API calls per minute, so it does not exhaust the budget your CI shares. Retry in a minute.`
      );
    }
    recentCalls.push(at);
  }

  function watchTenantBudget(headers: Headers): void {
    const remaining = readInteger(headers.get("x-ratelimit-remaining"));
    if (remaining === undefined || remaining > CLIENT_LIMITS.tenantRemainingFloor) {
      return;
    }
    const at = now();
    const resetSeconds = readInteger(headers.get("x-ratelimit-reset"));
    const resetAt = resetSeconds === undefined ? at + CLIENT_LIMITS.maxPauseMs : resetSeconds * 1000;
    pausedUntil = Math.min(Math.max(resetAt, at), at + CLIENT_LIMITS.maxPauseMs);
  }

  return function openInvocation(signal?: AbortSignal): GetJson {
    let calls = 0;
    return async function get(path: string, query: Record<string, QueryValue> = {}): Promise<JsonObject> {
      if (calls >= CLIENT_LIMITS.callsPerToolInvocation) {
        throw new BudgetError(`A tool may make at most ${CLIENT_LIMITS.callsPerToolInvocation} Aether API calls.`);
      }
      calls += 1;
      spendBudget();

      const target = new URL(config.baseUrl + path);
      for (const [name, value] of Object.entries(query)) {
        target.searchParams.set(name, String(value));
      }
      const timeout = AbortSignal.timeout(CLIENT_LIMITS.requestTimeoutMs);
      let response: Response;
      let text: string;
      try {
        response = await fetchImpl(target, {
          method: "GET",
          redirect: "error",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            Accept: "application/json",
            "User-Agent": userAgent,
            "X-Aether-CLI-Version": cliVersion,
          },
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        text = await response.text();
      } catch (error) {
        if (signal?.aborted) {
          throw error;
        }
        log(`request failed: ${transportFailureCode(error)}`);
        throw new ApiError(describeTransportFailure(error, config.host), 0);
      }

      watchTenantBudget(response.headers);
      const rawRequestId = response.headers.get("x-request-id") ?? "";
      const requestId = REQUEST_ID_SHAPE.test(rawRequestId) ? rawRequestId : undefined;
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      const code =
        body !== null && typeof body === "object" && typeof (body as JsonObject).code === "string"
          ? ((body as JsonObject).code as string)
          : undefined;

      if (!response.ok) {
        const message = describeStatus(response.status, code, readInteger(response.headers.get("retry-after")), config.host);
        if (response.status === 401) {
          unauthorizedUntil = now() + CLIENT_LIMITS.unauthorizedLockMs;
          unauthorizedMessage = message;
        }
        throw new ApiError(message, response.status, requestId);
      }
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw new ApiError("The Aether API answered with a body this server cannot read.", 502, requestId);
      }
      return body as JsonObject;
    };
  };
}
