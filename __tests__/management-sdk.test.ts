// Copyright (c) Aether. All rights reserved.

jest.mock("../../package.json", () => ({ version: "0.1.0-test" }), { virtual: true });

import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import AccountManager = require("../script/management-sdk");
import { AetherError } from "../script/errors";

const TEST_SERVER = "http://test.aetherpush.local";
const TEST_KEY = "test-access-key-abc123";

function randomDirName(): string {
  return "aether-sdk-test-" + crypto.randomBytes(6).toString("hex");
}

function jsonResponse(status: number, body?: any, extraHeaders: Record<string, string> = {}): Response {
  const headers: Record<string, string> = { "content-type": "application/json", ...extraHeaders };
  const bodyText = body !== undefined ? JSON.stringify(body) : "";
  return new Response(bodyText, { status, headers });
}

function textResponse(status: number, text: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(text, { status, headers: extraHeaders });
}

function emptyResponse(status: number, extraHeaders: Record<string, string> = {}): Response {
  // 204/205/304 require a null body per the Fetch spec (Node 22 enforces this strictly).
  return new Response(null, { status, headers: extraHeaders });
}

function newSdk(opts: { accessKey?: string; serverUrl?: string; customHeaders?: Record<string, string> } = {}): any {
  return new AccountManager(opts.accessKey ?? TEST_KEY, opts.customHeaders, opts.serverUrl ?? TEST_SERVER);
}

function lastFetchCall(spy: jest.SpyInstance): { url: string; init: RequestInit } {
  const calls = spy.mock.calls;
  const [url, init] = calls[calls.length - 1];
  return { url: String(url), init: (init || {}) as RequestInit };
}

