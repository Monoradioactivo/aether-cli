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
import * as cli from "../script/types/cli";
import * as executorMod from "../script/command-executor";

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

  const CI_ENV_VARS = [
    "CI",
    "GITHUB_ACTIONS",
    "GITHUB_SHA",
    "GITHUB_REF",
    "GITHUB_REF_NAME",
    "GITHUB_SERVER_URL",
    "GITHUB_REPOSITORY",
    "GITHUB_RUN_ID",
    "GITLAB_CI",
    "CI_COMMIT_SHA",
    "CI_COMMIT_REF_NAME",
    "CI_MERGE_REQUEST_IID",
    "CI_JOB_URL",
    "CIRCLECI",
    "CIRCLE_SHA1",
    "CIRCLE_BRANCH",
    "CIRCLE_PR_NUMBER",
    "CIRCLE_BUILD_URL",
    "JENKINS_URL",
    "GIT_COMMIT",
    "GIT_BRANCH",
    "CHANGE_ID",
    "BUILD_URL",
  ];
  let savedCiEnv: Record<string, string | undefined>;

  beforeEach(() => {
    resetSdkMocks();
    mockPromptGet.mockReset();

    savedCiEnv = {};
    for (const key of CI_ENV_VARS) {
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

    fetchSpy = jest.spyOn(globalThis, "fetch" as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    executor.sdk = null;

    for (const key of CI_ENV_VARS) {
      if (savedCiEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedCiEnv[key];
      }
    }
  });

  describe("execute dispatch", () => {
    it("login with existing session throws", async () => {
      readFileSyncSpy.mockReturnValueOnce(JSON.stringify({ accessKey: "existing-key" }));
      await expect(executor.execute({ type: cli.CommandType.login, accessKey: null, serverUrl: null })).rejects.toThrow(
        /already logged in/
      );
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

    it("login via prompt POSTs to /v1/auth/login and stores the returned accessKey", async () => {
      setLoginCredentials("user@example.com", "password123secret");
      mockSdkMethods.isAuthenticated.mockResolvedValue(true);
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ accessKey: "returned-ak" }), { status: 200 }));
      await executor.execute({
        type: cli.CommandType.login,
        accessKey: null,
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

    it("login via prompt surfaces server error message", async () => {
      setLoginCredentials("user@example.com", "wrong");
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Invalid credentials" }), { status: 401 }));
      await expect(
        executor.execute({
          type: cli.CommandType.login,
          accessKey: null,
          serverUrl: "https://api.aetherpush.com",
        })
      ).rejects.toThrow(/Invalid credentials/);
    });

    it("login via prompt rejects when fetch itself fails", async () => {
      setLoginCredentials("user@example.com", "password");
      fetchSpy.mockRejectedValueOnce(new TypeError("network down"));
      await expect(
        executor.execute({
          type: cli.CommandType.login,
          accessKey: null,
          serverUrl: "https://api.aetherpush.com",
        })
      ).rejects.toThrow(/Unable to reach Aether/);
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
