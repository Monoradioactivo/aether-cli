import { createInterface } from "readline";

import { ApiError, BudgetError, createApiClient, FetchImpl, GetJson, JsonObject, transportFailureCode } from "./api-client";
import { ConfigError, configWarnings, McpConfig, readConfig } from "./config";
import { publicTool, ToolInputError, TOOLS, validateArguments } from "./tools";
import { untrustedText } from "./text";

export const PROTOCOL_VERSION = "2026-07-28";

const JSONRPC = "2.0";
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;
const LIST_TTL_MS = 3_600_000;

const INSTRUCTIONS =
  "Beta. Read-only access to Aether OTA releases: apps, the live release per deployment, release history, install health, and a rollback dry run. Nothing here changes a release.";

export const USAGE = [
  "Usage: aether mcp",
  "",
  "Beta. Runs a read-only Model Context Protocol server (revision 2026-07-28) on stdin and stdout for MCP clients such as Claude Code.",
  "",
  "Environment:",
  "  AETHER_MCP_API_KEY  An Aether API key (aether_sk_live_…). Give it only the read scope.",
  "  AETHER_MCP_API_URL  The Aether server's root URL. Defaults to https://api.aetherpush.com.",
  "",
  "stdout carries MCP messages only; diagnostics go to stderr.",
].join("\n");

type RequestId = string | number;

export interface ServerOptions {
  env: NodeJS.ProcessEnv;
  version: string;
  write: (chunk: string) => void;
  log?: (text: string) => void;
  fetchImpl?: FetchImpl;
  now?: () => number;
  nodeVersion?: string;
}

export interface McpServer {
  config: McpConfig | null;
  configError: ConfigError | null;
  handleLine(line: string): Promise<void>;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRequestId(value: unknown): value is RequestId {
  return typeof value === "string" || typeof value === "number";
}

export function createServer(options: ServerOptions): McpServer {
  const { env, version, write, log = () => {}, fetchImpl, now, nodeVersion } = options;
  let config: McpConfig | null = null;
  let configError: ConfigError | null = null;
  try {
    config = readConfig(env, nodeVersion);
  } catch (error) {
    if (!(error instanceof ConfigError)) {
      throw error;
    }
    configError = error;
  }
  const openInvocation: ((signal?: AbortSignal) => GetJson) | null = config
    ? createApiClient({ config, userAgent: `aether-mcp/${version}`, cliVersion: version, fetchImpl, now, log })
    : null;
  const inFlight = new Map<RequestId, AbortController>();
  const serverInfo = { name: "aether", title: "Aether", version };
  const resultMeta = { "io.modelcontextprotocol/serverInfo": serverInfo };

  const send = (message: JsonObject): void => write(`${JSON.stringify(message)}\n`);
  const reply = (id: RequestId, result: JsonObject): void =>
    send({ jsonrpc: JSONRPC, id, result: { ...result, resultType: "complete", _meta: resultMeta } });
  const fail = (id: unknown, code: number, message: string, data?: JsonObject): void =>
    send({
      jsonrpc: JSONRPC,
      ...(isRequestId(id) ? { id } : {}),
      error: data === undefined ? { code, message } : { code, message, data },
    });

  function checkRequestMeta(id: RequestId, params: unknown): boolean {
    const meta = isObject(params) && isObject(params._meta) ? params._meta : undefined;
    const requested = meta?.["io.modelcontextprotocol/protocolVersion"];
    if (typeof requested !== "string") {
      fail(id, INVALID_PARAMS, "params._meta must carry io.modelcontextprotocol/protocolVersion.");
      return false;
    }
    if (requested !== PROTOCOL_VERSION) {
      fail(id, UNSUPPORTED_PROTOCOL_VERSION, "Unsupported protocol version.", {
        supported: [PROTOCOL_VERSION],
        requested: untrustedText(requested, 40),
      });
      return false;
    }
    if (!isObject(meta?.["io.modelcontextprotocol/clientCapabilities"])) {
      fail(id, INVALID_PARAMS, "params._meta must carry io.modelcontextprotocol/clientCapabilities.");
      return false;
    }
    return true;
  }

  async function callTool(id: RequestId, params: JsonObject): Promise<void> {
    const tool = TOOLS.find((candidate) => candidate.name === params.name);
    if (!tool) {
      fail(id, INVALID_PARAMS, "Unknown tool.", { name: typeof params.name === "string" ? untrustedText(params.name, 64) : null });
      return;
    }
    const toolError = (text: string): void => reply(id, { content: [{ type: "text", text }], isError: true });
    if (configError || !openInvocation) {
      toolError(configError ? configError.message : "aether mcp is not configured.");
      return;
    }
    const errors = validateArguments(tool.inputSchema, params.arguments);
    if (errors.length > 0) {
      toolError(`Invalid arguments: ${errors.join("; ")}.`);
      return;
    }
    const controller = new AbortController();
    inFlight.set(id, controller);
    try {
      const structured = await tool.run(openInvocation(controller.signal), (params.arguments as JsonObject | undefined) ?? {});
      if (controller.signal.aborted) return;
      reply(id, { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured, isError: false });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError) {
        toolError(error.requestId ? `${error.message} (request ${error.requestId})` : error.message);
      } else if (error instanceof BudgetError || error instanceof ToolInputError) {
        toolError(error.message);
      } else {
        log(`tool ${tool.name} failed: ${transportFailureCode(error)}`);
        fail(id, INTERNAL_ERROR, "Internal error.");
      }
    } finally {
      inFlight.delete(id);
    }
  }

