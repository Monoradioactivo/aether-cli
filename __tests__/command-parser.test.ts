jest.mock("../../package.json", () => ({ version: "0.1.0-test" }), { virtual: true });

jest.mock("parse-duration", () => ({
  default: (input: string): number => {
    const units: Record<string, number> = {
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
      y: 365 * 24 * 60 * 60 * 1000,
    };
    const match = String(input).match(/^(\d+)\s*([smhdy])$/);
    if (!match) return NaN;
    return parseInt(match[1], 10) * units[match[2]];
  },
}));

import { CommandType } from "../script/types/cli";

function parseArgs(args: string[]): any {
  let result: any;
  jest.isolateModules(() => {
    const originalArgv = process.argv;
    process.argv = ["node", "aether", ...args];
    try {
      const { createCommand } = require("../script/command-parser");
      result = createCommand();
    } finally {
      process.argv = originalArgv;
    }
  });
  return result;
}

const MS = {
  minute: 60 * 1000,
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
};

describe("command-parser", () => {
  beforeEach(() => {
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("access-key", () => {
    it("'access-key add <name>' uses the default 60-day ttl", () => {
      const cmd = parseArgs(["access-key", "add", "VSTS Integration"]);
      expect(cmd.type).toBe(CommandType.accessKeyAdd);
      expect(cmd.name).toBe("VSTS Integration");
      expect(cmd.ttl).toBe(60 * MS.day);
    });

    it("'access-key add' parses --ttl 5m correctly", () => {
      const cmd = parseArgs(["access-key", "add", "OneTime", "--ttl", "5m"]);
      expect(cmd.type).toBe(CommandType.accessKeyAdd);
      expect(cmd.name).toBe("OneTime");
      expect(cmd.ttl).toBe(5 * MS.minute);
    });

    it("'access-key patch' parses both --name and --ttl", () => {
      const cmd = parseArgs(["access-key", "patch", "OldName", "--name", "NewName", "--ttl", "7d"]);
      expect(cmd.type).toBe(CommandType.accessKeyPatch);
      expect(cmd.oldName).toBe("OldName");
      expect(cmd.newName).toBe("NewName");
      expect(cmd.ttl).toBe(7 * MS.day);
    });

    it("'access-key list' defaults --format to table", () => {
      const cmd = parseArgs(["access-key", "list"]);
      expect(cmd.type).toBe(CommandType.accessKeyList);
      expect(cmd.format).toBe("table");
    });

    it("'access-key ls' (alias) accepts --format json", () => {
      const cmd = parseArgs(["access-key", "ls", "--format", "json"]);
      expect(cmd.type).toBe(CommandType.accessKeyList);
      expect(cmd.format).toBe("json");
    });

    it("'access-key remove <name>'", () => {
      const cmd = parseArgs(["access-key", "remove", "VSTS Integration"]);
      expect(cmd.type).toBe(CommandType.accessKeyRemove);
      expect(cmd.accessKey).toBe("VSTS Integration");
    });

    it("'access-key rm' (alias)", () => {
      const cmd = parseArgs(["access-key", "rm", "MyKey"]);
      expect(cmd.type).toBe(CommandType.accessKeyRemove);
      expect(cmd.accessKey).toBe("MyKey");
    });
  });

  function parseArgsWithState(args: string[]): { cmd: any; parseFailed: boolean } {
    let cmd: any;
    let parseFailed = false;
    jest.isolateModules(() => {
      const originalArgv = process.argv;
      process.argv = ["node", "aether", ...args];
      try {
        const mod = require("../script/command-parser");
        cmd = mod.createCommand();
        parseFailed = mod.parseFailed;
      } finally {
        process.argv = originalArgv;
      }
    });
    return { cmd, parseFailed };
  }

  describe("parseFailed flag", () => {
    it("is false for a valid command", () => {
      const { cmd, parseFailed } = parseArgsWithState(["app", "list"]);
      expect(cmd).toBeDefined();
      expect(parseFailed).toBe(false);
    });

    it("is true for an unknown top-level command category", () => {
      const { parseFailed } = parseArgsWithState(["nonsense-command"]);
      expect(parseFailed).toBe(true);
    });

    it("is true when a known command is missing required positional args", () => {
      const { parseFailed } = parseArgsWithState(["app", "rm"]);
      expect(parseFailed).toBe(true);
    });

    it("is true when a known command is given too many positional args", () => {
      const { parseFailed } = parseArgsWithState(["app", "rm", "MyApp", "ExtraArg"]);
      expect(parseFailed).toBe(true);
    });

    it("is true for an unknown subcommand under a known category", () => {
      const { parseFailed } = parseArgsWithState(["app", "bogus-subcommand"]);
      expect(parseFailed).toBe(true);
    });

    it("is false when invoked with no args at all (user wants help)", () => {
      const { cmd, parseFailed } = parseArgsWithState([]);
      expect(cmd).toBeUndefined();
      expect(parseFailed).toBe(false);
    });

    it("is reset between invocations via isolateModules", () => {
      const first = parseArgsWithState(["nonsense"]);
      expect(first.parseFailed).toBe(true);
      const second = parseArgsWithState(["app", "list"]);
      expect(second.parseFailed).toBe(false);
    });
  });

  describe("api-key", () => {
    it("'api-key add <name> --scopes deploy,read' parses scopes as array", () => {
      const cmd = parseArgs(["api-key", "add", "ci-deploy", "--scopes", "deploy,read"]);
      expect(cmd.type).toBe(CommandType.apiKeyAdd);
      expect(cmd.name).toBe("ci-deploy");
      expect(cmd.scopes).toEqual(["deploy", "read"]);
      expect(cmd.ttl).toBeUndefined();
    });

    it("'api-key add' with --ttl 7d sets ttl in milliseconds", () => {
      const cmd = parseArgs(["api-key", "add", "ci-deploy", "--scopes", "deploy", "--ttl", "7d"]);
      expect(cmd.type).toBe(CommandType.apiKeyAdd);
      expect(cmd.ttl).toBe(7 * MS.day);
    });

    it("'api-key add' with a single scope", () => {
      const cmd = parseArgs(["api-key", "add", "k", "--scopes", "deploy"]);
      expect(cmd.scopes).toEqual(["deploy"]);
    });

    it("'api-key add' trims whitespace around comma-separated scopes", () => {
      const cmd = parseArgs(["api-key", "add", "k", "--scopes", "deploy, read , keys"]);
      expect(cmd.scopes).toEqual(["deploy", "read", "keys"]);
    });

    it("'api-key list' defaults --format=table and --include-revoked=false", () => {
      const cmd = parseArgs(["api-key", "list"]);
      expect(cmd.type).toBe(CommandType.apiKeyList);
      expect(cmd.format).toBe("table");
      expect(cmd.includeRevoked).toBe(false);
    });

    it("'api-key ls' (alias) with --format json --include-revoked", () => {
      const cmd = parseArgs(["api-key", "ls", "--format", "json", "--include-revoked"]);
      expect(cmd.type).toBe(CommandType.apiKeyList);
      expect(cmd.format).toBe("json");
      expect(cmd.includeRevoked).toBe(true);
    });

    it("'api-key patch <id> --name NewName' sets only newName", () => {
      const cmd = parseArgs(["api-key", "patch", "uuid-abc", "--name", "NewName"]);
      expect(cmd.type).toBe(CommandType.apiKeyPatch);
      expect(cmd.id).toBe("uuid-abc");
      expect(cmd.newName).toBe("NewName");
      expect(cmd.scopes).toBeUndefined();
      expect(cmd.ttl).toBeUndefined();
    });

    it("'api-key patch' with --scopes only", () => {
      const cmd = parseArgs(["api-key", "patch", "uuid-abc", "--scopes", "read,apps"]);
      expect(cmd.type).toBe(CommandType.apiKeyPatch);
      expect(cmd.id).toBe("uuid-abc");
      expect(cmd.scopes).toEqual(["read", "apps"]);
      expect(cmd.newName).toBeUndefined();
      expect(cmd.ttl).toBeUndefined();
    });

    it("'api-key patch' with --ttl only", () => {
      const cmd = parseArgs(["api-key", "patch", "uuid-abc", "--ttl", "30d"]);
      expect(cmd.type).toBe(CommandType.apiKeyPatch);
      expect(cmd.ttl).toBe(30 * MS.day);
    });

    it("'api-key patch' with all three fields", () => {
      const cmd = parseArgs(["api-key", "patch", "uuid-abc", "--name", "renamed", "--scopes", "deploy", "--ttl", "1y"]);
      expect(cmd.id).toBe("uuid-abc");
      expect(cmd.newName).toBe("renamed");
      expect(cmd.scopes).toEqual(["deploy"]);
      expect(cmd.ttl).toBe(365 * MS.day);
    });

    it("'api-key remove <id>'", () => {
      const cmd = parseArgs(["api-key", "remove", "uuid-xyz"]);
      expect(cmd.type).toBe(CommandType.apiKeyRemove);
      expect(cmd.id).toBe("uuid-xyz");
    });

    it("'api-key rm' (alias)", () => {
      const cmd = parseArgs(["api-key", "rm", "uuid-xyz"]);
      expect(cmd.type).toBe(CommandType.apiKeyRemove);
      expect(cmd.id).toBe("uuid-xyz");
    });
  });

  describe("app", () => {
    it("'app add <appName>'", () => {
      const cmd = parseArgs(["app", "add", "MyApp"]);
      expect(cmd.type).toBe(CommandType.appAdd);
      expect(cmd.appName).toBe("MyApp");
    });

    it("'app list' defaults to table", () => {
      const cmd = parseArgs(["app", "list"]);
      expect(cmd.type).toBe(CommandType.appList);
      expect(cmd.format).toBe("table");
    });

    it("'app list --format json'", () => {
      const cmd = parseArgs(["app", "list", "--format", "json"]);
      expect(cmd.type).toBe(CommandType.appList);
      expect(cmd.format).toBe("json");
    });

    it("'app ls' (alias)", () => {
      const cmd = parseArgs(["app", "ls"]);
      expect(cmd.type).toBe(CommandType.appList);
      expect(cmd.format).toBe("table");
    });

    it("'app remove <appName>'", () => {
      const cmd = parseArgs(["app", "remove", "MyApp"]);
      expect(cmd.type).toBe(CommandType.appRemove);
      expect(cmd.appName).toBe("MyApp");
    });

    it("'app rm' (alias)", () => {
      const cmd = parseArgs(["app", "rm", "OtherApp"]);
      expect(cmd.type).toBe(CommandType.appRemove);
      expect(cmd.appName).toBe("OtherApp");
    });

    it("'app rename <current> <new>'", () => {
      const cmd = parseArgs(["app", "rename", "OldName", "NewName"]);
      expect(cmd.type).toBe(CommandType.appRename);
      expect(cmd.currentAppName).toBe("OldName");
      expect(cmd.newAppName).toBe("NewName");
    });

    it("'app transfer <appName> <email>'", () => {
      const cmd = parseArgs(["app", "transfer", "MyApp", "new-owner@example.com"]);
      expect(cmd.type).toBe(CommandType.appTransfer);
      expect(cmd.appName).toBe("MyApp");
      expect(cmd.email).toBe("new-owner@example.com");
    });
  });

  describe("collaborator", () => {
    it("'collaborator add <appName> <email>'", () => {
      const cmd = parseArgs(["collaborator", "add", "MyApp", "alice@example.com"]);
      expect(cmd.type).toBe(CommandType.collaboratorAdd);
      expect(cmd.appName).toBe("MyApp");
      expect(cmd.email).toBe("alice@example.com");
    });

    it("'collaborator list <appName>' defaults --format to table", () => {
      const cmd = parseArgs(["collaborator", "list", "MyApp"]);
      expect(cmd.type).toBe(CommandType.collaboratorList);
      expect(cmd.appName).toBe("MyApp");
      expect(cmd.format).toBe("table");
    });

    it("'collaborator ls' (alias) accepts --format json", () => {
      const cmd = parseArgs(["collaborator", "ls", "MyApp", "--format", "json"]);
      expect(cmd.type).toBe(CommandType.collaboratorList);
      expect(cmd.format).toBe("json");
    });

    it("'collaborator remove <appName> <email>'", () => {
      const cmd = parseArgs(["collaborator", "remove", "MyApp", "bob@example.com"]);
      expect(cmd.type).toBe(CommandType.collaboratorRemove);
      expect(cmd.appName).toBe("MyApp");
      expect(cmd.email).toBe("bob@example.com");
    });

    it("'collaborator rm' (alias)", () => {
      const cmd = parseArgs(["collaborator", "rm", "MyApp", "carol@example.com"]);
      expect(cmd.type).toBe(CommandType.collaboratorRemove);
      expect(cmd.appName).toBe("MyApp");
      expect(cmd.email).toBe("carol@example.com");
    });
  });

  describe("debug", () => {
    it("'debug android'", () => {
      const cmd = parseArgs(["debug", "android"]);
      expect(cmd.type).toBe(CommandType.debug);
      expect(cmd.platform).toBe("android");
    });

    it("'debug ios'", () => {
      const cmd = parseArgs(["debug", "ios"]);
      expect(cmd.type).toBe(CommandType.debug);
      expect(cmd.platform).toBe("ios");
    });
  });

  describe("deployment", () => {
    it("'deployment add <appName> <deploymentName>'", () => {
      const cmd = parseArgs(["deployment", "add", "MyApp", "Prod"]);
      expect(cmd.type).toBe(CommandType.deploymentAdd);
      expect(cmd.appName).toBe("MyApp");
      expect(cmd.deploymentName).toBe("Prod");
      expect(cmd.key).toBeUndefined();
    });

    it("'deployment add' carries the --key option through", () => {
      const cmd = parseArgs(["deployment", "add", "MyApp", "Prod", "--key", "predefined-key-123"]);
      expect(cmd.type).toBe(CommandType.deploymentAdd);
      expect(cmd.key).toBe("predefined-key-123");
    });

    it("'deployment add' carries -k (alias for --key)", () => {
      const cmd = parseArgs(["deployment", "add", "MyApp", "Prod", "-k", "short-alias-key"]);
      expect(cmd.type).toBe(CommandType.deploymentAdd);
      expect(cmd.key).toBe("short-alias-key");
    });

    it("'deployment clear <appName> <deploymentName>'", () => {
      const cmd = parseArgs(["deployment", "clear", "MyApp", "Prod"]);
      expect(cmd.type).toBe(CommandType.deploymentHistoryClear);
      expect(cmd.appName).toBe("MyApp");
      expect(cmd.deploymentName).toBe("Prod");
    });

    it("'deployment list <appName>' defaults format=table, displayKeys=false", () => {
      const cmd = parseArgs(["deployment", "list", "MyApp"]);
      expect(cmd.type).toBe(CommandType.deploymentList);
      expect(cmd.appName).toBe("MyApp");
      expect(cmd.format).toBe("table");
      expect(cmd.displayKeys).toBe(false);
    });

    it("'deployment list' accepts --displayKeys / -k", () => {
      const cmd = parseArgs(["deployment", "list", "MyApp", "--displayKeys"]);
      expect(cmd.type).toBe(CommandType.deploymentList);
      expect(cmd.displayKeys).toBe(true);
    });

    it("'deployment ls' (alias)", () => {
      const cmd = parseArgs(["deployment", "ls", "MyApp"]);
      expect(cmd.type).toBe(CommandType.deploymentList);
    });

    it("'deployment remove <app> <deployment>'", () => {
      const cmd = parseArgs(["deployment", "remove", "MyApp", "Prod"]);
      expect(cmd.type).toBe(CommandType.deploymentRemove);
      expect(cmd.appName).toBe("MyApp");
      expect(cmd.deploymentName).toBe("Prod");
    });

    it("'deployment rm' (alias)", () => {
      const cmd = parseArgs(["deployment", "rm", "MyApp", "Prod"]);
      expect(cmd.type).toBe(CommandType.deploymentRemove);
    });

    it("'deployment rename <app> <current> <new>'", () => {
      const cmd = parseArgs(["deployment", "rename", "MyApp", "Old", "New"]);
      expect(cmd.type).toBe(CommandType.deploymentRename);
      expect(cmd.appName).toBe("MyApp");
      expect(cmd.currentDeploymentName).toBe("Old");
      expect(cmd.newDeploymentName).toBe("New");
    });

    it("'deployment history <app> <deployment>' defaults format=table, displayAuthor=false", () => {
      const cmd = parseArgs(["deployment", "history", "MyApp", "Prod"]);
      expect(cmd.type).toBe(CommandType.deploymentHistory);
      expect(cmd.appName).toBe("MyApp");
      expect(cmd.deploymentName).toBe("Prod");
      expect(cmd.format).toBe("table");
      expect(cmd.displayAuthor).toBe(false);
    });

    it("'deployment h' (alias) maps to deploymentHistory", () => {
      const cmd = parseArgs(["deployment", "h", "MyApp", "Prod"]);
      expect(cmd.type).toBe(CommandType.deploymentHistory);
    });

    it("'deployment history' accepts --displayAuthor / -a", () => {
      const cmd = parseArgs(["deployment", "history", "MyApp", "Prod", "--displayAuthor"]);
      expect(cmd.displayAuthor).toBe(true);
    });
  });

  describe("login / logout", () => {
    it("bare 'login' sets serverUrl=null and accessKey=null", () => {
      const cmd = parseArgs(["login"]);
      expect(cmd.type).toBe(CommandType.login);
      expect(cmd.serverUrl).toBe(null);
      expect(cmd.accessKey).toBe(null);
    });

    it("'login --accessKey <key>' carries the key through", () => {
      const cmd = parseArgs(["login", "--accessKey", "raw-ak"]);
      expect(cmd.type).toBe(CommandType.login);
      expect(cmd.accessKey).toBe("raw-ak");
    });

    it("'login --key' is an alias for --accessKey", () => {
      const cmd = parseArgs(["login", "--key", "raw-ak-via-alias"]);
      expect(cmd.type).toBe(CommandType.login);
      expect(cmd.accessKey).toBe("raw-ak-via-alias");
    });

    it("'login --serverUrl <url>' normalises the URL", () => {
      const cmd = parseArgs(["login", "--serverUrl", "https://staging.example.com"]);
      expect(cmd.serverUrl).toBe("https://staging.example.com");
    });

    it("'logout' returns the logout command", () => {
      const cmd = parseArgs(["logout"]);
      expect(cmd.type).toBe(CommandType.logout);
    });
  });

  describe("patch", () => {
    it("'patch <app> <deployment>' with no options leaves everything null", () => {
      const cmd = parseArgs(["patch", "MyApp", "Production"]);
      expect(cmd.type).toBe(CommandType.patch);
      expect(cmd.appName).toBe("MyApp");
      expect(cmd.deploymentName).toBe("Production");
      expect(cmd.label).toBe(null);
      expect(cmd.description).toBe(null);
      expect(cmd.disabled).toBe(null);
      expect(cmd.mandatory).toBe(null);
      expect(cmd.rollout).toBe(null);
      expect(cmd.appStoreVersion).toBe(null);
    });

    it("'patch' with full option set", () => {
      const cmd = parseArgs([
        "patch",
        "MyApp",
        "Production",
        "-l",
        "v3",
        "--des",
        "Bumped rollout",
        "-x",
        "--mandatory",
        "-r",
        "50%",
        "-t",
        "~1.2.0",
      ]);
      expect(cmd.type).toBe(CommandType.patch);
      expect(cmd.label).toBe("v3");
      expect(cmd.description).toBe("Bumped rollout");
      expect(cmd.disabled).toBe(true);
      expect(cmd.mandatory).toBe(true);
      expect(cmd.rollout).toBe(50);
      expect(cmd.appStoreVersion).toBe("~1.2.0");
    });

    it("'patch --rollout 1%' parses to integer 1 (regex lower bound)", () => {
      const cmd = parseArgs(["patch", "MyApp", "Prod", "--rollout", "1%"]);
      expect(cmd.rollout).toBe(1);
    });

    it("'patch --rollout 100' (no percent sign) parses to 100", () => {
      const cmd = parseArgs(["patch", "MyApp", "Prod", "--rollout", "100"]);
      expect(cmd.rollout).toBe(100);
    });

    it("'patch' processes backslash escape sequences in --description", () => {
      const cmd = parseArgs(["patch", "MyApp", "Prod", "--des", "line1\\nline2"]);
      expect(cmd.description).toBe("line1\nline2");
    });

    it("'patch --rollout 200%' fails validation and returns undefined", () => {
      const cmd = parseArgs(["patch", "MyApp", "Prod", "--rollout", "200%"]);
      expect(cmd).toBeUndefined();
    });

    it("'patch --rollout 0%' fails validation (regex requires 1-100)", () => {
      const cmd = parseArgs(["patch", "MyApp", "Prod", "--rollout", "0%"]);
      expect(cmd).toBeUndefined();
    });
  });

  describe("promote", () => {
    it("'promote <app> <src> <dest>' with default rollout=100", () => {
      const cmd = parseArgs(["promote", "MyApp", "Staging", "Production"]);
      expect(cmd.type).toBe(CommandType.promote);
      expect(cmd.appName).toBe("MyApp");
      expect(cmd.sourceDeploymentName).toBe("Staging");
      expect(cmd.destDeploymentName).toBe("Production");
      expect(cmd.rollout).toBe(100);
      expect(cmd.noDuplicateReleaseError).toBe(false);
    });

    it("'promote' with all option flags", () => {
      const cmd = parseArgs([
        "promote",
        "MyApp",
        "Staging",
        "Production",
        "--des",
        "Promotion notes",
        "-l",
        "v5",
        "-x",
        "-m",
        "--noDuplicateReleaseError",
        "-r",
        "25%",
        "-t",
        ">=1.0.0",
      ]);
      expect(cmd.description).toBe("Promotion notes");
      expect(cmd.label).toBe("v5");
      expect(cmd.disabled).toBe(true);
      expect(cmd.mandatory).toBe(true);
      expect(cmd.noDuplicateReleaseError).toBe(true);
      expect(cmd.rollout).toBe(25);
      expect(cmd.appStoreVersion).toBe(">=1.0.0");
    });
  });

  describe("register", () => {
    it("bare 'register' has serverUrl=null", () => {
      const cmd = parseArgs(["register"]);
      expect(cmd.type).toBe(CommandType.register);
      expect(cmd.serverUrl).toBe(null);
    });

    it("'register --serverUrl <url>' carries it through", () => {
      const cmd = parseArgs(["register", "--serverUrl", "https://api-staging.aetherpush.com"]);
      expect(cmd.type).toBe(CommandType.register);
      expect(cmd.serverUrl).toBe("https://api-staging.aetherpush.com");
    });
  });

  describe("release", () => {
    it("'release <app> <pkg> <version>' defaults --deploymentName to Staging", () => {
      const cmd = parseArgs(["release", "MyApp", "./bundle.js", "1.0.0"]);
      expect(cmd.type).toBe(CommandType.release);
      expect(cmd.appName).toBe("MyApp");
      expect(cmd.package).toBe("./bundle.js");
      expect(cmd.appStoreVersion).toBe("1.0.0");
      expect(cmd.deploymentName).toBe("Staging");
      expect(cmd.disabled).toBe(false);
      expect(cmd.mandatory).toBe(false);
      expect(cmd.noDuplicateReleaseError).toBe(false);
      expect(cmd.rollout).toBe(100);
      expect(cmd.description).toBe("");
    });

    it("'release' with -d Production overrides the deployment", () => {
      const cmd = parseArgs(["release", "MyApp", "./bundle.js", "1.0.0", "-d", "Production"]);
      expect(cmd.deploymentName).toBe("Production");
    });

    it("'release' with --rollout 20 and full flags", () => {
      const cmd = parseArgs([
        "release",
        "MyApp",
        "./www",
        "1.0.3",
        "-d",
        "Production",
        "--des",
        "v3 hotfix",
        "-x",
        "-m",
        "--noDuplicateReleaseError",
        "-r",
        "20",
      ]);
      expect(cmd.description).toBe("v3 hotfix");
      expect(cmd.disabled).toBe(true);
      expect(cmd.mandatory).toBe(true);
      expect(cmd.noDuplicateReleaseError).toBe(true);
      expect(cmd.rollout).toBe(20);
    });
  });

  describe("release-react", () => {
    it("'release-react <app> <platform>' uses sensible defaults", () => {
      const cmd = parseArgs(["release-react", "MyApp", "ios"]);
      expect(cmd.type).toBe(CommandType.releaseReact);
      expect(cmd.appName).toBe("MyApp");
      expect(cmd.platform).toBe("ios");
      expect(cmd.deploymentName).toBe("Staging");
      expect(cmd.development).toBe(false);
      expect(cmd.disabled).toBe(false);
      expect(cmd.mandatory).toBe(false);
      expect(cmd.useHermes).toBe(false);
      expect(cmd.rollout).toBe(100);
      expect(cmd.description).toBe("");
      expect(cmd.bundleName).toBe(null);
      expect(cmd.entryFile).toBe(null);
      expect(cmd.gradleFile).toBe(null);
      expect(cmd.plistFile).toBe(null);
      expect(cmd.plistFilePrefix).toBe(null);
      expect(cmd.sourcemapOutput).toBe(null);
      expect(cmd.outputDir).toBe(null);
      expect(cmd.podFile).toBe(null);
      expect(cmd.privateKeyPath).toBe(null);
      expect(cmd.xcodeProjectFile).toBe(null);
    });

    it("'release-react android --useHermes' sets useHermes=true", () => {
      const cmd = parseArgs(["release-react", "MyApp", "android", "--useHermes"]);
      expect(cmd.useHermes).toBe(true);
      expect(cmd.platform).toBe("android");
    });

    it("'release-react' threads many options through correctly", () => {
      const cmd = parseArgs([
        "release-react",
        "MyApp",
        "ios",
        "-d",
        "Production",
        "-b",
        "custom.jsbundle",
        "-e",
        "src/index.tsx",
        "-t",
        ">=2.0.0",
        "-s",
        "build/main.map",
        "-o",
        "build/",
        "-p",
        "ios/Info.plist",
        "--plistFilePrefix",
        "Dev",
        "--pod",
        "ios/Podfile",
        "-k",
        "keys/private.pem",
        "--xcodeProjectFile",
        "ios/MyApp.xcodeproj",
        "--xcodeTargetName",
        "MyAppTarget",
        "-c",
        "Release",
        "-r",
        "50%",
        "-m",
        "-x",
        "--dev",
      ]);
      expect(cmd.deploymentName).toBe("Production");
      expect(cmd.bundleName).toBe("custom.jsbundle");
      expect(cmd.entryFile).toBe("src/index.tsx");
      expect(cmd.appStoreVersion).toBe(">=2.0.0");
      expect(cmd.sourcemapOutput).toBe("build/main.map");
      expect(cmd.outputDir).toBe("build/");
      expect(cmd.plistFile).toBe("ios/Info.plist");
      expect(cmd.plistFilePrefix).toBe("Dev");
      expect(cmd.podFile).toBe("ios/Podfile");
      expect(cmd.privateKeyPath).toBe("keys/private.pem");
      expect(cmd.xcodeProjectFile).toBe("ios/MyApp.xcodeproj");
      expect(cmd.xcodeTargetName).toBe("MyAppTarget");
      expect(cmd.buildConfigurationName).toBe("Release");
      expect(cmd.rollout).toBe(50);
      expect(cmd.mandatory).toBe(true);
      expect(cmd.disabled).toBe(true);
      expect(cmd.development).toBe(true);
    });

    it("'release-react' accepts --extraHermesFlags as an array", () => {
      const cmd = parseArgs(["release-react", "MyApp", "android", "--extraHermesFlags=-O", "--extraHermesFlags=-emit-binary"]);
      expect(Array.isArray(cmd.extraHermesFlags)).toBe(true);
      expect(cmd.extraHermesFlags).toEqual(["-O", "-emit-binary"]);
    });
  });

  describe("rollback", () => {
    it("'rollback <app> <deployment>' without --targetRelease", () => {
      const cmd = parseArgs(["rollback", "MyApp", "Production"]);
      expect(cmd.type).toBe(CommandType.rollback);
      expect(cmd.appName).toBe("MyApp");
      expect(cmd.deploymentName).toBe("Production");
      expect(cmd.targetRelease).toBe(null);
    });

    it("'rollback --targetRelease v4'", () => {
      const cmd = parseArgs(["rollback", "MyApp", "Production", "--targetRelease", "v4"]);
      expect(cmd.targetRelease).toBe("v4");
    });

    it("'rollback -r v4' (alias)", () => {
      const cmd = parseArgs(["rollback", "MyApp", "Production", "-r", "v4"]);
      expect(cmd.targetRelease).toBe("v4");
    });
  });

  describe("session", () => {
    it("'session list' defaults --format to table", () => {
      const cmd = parseArgs(["session", "list"]);
      expect(cmd.type).toBe(CommandType.sessionList);
      expect(cmd.format).toBe("table");
    });

    it("'session ls' (alias) accepts --format json", () => {
      const cmd = parseArgs(["session", "ls", "--format", "json"]);
      expect(cmd.type).toBe(CommandType.sessionList);
      expect(cmd.format).toBe("json");
    });

    it("'session remove <machine>'", () => {
      const cmd = parseArgs(["session", "remove", "John's PC"]);
      expect(cmd.type).toBe(CommandType.sessionRemove);
      expect(cmd.machineName).toBe("John's PC");
    });

    it("'session rm' (alias)", () => {
      const cmd = parseArgs(["session", "rm", "Laptop"]);
      expect(cmd.type).toBe(CommandType.sessionRemove);
      expect(cmd.machineName).toBe("Laptop");
    });
  });

  describe("whoami", () => {
    it("'whoami' returns the whoami command", () => {
      const cmd = parseArgs(["whoami"]);
      expect(cmd.type).toBe(CommandType.whoami);
    });
  });

  describe("getServerUrl (via login --serverUrl)", () => {
    it("strips a single trailing slash", () => {
      const cmd = parseArgs(["login", "--serverUrl", "https://api.aetherpush.com/"]);
      expect(cmd.serverUrl).toBe("https://api.aetherpush.com");
    });

    it("trims surrounding whitespace", () => {
      const cmd = parseArgs(["login", "--serverUrl", "  https://api.aetherpush.com  "]);
      expect(cmd.serverUrl).toBe("https://api.aetherpush.com");
    });

    it("repairs a Windows Git Bash 'http:\\' into 'http://'", () => {
      const cmd = parseArgs(["login", "--serverUrl", "http:\\example.com"]);
      expect(cmd.serverUrl).toBe("http://example.com");
    });

    it("repairs 'https:\\' too (https branch of the regex)", () => {
      const cmd = parseArgs(["login", "--serverUrl", "https:\\example.com"]);
      expect(cmd.serverUrl).toBe("https://example.com");
    });
  });

  describe("edge cases", () => {
    it("'release' without --deploymentName falls back to default Staging (check passes)", () => {
      const cmd = parseArgs(["release", "MyApp", "./bundle.js", "1.0.0"]);
      expect(cmd).toBeDefined();
      expect(cmd.deploymentName).toBe("Staging");
    });

    it("'release --rollout abc' fails the isValidRollout check", () => {
      const cmd = parseArgs(["release", "MyApp", "./bundle.js", "1.0.0", "-r", "abc"]);
      expect(cmd).toBeUndefined();
    });

    it("'access-key add' with no name produces no command", () => {
      const cmd = parseArgs(["access-key", "add"]);
      expect(cmd).toBeUndefined();
    });

    it("'api-key add' without --scopes produces no command", () => {
      const cmd = parseArgs(["api-key", "add", "ci-deploy"]);
      expect(cmd).toBeUndefined();
    });

    it("'api-key patch' without id produces no command", () => {
      const cmd = parseArgs(["api-key", "patch", "--name", "x"]);
      expect(cmd).toBeUndefined();
    });

    it("'api-key remove' without id produces no command", () => {
      const cmd = parseArgs(["api-key", "remove"]);
      expect(cmd).toBeUndefined();
    });

    it("'app rename' with only one argument fails", () => {
      const cmd = parseArgs(["app", "rename", "OnlyOne"]);
      expect(cmd).toBeUndefined();
    });

    it("unknown top-level command produces no command", () => {
      const cmd = parseArgs(["totally-unknown-command"]);
      expect(cmd).toBeUndefined();
    });
  });
});
