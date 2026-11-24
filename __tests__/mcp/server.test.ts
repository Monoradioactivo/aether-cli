import { PROTOCOL_VERSION, USAGE } from "../../script/mcp/server";
import { TOOLS } from "../../script/mcp/tools";
import { ENV, harness, historyRoute, jsonResponse, KEY, META, pkg, STUB_URL } from "./helpers";

describe("aether mcp protocol", () => {
  test("server/discover answers with the 2026-07-28 result shape and the CLI version", async () => {
    const [response] = await harness().send({ jsonrpc: "2.0", id: "d", method: "server/discover", params: { _meta: META } });
    expect(response.id).toBe("d");
    expect(response.result.supportedVersions).toEqual([PROTOCOL_VERSION]);
    expect(response.result.capabilities).toEqual({ tools: {} });
    expect(response.result.resultType).toBe("complete");
    expect(typeof response.result.ttlMs).toBe("number");
    expect(response.result.cacheScope).toBe("public");
    expect(response.result.instructions).toMatch(/^Beta\./);
    expect(response.result._meta["io.modelcontextprotocol/serverInfo"]).toEqual({ name: "aether", title: "Aether", version: "9.9.9" });
  });

  test("initialize is refused with the supported versions", async () => {
    const [response] = await harness().send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "x", version: "1" } },
    });
    expect(response.error.code).toBe(-32022);
    expect(response.error.data).toEqual({ supported: [PROTOCOL_VERSION], requested: "2025-11-25" });
  });

  test("per-request _meta is enforced", async () => {
    const h = harness();
    expect((await h.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }))[0].error.code).toBe(-32602);
    expect((await h.send({ jsonrpc: "2.0", id: 1, method: "tools/list" }))[0].error.code).toBe(-32602);
    const [unsupported] = await h.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: { _meta: { ...META, "io.modelcontextprotocol/protocolVersion": "1900-01-01" } },
    });
    expect(unsupported.error.code).toBe(-32022);
    expect(unsupported.error.data).toEqual({ supported: [PROTOCOL_VERSION], requested: "1900-01-01" });
    const [noCapabilities] = await h.send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
      params: { _meta: { "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION } },
    });
    expect(noCapabilities.error.code).toBe(-32602);
  });

  test("JSON-RPC framing errors", async () => {
    const h = harness();
    const [parse] = await h.send("{not json");
    expect(parse.error.code).toBe(-32700);
    expect("id" in parse).toBe(false);
    expect((await h.send({ id: 1, method: "tools/list" }))[0].error.code).toBe(-32600);
    expect((await h.send({ jsonrpc: "2.0", id: null, method: "tools/list", params: { _meta: META } }))[0].error.code).toBe(-32600);
    expect((await h.send({ jsonrpc: "2.0", id: 4, method: "prompts/list", params: { _meta: META } }))[0].error.code).toBe(-32601);
    expect(await h.send({ jsonrpc: "2.0", method: "notifications/whatever" })).toEqual([]);
    expect(await h.send({ jsonrpc: "2.0", id: 9, result: {} })).toEqual([]);
    expect(await h.send("   ")).toEqual([]);
  });

  test("tools/list returns the five read-only tools with valid schemas, under 8 KB", async () => {
    const [response] = await harness().send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: META } });
    const tools = response.result.tools;
    expect(response.result.resultType).toBe("complete");
    expect(response.result.nextCursor).toBeUndefined();
    expect(tools.map((t: any) => t.name)).toEqual([
      "list_apps",
      "get_live_release",
      "list_release_history",
      "get_release_health",
      "preview_rollback",
    ]);
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[A-Za-z0-9_.-]{1,128}$/);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.outputSchema.type).toBe("object");
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect("run" in tool).toBe(false);
    }
    expect(Buffer.byteLength(JSON.stringify(response.result.tools))).toBeLessThan(8192);
    const [cursor] = await harness().send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: META, cursor: "x" } });
    expect(cursor.error.code).toBe(-32602);
  });

  test("the input contract pins history limit to 1..20 with default 10 and names to 255 characters", () => {
    const history = TOOLS.find((t) => t.name === "list_release_history")!;
    expect(history.inputSchema.properties.limit).toMatchObject({ type: "integer", minimum: 1, maximum: 20, default: 10 });
    expect(history.inputSchema.required).toEqual(["app", "deployment"]);
    expect(history.inputSchema.properties.app.maxLength).toBe(255);
    expect(history.outputSchema.required).toEqual(["app", "deployment", "totalReleases", "releases", "truncated", "notice"]);
    const apps = TOOLS.find((t) => t.name === "list_apps")!;
    expect(apps.outputSchema.required).toEqual(["apps", "totalApps", "truncated", "sharedAppsOmitted", "notice"]);
    const live = TOOLS.find((t) => t.name === "get_live_release")!;
    expect(live.outputSchema.required).toEqual(["app", "deployments", "totalDeployments", "truncated", "notice"]);
  });

  test("the usage text marks the subcommand as beta and names both variables", () => {
    expect(USAGE).toMatch(/Beta\./);
    expect(USAGE).toMatch(/AETHER_MCP_API_KEY/);
    expect(USAGE).toMatch(/AETHER_MCP_API_URL/);
  });
});

