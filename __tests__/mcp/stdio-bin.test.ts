import { spawn } from "child_process";
import { createHash } from "crypto";
import { existsSync } from "fs";
import { createServer, IncomingMessage, Server, ServerResponse } from "http";
import { AddressInfo } from "net";
import * as path from "path";

import { DEFAULT_AETHER_SERVER_URL } from "../../script/server-url";

const BIN = path.resolve(__dirname, "../../bin/script/cli.js");
const CLI_MANIFEST = require("../../package.json");
const MCP_MANIFEST_PATH = require.resolve("@aetherpush/mcp/package.json");
const MCP_MANIFEST = require(MCP_MANIFEST_PATH);
const MCP_BIN = path.join(path.dirname(MCP_MANIFEST_PATH), MCP_MANIFEST.bin["aether-mcp"]);
const TOOL_NAMES = ["list_apps", "get_live_release", "list_release_history", "get_release_health", "preview_rollback"];
const TOOL_CONTRACT_SHA256 = "4042e429088824522fbb65277ec01db0beb53959a80408de9ccbaced078c85cc";
const KEY = "aether_sk_live_binTestKey42";
const META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[], env: NodeJS.ProcessEnv, lines: unknown[] = []): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { PATH: process.env.PATH, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    for (const line of lines) {
      child.stdin.write(`${typeof line === "string" ? line : JSON.stringify(line)}\n`);
    }
    child.stdin.end();
  });
}

function jsonRpcLines(stdout: string): any[] {
  expect(stdout.endsWith("\n")).toBe(true);
  return stdout
    .slice(0, -1)
    .split("\n")
    .map((line) => {
      const message = JSON.parse(line);
      expect(message.jsonrpc).toBe("2.0");
      return message;
    });
}

describe("aether mcp from the built bin", () => {
  let stub: Server;
  let url: string;
  const hits: string[] = [];

  beforeAll(async () => {
    if (!existsSync(BIN)) {
      throw new Error(`${BIN} is missing. Run npm run build first; npm test runs it as pretest.`);
    }
    stub = createServer((req: IncomingMessage, res: ServerResponse) => {
      hits.push(`${req.method} ${req.url} ${req.headers["user-agent"]}`);
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json", "x-ratelimit-remaining": "50", "x-request-id": "req_bin" });
        res.end(JSON.stringify(body));
      };
      if (req.url === "/v1/apps") return json(200, { apps: [{ name: "Shop", deployments: ["Production"] }] });
      if (req.url === "/v1/apps/Locked/deployments") return json(401, { code: "session_or_key_invalid", error: "SERVER TEXT" });
      return json(404, { code: "not_found" });
    });
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  });

  test("stdout carries only JSON-RPC for discovery, listing, calls and errors, and the CLI tree never loads", async () => {
    const result = await run(["mcp"], { AETHER_MCP_API_KEY: KEY, AETHER_MCP_API_URL: url, NODE_DEBUG: "module" }, [
      { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: META } },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: META } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { _meta: META, name: "list_apps", arguments: {} } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { _meta: META, name: "get_live_release", arguments: { app: "Locked" } } },
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { _meta: META, name: "no_such_tool", arguments: {} } },
      "{not json",
    ]);
    expect(result.code).toBe(0);
    const messages = jsonRpcLines(result.stdout);
    const byId = new Map(messages.filter((m) => "id" in m).map((m) => [m.id, m]));
    expect([...byId.keys()].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(byId.get(1).result.supportedVersions).toEqual(["2026-07-28"]);
    expect(byId.get(1).result._meta["io.modelcontextprotocol/serverInfo"].version).toBe(MCP_MANIFEST.version);
    const tools = byId.get(2).result.tools;
    expect(tools.map((tool: { name: string }) => tool.name)).toEqual(TOOL_NAMES);
    const contract = JSON.stringify(
      tools.map((tool: { name: string; inputSchema: unknown; outputSchema: unknown; annotations: unknown }) => ({
        name: tool.name,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      }))
    );
    expect(createHash("sha256").update(contract).digest("hex")).toBe(TOOL_CONTRACT_SHA256);
    expect(byId.get(3).result.structuredContent.apps).toEqual([{ name: "Shop", deployments: ["Production"] }]);
    expect(byId.get(4).result.isError).toBe(true);
    expect(byId.get(4).result.content[0].text).toMatch(/rejected the API key/);
    expect(byId.get(5).error.code).toBe(-32602);
    expect(messages.filter((m) => !("id" in m)).map((m) => m.error.code)).toEqual([-32700]);
    expect(hits.some((hit) => hit.startsWith("GET /v1/apps aether-mcp/"))).toBe(true);
    expect(result.stderr).toContain(`Module._load REQUEST ./server parent: ${MCP_BIN}\n`);
    expect(result.stderr).not.toMatch(/Module\._load REQUEST \.\/mcp\//);
    expect(result.stderr).not.toMatch(/Module\._load REQUEST (\.\/command-parser|\.\/command-executor|yargs|chalk) /);
    expect(result.stderr.includes(KEY)).toBe(false);
  });

  test("a configuration error keeps stdout clean and fails each call as a tool error", async () => {
    const result = await run(["mcp"], { AETHER_MCP_API_KEY: "opaque-access-key" }, [
      { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: META } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { _meta: META, name: "list_apps", arguments: {} } },
    ]);
    expect(result.code).toBe(0);
    const messages = jsonRpcLines(result.stdout);
    expect(messages.map((m) => m.id)).toEqual([1, 2]);
    expect(messages[1].result.isError).toBe(true);
    expect(result.stderr).toMatch(/must be an API key/);
    expect(result.stderr.includes("opaque-access-key")).toBe(false);
  });

  test("the server logs which origin it serves and warns about the CI URL variable", async () => {
    const result = await run(["mcp"], { AETHER_MCP_API_KEY: KEY, AETHER_API_URL: "https://staging.example.com" });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/AETHER_API_URL is set but aether mcp reads AETHER_MCP_API_URL only/);
    expect(result.stderr).toContain(`serving read-only tools for ${new URL(DEFAULT_AETHER_SERVER_URL).origin} `);
  });

  test("the CLI pins one exact @aetherpush/mcp version and runs that copy", () => {
    expect(CLI_MANIFEST.dependencies["@aetherpush/mcp"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(CLI_MANIFEST.dependencies["@aetherpush/mcp"]).toBe(MCP_MANIFEST.version);
  });

  test("the pinned @aetherpush/mcp installs nothing else and runs no install script", () => {
    expect(MCP_MANIFEST.dependencies).toBeUndefined();
    expect(MCP_MANIFEST.optionalDependencies).toBeUndefined();
    expect(MCP_MANIFEST.peerDependencies).toBeUndefined();
    for (const hook of ["preinstall", "install", "postinstall"]) {
      expect(MCP_MANIFEST.scripts?.[hook]).toBeUndefined();
    }
    expect(MCP_MANIFEST.engines).toEqual(CLI_MANIFEST.engines);
  });

  test("--help prints the beta usage to stderr and exits 0", async () => {
    const result = await run(["mcp", "--help"], {});
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^Usage: aether mcp/);
    expect(result.stderr).toMatch(/Beta\./);
  });

  test("an unknown argument exits 2 with nothing on stdout", async () => {
    const result = await run(["mcp", "--verbose"], {});
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/takes no arguments/);
  });

  test("other commands still reach the CLI", async () => {
    const result = await run(["--version"], {});
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
