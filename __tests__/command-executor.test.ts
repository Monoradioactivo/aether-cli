jest.mock("../../package.json", () => ({ version: "0.1.0-test" }), { virtual: true });

const mockSdkMethods: Record<string, jest.Mock> = {
  isAuthenticated: jest.fn(),
  addAccessKey: jest.fn(),
  patchAccessKey: jest.fn(),
  getAccessKeys: jest.fn(),
  removeAccessKey: jest.fn(),
  addApp: jest.fn(),
  getApps: jest.fn(),
  removeApp: jest.fn(),
  renameApp: jest.fn(),
  transferApp: jest.fn(),
  addCollaborator: jest.fn(),
  getCollaborators: jest.fn(),
  removeCollaborator: jest.fn(),
  addDeployment: jest.fn(),
  clearDeploymentHistory: jest.fn(),
  getDeployments: jest.fn(),
  getDeployment: jest.fn(),
  getDeploymentHistory: jest.fn(),
  getDeploymentMetrics: jest.fn(),
  removeDeployment: jest.fn(),
  renameDeployment: jest.fn(),
  release: jest.fn(),
  patchRelease: jest.fn(),
  promote: jest.fn(),
  rollback: jest.fn(),
  getSessions: jest.fn(),
  removeSessions: jest.fn(),
  getAccountInfo: jest.fn(),
  getApiKeys: jest.fn(),
  addApiKey: jest.fn(),
  patchApiKey: jest.fn(),
  revokeApiKey: jest.fn(),
};

jest.mock("../script/management-sdk", () => {
  const ctor = jest.fn().mockImplementation(() => mockSdkMethods);
  (ctor as any).prototype = {};
  (ctor as any).AppPermission = { OWNER: "Owner", COLLABORATOR: "Collaborator" };
  return ctor;
});

const mockRunBrowserLogin = jest.fn();
jest.mock("../script/auth/browser-login", () => {
  class UnsupportedServerError extends Error {}
  return {
    UnsupportedServerError,
    runBrowserLogin: (...args: any[]) => mockRunBrowserLogin(...args),
  };
});

