import { DEFAULT_AETHER_SERVER_URL } from "../server-url";

export const API_KEY_PREFIX = "aether_sk_live_";
export const MINIMUM_NODE_MAJOR = 22;

const API_KEY_SHAPE = /^aether_sk_live_[A-Za-z0-9]+$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]"]);

export class ConfigError extends Error {}

export interface McpConfig {
  apiKey: string;
  origin: string;
  host: string;
  baseUrl: string;
}

export function readConfig(env: NodeJS.ProcessEnv, nodeVersion: string = process.versions.node): McpConfig {
  const major = Number.parseInt(nodeVersion.split(".")[0] ?? "", 10);
  if (!Number.isFinite(major) || major < MINIMUM_NODE_MAJOR) {
    throw new ConfigError(
      `aether mcp needs Node.js ${MINIMUM_NODE_MAJOR} or later; the MCP client started it with Node.js ${nodeVersion}.`
    );
  }

  const apiKey = env.AETHER_MCP_API_KEY;
  if (!apiKey) {
    throw new ConfigError(
      "AETHER_MCP_API_KEY is not set. Create an API key with only the read scope and pass it in the MCP client's env."
    );
  }
  if (!apiKey.startsWith(API_KEY_PREFIX)) {
    throw new ConfigError(
      `AETHER_MCP_API_KEY must be an API key (${API_KEY_PREFIX}…). Access keys and CLI sessions carry every scope and are refused.`
    );
  }
  if (!API_KEY_SHAPE.test(apiKey)) {
    throw new ConfigError("AETHER_MCP_API_KEY is not a well-formed API key. Copy it again without spaces or line breaks.");
  }

  const rawUrl = env.AETHER_MCP_API_URL || DEFAULT_AETHER_SERVER_URL;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ConfigError("AETHER_MCP_API_URL is not a valid URL.");
  }
  const isLoopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    throw new ConfigError("AETHER_MCP_API_URL must use https. Plain http is accepted only on 127.0.0.1 or [::1].");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ConfigError("AETHER_MCP_API_URL must not carry credentials, a query or a fragment.");
  }
  if (url.pathname !== "/") {
    throw new ConfigError("AETHER_MCP_API_URL must be the server's root URL, without a path such as /v1.");
  }

  return { apiKey, origin: url.origin, host: url.host, baseUrl: `${url.origin}/v1` };
}

export function configWarnings(env: NodeJS.ProcessEnv): string[] {
  const warnings: string[] = [];
  if (env.AETHER_API_URL && !env.AETHER_MCP_API_URL) {
    warnings.push("AETHER_API_URL is set but aether mcp reads AETHER_MCP_API_URL only; it is using the production server.");
  }
  return warnings;
}