  async function handleMessage(message: unknown): Promise<void> {
    if (isObject(message) && message.jsonrpc === JSONRPC && !("method" in message) && ("result" in message || "error" in message)) {
      return;
    }
    if (!isObject(message) || message.jsonrpc !== JSONRPC || typeof message.method !== "string") {
      fail(isObject(message) ? message.id : undefined, INVALID_REQUEST, "Invalid request.");
      return;
    }
    if (!("id" in message)) {
      if (message.method === "notifications/cancelled" && isObject(message.params) && isRequestId(message.params.requestId)) {
        inFlight.get(message.params.requestId)?.abort();
      }
      return;
    }
    const { id, method, params } = message;
    if (!isRequestId(id)) {
      fail(undefined, INVALID_REQUEST, "Request id must be a string or a number.");
      return;
    }
    if (method === "initialize") {
      fail(
        id,
        UNSUPPORTED_PROTOCOL_VERSION,
        `This server implements MCP ${PROTOCOL_VERSION} only, which has no initialize handshake.`,
        {
          supported: [PROTOCOL_VERSION],
          requested: isObject(params) && typeof params.protocolVersion === "string" ? untrustedText(params.protocolVersion, 40) : null,
        }
      );
      return;
    }
    if (!checkRequestMeta(id, params)) {
      return;
    }
    const requestParams = params as JsonObject;
    if (method === "server/discover") {
      reply(id, {
        supportedVersions: [PROTOCOL_VERSION],
        capabilities: { tools: {} },
        instructions: INSTRUCTIONS,
        ttlMs: LIST_TTL_MS,
        cacheScope: "public",
      });
      return;
    }
    if (method === "tools/list") {
      if (requestParams.cursor !== undefined) {
        fail(id, INVALID_PARAMS, "Invalid cursor.");
        return;
      }
      reply(id, { tools: TOOLS.map(publicTool), ttlMs: LIST_TTL_MS, cacheScope: "public" });
      return;
    }
    if (method === "tools/call") {
      await callTool(id, requestParams);
      return;
    }
    fail(id, METHOD_NOT_FOUND, "Method not found.");
  }

  return {
    config,
    configError,
    async handleLine(line: string): Promise<void> {
      if (!line.trim()) {
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        fail(undefined, PARSE_ERROR, "Parse error.");
        return;
      }
      try {
        await handleMessage(message);
      } catch (error) {
        log(`message handling failed: ${transportFailureCode(error)}`);
        if (isObject(message) && "method" in message && isRequestId(message.id)) {
          fail(message.id, INTERNAL_ERROR, "Internal error.");
        }
      }
    },
  };
}

export interface MainOptions {
  argv: string[];
  version: string;
}

export function main(options: MainOptions): void {
  const log = (text: string): void => {
    process.stderr.write(`[aether mcp] ${text}\n`);
  };
  if (options.argv.length === 1 && (options.argv[0] === "--help" || options.argv[0] === "-h")) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 0;
    return;
  }
  if (options.argv.length > 0) {
    log(`aether mcp takes no arguments; run "aether mcp --help" for its environment variables.`);
    process.exitCode = 2;
    return;
  }

  process.stdout.on("error", () => process.exit(0));
  const server = createServer({ env: process.env, version: options.version, write: (chunk) => process.stdout.write(chunk), log });
  for (const warning of configWarnings(process.env)) {
    log(warning);
  }
  if (server.configError) {
    log(server.configError.message);
  } else if (server.config) {
    log(`serving read-only tools for ${server.config.origin} (beta, MCP ${PROTOCOL_VERSION})`);
  }
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    server.handleLine(line).catch((error: unknown) => log(`message handling failed: ${transportFailureCode(error)}`));
  });
}