describe("management-sdk / AccountManager", () => {
  let fetchSpy: jest.SpyInstance;
  let sandbox: string;

  beforeAll(() => {
    sandbox = path.join(os.tmpdir(), randomDirName());
    fs.mkdirSync(sandbox, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe("constructor", () => {
    it("throws when no accessKey is provided", () => {
      expect(() => new AccountManager("", undefined, TEST_SERVER)).toThrow(/access key must be specified/);
    });

    it("throws when accessKey is null", () => {
      expect(() => new AccountManager(null as any)).toThrow(/access key must be specified/);
    });

    it("stores accessKey and exposes it via the getter", () => {
      const sdk = newSdk({ accessKey: "my-key" });
      expect(sdk.accessKey).toBe("my-key");
    });

    it("uses DEFAULT_SERVER_URL (localhost:3000) when serverUrl is not provided", async () => {
      const sdk = new AccountManager(TEST_KEY);
      fetchSpy.mockResolvedValueOnce(jsonResponse(200, { account: {} }));
      await sdk.getAccountInfo();
      const { url } = lastFetchCall(fetchSpy);
      expect(url).toBe("http://localhost:3000/v1/account");
    });
  });

  describe("isAuthenticated", () => {
    it("returns true when the server responds 200", async () => {
      const sdk = newSdk();
      fetchSpy.mockResolvedValueOnce(emptyResponse(200));
      await expect(sdk.isAuthenticated()).resolves.toBe(true);
    });

    it("hits /v1/authenticated with a GET and Bearer auth", async () => {
      const sdk = newSdk();
      fetchSpy.mockResolvedValueOnce(emptyResponse(200));
      await sdk.isAuthenticated();
      const { url, init } = lastFetchCall(fetchSpy);
      expect(url).toBe(`${TEST_SERVER}/v1/authenticated`);
      expect(init.method).toBe("GET");
      expect((init.headers as any).Authorization).toBe(`Bearer ${TEST_KEY}`);
    });

    it("returns false on any non-200 HTTP status (401, 403, 500, etc.)", async () => {
      const sdk = newSdk();
      fetchSpy.mockResolvedValueOnce(jsonResponse(401, { error: "Unauthorized" }));
      await expect(sdk.isAuthenticated()).resolves.toBe(false);

      fetchSpy.mockResolvedValueOnce(jsonResponse(500, { error: "Server error" }));
      await expect(sdk.isAuthenticated()).resolves.toBe(false);
    });

    it("throws AetherError(504) when the network call itself fails", async () => {
      const sdk = newSdk();
      fetchSpy.mockRejectedValueOnce(new TypeError("fetch failed"));
      const err = await sdk.isAuthenticated().catch((e: any) => e);
      expect(err).toBeInstanceOf(AetherError);
      expect(err.statusCode).toBe(504);
    });
  });

  describe("access keys", () => {
    it("addAccessKey throws synchronously when name is empty", async () => {
      const sdk = newSdk();
      await expect(sdk.addAccessKey("")).rejects.toThrow(/name must be specified/);
    });

    it("addAccessKey posts the friendlyName and returns the new access key", async () => {
      const sdk = newSdk();
      const created = { name: "raw-key-secret", friendlyName: "ci", expires: 1700000000000 };
      fetchSpy.mockResolvedValueOnce(jsonResponse(201, { accessKey: created }));

      const result = await sdk.addAccessKey("ci");

      const { url, init } = lastFetchCall(fetchSpy);
      expect(url).toBe(`${TEST_SERVER}/v1/access-keys`);
      expect(init.method).toBe("POST");
      expect((init.headers as any)["Content-Type"]).toMatch(/application\/json/);
      expect(JSON.parse(init.body as string)).toEqual({ friendlyName: "ci" });
      expect(result).toEqual(created);
    });

    it("addAccessKey includes ttl in the body when provided", async () => {
      const sdk = newSdk();
      fetchSpy.mockResolvedValueOnce(jsonResponse(201, { accessKey: { name: "x" } }));
      await sdk.addAccessKey("ci", 86400000);
      const { init } = lastFetchCall(fetchSpy);
      expect(JSON.parse(init.body as string)).toEqual({ friendlyName: "ci", ttl: 86400000 });
    });

    it("getAccessKey URL-encodes the name segment", async () => {
      const sdk = newSdk();
      fetchSpy.mockResolvedValueOnce(jsonResponse(200, { accessKey: { friendlyName: "weird/name" } }));
      await sdk.getAccessKey("weird/name");
      const { url } = lastFetchCall(fetchSpy);
      expect(url).toBe(`${TEST_SERVER}/v1/access-keys/weird%2Fname`);
    });

    it("getAccessKeys filters out session keys", async () => {
      const sdk = newSdk();
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(200, {
          accessKeys: [
            { friendlyName: "cli-key", isSession: false },
            { friendlyName: "session-key", isSession: true },
            { friendlyName: "no-isSession-field" },
          ],
        })
      );
      const keys = await sdk.getAccessKeys();
      expect(keys).toHaveLength(2);
      expect(keys.map((k: any) => k.friendlyName)).toEqual(["cli-key", "no-isSession-field"]);
    });

    it("patchAccessKey PATCHes with only the provided fields", async () => {
      const sdk = newSdk();
      fetchSpy.mockResolvedValueOnce(jsonResponse(200, { accessKey: { friendlyName: "renamed" } }));
      await sdk.patchAccessKey("old-name", "new-name");
      const { url, init } = lastFetchCall(fetchSpy);
      expect(url).toBe(`${TEST_SERVER}/v1/access-keys/old-name`);
      expect(init.method).toBe("PATCH");
      expect(JSON.parse(init.body as string)).toEqual({ friendlyName: "new-name" });
    });

    it("patchAccessKey includes ttl when provided and omits friendlyName when not", async () => {
      const sdk = newSdk();
      fetchSpy.mockResolvedValueOnce(jsonResponse(200, { accessKey: {} }));
      await sdk.patchAccessKey("old-name", undefined, 7200000);
      const { init } = lastFetchCall(fetchSpy);
      expect(JSON.parse(init.body as string)).toEqual({ ttl: 7200000 });
    });

    it("removeAccessKey issues DELETE with no body", async () => {
      const sdk = newSdk();
      fetchSpy.mockResolvedValueOnce(emptyResponse(204));
      await sdk.removeAccessKey("my-key");
      const { url, init } = lastFetchCall(fetchSpy);
      expect(url).toBe(`${TEST_SERVER}/v1/access-keys/my-key`);
      expect(init.method).toBe("DELETE");
      expect(init.body).toBeUndefined();
    });

    it("removeSessions hits /v1/sessions/:createdBy with DELETE", async () => {
      const sdk = newSdk();
      fetchSpy.mockResolvedValueOnce(emptyResponse(204));
      await sdk.removeSessions("203.0.113.42");
      const { url, init } = lastFetchCall(fetchSpy);
      expect(url).toBe(`${TEST_SERVER}/v1/sessions/203.0.113.42`);
      expect(init.method).toBe("DELETE");
    });
  });

  describe("getSessions", () => {
    it("returns only non-expired session keys, deduplicated by createdBy", async () => {
      const sdk = newSdk();
      const now = Date.now();
      const future = now + 60_000;
      const past = now - 60_000;
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(200, {
          accessKeys: [
            { isSession: true, createdBy: "ip-1", createdTime: 1000, expires: future },
            { isSession: true, createdBy: "ip-1", createdTime: 2000, expires: future }, // dedupes ip-1
            { isSession: true, createdBy: "ip-2", createdTime: 3000, expires: past }, // expired
            { isSession: true, createdBy: "ip-3", createdTime: 4000, expires: future },
            { isSession: false, createdBy: "ip-4", createdTime: 5000, expires: future }, // not a session
            { isSession: true, createdTime: 6000, expires: future }, // missing createdBy
          ],
        })
      );
      const sessions = await sdk.getSessions();
      const byIp = sessions.reduce((acc: any, s: any) => ((acc[s.createdBy] = s.loggedInTime), acc), {});
      expect(Object.keys(byIp).sort()).toEqual(["ip-1", "ip-3"]);
      // ip-1 dedupes — the later entry (createdTime: 2000) wins
      expect(byIp["ip-1"]).toBe(2000);
    });
  });

  describe("account", () => {
    it("getAccountInfo returns the account object", async () => {
      const sdk = newSdk();
      const account = { email: "a@b.com", name: "Tester", linkedProviders: [] };
      fetchSpy.mockResolvedValueOnce(jsonResponse(200, { account }));
      const result = await sdk.getAccountInfo();
      expect(result).toEqual(account);
    });
  });

  describe("apps", () => {
    it("getApps GETs /v1/apps and returns the apps array", async () => {
      const sdk = newSdk();
      const apps = [{ name: "app1" }, { name: "app2" }];
      fetchSpy.mockResolvedValueOnce(jsonResponse(200, { apps }));
      const result = await sdk.getApps();
      const { url } = lastFetchCall(fetchSpy);
      expect(url).toBe(`${TEST_SERVER}/v1/apps`);
      expect(result).toEqual(apps);
    });

    it("getApp URL-encodes the app name", async () => {
      const sdk = newSdk();
      fetchSpy.mockResolvedValueOnce(jsonResponse(200, { app: { name: "My App" } }));
      await sdk.getApp("My App");
      const { url } = lastFetchCall(fetchSpy);
      expect(url).toBe(`${TEST_SERVER}/v1/apps/My%20App`);
    });

    it("addApp POSTs with the app name and returns the created app", async () => {
      const sdk = newSdk();
      fetchSpy.mockResolvedValueOnce(jsonResponse(201, { app: { name: "newApp" } }));
      const result = await sdk.addApp("newApp");
      const { init } = lastFetchCall(fetchSpy);
      expect(JSON.parse(init.body as string)).toEqual({ name: "newApp" });
      expect(result).toEqual({ name: "newApp" });
    });

    it("addApp includes manuallyProvisionDeployments when provided", async () => {
      const sdk = newSdk();
      fetchSpy.mockResolvedValueOnce(jsonResponse(201, { app: { name: "x" } }));
      await sdk.addApp("x", true);
      const { init } = lastFetchCall(fetchSpy);
      expect(JSON.parse(init.body as string)).toEqual({ name: "x", manuallyProvisionDeployments: true });
    });

    it("removeApp DELETEs the app", async () => {
      const sdk = newSdk();
      fetchSpy.mockResolvedValueOnce(emptyResponse(204));
      await sdk.removeApp("my-app");
      const { url, init } = lastFetchCall(fetchSpy);
      expect(url).toBe(`${TEST_SERVER}/v1/apps/my-app`);
      expect(init.method).toBe("DELETE");
    });

    it("renameApp PATCHes with the new name", async () => {
      const sdk = newSdk();
      fetchSpy.mockResolvedValueOnce(emptyResponse(200));
      await sdk.renameApp("old", "new");
      const { url, init } = lastFetchCall(fetchSpy);
      expect(url).toBe(`${TEST_SERVER}/v1/apps/old`);
      expect(init.method).toBe("PATCH");
      expect(JSON.parse(init.body as string)).toEqual({ name: "new" });
    });

    it("transferApp POSTs the destination email", async () => {
      const sdk = newSdk();
      fetchSpy.mockResolvedValueOnce(emptyResponse(201));
      await sdk.transferApp("my-app", "new@owner.com");
      const { url, init } = lastFetchCall(fetchSpy);
      expect(url).toBe(`${TEST_SERVER}/v1/apps/my-app/transfers`);
      expect(JSON.parse(init.body as string)).toEqual({ email: "new@owner.com" });
    });
  });

  describe("collaborators", () => {
    it("getCollaborators returns the collaborator map", async () => {
      const sdk = newSdk();
      const collaborators = { "a@b.com": { permission: "Owner" } };
      fetchSpy.mockResolvedValueOnce(jsonResponse(200, { collaborators }));
      const result = await sdk.getCollaborators("my-app");
      expect(result).toEqual(collaborators);
    });

    it("addCollaborator POSTs the email", async () => {
      const sdk = newSdk();
      fetchSpy.mockResolvedValueOnce(emptyResponse(201));
      await sdk.addCollaborator("my-app", "new@user.com");
      const { url, init } = lastFetchCall(fetchSpy);
      expect(url).toBe(`${TEST_SERVER}/v1/apps/my-app/collaborators`);
      expect(JSON.parse(init.body as string)).toEqual({ email: "new@user.com" });
    });

    it("removeCollaborator URL-encodes both the app name and the email", async () => {
      const sdk = newSdk();
      fetchSpy.mockResolvedValueOnce(emptyResponse(204));
      await sdk.removeCollaborator("my-app", "user+suffix@host.com");
      const { url, init } = lastFetchCall(fetchSpy);
      expect(url).toBe(`${TEST_SERVER}/v1/apps/my-app/collaborators/user%2Bsuffix%40host.com`);
      expect(init.method).toBe("DELETE");
    });
  });

  describe("deployments", () => {
    it("addDeployment POSTs the name and returns the new deployment", async () => {
      const sdk = newSdk();
      fetchSpy.mockResolvedValueOnce(jsonResponse(201, { deployment: { name: "Beta", key: "abc" } }));
      const result = await sdk.addDeployment("my-app", "Beta");
      const { url, init } = lastFetchCall(fetchSpy);
      expect(url).toBe(`${TEST_SERVER}/v1/apps/my-app/deployments`);
      expect(JSON.parse(init.body as string)).toEqual({ name: "Beta" });
      expect(result).toEqual({ name: "Beta", key: "abc" });
    });

    it("addDeployment includes a pre-defined key when provided", async () => {
      const sdk = newSdk();
      fetchSpy.mockResolvedValueOnce(jsonResponse(201, { deployment: {} }));
      await sdk.addDeployment("my-app", "Beta", "predefined-key");
      const { init } = lastFetchCall(fetchSpy);
      expect(JSON.parse(init.body as string)).toEqual({ name: "Beta", key: "predefined-key" });
    });

    it("getDeployments returns the deployments array", async () => {
      const sdk = newSdk();
      fetchSpy.mockResolvedValueOnce(jsonResponse(200, { deployments: [{ name: "Production" }] }));
      const result = await sdk.getDeployments("my-app");
      expect(result).toEqual([{ name: "Production" }]);
    });

    it("renameDeployment PATCHes the deployment with a new name", async () => {
      const sdk = newSdk();
      fetchSpy.mockResolvedValueOnce(emptyResponse(200));
      await sdk.renameDeployment("my-app", "Staging", "QA");
      const { url, init } = lastFetchCall(fetchSpy);
      expect(url).toBe(`${TEST_SERVER}/v1/apps/my-app/deployments/Staging`);
      expect(init.method).toBe("PATCH");
      expect(JSON.parse(init.body as string)).toEqual({ name: "QA" });
    });

    it("removeDeployment DELETEs the deployment", async () => {
      const sdk = newSdk();
      fetchSpy.mockResolvedValueOnce(emptyResponse(204));
      await sdk.removeDeployment("my-app", "Staging");
      const { url, init } = lastFetchCall(fetchSpy);
      expect(url).toBe(`${TEST_SERVER}/v1/apps/my-app/deployments/Staging`);
      expect(init.method).toBe("DELETE");
    });

    it("clearDeploymentHistory DELETEs the /history sub-resource", async () => {
      const sdk = newSdk();
      fetchSpy.mockResolvedValueOnce(emptyResponse(204));
      await sdk.clearDeploymentHistory("my-app", "Production");
      const { url, init } = lastFetchCall(fetchSpy);
      expect(url).toBe(`${TEST_SERVER}/v1/apps/my-app/deployments/Production/history`);
      expect(init.method).toBe("DELETE");
    });

    it("getDeploymentMetrics returns the metrics map", async () => {
      const sdk = newSdk();
      fetchSpy.mockResolvedValueOnce(jsonResponse(200, { metrics: { v1: { active: 100 } } }));
      const result = await sdk.getDeploymentMetrics("my-app", "Production");
      expect(result).toEqual({ v1: { active: 100 } });
    });

    it("getDeploymentHistory returns the history array", async () => {
      const sdk = newSdk();
      fetchSpy.mockResolvedValueOnce(jsonResponse(200, { history: [{ label: "v1" }, { label: "v2" }] }));
      const result = await sdk.getDeploymentHistory("my-app", "Production");
      expect(result).toEqual([{ label: "v1" }, { label: "v2" }]);
    });
  });

  describe("releases", () => {
    it("patchRelease wraps the metadata with a label and PATCHes the /release endpoint", async () => {
      const sdk = newSdk();
      fetchSpy.mockResolvedValueOnce(emptyResponse(200));
      await sdk.patchRelease("my-app", "Staging", "v3", { description: "Bugfix", rollout: 50 });
      const { url, init } = lastFetchCall(fetchSpy);
      expect(url).toBe(`${TEST_SERVER}/v1/apps/my-app/deployments/Staging/release`);
      expect(init.method).toBe("PATCH");
      expect(JSON.parse(init.body as string)).toEqual({
        packageInfo: { description: "Bugfix", rollout: 50, label: "v3" },
      });
    });

    it("promote POSTs the destination and optional packageInfo to /promotions", async () => {
      const sdk = newSdk();
      fetchSpy.mockResolvedValueOnce(jsonResponse(201, { package: { label: "v4" } }));
      const result = await sdk.promote("my-app", "Staging", "Production", { description: "rollout", rollout: 25 });
      const { url, init } = lastFetchCall(fetchSpy);
      expect(url).toBe(`${TEST_SERVER}/v1/apps/my-app/deployments/Staging/promotions`);
      expect(JSON.parse(init.body as string)).toEqual({
        destination: "Production",
        packageInfo: { description: "rollout", rollout: 25 },
      });
      expect(result).toEqual({ label: "v4" });
    });

    it("promote omits packageInfo when not provided", async () => {
      const sdk = newSdk();
      fetchSpy.mockResolvedValueOnce(jsonResponse(201, { package: {} }));
      await sdk.promote("my-app", "Staging", "Production");
      const { init } = lastFetchCall(fetchSpy);
      expect(JSON.parse(init.body as string)).toEqual({ destination: "Production" });
    });

    it("rollback POSTs to /rollbacks with targetRelease when provided", async () => {
      const sdk = newSdk();
      fetchSpy.mockResolvedValueOnce(jsonResponse(201, { package: { label: "v5" } }));
      await sdk.rollback("my-app", "Production", "v3");
      const { url, init } = lastFetchCall(fetchSpy);
      expect(url).toBe(`${TEST_SERVER}/v1/apps/my-app/deployments/Production/rollbacks`);
      expect(JSON.parse(init.body as string)).toEqual({ targetRelease: "v3" });
    });

    it("rollback omits targetRelease when not provided", async () => {
      const sdk = newSdk();
      fetchSpy.mockResolvedValueOnce(jsonResponse(201, { package: {} }));
      await sdk.rollback("my-app", "Production");
      const { init } = lastFetchCall(fetchSpy);
      expect(JSON.parse(init.body as string)).toEqual({});
    });

    it("release uploads a single file as multipart form-data", async () => {
      const sdk = newSdk();
      const bundleFile = path.join(sandbox, "bundle.js");
      fs.writeFileSync(bundleFile, "console.log('release')");

      fetchSpy.mockResolvedValueOnce(jsonResponse(201, { package: { label: "v1", appVersion: "1.0.0" } }));

      const result = await sdk.release("MyApp", "Staging", bundleFile, "1.0.0", { description: "Initial" });

      const { url, init } = lastFetchCall(fetchSpy);
      expect(url).toBe(`${TEST_SERVER}/v1/apps/MyApp/deployments/Staging/release`);
      expect(init.method).toBe("POST");
      expect(init.body).toBeInstanceOf(FormData);

      const form = init.body as FormData;
      const packageInfo = form.get("packageInfo");
      expect(typeof packageInfo).toBe("string");
      expect(JSON.parse(packageInfo as string)).toEqual({ description: "Initial", appVersion: "1.0.0" });
      expect(form.get("package")).toBeTruthy(); // a Blob

      expect(result).toEqual({ label: "v1", appVersion: "1.0.0" });
    });

    it("release does NOT set Content-Type header (let fetch + FormData choose the multipart boundary)", async () => {
      const sdk = newSdk();
      const bundleFile = path.join(sandbox, "bundle-ct.js");
      fs.writeFileSync(bundleFile, "x");
      fetchSpy.mockResolvedValueOnce(jsonResponse(201, { package: {} }));

      await sdk.release("MyApp", "Staging", bundleFile, "1.0.0", {});

      const { init } = lastFetchCall(fetchSpy);
      const headers = init.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBeUndefined();
      expect(headers.Authorization).toBe(`Bearer ${TEST_KEY}`);
    });

    it("release zips a directory, uploads it, and cleans up the temp zip", async () => {
      const sdk = newSdk();
      const releaseDir = path.join(sandbox, "rel-" + crypto.randomBytes(3).toString("hex"));
      fs.mkdirSync(path.join(releaseDir, "subdir"), { recursive: true });
      fs.writeFileSync(path.join(releaseDir, "index.js"), "console.log('a')");
      fs.writeFileSync(path.join(releaseDir, "subdir", "asset.txt"), "asset");

      fetchSpy.mockResolvedValueOnce(jsonResponse(201, { package: { label: "v9" } }));

      // The temp zip lands at process.cwd() — chdir to sandbox so we can observe and clean.
      const cwdBefore = process.cwd();
      const tmpCwd = path.join(sandbox, "tmpcwd");
      fs.mkdirSync(tmpCwd, { recursive: true });
      process.chdir(tmpCwd);

      try {
        const result = await sdk.release("MyApp", "Staging", releaseDir, "1.0.0", {});
        expect(result).toEqual({ label: "v9" });

        // The temp zip should have been deleted after upload.
        const leftover = fs.readdirSync(tmpCwd).filter((f) => f.endsWith(".zip"));
        expect(leftover).toEqual([]);
      } finally {
        process.chdir(cwdBefore);
      }

      const { init } = lastFetchCall(fetchSpy);
      expect(init.body).toBeInstanceOf(FormData);
    });

    it("release deletes the temp zip even when the upload fails", async () => {
      const sdk = newSdk();
      const releaseDir = path.join(sandbox, "rel-fail-" + crypto.randomBytes(3).toString("hex"));
      fs.mkdirSync(releaseDir);
      fs.writeFileSync(path.join(releaseDir, "x.js"), "x");

      fetchSpy.mockResolvedValueOnce(jsonResponse(409, { error: "Conflict: duplicate package" }));

      const cwdBefore = process.cwd();
      const tmpCwd = path.join(sandbox, "tmpcwd-fail");
      fs.mkdirSync(tmpCwd, { recursive: true });
      process.chdir(tmpCwd);

      try {
        await expect(sdk.release("MyApp", "Staging", releaseDir, "1.0.0", {})).rejects.toThrow(/duplicate/);
        const leftover = fs.readdirSync(tmpCwd).filter((f) => f.endsWith(".zip"));
        expect(leftover).toEqual([]);
      } finally {
        process.chdir(cwdBefore);
      }
    });
  });

  describe("api keys", () => {
    it("getApiKeys without args hits /v1/api-keys with no query string", async () => {
      const sdk = newSdk();
      fetchSpy.mockResolvedValueOnce(jsonResponse(200, { api_keys: [{ id: "uuid-1" }] }));
      const result = await sdk.getApiKeys();
      const { url } = lastFetchCall(fetchSpy);
      expect(url).toBe(`${TEST_SERVER}/v1/api-keys`);
      expect(result).toEqual([{ id: "uuid-1" }]);
    });

    it("getApiKeys adds ?include_revoked=true when requested", async () => {
      const sdk = newSdk();
      fetchSpy.mockResolvedValueOnce(jsonResponse(200, { api_keys: [] }));
      await sdk.getApiKeys(true);
      const { url } = lastFetchCall(fetchSpy);
      expect(url).toBe(`${TEST_SERVER}/v1/api-keys?include_revoked=true`);
    });

    it("addApiKey posts the request and returns the secret payload", async () => {
      const sdk = newSdk();
      const payload = { id: "uuid", key: "aether_sk_live_abcdef", scopes: ["deploy"] };
      fetchSpy.mockResolvedValueOnce(jsonResponse(201, payload));
      const result = await sdk.addApiKey({ name: "ci", scopes: ["deploy"] });
      const { init } = lastFetchCall(fetchSpy);
      expect(JSON.parse(init.body as string)).toEqual({ name: "ci", scopes: ["deploy"] });
      expect(result).toEqual(payload);
    });

    it("patchApiKey PATCHes /v1/api-keys/:id with the update body", async () => {
      const sdk = newSdk();
      fetchSpy.mockResolvedValueOnce(jsonResponse(200, { id: "uuid", scopes: ["read"] }));
      await sdk.patchApiKey("uuid-1", { scopes: ["read"] });
      const { url, init } = lastFetchCall(fetchSpy);
      expect(url).toBe(`${TEST_SERVER}/v1/api-keys/uuid-1`);
      expect(init.method).toBe("PATCH");
      expect(JSON.parse(init.body as string)).toEqual({ scopes: ["read"] });
    });

    it("revokeApiKey DELETEs /v1/api-keys/:id and returns the revoke result", async () => {
      const sdk = newSdk();
      const body = { id: "uuid", revoked_at: "2026-05-01T00:00:00Z" };
      fetchSpy.mockResolvedValueOnce(jsonResponse(200, body));
      const result = await sdk.revokeApiKey("uuid-1");
      const { url, init } = lastFetchCall(fetchSpy);
      expect(url).toBe(`${TEST_SERVER}/v1/api-keys/uuid-1`);
      expect(init.method).toBe("DELETE");
      expect(result).toEqual(body);
    });
  });

  describe("error handling", () => {
    it("wraps fetch network errors as AetherError with statusCode 504", async () => {
      const sdk = newSdk();
      fetchSpy.mockRejectedValueOnce(new TypeError("fetch failed"));
      try {
        await sdk.getApps();
        fail("expected to throw");
      } catch (err: any) {
        expect(err).toBeInstanceOf(AetherError);
        expect(err.statusCode).toBe(504);
        expect(err.message).toMatch(/Unable to connect to the Aether server/);
      }
    });

    it("throws AetherError with the server's status code on HTTP errors", async () => {
      const sdk = newSdk();
      fetchSpy.mockResolvedValueOnce(jsonResponse(404, { error: "Not found" }));
      try {
        await sdk.getApp("missing");
        fail("expected to throw");
      } catch (err: any) {
        expect(err).toBeInstanceOf(AetherError);
        expect(err.statusCode).toBe(404);
        expect(err.message).toBe("Not found");
      }
    });

    it("propagates the requestId from the X-Request-Id header", async () => {
      const sdk = newSdk();
      fetchSpy.mockResolvedValueOnce(jsonResponse(500, { error: "Boom" }, { "x-request-id": "req_xyz" }));
      try {
        await sdk.getApps();
        fail("expected to throw");
      } catch (err: any) {
        expect(err.requestId).toBe("req_xyz");
      }
    });

    it("falls back to requestId in the response body when the header is missing", async () => {
      const sdk = newSdk();
      fetchSpy.mockResolvedValueOnce(jsonResponse(400, { error: "Bad", requestId: "req_from_body" }));
      try {
        await sdk.getApps();
        fail("expected to throw");
      } catch (err: any) {
        expect(err.requestId).toBe("req_from_body");
      }
    });

    it("throws when expectResponseBody=true but the body is not JSON", async () => {
      const sdk = newSdk();
      fetchSpy.mockResolvedValueOnce(textResponse(200, "<html>not json</html>"));
      try {
        await sdk.getApps();
        fail("expected to throw");
      } catch (err: any) {
        expect(err).toBeInstanceOf(AetherError);
        expect(err.statusCode).toBe(500);
        expect(err.message).toMatch(/Could not parse response/);
      }
    });

    it("falls back to statusText when the error body is empty", async () => {
      const sdk = newSdk();
      fetchSpy.mockResolvedValueOnce(new Response("", { status: 503, statusText: "Service Unavailable" }));
      try {
        await sdk.getApps();
        fail("expected to throw");
      } catch (err: any) {
        expect(err.message).toBe("Service Unavailable");
        expect(err.statusCode).toBe(503);
      }
    });
  });

  describe("headers", () => {
    it("attaches Bearer auth, User-Agent and Accept headers on every request", async () => {
      const sdk = newSdk();
      fetchSpy.mockResolvedValueOnce(jsonResponse(200, { apps: [] }));
      await sdk.getApps();
      const { init } = lastFetchCall(fetchSpy);
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${TEST_KEY}`);
      expect(headers.Accept).toBe("application/json");
      expect(headers["User-Agent"]).toMatch(/^aether-management-sdk\//);
    });

    it("includes Content-Type only for requests that carry a body", async () => {
      const sdk = newSdk();

      // GET has no body
      fetchSpy.mockResolvedValueOnce(jsonResponse(200, { apps: [] }));
      await sdk.getApps();
      let headers = lastFetchCall(fetchSpy).init.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBeUndefined();

      // POST has a body
      fetchSpy.mockResolvedValueOnce(jsonResponse(201, { app: { name: "x" } }));
      await sdk.addApp("x");
      headers = lastFetchCall(fetchSpy).init.headers as Record<string, string>;
      expect(headers["Content-Type"]).toMatch(/application\/json/);
    });

    it("forwards custom headers passed to the constructor", async () => {
      const sdk = newSdk({ customHeaders: { "X-Aether-CLI-Version": "0.1.0", "X-Custom": "foo" } });
      fetchSpy.mockResolvedValueOnce(jsonResponse(200, { apps: [] }));
      await sdk.getApps();
      const headers = lastFetchCall(fetchSpy).init.headers as Record<string, string>;
      expect(headers["X-Aether-CLI-Version"]).toBe("0.1.0");
      expect(headers["X-Custom"]).toBe("foo");
    });
  });
});