describe("aether mcp configuration", () => {
  test("access keys, malformed keys and missing keys are refused", async () => {
    for (const [env, pattern] of [
      [{ AETHER_MCP_API_URL: STUB_URL }, /AETHER_MCP_API_KEY is not set/],
      [{ ...ENV, AETHER_MCP_API_KEY: "a-wildcard-access-key" }, /Access keys and CLI sessions/],
      [{ ...ENV, AETHER_MCP_API_KEY: `${KEY}\n` }, /not a well-formed API key/],
    ] as Array<[NodeJS.ProcessEnv, RegExp]>) {
      const h = harness({ env });
      expect(h.server.configError?.message).toMatch(pattern);
      const response = await h.call("list_apps", {});
      expect(response.result.isError).toBe(true);
      expect(response.result.content[0].text).toMatch(pattern);
      expect(h.calls).toHaveLength(0);
    }
  });

  test("without AETHER_MCP_API_URL the production server is used, never localhost", () => {
    const h = harness({ env: { AETHER_MCP_API_KEY: KEY } });
    expect(h.server.config?.baseUrl).toBe("https://api.aetherpush.com/v1");
  });

  test("the URL must be https, or http on 127.0.0.1 or [::1], at the root, without credentials", () => {
    expect(harness({ env: { ...ENV, AETHER_MCP_API_URL: "https://staging.example.com" } }).server.config?.baseUrl).toBe(
      "https://staging.example.com/v1"
    );
    expect(harness({ env: { ...ENV, AETHER_MCP_API_URL: "http://[::1]:3000/" } }).server.config?.baseUrl).toBe("http://[::1]:3000/v1");
    for (const url of [
      "http://localhost:3000",
      "http://10.0.0.5:3000",
      "http://api.aetherpush.com",
      "ftp://127.0.0.1",
      "http://u:p@127.0.0.1:3000",
      "http://127.0.0.1:3000/?x=1",
      "http://127.0.0.1:3000/#x",
      "http://127.0.0.1:3000/v1",
      "not a url",
    ]) {
      expect(harness({ env: { ...ENV, AETHER_MCP_API_URL: url } }).server.configError).not.toBeNull();
    }
  });

  test("Node below 22 is a configuration error with fixed wording", async () => {
    const h = harness({ nodeVersion: "18.19.0" });
    const response = await h.call("list_apps", {});
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toBe(
      "aether mcp needs Node.js 22 or later; the MCP client started it with Node.js 18.19.0."
    );
  });

  test("a bad configuration still answers discovery", async () => {
    const h = harness({ env: { AETHER_MCP_API_KEY: "opaque", AETHER_MCP_API_URL: STUB_URL } });
    expect((await h.send({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: META } }))[0].result).toBeDefined();
  });
});