jest.mock("../script/commands/debug", () => ({
  __esModule: true,
  default: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("child_process", () => ({
  spawn: jest.fn(),
  execSync: jest.fn(),
}));

const mockPromptGet = jest.fn();
jest.mock("prompt", () => ({
  message: "",
  delimiter: "",
  start: jest.fn(),
  get: (...args: any[]) => mockPromptGet(...args),
}));

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as cli from "../script/types/cli";
import * as executorMod from "../script/command-executor";
import { AetherError } from "../script/errors";
import { CI_ENVIRONMENT_VARIABLES_TO_SCRUB } from "./fixtures/ci-environment";

const executor: any = executorMod;

function resetSdkMocks(): void {
  Object.values(mockSdkMethods).forEach((fn) => fn.mockReset());
}

function setConfirmResponse(response: string): void {
  mockPromptGet.mockImplementation((_schema: any, cb: any) => cb(null, { response }));
}

function setLoginCredentials(email: string, password: string): void {
  mockPromptGet.mockImplementation((_schema: any, cb: any) => cb(null, { email, password }));
}

function setRegisterCredentials(email: string, password: string, confirmPassword: string, name = ""): void {
  mockPromptGet.mockImplementation((_schema: any, cb: any) => cb(null, { email, name, password, confirmPassword }));
}

describe("command-executor", () => {
  let readFileSyncSpy: jest.SpyInstance;
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;
  let unlinkSyncSpy: jest.SpyInstance;
  let mkdirSyncSpy: jest.SpyInstance;
  let writeFileSyncSpy: jest.SpyInstance;
  let fetchSpy: jest.SpyInstance;

  let savedCiEnv: Record<string, string | undefined>;
  let savedHome: string | undefined;
  let savedLocalAppData: string | undefined;
  let sandboxHome: string;

  beforeEach(() => {
    resetSdkMocks();
    mockPromptGet.mockReset();
    mockRunBrowserLogin.mockReset();

    // The credential store resolves its paths from HOME. The fs spies below
    // cover the calls it makes today, but an implementation that reaches for a
    // different fs call would otherwise write into the developer's real home,
    // which is exactly what happened once.
    sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "aether-cli-test-"));
    savedHome = process.env.HOME;
    savedLocalAppData = process.env.LOCALAPPDATA;
    process.env.HOME = sandboxHome;
    delete process.env.LOCALAPPDATA;

    savedCiEnv = {};
    for (const key of CI_ENVIRONMENT_VARIABLES_TO_SCRUB) {
      savedCiEnv[key] = process.env[key];
      delete process.env[key];
    }

    consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);

    readFileSyncSpy = jest.spyOn(fs, "readFileSync").mockImplementation(() => {
      const err: any = new Error("ENOENT");
      err.code = "ENOENT";
      throw err;
    });
    unlinkSyncSpy = jest.spyOn(fs, "unlinkSync").mockImplementation(() => undefined);
    mkdirSyncSpy = jest.spyOn(fs, "mkdirSync").mockImplementation(() => undefined as any);
    writeFileSyncSpy = jest.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);
    jest.spyOn(fs, "openSync").mockImplementation(() => 1234 as any);
    jest.spyOn(fs, "closeSync").mockImplementation(() => undefined);
    jest.spyOn(fs, "fchmodSync").mockImplementation(() => undefined);
    jest.spyOn(fs, "chmodSync").mockImplementation(() => undefined);

    fetchSpy = jest.spyOn(globalThis, "fetch" as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    executor.sdk = null;

    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = savedLocalAppData;
    fs.rmSync(sandboxHome, { recursive: true, force: true });

    for (const key of CI_ENVIRONMENT_VARIABLES_TO_SCRUB) {
      if (savedCiEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedCiEnv[key];
      }
    }
  });

  describe("execute dispatch", () => {
    it("login with a session the server still accepts throws", async () => {
      readFileSyncSpy.mockReturnValue(JSON.stringify({ accessKey: "existing-key" }));
      mockSdkMethods.isAuthenticated.mockResolvedValue(true);
      await expect(executor.execute({ type: cli.CommandType.login, accessKey: null, serverUrl: null })).rejects.toThrow(
        /already logged in/
      );
    });

    it("a stored credential with no server override targets production, not localhost", async () => {
      // Only an explicit --serverUrl is persisted, so an absent one means the
      // default. Falling through to the SDK's own default sends every
      // authenticated command to localhost, which is what happened once.
      readFileSyncSpy.mockReturnValue(JSON.stringify({ accessKey: "stored-key" }));
      executor.sdk = null;
      mockSdkMethods.getAccountInfo.mockResolvedValue({ email: "user@example.com" });

      await executor.execute({ type: cli.CommandType.whoami });

      const AccountManager = require("../script/management-sdk");
      const serverUrl = AccountManager.mock.calls[AccountManager.mock.calls.length - 1][2];
      expect(serverUrl).toBe("https://api.aetherpush.com");
    });

    it("an explicit server override is still honored on later commands", async () => {
      readFileSyncSpy.mockImplementation((filePath: any) => {
        if (String(filePath).endsWith("credentials.json")) {
          return JSON.stringify({ accessKey: "stored-key" });
        }
        return JSON.stringify({ serverUrl: "https://api-staging.aetherpush.com" });
      });
      executor.sdk = null;
      mockSdkMethods.getAccountInfo.mockResolvedValue({ email: "user@example.com" });

      await executor.execute({ type: cli.CommandType.whoami });

      const AccountManager = require("../script/management-sdk");
      const serverUrl = AccountManager.mock.calls[AccountManager.mock.calls.length - 1][2];
      expect(serverUrl).toBe("https://api-staging.aetherpush.com");
    });

    it("default command without sdk and without connectionInfo throws", async () => {
      executor.sdk = null;
      await expect(executor.execute({ type: cli.CommandType.whoami })).rejects.toThrow(/not currently logged in/);
    });

    it("default command uses pre-set sdk (test escape hatch)", async () => {
      executor.sdk = mockSdkMethods;
      mockSdkMethods.getAccountInfo.mockResolvedValue({ email: "user@example.com" });
      await executor.execute({ type: cli.CommandType.whoami });
      expect(mockSdkMethods.getAccountInfo).toHaveBeenCalled();
      expect(consoleLogSpy).toHaveBeenCalledWith("user@example.com");
    });

    it("unknown command type throws", async () => {
      executor.sdk = mockSdkMethods;
      await expect(executor.execute({ type: 99999 })).rejects.toThrow(/Invalid command/);
    });
  });

  describe("dashboard-session hints", () => {
    const SERVER_PARAGRAPH =
      "Creating an access key requires a dashboard login session. If you are already signed in there and still see this, sign out and sign in again.";
    const refused = (): AetherError => new AetherError(SERVER_PARAGRAPH, 403, "req_1", "dashboard_session_required");

    beforeEach(() => {
      executor.sdk = mockSdkMethods;
    });

    it("accessKeyAdd maps dashboard_session_required to the CLI access keys hint", async () => {
      mockSdkMethods.addAccessKey.mockRejectedValue(refused());
      await expect(executor.execute({ type: cli.CommandType.accessKeyAdd, name: "ci" })).rejects.toThrow(
        "Access keys are created in the dashboard under Account > CLI access keys, not from the CLI."
      );
    });

    it("accessKeyPatch --ttl maps to the revoke-and-recreate hint", async () => {
      mockSdkMethods.patchAccessKey.mockRejectedValue(refused());
      await expect(executor.execute({ type: cli.CommandType.accessKeyPatch, oldName: "ci", ttl: 604800000 })).rejects.toThrow(
        "An access key's lifetime cannot be changed from the CLI, so nothing was updated: revoke the key and create a new one in the dashboard under Account > CLI access keys."
      );
    });

    it("accessKeyPatch --name without --ttl keeps the server message even with the code", async () => {
      mockSdkMethods.patchAccessKey.mockRejectedValue(refused());
      await expect(executor.execute({ type: cli.CommandType.accessKeyPatch, oldName: "ci", newName: "ci-old" })).rejects.toThrow(
        SERVER_PARAGRAPH
      );
    });

    it("apiKeyAdd maps to the API Keys hint", async () => {
      mockSdkMethods.addApiKey.mockRejectedValue(refused());
      await expect(executor.execute({ type: cli.CommandType.apiKeyAdd, name: "ci", scopes: ["read"] })).rejects.toThrow(
        "API keys are created in the dashboard under API Keys, not from the CLI."
      );
    });

    const API_KEY_PATCH_HINT =
      "An API key's expiration cannot be changed and its scopes cannot be widened, so nothing was updated: create a new key with the settings you need in the dashboard under API Keys and revoke this one.";

    it("apiKeyPatch --ttl maps to the API Keys hint", async () => {
      mockSdkMethods.patchApiKey.mockRejectedValue(refused());
      await expect(executor.execute({ type: cli.CommandType.apiKeyPatch, id: "uuid-1", ttl: 31536000000 })).rejects.toThrow(
        API_KEY_PATCH_HINT
      );
    });

    it("apiKeyPatch --scopes maps to the API Keys hint", async () => {
      mockSdkMethods.patchApiKey.mockRejectedValue(refused());
      await expect(executor.execute({ type: cli.CommandType.apiKeyPatch, id: "uuid-1", scopes: ["deploy", "apps"] })).rejects.toThrow(
        API_KEY_PATCH_HINT
      );
    });

    it("apiKeyPatch --name without --ttl or --scopes keeps the server message even with the code", async () => {
      mockSdkMethods.patchApiKey.mockRejectedValue(refused());
      await expect(executor.execute({ type: cli.CommandType.apiKeyPatch, id: "uuid-1", newName: "renamed" })).rejects.toThrow(
        SERVER_PARAGRAPH
      );
    });

    it("the mapped error keeps statusCode, requestId and code", async () => {
      mockSdkMethods.addAccessKey.mockRejectedValue(refused());
      try {
        await executor.execute({ type: cli.CommandType.accessKeyAdd, name: "ci" });
        fail("expected to throw");
      } catch (err: any) {
        expect(err).toBeInstanceOf(AetherError);
        expect(err.statusCode).toBe(403);
        expect(err.requestId).toBe("req_1");
        expect(err.code).toBe("dashboard_session_required");
        expect(err.message).not.toContain("sign out");
      }
    });

    it("a mapped command without the code keeps the server message", async () => {
      mockSdkMethods.addAccessKey.mockRejectedValue(new AetherError("Server says no", 403, "req_2"));
      await expect(executor.execute({ type: cli.CommandType.accessKeyAdd, name: "ci" })).rejects.toThrow("Server says no");
    });

    it("an unmapped command with the code keeps the server message", async () => {
      mockSdkMethods.getAccessKeys.mockRejectedValue(refused());
      await expect(executor.execute({ type: cli.CommandType.accessKeyList, format: "table" })).rejects.toThrow(SERVER_PARAGRAPH);
    });
  });

  describe("access-key commands", () => {
    beforeEach(() => {
      executor.sdk = mockSdkMethods;
    });

    it("accessKeyAdd calls sdk.addAccessKey and logs the key", async () => {
      mockSdkMethods.addAccessKey.mockResolvedValue({ name: "raw-key-secret-value" });
      await executor.execute({
        type: cli.CommandType.accessKeyAdd,
        name: "VSTS",
        ttl: 60 * 86400 * 1000,
      });
      expect(mockSdkMethods.addAccessKey).toHaveBeenCalledWith("VSTS", 60 * 86400 * 1000);
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("raw-key-secret-value"));
    });

    it("accessKeyPatch with only --name renames", async () => {
      mockSdkMethods.patchAccessKey.mockResolvedValue({ expires: Date.now() + 100000 });
      await executor.execute({
        type: cli.CommandType.accessKeyPatch,
        oldName: "Old",
        newName: "New",
        ttl: null,
      });
      expect(mockSdkMethods.patchAccessKey).toHaveBeenCalledWith("Old", "New", null);
    });

    it("accessKeyPatch with both name and ttl updates both", async () => {
      mockSdkMethods.patchAccessKey.mockResolvedValue({ expires: Date.now() + 100000 });
      await executor.execute({
        type: cli.CommandType.accessKeyPatch,
        oldName: "Old",
        newName: "New",
        ttl: 5 * 60 * 1000,
      });
      expect(mockSdkMethods.patchAccessKey).toHaveBeenCalledWith("Old", "New", 5 * 60 * 1000);
    });

    it("accessKeyPatch with neither field throws", async () => {
      await expect(
        executor.execute({
          type: cli.CommandType.accessKeyPatch,
          oldName: "Old",
          newName: undefined,
          ttl: undefined,
        })
      ).rejects.toThrow(/new name and\/or TTL must be provided/);
    });

    it("accessKeyList calls sdk.getAccessKeys", async () => {
      mockSdkMethods.getAccessKeys.mockResolvedValue([]);
      await executor.execute({
        type: cli.CommandType.accessKeyList,
        format: "json",
      });
      expect(mockSdkMethods.getAccessKeys).toHaveBeenCalled();
    });

    it("accessKeyRemove confirmed proceeds with removal", async () => {
      setConfirmResponse("y");
      mockSdkMethods.removeAccessKey.mockResolvedValue(undefined);
      await executor.execute({
        type: cli.CommandType.accessKeyRemove,
        accessKey: "MyKey",
      });
      expect(mockSdkMethods.removeAccessKey).toHaveBeenCalledWith("MyKey");
    });

    it("accessKeyRemove cancelled does not call SDK", async () => {
      setConfirmResponse("n");
      await executor.execute({
        type: cli.CommandType.accessKeyRemove,
        accessKey: "MyKey",
      });
      expect(mockSdkMethods.removeAccessKey).not.toHaveBeenCalled();
      expect(consoleLogSpy).toHaveBeenCalledWith("Access key removal cancelled.");
    });
  });

  describe("api-key commands", () => {
    beforeEach(() => {
      executor.sdk = mockSdkMethods;
    });

    it("apiKeyAdd with invalid scope throws before calling SDK", async () => {
      await expect(
        executor.execute({
          type: cli.CommandType.apiKeyAdd,
          name: "ci",
          scopes: ["deploy", "invalid"],
        })
      ).rejects.toThrow(/Invalid scope/);
      expect(mockSdkMethods.addApiKey).not.toHaveBeenCalled();
    });

    it("apiKeyAdd with empty scopes throws", async () => {
      await expect(
        executor.execute({
          type: cli.CommandType.apiKeyAdd,
          name: "ci",
          scopes: [],
        })
      ).rejects.toThrow(/At least one scope/);
      expect(mockSdkMethods.addApiKey).not.toHaveBeenCalled();
    });

    it("apiKeyAdd without ttl omits expires_at from the SDK request", async () => {
      mockSdkMethods.addApiKey.mockResolvedValue({
        id: "uuid-1",
        key: "aether_sk_live_RAW_SECRET",
        name: "ci",
        scopes: ["deploy", "read"],
        expires_at: null,
      });
      await executor.execute({
        type: cli.CommandType.apiKeyAdd,
        name: "ci",
        scopes: ["deploy", "read"],
      });
      expect(mockSdkMethods.addApiKey).toHaveBeenCalledWith({
        name: "ci",
        scopes: ["deploy", "read"],
      });
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("aether_sk_live_RAW_SECRET"));
    });

    it("apiKeyAdd with ttl translates to ISO expires_at", async () => {
      const realNow = Date.now;
      Date.now = () => 1700000000000;
      try {
        mockSdkMethods.addApiKey.mockResolvedValue({
          id: "uuid-1",
          key: "key",
          name: "ci",
          scopes: ["deploy"],
          expires_at: "2023-12-04T08:13:20.000Z",
        });
        await executor.execute({
          type: cli.CommandType.apiKeyAdd,
          name: "ci",
          scopes: ["deploy"],
          ttl: 86400000,
        });
        expect(mockSdkMethods.addApiKey).toHaveBeenCalledWith({
          name: "ci",
          scopes: ["deploy"],
          expires_at: new Date(1700000000000 + 86400000).toISOString(),
        });
      } finally {
        Date.now = realNow;
      }
    });

    it("apiKeyList passes includeRevoked to the SDK", async () => {
      mockSdkMethods.getApiKeys.mockResolvedValue([]);
      await executor.execute({
        type: cli.CommandType.apiKeyList,
        format: "json",
        includeRevoked: true,
      });
      expect(mockSdkMethods.getApiKeys).toHaveBeenCalledWith(true);
    });

    it("apiKeyList rejects invalid format", async () => {
      await expect(
        executor.execute({
          type: cli.CommandType.apiKeyList,
          format: "yaml",
          includeRevoked: false,
        })
      ).rejects.toThrow(/Invalid format/);
    });

    it("apiKeyPatch with no fields throws", async () => {
      await expect(
        executor.execute({
          type: cli.CommandType.apiKeyPatch,
          id: "uuid-abc",
        })
      ).rejects.toThrow(/At least one of --name, --scopes, or --ttl/);
      expect(mockSdkMethods.patchApiKey).not.toHaveBeenCalled();
    });

    it("apiKeyPatch with only --name sends only name to SDK", async () => {
      mockSdkMethods.patchApiKey.mockResolvedValue({ id: "uuid-abc", name: "renamed" });
      await executor.execute({
        type: cli.CommandType.apiKeyPatch,
        id: "uuid-abc",
        newName: "renamed",
      });
      expect(mockSdkMethods.patchApiKey).toHaveBeenCalledWith("uuid-abc", { name: "renamed" });
    });

    it("apiKeyPatch with invalid scope throws before calling SDK", async () => {
      await expect(
        executor.execute({
          type: cli.CommandType.apiKeyPatch,
          id: "uuid-abc",
          scopes: ["bogus"],
        })
      ).rejects.toThrow(/Invalid scope/);
      expect(mockSdkMethods.patchApiKey).not.toHaveBeenCalled();
    });

    it("apiKeyPatch with all fields builds the full update", async () => {
      const realNow = Date.now;
      Date.now = () => 1700000000000;
      try {
        mockSdkMethods.patchApiKey.mockResolvedValue({ id: "uuid-abc", name: "renamed" });
        await executor.execute({
          type: cli.CommandType.apiKeyPatch,
          id: "uuid-abc",
          newName: "renamed",
          scopes: ["deploy", "read"],
          ttl: 3600000,
        });
        expect(mockSdkMethods.patchApiKey).toHaveBeenCalledWith("uuid-abc", {
          name: "renamed",
          scopes: ["deploy", "read"],
          expires_at: new Date(1700000000000 + 3600000).toISOString(),
        });
      } finally {
        Date.now = realNow;
      }
    });

    it("apiKeyRemove confirmed calls sdk.revokeApiKey", async () => {
      setConfirmResponse("y");
      mockSdkMethods.revokeApiKey.mockResolvedValue({
        id: "uuid-abc",
        revoked_at: "2025-01-01T00:00:00Z",
      });
      await executor.execute({
        type: cli.CommandType.apiKeyRemove,
        id: "uuid-abc",
      });
      expect(mockSdkMethods.revokeApiKey).toHaveBeenCalledWith("uuid-abc");
    });

    it("apiKeyRemove cancelled does not call SDK", async () => {
      setConfirmResponse("n");
      await executor.execute({
        type: cli.CommandType.apiKeyRemove,
        id: "uuid-abc",
      });
      expect(mockSdkMethods.revokeApiKey).not.toHaveBeenCalled();
      expect(consoleLogSpy).toHaveBeenCalledWith("API key revocation cancelled.");
    });
  });

  describe("app commands", () => {
    beforeEach(() => {
      executor.sdk = mockSdkMethods;
    });

    it("appAdd creates app and lists its deployments", async () => {
      mockSdkMethods.addApp.mockResolvedValue({ name: "MyApp" });
      mockSdkMethods.getDeployments.mockResolvedValue([
        { name: "Production", key: "key-prod" },
        { name: "Staging", key: "key-stage" },
      ]);
      await executor.execute({ type: cli.CommandType.appAdd, appName: "MyApp" });
      expect(mockSdkMethods.addApp).toHaveBeenCalledWith("MyApp");
      expect(mockSdkMethods.getDeployments).toHaveBeenCalledWith("MyApp");
    });

    it("appList rejects invalid format", async () => {
      await expect(executor.execute({ type: cli.CommandType.appList, format: "xml" })).rejects.toThrow(/Invalid format/);
    });

    it("appList json fetches apps and prints", async () => {
      mockSdkMethods.getApps.mockResolvedValue([{ name: "App1", deployments: ["Production", "Staging"] }]);
      await executor.execute({ type: cli.CommandType.appList, format: "json" });
      expect(mockSdkMethods.getApps).toHaveBeenCalled();
    });

    it("appRemove confirmed deletes the app", async () => {
      setConfirmResponse("y");
      mockSdkMethods.removeApp.mockResolvedValue(undefined);
      await executor.execute({ type: cli.CommandType.appRemove, appName: "MyApp" });
      expect(mockSdkMethods.removeApp).toHaveBeenCalledWith("MyApp");
    });

    it("appRemove cancelled skips deletion", async () => {
      setConfirmResponse("n");
      await executor.execute({ type: cli.CommandType.appRemove, appName: "MyApp" });
      expect(mockSdkMethods.removeApp).not.toHaveBeenCalled();
    });

    it("appRename calls sdk.renameApp", async () => {
      mockSdkMethods.renameApp.mockResolvedValue(undefined);
      await executor.execute({
        type: cli.CommandType.appRename,
        currentAppName: "Old",
        newAppName: "New",
      });
      expect(mockSdkMethods.renameApp).toHaveBeenCalledWith("Old", "New");
    });

    it("appTransfer with invalid email throws before confirm", async () => {
      await expect(
        executor.execute({
          type: cli.CommandType.appTransfer,
          appName: "MyApp",
          email: "not-an-email",
        })
      ).rejects.toThrow(/invalid e-mail/);
      expect(mockSdkMethods.transferApp).not.toHaveBeenCalled();
    });

    it("appTransfer with valid email and confirmation transfers", async () => {
      setConfirmResponse("y");
      mockSdkMethods.transferApp.mockResolvedValue(undefined);
      await executor.execute({
        type: cli.CommandType.appTransfer,
        appName: "MyApp",
        email: "new-owner@example.com",
      });
      expect(mockSdkMethods.transferApp).toHaveBeenCalledWith("MyApp", "new-owner@example.com");
    });
  });

  describe("deployment commands", () => {
    beforeEach(() => {
      executor.sdk = mockSdkMethods;
    });

    it("deploymentAdd calls sdk.addDeployment with optional key", async () => {
      mockSdkMethods.addDeployment.mockResolvedValue({ name: "Prod", key: "abc" });
      await executor.execute({
        type: cli.CommandType.deploymentAdd,
        appName: "MyApp",
        deploymentName: "Prod",
        key: "predefined-123",
      });
      expect(mockSdkMethods.addDeployment).toHaveBeenCalledWith("MyApp", "Prod", "predefined-123");
    });

    it("deploymentList without showPackage skips metrics fetch", async () => {
      mockSdkMethods.getDeployments.mockResolvedValue([{ name: "Prod", key: "k1" }]);
      await executor.deploymentList(
        {
          type: cli.CommandType.deploymentList,
          appName: "MyApp",
          format: "json",
          displayKeys: true,
        },
        false
      );
      expect(mockSdkMethods.getDeployments).toHaveBeenCalledWith("MyApp");
      expect(mockSdkMethods.getDeploymentMetrics).not.toHaveBeenCalled();
    });

    it("deploymentList with showPackage fetches metrics for deployments with packages", async () => {
      mockSdkMethods.getDeployments.mockResolvedValue([
        {
          name: "Prod",
          key: "k1",
          package: { label: "v1", appVersion: "1.0.0", isMandatory: false },
        },
        { name: "Staging", key: "k2" },
      ]);
      mockSdkMethods.getDeploymentMetrics.mockResolvedValue({
        v1: { active: 100, downloaded: 110, failed: 0, installed: 110 },
      });
      await executor.execute({
        type: cli.CommandType.deploymentList,
        appName: "MyApp",
        format: "table",
        displayKeys: false,
      });
      expect(mockSdkMethods.getDeploymentMetrics).toHaveBeenCalledTimes(1);
      expect(mockSdkMethods.getDeploymentMetrics).toHaveBeenCalledWith("MyApp", "Prod");
    });

    it("deploymentRemove confirmed removes the deployment", async () => {
      setConfirmResponse("y");
      mockSdkMethods.removeDeployment.mockResolvedValue(undefined);
      await executor.execute({
        type: cli.CommandType.deploymentRemove,
        appName: "MyApp",
        deploymentName: "Prod",
      });
      expect(mockSdkMethods.removeDeployment).toHaveBeenCalledWith("MyApp", "Prod");
    });

    it("deploymentRename calls sdk.renameDeployment", async () => {
      mockSdkMethods.renameDeployment.mockResolvedValue(undefined);
      await executor.execute({
        type: cli.CommandType.deploymentRename,
        appName: "MyApp",
        currentDeploymentName: "Old",
        newDeploymentName: "New",
      });
      expect(mockSdkMethods.renameDeployment).toHaveBeenCalledWith("MyApp", "Old", "New");
    });

    it("deploymentHistoryClear confirmed clears history", async () => {
      setConfirmResponse("y");
      mockSdkMethods.clearDeploymentHistory.mockResolvedValue(undefined);
      await executor.execute({
        type: cli.CommandType.deploymentHistoryClear,
        appName: "MyApp",
        deploymentName: "Prod",
      });
      expect(mockSdkMethods.clearDeploymentHistory).toHaveBeenCalledWith("MyApp", "Prod");
    });

    it("deploymentHistory fetches account + history + metrics in parallel", async () => {
      mockSdkMethods.getAccountInfo.mockResolvedValue({ email: "user@example.com" });
      mockSdkMethods.getDeploymentHistory.mockResolvedValue([
        {
          label: "v1",
          appVersion: "1.0.0",
          uploadTime: Date.now(),
          isMandatory: false,
          releaseMethod: "Upload",
          description: "",
        },
      ]);
      mockSdkMethods.getDeploymentMetrics.mockResolvedValue({
        v1: { active: 100, downloaded: 110, failed: 0, installed: 110 },
      });
      await executor.execute({
        type: cli.CommandType.deploymentHistory,
        appName: "MyApp",
        deploymentName: "Prod",
        format: "json",
        displayAuthor: false,
      });
      expect(mockSdkMethods.getAccountInfo).toHaveBeenCalled();
      expect(mockSdkMethods.getDeploymentHistory).toHaveBeenCalledWith("MyApp", "Prod");
      expect(mockSdkMethods.getDeploymentMetrics).toHaveBeenCalledWith("MyApp", "Prod");
    });
  });

  describe("collaborator commands", () => {
    beforeEach(() => {
      executor.sdk = mockSdkMethods;
    });

    it("addCollaborator with valid email", async () => {
      mockSdkMethods.addCollaborator.mockResolvedValue(undefined);
      await executor.execute({
        type: cli.CommandType.collaboratorAdd,
        appName: "MyApp",
        email: "alice@example.com",
      });
      expect(mockSdkMethods.addCollaborator).toHaveBeenCalledWith("MyApp", "alice@example.com");
    });

    it("addCollaborator with invalid email throws", async () => {
      await expect(
        executor.execute({
          type: cli.CommandType.collaboratorAdd,
          appName: "MyApp",
          email: "not-an-email",
        })
      ).rejects.toThrow(/invalid e-mail/);
    });

    it("listCollaborators fetches and prints", async () => {
      mockSdkMethods.getCollaborators.mockResolvedValue({
        "alice@example.com": { permission: "Owner", isCurrentAccount: true },
      });
      await executor.execute({
        type: cli.CommandType.collaboratorList,
        appName: "MyApp",
        format: "json",
      });
      expect(mockSdkMethods.getCollaborators).toHaveBeenCalledWith("MyApp");
    });

    it("removeCollaborator confirmed removes the collaborator", async () => {
      setConfirmResponse("y");
      mockSdkMethods.removeCollaborator.mockResolvedValue(undefined);
      await executor.execute({
        type: cli.CommandType.collaboratorRemove,
        appName: "MyApp",
        email: "bob@example.com",
      });
      expect(mockSdkMethods.removeCollaborator).toHaveBeenCalledWith("MyApp", "bob@example.com");
    });
  });

  describe("login / register / logout", () => {
    it("login with --accessKey succeeds when sdk reports authenticated", async () => {
      mockSdkMethods.isAuthenticated.mockResolvedValue(true);
      await executor.execute({
        type: cli.CommandType.login,
        accessKey: "valid-raw-key",
        serverUrl: "https://api.aetherpush.com",
      });
      expect(mockSdkMethods.isAuthenticated).toHaveBeenCalled();
      expect(writeFileSyncSpy).toHaveBeenCalled();
    });

    it("login with --accessKey fails when sdk reports not authenticated", async () => {
      mockSdkMethods.isAuthenticated.mockResolvedValue(false);
      await expect(
        executor.execute({
          type: cli.CommandType.login,
          accessKey: "invalid-key",
          serverUrl: null,
        })
      ).rejects.toThrow(/Invalid access key/);
      expect(writeFileSyncSpy).not.toHaveBeenCalled();
    });

    it("login --password POSTs to /v1/auth/login and stores the returned accessKey", async () => {
      setLoginCredentials("user@example.com", "password123secret");
      mockSdkMethods.isAuthenticated.mockResolvedValue(true);
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ accessKey: "returned-ak" }), { status: 200 }));
      await executor.execute({
        type: cli.CommandType.login,
        accessKey: null,
        password: true,
        serverUrl: "https://api.aetherpush.com",
      });
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://api.aetherpush.com/v1/auth/login");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({
        email: "user@example.com",
        password: "password123secret",
      });
      expect(writeFileSyncSpy).toHaveBeenCalled();
    });

    it("login --password sends an MFA account to the browser flow instead", async () => {
      setLoginCredentials("user@example.com", "password123secret");
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ mfaRequired: true, pendingToken: "pt", expires: 123, methods: ["passkey"] }), { status: 200 })
      );
      await expect(
        executor.execute({
          type: cli.CommandType.login,
          accessKey: null,
          password: true,
          serverUrl: "https://api.aetherpush.com",
        })
      ).rejects.toThrow(/multi-factor authentication.*browser/s);
    });

    it("login --password surfaces the server error message", async () => {
      setLoginCredentials("user@example.com", "wrong");
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Invalid credentials" }), { status: 401 }));
      await expect(
        executor.execute({
          type: cli.CommandType.login,
          accessKey: null,
          password: true,
          serverUrl: "https://api.aetherpush.com",
        })
      ).rejects.toThrow(/Invalid credentials/);
    });

    it("login --password rejects when fetch itself fails", async () => {
      setLoginCredentials("user@example.com", "password");
      fetchSpy.mockRejectedValueOnce(new TypeError("network down"));
      await expect(
        executor.execute({
          type: cli.CommandType.login,
          accessKey: null,
          password: true,
          serverUrl: "https://api.aetherpush.com",
        })
      ).rejects.toThrow(/Unable to reach Aether/);
    });

    it("bare login runs the browser ceremony and stores what it returns", async () => {
      mockRunBrowserLogin.mockResolvedValue({
        accessKey: "browser-key",
        expires: 123,
        credentialId: "cred-1",
        email: "user@example.com",
      });

      await executor.execute({
        type: cli.CommandType.login,
        accessKey: null,
        serverUrl: "https://api.aetherpush.com",
      });

      expect(mockRunBrowserLogin).toHaveBeenCalledTimes(1);
      const options = mockRunBrowserLogin.mock.calls[0][0];
      expect(options.serverUrl).toBe("https://api.aetherpush.com");
      expect(options.forceDeviceFlow).toBe(false);
      expect(options.deviceId).toEqual(expect.any(String));
      expect(options.clientPlatform).toContain(process.platform);

      // Never prompts for a password, and never posts credentials anywhere.
      expect(mockPromptGet).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();

      const written = writeFileSyncSpy.mock.calls.map((call: any[]) => String(call[1])).join(" ");
      expect(written).toContain("browser-key");
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("user@example.com"));
    });

    it("login --device asks the ceremony for the printed-code path", async () => {
      mockRunBrowserLogin.mockResolvedValue({ accessKey: "browser-key", expires: 1 });

      await executor.execute({
        type: cli.CommandType.login,
        accessKey: null,
        device: true,
        serverUrl: "https://api.aetherpush.com",
      });

      expect(mockRunBrowserLogin.mock.calls[0][0].forceDeviceFlow).toBe(true);
    });

    it("login replaces a stored credential the server no longer accepts", async () => {
      readFileSyncSpy.mockReturnValue(JSON.stringify({ accessKey: "stale-key" }));
      mockSdkMethods.isAuthenticated.mockResolvedValue(false);
      mockRunBrowserLogin.mockResolvedValue({ accessKey: "fresh-key", expires: 1 });

      await executor.execute({ type: cli.CommandType.login, accessKey: null, serverUrl: null });

      expect(mockRunBrowserLogin).toHaveBeenCalled();
      expect(unlinkSyncSpy).toHaveBeenCalled();
    });

    it("login keeps refusing when the network is down rather than discarding a working session", async () => {
      readFileSyncSpy.mockReturnValue(JSON.stringify({ accessKey: "existing-key" }));
      mockSdkMethods.isAuthenticated.mockRejectedValue(new Error("offline"));

      await expect(executor.execute({ type: cli.CommandType.login, accessKey: null, serverUrl: null })).rejects.toThrow(
        /already logged in/
      );
      expect(mockRunBrowserLogin).not.toHaveBeenCalled();
    });

    it("login surfaces a server that does not implement browser sign-in", async () => {
      const { UnsupportedServerError } = require("../script/auth/browser-login");
      mockRunBrowserLogin.mockRejectedValue(new UnsupportedServerError("nope, use --accessKey"));

      await expect(
        executor.execute({ type: cli.CommandType.login, accessKey: null, serverUrl: "https://old.example.com" })
      ).rejects.toThrow(/--accessKey/);
    });

    it("logout revokes the device on the server before clearing local state", async () => {
      readFileSyncSpy.mockImplementation((filePath: any) => {
        if (String(filePath).endsWith("credentials.json")) {
          return JSON.stringify({ accessKey: "the-key" });
        }
        return JSON.stringify({ credentialId: "cred-1", serverUrl: "https://api.aetherpush.com" });
      });
      fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));

      await executor.execute({ type: cli.CommandType.logout });

      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://api.aetherpush.com/v1/cli/devices/current");
      expect(init.method).toBe("DELETE");
      expect(init.headers.Authorization).toBe("Bearer the-key");
      expect(unlinkSyncSpy).toHaveBeenCalled();
    });

    it("logout still clears local state when the remote revoke fails", async () => {
      readFileSyncSpy.mockImplementation((filePath: any) => {
        if (String(filePath).endsWith("credentials.json")) {
          return JSON.stringify({ accessKey: "the-key" });
        }
        return JSON.stringify({ credentialId: "cred-1", serverUrl: "https://api.aetherpush.com" });
      });
      fetchSpy.mockRejectedValueOnce(new TypeError("network down"));

      await executor.execute({ type: cli.CommandType.logout });

      expect(unlinkSyncSpy).toHaveBeenCalled();
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("dashboard"));
    });

    it("logout of a key-only session skips the revoke call entirely", async () => {
      readFileSyncSpy.mockImplementation((filePath: any) => {
        if (String(filePath).endsWith("credentials.json")) {
          return JSON.stringify({ accessKey: "ci-api-key" });
        }
        return JSON.stringify({ preserveAccessKeyOnLogout: true });
      });

      await executor.execute({ type: cli.CommandType.logout });

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(unlinkSyncSpy).toHaveBeenCalled();
    });

    it("register happy path POSTs to /v1/auth/register", async () => {
      setRegisterCredentials("new@example.com", "Password123!Strong", "Password123!Strong", "Alice");
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ accountId: "uuid", tenantId: "uuid", emailSent: true }), { status: 201 })
      );
      await executor.execute({
        type: cli.CommandType.register,
        serverUrl: "https://api.aetherpush.com",
      });
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://api.aetherpush.com/v1/auth/register");
      const body = JSON.parse(init.body);
      expect(body.email).toBe("new@example.com");
      expect(body.password).toBe("Password123!Strong");
      expect(body.name).toBe("Alice");
    });

    it("register throws when passwords do not match", async () => {
      setRegisterCredentials("new@example.com", "Password123!", "Different456!", "");
      await expect(
        executor.execute({
          type: cli.CommandType.register,
          serverUrl: null,
        })
      ).rejects.toThrow(/Passwords do not match/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("register surfaces structured server errors when body.errors present", async () => {
      setRegisterCredentials("bad@example.com", "weak", "weak", "");
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            errors: [
              { field: "password", message: "Password too short" },
              { field: "password", message: "Password must contain a digit" },
            ],
          }),
          { status: 400 }
        )
      );
      await expect(
        executor.execute({
          type: cli.CommandType.register,
          serverUrl: "https://api.aetherpush.com",
        })
      ).rejects.toThrow(/Password too short[\s\S]*Password must contain a digit/);
    });

    it("logout deletes session file and nulls sdk", async () => {
      executor.sdk = mockSdkMethods;
      await executor.execute({ type: cli.CommandType.logout });
      expect(unlinkSyncSpy).toHaveBeenCalled();
      expect(executor.sdk).toBeNull();
    });
  });

  describe("patch / promote / rollback", () => {
    beforeEach(() => {
      executor.sdk = mockSdkMethods;
    });

    it("patch with at least one field calls sdk.patchRelease", async () => {
      mockSdkMethods.patchRelease.mockResolvedValue(undefined);
      await executor.execute({
        type: cli.CommandType.patch,
        appName: "MyApp",
        deploymentName: "Prod",
        label: "v3",
        description: "bump rollout",
        mandatory: null,
        disabled: null,
        rollout: 50,
        appStoreVersion: null,
      });
      expect(mockSdkMethods.patchRelease).toHaveBeenCalledWith(
        "MyApp",
        "Prod",
        "v3",
        expect.objectContaining({
          description: "bump rollout",
          rollout: 50,
        })
      );
    });

    it("patch with all-null fields throws", async () => {
      await expect(
        executor.execute({
          type: cli.CommandType.patch,
          appName: "MyApp",
          deploymentName: "Prod",
          label: null,
          description: null,
          mandatory: null,
          disabled: null,
          rollout: null,
          appStoreVersion: null,
        })
      ).rejects.toThrow(/At least one property must be specified/);
    });

    it("promote calls sdk.promote with full packageInfo", async () => {
      mockSdkMethods.promote.mockResolvedValue(undefined);
      await executor.execute({
        type: cli.CommandType.promote,
        appName: "MyApp",
        sourceDeploymentName: "Staging",
        destDeploymentName: "Production",
        label: "v5",
        description: "QA passed",
        mandatory: false,
        disabled: false,
        rollout: 25,
        appStoreVersion: ">=1.0.0",
        noDuplicateReleaseError: false,
      });
      expect(mockSdkMethods.promote).toHaveBeenCalledWith(
        "MyApp",
        "Staging",
        "Production",
        expect.objectContaining({
          appVersion: ">=1.0.0",
          description: "QA passed",
          label: "v5",
          rollout: 25,
        })
      );
    });

    it("rollback confirmed calls sdk.rollback", async () => {
      setConfirmResponse("y");
      mockSdkMethods.rollback.mockResolvedValue(undefined);
      await executor.execute({
        type: cli.CommandType.rollback,
        appName: "MyApp",
        deploymentName: "Prod",
        targetRelease: "v3",
      });
      expect(mockSdkMethods.rollback).toHaveBeenCalledWith("MyApp", "Prod", "v3");
    });

    it("rollback cancelled does nothing", async () => {
      setConfirmResponse("n");
      await executor.execute({
        type: cli.CommandType.rollback,
        appName: "MyApp",
        deploymentName: "Prod",
        targetRelease: null,
      });
      expect(mockSdkMethods.rollback).not.toHaveBeenCalled();
    });
  });

  describe("release", () => {
    beforeEach(() => {
      executor.sdk = mockSdkMethods;
    });

    it("rejects a .zip package path", () => {
      expect(() =>
        executor.release({
          type: cli.CommandType.release,
          appName: "MyApp",
          deploymentName: "Production",
          package: "build/bundle.zip",
          appStoreVersion: "1.0.0",
        })
      ).toThrow(/unnecessary to package releases in a \.zip/);
    });

    it("signing a single-file package fails with folder guidance", () => {
      expect(() => executorMod.throwForInvalidSignedReleaseFolder("./bundle.js", true)).toThrow(/folder named "CodePush"/);
    });

    it("signing a folder not named CodePush fails", () => {
      expect(() => executorMod.throwForInvalidSignedReleaseFolder("./build/Aether", false)).toThrow(/named "Aether"/);
    });

    it("signing a folder named CodePush passes the guard", () => {
      expect(() => executorMod.throwForInvalidSignedReleaseFolder("./build/CodePush", false)).not.toThrow();
    });

    it("rejects an invalid semver range", () => {
      jest.spyOn(fs, "lstatSync").mockReturnValue({ isDirectory: () => false } as any);
      expect(() =>
        executor.release({
          type: cli.CommandType.release,
          appName: "MyApp",
          deploymentName: "Production",
          package: "./bundle.js",
          appStoreVersion: "not-a-version",
        })
      ).toThrow(/semver-compliant target binary version/);
    });

    it("happy path calls sdk.isAuthenticated then sdk.release", async () => {
      jest.spyOn(fs, "lstatSync").mockReturnValue({ isDirectory: () => false } as any);
      mockSdkMethods.isAuthenticated.mockResolvedValue(true);
      mockSdkMethods.release.mockResolvedValue(undefined);
      await executor.release({
        type: cli.CommandType.release,
        appName: "MyApp",
        deploymentName: "Production",
        package: "./bundle.js",
        appStoreVersion: "1.0.0",
        description: "first release",
        disabled: false,
        mandatory: false,
        rollout: 100,
        noDuplicateReleaseError: false,
      });
      expect(mockSdkMethods.isAuthenticated).toHaveBeenCalledWith(true);
      expect(mockSdkMethods.release).toHaveBeenCalledWith(
        "MyApp",
        "Production",
        "./bundle.js",
        "1.0.0",
        expect.objectContaining({ description: "first release", rollout: 100 })
      );
    });

    it("with --json emits the package JSON as the last stdout line and routes progress to stderr", async () => {
      jest.spyOn(fs, "lstatSync").mockReturnValue({ isDirectory: () => false } as any);
      mockSdkMethods.isAuthenticated.mockResolvedValue(true);
      const pkg = {
        label: "v3",
        packageHash: "abc123hash",
        size: 4242,
        appVersion: "1.0.0",
        blobUrl: "https://cdn.example.com/blob/v3",
        manifestBlobUrl: "https://cdn.example.com/manifest/v3",
        description: "first release",
        releasedBy: "adrian@aetherpush.com",
        releaseMethod: "Upload",
        uploadTime: 1714867200000,
        rollout: 100,
        isMandatory: false,
        isDisabled: false,
      };
      mockSdkMethods.release.mockResolvedValue(pkg);

      await executor.release({
        type: cli.CommandType.release,
        appName: "MyApp",
        deploymentName: "Production",
        package: "./bundle.js",
        appStoreVersion: "1.0.0",
        description: "first release",
        disabled: false,
        mandatory: false,
        rollout: 100,
        noDuplicateReleaseError: false,
        json: true,
      });

      const stdoutMessages = consoleLogSpy.mock.calls.map((c) => String(c[0]));
      const lastStdout = stdoutMessages[stdoutMessages.length - 1];
      const parsed = JSON.parse(lastStdout);
      expect(parsed).toEqual({
        label: "v3",
        packageHash: "abc123hash",
        size: 4242,
        appVersion: "1.0.0",
        blobUrl: "https://cdn.example.com/blob/v3",
        manifestBlobUrl: "https://cdn.example.com/manifest/v3",
        description: "first release",
        releasedBy: "adrian@aetherpush.com",
        releaseMethod: "Upload",
        uploadTime: 1714867200000,
        rollout: 100,
        isMandatory: false,
        isDisabled: false,
      });
      expect(stdoutMessages.some((m) => m.includes("Uploading release package"))).toBe(false);
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Uploading release package"));
    });

    it("without --json keeps progress on stdout and emits no JSON payload", async () => {
      jest.spyOn(fs, "lstatSync").mockReturnValue({ isDirectory: () => false } as any);
      mockSdkMethods.isAuthenticated.mockResolvedValue(true);
      mockSdkMethods.release.mockResolvedValue({
        label: "v3",
        packageHash: "h",
        size: 1,
        appVersion: "1.0.0",
        blobUrl: "u",
      } as any);

      await executor.release({
        type: cli.CommandType.release,
        appName: "MyApp",
        deploymentName: "Production",
        package: "./bundle.js",
        appStoreVersion: "1.0.0",
        description: "first release",
        disabled: false,
        mandatory: false,
        rollout: 100,
        noDuplicateReleaseError: false,
      });

      const stdoutMessages = consoleLogSpy.mock.calls.map((c) => String(c[0]));
      expect(stdoutMessages.some((m) => m.includes("Uploading release package"))).toBe(true);
      const jsonLines = stdoutMessages.filter((m) => {
        try {
          JSON.parse(m);
          return true;
        } catch {
          return false;
        }
      });
      expect(jsonLines.length).toBe(0);
    });
  });

  describe("session / whoami", () => {
    beforeEach(() => {
      executor.sdk = mockSdkMethods;
    });

    it("sessionList fetches and prints", async () => {
      mockSdkMethods.getSessions.mockResolvedValue([]);
      await executor.execute({
        type: cli.CommandType.sessionList,
        format: "json",
      });
      expect(mockSdkMethods.getSessions).toHaveBeenCalled();
    });

    it("sessionRemove of own machine name throws", async () => {
      const os = require("os");
      const hostname = os.hostname();
      await expect(
        executor.execute({
          type: cli.CommandType.sessionRemove,
          machineName: hostname,
        })
      ).rejects.toThrow(/Cannot remove the current login session/);
    });

    it("sessionRemove of another machine confirmed removes", async () => {
      setConfirmResponse("y");
      mockSdkMethods.removeSessions.mockResolvedValue(undefined);
      await executor.execute({
        type: cli.CommandType.sessionRemove,
        machineName: "Other Machine That Does Not Exist Here",
      });
      expect(mockSdkMethods.removeSessions).toHaveBeenCalledWith("Other Machine That Does Not Exist Here");
    });

    it("whoami prints the account email", async () => {
      mockSdkMethods.getAccountInfo.mockResolvedValue({ email: "me@example.com" });
      await executor.execute({ type: cli.CommandType.whoami });
      expect(consoleLogSpy).toHaveBeenCalledWith("me@example.com");
    });
  });

  describe("confirm prompt", () => {
    it("accepts 'y' as confirmation", async () => {
      setConfirmResponse("y");
      const result = await executor.confirm();
      expect(result).toBe(true);
    });

    it("rejects 'n' explicitly", async () => {
      setConfirmResponse("n");
      const result = await executor.confirm();
      expect(result).toBe(false);
    });

    it("rejects invalid responses and logs", async () => {
      setConfirmResponse("maybe");
      const result = await executor.confirm();
      expect(result).toBe(false);
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid response: "maybe"'));
    });
  });

  describe("non-interactive mode", () => {
    beforeEach(() => {
      executor.sdk = mockSdkMethods;
    });

    it("confirm short-circuits to true without prompting when autoConfirm is set", async () => {
      const result = await executor.confirm(undefined, true);
      expect(result).toBe(true);
      expect(mockPromptGet).not.toHaveBeenCalled();
    });

    it("rollback with nonInteractive skips the prompt and proceeds", async () => {
      mockSdkMethods.rollback.mockResolvedValue(undefined);
      await executor.execute({
        type: cli.CommandType.rollback,
        appName: "MyApp",
        deploymentName: "Prod",
        targetRelease: "v3",
        nonInteractive: true,
      });
      expect(mockPromptGet).not.toHaveBeenCalled();
      expect(mockSdkMethods.rollback).toHaveBeenCalledWith("MyApp", "Prod", "v3");
    });

    it("sessionRemove with nonInteractive skips the prompt and proceeds", async () => {
      mockSdkMethods.removeSessions.mockResolvedValue(undefined);
      await executor.execute({
        type: cli.CommandType.sessionRemove,
        machineName: "Other Machine That Does Not Exist Here",
        nonInteractive: true,
      });
      expect(mockPromptGet).not.toHaveBeenCalled();
      expect(mockSdkMethods.removeSessions).toHaveBeenCalledWith("Other Machine That Does Not Exist Here");
    });

    it("collaborator remove with nonInteractive skips the prompt and proceeds", async () => {
      mockSdkMethods.removeCollaborator.mockResolvedValue(undefined);
      await executor.execute({
        type: cli.CommandType.collaboratorRemove,
        appName: "MyApp",
        email: "bob@example.com",
        nonInteractive: true,
      });
      expect(mockPromptGet).not.toHaveBeenCalled();
      expect(mockSdkMethods.removeCollaborator).toHaveBeenCalledWith("MyApp", "bob@example.com");
    });

    it("auto-enables non-interactive when CI is true and announces on stderr", async () => {
      process.env.CI = "true";
      mockSdkMethods.rollback.mockResolvedValue(undefined);
      await executor.execute({
        type: cli.CommandType.rollback,
        appName: "MyApp",
        deploymentName: "Prod",
        targetRelease: "v3",
      });
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Detected CI environment"));
      expect(mockPromptGet).not.toHaveBeenCalled();
      expect(mockSdkMethods.rollback).toHaveBeenCalledWith("MyApp", "Prod", "v3");
    });

    it("explicit nonInteractive false overrides CI auto-detect and keeps prompting", async () => {
      process.env.CI = "true";
      setConfirmResponse("y");
      mockSdkMethods.rollback.mockResolvedValue(undefined);
      await executor.execute({
        type: cli.CommandType.rollback,
        appName: "MyApp",
        deploymentName: "Prod",
        targetRelease: "v3",
        nonInteractive: false,
      });
      expect(consoleErrorSpy).not.toHaveBeenCalledWith(expect.stringContaining("Detected CI environment"));
      expect(mockPromptGet).toHaveBeenCalled();
      expect(mockSdkMethods.rollback).toHaveBeenCalledWith("MyApp", "Prod", "v3");
    });
  });

  describe("force and destructive gating", () => {
    beforeEach(() => {
      executor.sdk = mockSdkMethods;
    });

    it("destructive command with force proceeds without prompting in non-interactive mode", async () => {
      mockSdkMethods.removeApp.mockResolvedValue(undefined);
      await executor.execute({
        type: cli.CommandType.appRemove,
        appName: "MyApp",
        nonInteractive: true,
        force: true,
      });
      expect(mockPromptGet).not.toHaveBeenCalled();
      expect(mockSdkMethods.removeApp).toHaveBeenCalledWith("MyApp");
    });

    it("destructive command without force fails loud in non-interactive mode", async () => {
      await expect(
        executor.execute({
          type: cli.CommandType.appRemove,
          appName: "MyApp",
          nonInteractive: true,
        })
      ).rejects.toThrow(/destructive action/);
      expect(mockPromptGet).not.toHaveBeenCalled();
      expect(mockSdkMethods.removeApp).not.toHaveBeenCalled();
    });

    it("destructive command with force skips the prompt in interactive mode", async () => {
      mockSdkMethods.removeApp.mockResolvedValue(undefined);
      await executor.execute({
        type: cli.CommandType.appRemove,
        appName: "MyApp",
        force: true,
      });
      expect(mockPromptGet).not.toHaveBeenCalled();
      expect(mockSdkMethods.removeApp).toHaveBeenCalledWith("MyApp");
    });

    it("force skips the prompt for a non-destructive command in interactive mode", async () => {
      mockSdkMethods.rollback.mockResolvedValue(undefined);
      await executor.execute({
        type: cli.CommandType.rollback,
        appName: "MyApp",
        deploymentName: "Prod",
        targetRelease: "v3",
        force: true,
      });
      expect(mockPromptGet).not.toHaveBeenCalled();
      expect(mockSdkMethods.rollback).toHaveBeenCalledWith("MyApp", "Prod", "v3");
    });

    it("login without accessKey fails loud in non-interactive mode", async () => {
      await expect(
        executor.execute({
          type: cli.CommandType.login,
          accessKey: null,
          serverUrl: null,
          nonInteractive: true,
        })
      ).rejects.toThrow(/Interactive login is unavailable/);
      expect(mockPromptGet).not.toHaveBeenCalled();
    });

    it("login with accessKey succeeds in non-interactive mode", async () => {
      mockSdkMethods.isAuthenticated.mockResolvedValue(true);
      await executor.execute({
        type: cli.CommandType.login,
        accessKey: "valid-raw-key",
        serverUrl: null,
        nonInteractive: true,
      });
      expect(mockSdkMethods.isAuthenticated).toHaveBeenCalled();
      expect(mockPromptGet).not.toHaveBeenCalled();
    });
    it("login with accessKey in non-interactive mode overwrites an existing session", async () => {
      readFileSyncSpy.mockReturnValueOnce(JSON.stringify({ accessKey: "existing-key" }));
      mockSdkMethods.isAuthenticated.mockResolvedValue(true);
      await executor.execute({
        type: cli.CommandType.login,
        accessKey: "valid-raw-key",
        serverUrl: null,
        nonInteractive: true,
      });
      expect(mockSdkMethods.isAuthenticated).toHaveBeenCalled();
      expect(mockPromptGet).not.toHaveBeenCalled();
    });

    it("register fails loud in non-interactive mode", async () => {
      await expect(
        executor.execute({
          type: cli.CommandType.register,
          serverUrl: null,
          nonInteractive: true,
        })
      ).rejects.toThrow(/registration is unavailable/);
      expect(mockPromptGet).not.toHaveBeenCalled();
    });
  });

  describe("ci metadata enrichment", () => {
    beforeEach(() => {
      executor.sdk = mockSdkMethods;
      mockSdkMethods.promote.mockResolvedValue(undefined);
      mockSdkMethods.patchRelease.mockResolvedValue(undefined);
    });

    function setGithubEnv(): void {
      process.env.GITHUB_ACTIONS = "true";
      process.env.GITHUB_SHA = "abc1234567";
      process.env.GITHUB_REF_NAME = "main";
    }

    it("appends CI metadata to a user-provided description on promote", async () => {
      setGithubEnv();
      await executor.execute({
        type: cli.CommandType.promote,
        appName: "MyApp",
        sourceDeploymentName: "Staging",
        destDeploymentName: "Production",
        description: "Fix auth token timeout",
      });

      expect(mockSdkMethods.promote).toHaveBeenCalledTimes(1);
      const packageInfo = mockSdkMethods.promote.mock.calls[0][3];
      expect(packageInfo.description).toBe("Fix auth token timeout\n\n[ci=github sha=abc1234 branch=main]");
    });

    it("uses CI metadata as the description when none is provided", async () => {
      setGithubEnv();
      await executor.execute({
        type: cli.CommandType.promote,
        appName: "MyApp",
        sourceDeploymentName: "Staging",
        destDeploymentName: "Production",
      });

      const packageInfo = mockSdkMethods.promote.mock.calls[0][3];
      expect(packageInfo.description).toBe("[ci=github sha=abc1234 branch=main]");
    });

    it("skips enrichment when ciMetadata is false", async () => {
      setGithubEnv();
      await executor.execute({
        type: cli.CommandType.promote,
        appName: "MyApp",
        sourceDeploymentName: "Staging",
        destDeploymentName: "Production",
        description: "Fix auth token timeout",
        ciMetadata: false,
      });

      const packageInfo = mockSdkMethods.promote.mock.calls[0][3];
      expect(packageInfo.description).toBe("Fix auth token timeout");
    });

    it("leaves the description untouched when no CI provider is detected", async () => {
      await executor.execute({
        type: cli.CommandType.promote,
        appName: "MyApp",
        sourceDeploymentName: "Staging",
        destDeploymentName: "Production",
        description: "Fix auth token timeout",
      });

      const packageInfo = mockSdkMethods.promote.mock.calls[0][3];
      expect(packageInfo.description).toBe("Fix auth token timeout");
    });

    it("enriches a patch command as well", async () => {
      setGithubEnv();
      await executor.execute({
        type: cli.CommandType.patch,
        appName: "MyApp",
        deploymentName: "Production",
        label: "v3",
        description: "Bumped rollout",
      });

      expect(mockSdkMethods.patchRelease).toHaveBeenCalledTimes(1);
      const packageInfo = mockSdkMethods.patchRelease.mock.calls[0][3];
      expect(packageInfo.description).toBe("Bumped rollout\n\n[ci=github sha=abc1234 branch=main]");
    });
  });
});
