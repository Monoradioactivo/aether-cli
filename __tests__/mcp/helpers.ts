import { createServer, PROTOCOL_VERSION } from "../../script/mcp/server";

export const KEY = "aether_sk_live_testkey123";
export const STUB_URL = "http://127.0.0.1:3999";
export const ENV = { AETHER_MCP_API_KEY: KEY, AETHER_MCP_API_URL: STUB_URL };
export const META = {
  "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientCapabilities": {},
};

export type Route = Record<string, unknown> | ((url: URL, init: RequestInit) => Response | Promise<Response>);

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export interface RecordedCall {
  url: URL;
  init: RequestInit;
}

export function harness(
  options: { env?: NodeJS.ProcessEnv; routes?: Record<string, Route>; now?: () => number; nodeVersion?: string } = {}
) {
  const { env = ENV, routes = {}, now, nodeVersion = "22.0.0" } = options;
  const out: string[] = [];
  const calls: RecordedCall[] = [];
  const logs: string[] = [];
  const fetchImpl = async (input: URL, init: RequestInit): Promise<Response> => {
    const url = new URL(input);
    calls.push({ url, init });
    const route = routes[url.pathname];
    if (!route) return jsonResponse(404, { code: "not_found", error: "nope" });
    return typeof route === "function" ? route(url, init) : jsonResponse(200, route);
  };
  const server = createServer({
    env,
    version: "9.9.9",
    fetchImpl,
    now,
    nodeVersion,
    write: (chunk) => out.push(chunk),
    log: (text) => logs.push(text),
  });
  const send = async (message: unknown): Promise<any[]> => {
    await server.handleLine(typeof message === "string" ? message : JSON.stringify(message));
    return out.splice(0).map((line) => {
      expect(line.endsWith("\n")).toBe(true);
      expect(line.indexOf("\n")).toBe(line.length - 1);
      return JSON.parse(line);
    });
  };
  const call = async (name: string, args: unknown, id: number | string = 1): Promise<any> =>
    (await send({ jsonrpc: "2.0", id, method: "tools/call", params: { _meta: META, name, arguments: args } }))[0];
  return { server, send, call, calls, logs };
}

export function pkg(label: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    label,
    appVersion: "2.4.0",
    description: `release ${label}`,
    uploadTime: 1763800000000,
    rollout: null,
    isMandatory: false,
    isDisabled: false,
    isAutoHalted: false,
    releaseMethod: "Upload",
    blobUrl: "https://blobs.example/secret",
    packageHash: "abc",
    size: 10,
    ...extra,
  };
}

export function historyRoute(history: Record<string, unknown>[]): Route {
  return (url) => {
    const page = Number(url.searchParams.get("page"));
    const size = Number(url.searchParams.get("size"));
    const slice = history.slice((page - 1) * size, (page - 1) * size + size);
    return jsonResponse(200, {
      history: slice,
      meta: { totalItems: history.length, itemsPerPage: size, currentPage: page, totalPages: Math.ceil(history.length / size) || 1 },
    });
  };
}

export function textBytes(response: any): number {
  return Buffer.byteLength(response.result.content[0].text, "utf8");
}