describe("aether mcp tool calls", () => {
  test("unknown tools are protocol errors, bad arguments are tool errors", async () => {
    const h = harness();
    expect((await h.call("delete_everything", {})).error.code).toBe(-32602);
    const objectName = (
      await h.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { _meta: META, name: { toString: 1 }, arguments: {} } })
    )[0];
    expect(objectName.error).toEqual({ code: -32602, message: "Unknown tool.", data: { name: null } });
    const bad = await h.call("list_release_history", { app: "Shop", limit: 500 });
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0].text).toBe("Invalid arguments: deployment is required; limit must be between 1 and 20.");
    expect((await h.call("list_release_history", { app: "Shop", deployment: "Production", limit: 21 })).result.isError).toBe(true);
    expect((await h.call("list_apps", { injected: true })).result.isError).toBe(true);
    expect((await h.call("list_apps", "nope")).result.content[0].text).toBe("Invalid arguments: arguments must be an object.");
    expect(h.calls).toHaveLength(0);
  });

  test("dot path segments, colons and inherited keys are refused as arguments", async () => {
    const h = harness();
    for (const args of [{ app: ".." }, { app: "Shop", deployment: "." }]) {
      const response = await h.call("get_live_release", args);
      expect(response.result.isError).toBe(true);
      expect(response.result.content[0].text).toMatch(/dot path segment/);
    }
    const qualified = await h.call("get_live_release", { app: "owner@example.com:Shop" });
    expect(qualified.result.isError).toBe(true);
    expect(qualified.result.content[0].text).toMatch(/must not contain a colon/);
    const inherited = await h.call("list_apps", JSON.parse('{"constructor":1,"__proto__":2,"toString":"x"}'));
    expect(inherited.result.isError).toBe(true);
    expect(h.calls).toHaveLength(0);
  });

  test("names are measured in code points, as the server measures them", async () => {
    const h = harness({ routes: { [`/v1/apps/${encodeURIComponent("😀".repeat(255))}/deployments`]: { deployments: [] } } });
    expect((await h.call("get_live_release", { app: "😀".repeat(255) })).result.isError).toBe(false);
    expect((await h.call("get_live_release", { app: "😀".repeat(256) })).result.isError).toBe(true);
  });

  test("get_live_release sends the bearer and headers, refuses redirects and drops keys and blob URLs", async () => {
    const h = harness({
      routes: {
        "/v1/apps/My%20App/deployments": {
          deployments: [
            { name: "Production", key: "deployment-key-secret", package: pkg("v3") },
            { name: "Staging", key: "other-secret", package: null },
          ],
        },
      },
    });
    const response = await h.call("get_live_release", { app: "My App" });
    expect(response.result.isError).toBe(false);
    const headers = h.calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(headers["User-Agent"]).toBe("aether-mcp/9.9.9");
    expect(headers["X-Aether-CLI-Version"]).toBe("9.9.9");
    expect(h.calls[0].init.redirect).toBe("error");
    expect(h.calls[0].init.method).toBe("GET");
    expect(h.calls[0].url.origin).toBe(STUB_URL);
    const text = response.result.content[0].text;
    for (const secret of ["deployment-key-secret", "other-secret", "blobs.example", "packageHash", "abc"]) {
      expect(text.includes(secret)).toBe(false);
    }
    expect(JSON.parse(text)).toEqual(response.result.structuredContent);
    expect(response.result.structuredContent.deployments[0].liveRelease.label).toBe("v3");
    expect(response.result.structuredContent.deployments[0].liveRelease.rolloutPercent).toBe(100);
    expect(response.result.structuredContent.deployments[1].liveRelease).toBeNull();
    expect(response.result.structuredContent.totalDeployments).toBe(2);
    expect(response.result.structuredContent.truncated).toBe(false);
  });

  test("get_live_release reports isAutoHalted as null when the deployments answer omits it, as the server's does", async () => {
    const { isAutoHalted: _omitted, ...live } = pkg("v4", { isDisabled: true });
    const h = harness({
      routes: {
        "/v1/apps/Shop/deployments": { deployments: [{ name: "Production", package: live }] },
        "/v1/apps/Shop/deployments/Production/history": historyRoute([pkg("v3"), pkg("v4", { isDisabled: true, isAutoHalted: true })]),
      },
    });
    const liveRelease = (await h.call("get_live_release", { app: "Shop" })).result.structuredContent.deployments[0].liveRelease;
    expect(liveRelease).toMatchObject({ label: "v4", isDisabled: true, isAutoHalted: null });
    const history = (await h.call("list_release_history", { app: "Shop", deployment: "Production" }, 2)).result.structuredContent
      .releases;
    expect(history.map((r: any) => r.isAutoHalted)).toEqual([true, false]);
  });

  test("get_release_health marks app-version keys as binary counts", async () => {
    const h = harness({
      routes: {
        "/v1/apps/Shop/deployments/Production/metrics": { metrics: { v2: { active: 10 }, "1.0.0": { active: 500 } } },
        "/v1/apps/Shop/deployments/Production/halt-history": { items: [] },
      },
    });
    const metrics = (await h.call("get_release_health", { app: "Shop", deployment: "Production" })).result.structuredContent.metrics;
    expect(metrics.map((m: any) => [m.label, m.kind])).toEqual([
      ["v2", "release"],
      ["1.0.0", "binary"],
    ]);
  });

  test("get_live_release with a deployment reads one deployment", async () => {
    const h = harness({
      routes: { "/v1/apps/Shop/deployments/Production": { deployment: { name: "Production", key: "k-secret", package: pkg("v2") } } },
    });
    const response = await h.call("get_live_release", { app: "Shop", deployment: "Production" });
    expect(response.result.structuredContent.deployments).toEqual([
      { name: "Production", liveRelease: expect.objectContaining({ label: "v2" }) },
    ]);
    expect(response.result.content[0].text.includes("k-secret")).toBe(false);
  });

  test("list_apps drops collaborator emails, including owner-qualified names", async () => {
    const h = harness({
      routes: {
        "/v1/apps": {
          apps: [
            { name: "Shop", collaborators: { "me@example.com": { permission: "Owner" } }, deployments: ["Production", "Staging"] },
            {
              name: "owner@example.com:Shop",
              collaborators: { "owner@example.com": { permission: "Owner" } },
              deployments: ["Production"],
            },
          ],
        },
      },
    });
    const response = await h.call("list_apps", {});
    expect(response.result.content[0].text.includes("@")).toBe(false);
    expect(JSON.stringify(response.result.structuredContent).includes("@")).toBe(false);
    expect(response.result.structuredContent).toMatchObject({
      apps: [{ name: "Shop", deployments: ["Production", "Staging"] }],
      totalApps: 1,
      truncated: false,
      sharedAppsOmitted: 1,
    });
  });

  test("list_release_history returns newest first within the limit, in two calls", async () => {
    const history = Array.from({ length: 12 }, (_, i) => pkg(`v${i + 1}`));
    const h = harness({ routes: { "/v1/apps/Shop/deployments/Production/history": historyRoute(history) } });
    const response = await h.call("list_release_history", { app: "Shop", deployment: "Production", limit: 3 });
    expect(response.result.structuredContent.releases.map((r: any) => r.label)).toEqual(["v12", "v11", "v10"]);
    expect(response.result.structuredContent.totalReleases).toBe(12);
    expect(h.calls).toHaveLength(2);
    const defaults = await h.call("list_release_history", { app: "Shop", deployment: "Production" }, 2);
    expect(defaults.result.structuredContent.releases).toHaveLength(10);
  });

  test("history of one release takes one call", async () => {
    const h = harness({ routes: { "/v1/apps/Shop/deployments/Production/history": historyRoute([pkg("v1")]) } });
    const response = await h.call("list_release_history", { app: "Shop", deployment: "Production" });
    expect(response.result.structuredContent.releases.map((r: any) => r.label)).toEqual(["v1"]);
    expect(h.calls).toHaveLength(1);
  });

  test("history longer than the fetch cap is a tool error, not a huge read", async () => {
    const h = harness({
      routes: {
        "/v1/apps/Shop/deployments/Production/history": () => jsonResponse(200, { history: [pkg("v1")], meta: { totalItems: 501 } }),
      },
    });
    const response = await h.call("list_release_history", { app: "Shop", deployment: "Production" });
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toMatch(/has 501 releases; this server reads deployments of at most 500/);
    expect(h.calls).toHaveLength(1);
  });

  test("a history page shorter than its total is refused rather than read as the newest releases", async () => {
    const history = Array.from({ length: 30 }, (_, i) => pkg(`v${i + 1}`));
    const h = harness({
      routes: {
        "/v1/apps/Shop/deployments/Production/history": (url) => {
          const size = Math.min(Number(url.searchParams.get("size")), 20);
          return jsonResponse(200, { history: history.slice(0, size), meta: { totalItems: history.length } });
        },
      },
    });
    for (const tool of ["list_release_history", "preview_rollback"]) {
      const response = await h.call(tool, { app: "Shop", deployment: "Production" });
      expect(response.result.isError).toBe(true);
      expect(response.result.content[0].text).toMatch(/returned part of the history/);
    }
  });

  test("history that changes between the two reads is refused", async () => {
    let reads = 0;
    const h = harness({
      routes: {
        "/v1/apps/Shop/deployments/Production/history": (url) => {
          reads += 1;
          const total = reads === 1 ? 2 : 3;
          return jsonResponse(200, {
            history: [pkg("v1"), pkg("v2"), pkg("v3")].slice(0, Number(url.searchParams.get("size"))),
            meta: { totalItems: total },
          });
        },
      },
    });
    const response = await h.call("preview_rollback", { app: "Shop", deployment: "Production" });
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toMatch(/landed while the history was being read/);
  });

  test("a history the server returns newest first is refused rather than read backwards", async () => {
    const h = harness({
      routes: { "/v1/apps/Shop/deployments/Production/history": historyRoute([pkg("v3"), pkg("v2"), pkg("v1")]) },
    });
    for (const tool of ["list_release_history", "preview_rollback"]) {
      const response = await h.call(tool, { app: "Shop", deployment: "Production" });
      expect(response.result.isError).toBe(true);
      expect(response.result.content[0].text).toMatch(/in an order this server does not expect/);
    }
  });

  test("get_release_health keeps binary counts when release labels exceed the cap", async () => {
    const metrics: Record<string, unknown> = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`v${i + 1}`, { active: 1 }]));
    for (const version of ["1.0.0", "1.2.0", "1.10.0", "0.9.0", "2.0.0", "2.1.0", "3.0.0"]) metrics[version] = { active: 500 };
    const h = harness({
      routes: {
        "/v1/apps/Shop/deployments/Production/metrics": { metrics },
        "/v1/apps/Shop/deployments/Production/halt-history": { items: [] },
      },
    });
    const result = (await h.call("get_release_health", { app: "Shop", deployment: "Production" })).result.structuredContent;
    expect(result.metrics).toHaveLength(20);
    expect(result.metricsTruncated).toBe(true);
    expect(result.metrics[0].label).toBe("v30");
    expect(result.metrics.filter((m: any) => m.kind === "binary").map((m: any) => m.label)).toEqual([
      "3.0.0",
      "2.1.0",
      "2.0.0",
      "1.10.0",
      "1.2.0",
    ]);
  });

  test("a failure while answering still sends one internal error for that request", async () => {
    const { createServer } = await import("../../script/mcp/server");
    const out: string[] = [];
    let failNextWrite = true;
    const server = createServer({
      env: ENV,
      version: "9.9.9",
      nodeVersion: "22.0.0",
      log: () => {},
      write: (chunk) => {
        if (failNextWrite) {
          failNextWrite = false;
          throw new Error("write failed");
        }
        out.push(chunk);
      },
    });
    await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: "x", method: "server/discover", params: { _meta: META } }));
    expect(out.map((line) => JSON.parse(line))).toEqual([
      { jsonrpc: "2.0", id: "x", error: { code: -32603, message: "Internal error." } },
    ]);
    failNextWrite = true;
    await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: null, method: "tools/list", params: { _meta: META } }));
    expect(failNextWrite).toBe(false);
    expect(out).toHaveLength(1);
  });

  test("an unreadable history total is a tool error", async () => {
    const h = harness({ routes: { "/v1/apps/Shop/deployments/Production/history": { history: [], meta: { totalItems: "many" } } } });
    const response = await h.call("list_release_history", { app: "Shop", deployment: "Production" });
    expect(response.result.content[0].text).toBe("The Aether API answered with a history this server cannot read.");
  });

  test("get_release_health keeps the newest labels and says when it truncated", async () => {
    const metrics = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`v${i + 1}`, { active: i, failed: i === 29 ? 999 : 0 }]));
    const h = harness({
      routes: {
        "/v1/apps/Shop/deployments/Production/metrics": { metrics },
        "/v1/apps/Shop/deployments/Production/halt-history": {
          items: [
            {
              kind: "halt",
              label: "v30",
              occurredAt: "2026-11-24T00:00:00.000Z",
              servedDevices: 100,
              failedDevices: 40,
              isActive: true,
              payload: "secret",
            },
          ],
        },
      },
    });
    const response = await h.call("get_release_health", { app: "Shop", deployment: "Production" });
    const result = response.result.structuredContent;
    expect(result.metricsTruncated).toBe(true);
    expect(result.metrics).toHaveLength(20);
    expect(result.metrics[0]).toEqual({ label: "v30", kind: "release", active: 29, downloaded: 0, installed: 0, failed: 999 });
    expect(result.halts).toEqual([
      { kind: "halt", label: "v30", occurredAt: "2026-11-24T00:00:00.000Z", servedDevices: 100, failedDevices: 40, isActive: true },
    ]);
    expect(h.calls[1].url.searchParams.get("limit")).toBe("10");
  });

  test("preview_rollback never calls a write route", async () => {
    const h = harness({ routes: { "/v1/apps/Shop/deployments/Production/history": historyRoute([pkg("v1"), pkg("v2")]) } });
    const response = await h.call("preview_rollback", { app: "Shop", deployment: "Production" });
    expect(response.result.structuredContent.outcome).toBe("would_roll_back");
    expect(h.calls.every((c) => c.init.method === "GET")).toBe(true);
    expect(h.calls.every((c) => !c.url.pathname.endsWith("/rollbacks"))).toBe(true);
  });

  test("a cancelled call sends no response", async () => {
    const out: string[] = [];
    let started = false;
    const { createServer } = await import("../../script/mcp/server");
    const server = createServer({
      env: ENV,
      version: "9.9.9",
      nodeVersion: "22.0.0",
      write: (chunk) => out.push(chunk),
      fetchImpl: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          started = true;
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    });
    const pending = server.handleLine(
      JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { _meta: META, name: "list_apps", arguments: {} } })
    );
    await new Promise((resolve) => setImmediate(resolve));
    await server.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } }));
    await pending;
    expect(started).toBe(true);
    expect(out).toEqual([]);
  });

  test("malformed server answers are read defensively", async () => {
    const h = harness({ routes: { "/v1/apps": () => jsonResponse(200, { apps: 5 }) } });
    const ok = await h.call("list_apps", {});
    expect(ok.result.isError).toBe(false);
    expect(ok.result.structuredContent.apps).toEqual([]);
  });

  test("a transport failure is a tool error naming the host, and its code goes to the log only", async () => {
    const h = harness({
      routes: {
        "/v1/apps": () => {
          throw new RangeError("boom");
        },
      },
    });
    const response = await h.call("list_apps", {});
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toBe("The Aether API at 127.0.0.1:3999 could not be reached.");
    expect(h.logs).toEqual(["request failed: RangeError"]);
  });
});
