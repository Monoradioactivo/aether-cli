// Copyright (c) Aether. All rights reserved.

jest.mock("child_process");

import * as crypto from "crypto";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as childProcess from "child_process";

import * as rnUtils from "../script/react-native-utils";

const mockedSpawn = childProcess.spawn as jest.MockedFunction<typeof childProcess.spawn>;
const mockedSpawnSync = childProcess.spawnSync as jest.MockedFunction<typeof childProcess.spawnSync>;

function randomDirName(): string {
  return "aether-rn-utils-test-" + crypto.randomBytes(6).toString("hex");
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function createFakeChildProcess(): any {
  const proc: any = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
}

function withCwd<T>(dir: string, fn: () => T): T {
  const originalCwd = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(originalCwd);
  }
}

function hermesOsBin(): string {
  switch (process.platform) {
    case "win32":
      return "win64-bin";
    case "darwin":
      return "osx-bin";
    default:
      return "linux64-bin";
  }
}

function hermesOsExe(rnVersion: string): string {
  const major = parseInt(rnVersion.split(".")[0], 10);
  const minor = parseInt(rnVersion.split(".")[1], 10);
  const useHermesc = major > 0 || minor >= 63;
  const name = useHermesc ? "hermesc" : "hermes";
  return process.platform === "win32" ? `${name}.exe` : name;
}

describe("react-native-utils", () => {
  let sandbox: string;
  let logSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;

  beforeAll(() => {
    sandbox = path.join(os.tmpdir(), randomDirName());
    fs.mkdirSync(sandbox, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  beforeEach(() => {
    logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    errSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    mockedSpawn.mockReset();
    mockedSpawnSync.mockReset();
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  describe("isValidVersion", () => {
    it("accepts full semver versions", () => {
      expect(rnUtils.isValidVersion("1.0.0")).toBe(true);
      expect(rnUtils.isValidVersion("12.34.56")).toBe(true);
    });

    it("accepts semver versions with prerelease tags", () => {
      expect(rnUtils.isValidVersion("1.0.0-alpha")).toBe(true);
      expect(rnUtils.isValidVersion("2.3.4-rc.1")).toBe(true);
    });

    it("accepts major.minor versions via the relaxed regex", () => {
      expect(rnUtils.isValidVersion("1.0")).toBe(true);
      expect(rnUtils.isValidVersion("12.34")).toBe(true);
    });

    it("rejects bare major versions", () => {
      expect(rnUtils.isValidVersion("1")).toBe(false);
    });

    it("rejects four-part version strings", () => {
      expect(rnUtils.isValidVersion("1.2.3.4")).toBe(false);
    });

    it("rejects non-numeric inputs", () => {
      expect(rnUtils.isValidVersion("abc")).toBe(false);
      expect(rnUtils.isValidVersion("")).toBe(false);
    });
  });

  describe("directoryExistsSync", () => {
    it("returns true for an existing directory", () => {
      const dir = path.join(sandbox, "dir-exists");
      fs.mkdirSync(dir);
      expect(rnUtils.directoryExistsSync(dir)).toBe(true);
    });

    it("returns false for a regular file", () => {
      const file = path.join(sandbox, "regular-file.txt");
      fs.writeFileSync(file, "x");
      expect(rnUtils.directoryExistsSync(file)).toBe(false);
    });

    it("returns false (without throwing) for a missing path", () => {
      expect(rnUtils.directoryExistsSync(path.join(sandbox, "does-not-exist"))).toBe(false);
    });
  });

  describe("getReactNativeVersion", () => {
    it("returns the version from dependencies", () => {
      const dir = path.join(sandbox, "rn-deps");
      writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "my-app", dependencies: { "react-native": "0.70.0" } }));

      withCwd(dir, () => {
        expect(rnUtils.getReactNativeVersion()).toBe("0.70.0");
      });
    });

    it("returns the version from devDependencies when not in dependencies", () => {
      const dir = path.join(sandbox, "rn-devdeps");
      writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "my-app", devDependencies: { "react-native": "0.69.5" } }));

      withCwd(dir, () => {
        expect(rnUtils.getReactNativeVersion()).toBe("0.69.5");
      });
    });

    it("throws when package.json is missing in the cwd", () => {
      const dir = path.join(sandbox, "rn-nopkg");
      fs.mkdirSync(dir);

      withCwd(dir, () => {
        expect(() => rnUtils.getReactNativeVersion()).toThrow(/Unable to find or read "package.json"/);
      });
    });

    it("throws when package.json has no name field", () => {
      const dir = path.join(sandbox, "rn-noname");
      writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: { "react-native": "0.70.0" } }));

      withCwd(dir, () => {
        expect(() => rnUtils.getReactNativeVersion()).toThrow(/"name" field/);
      });
    });

    it("throws when package.json is malformed JSON", () => {
      const dir = path.join(sandbox, "rn-bad-json");
      writeFile(path.join(dir, "package.json"), "{not valid json");

      withCwd(dir, () => {
        expect(() => rnUtils.getReactNativeVersion()).toThrow(/Unable to find or read/);
      });
    });
  });

  describe("getiOSHermesEnabled", () => {
    it("returns true when Podfile contains `:hermes_enabled => true`", () => {
      const podPath = path.join(sandbox, "pod-1", "Podfile");
      writeFile(podPath, "use_react_native!(\n  :hermes_enabled => true\n)\n");
      expect(rnUtils.getiOSHermesEnabled(podPath)).toBe(true);
    });

    it("returns true when Podfile contains `hermes_enabled: true`", () => {
      const podPath = path.join(sandbox, "pod-2", "Podfile");
      writeFile(podPath, "use_react_native!(hermes_enabled: true)\n");
      expect(rnUtils.getiOSHermesEnabled(podPath)).toBe(true);
    });

    it("returns false when hermes_enabled is missing", () => {
      const podPath = path.join(sandbox, "pod-3", "Podfile");
      writeFile(podPath, "use_react_native!()\n");
      expect(rnUtils.getiOSHermesEnabled(podPath)).toBe(false);
    });

    it("ignores commented-out hermes_enabled lines", () => {
      const podPath = path.join(sandbox, "pod-4", "Podfile");
      writeFile(podPath, "# :hermes_enabled => true\n");
      expect(rnUtils.getiOSHermesEnabled(podPath)).toBe(false);
    });

    it("throws when the Podfile does not exist", () => {
      expect(() => rnUtils.getiOSHermesEnabled(path.join(sandbox, "missing-podfile"))).toThrow(/Unable to find Podfile/);
    });
  });

  describe("getAndroidHermesEnabled", () => {
    it("returns true when enableHermes is set to true in project.ext.react", async () => {
      const gradlePath = path.join(sandbox, "gradle-hermes-on", "build.gradle");
      writeFile(gradlePath, `project.ext.react = [\n  enableHermes: true\n]\n`);
      await expect(rnUtils.getAndroidHermesEnabled(gradlePath)).resolves.toBe(true);
    });

    it("returns false when enableHermes is set to false", async () => {
      const gradlePath = path.join(sandbox, "gradle-hermes-off", "build.gradle");
      writeFile(gradlePath, `project.ext.react = [\n  enableHermes: false\n]\n`);
      await expect(rnUtils.getAndroidHermesEnabled(gradlePath)).resolves.toBe(false);
    });

    it("rejects when the gradle file does not exist", async () => {
      await expect(rnUtils.getAndroidHermesEnabled(path.join(sandbox, "no-gradle-here", "build.gradle"))).rejects.toThrow(
        /Unable to find gradle file/
      );
    });
  });

  describe("runHermesEmitBinaryCommand", () => {
    function buildProjectFixture(rnVersion: string): { projectDir: string; gradleFile: string; outputFolder: string } {
      const projectDir = path.join(sandbox, "proj-" + crypto.randomBytes(4).toString("hex"));

      writeFile(
        path.join(projectDir, "package.json"),
        JSON.stringify({ name: "test-app", dependencies: { "react-native": rnVersion } })
      );

      writeFile(
        path.join(projectDir, "node_modules", "react-native", "package.json"),
        JSON.stringify({ name: "react-native", version: rnVersion })
      );

      writeFile(
        path.join(projectDir, "node_modules", "react-native", "sdks", "hermesc", hermesOsBin(), hermesOsExe(rnVersion)),
        "fake-hermes-bin"
      );

      writeFile(
        path.join(projectDir, "node_modules", "react-native", "scripts", "compose-source-maps.js"),
        "// fake compose-source-maps script"
      );

      const gradleFile = path.join(projectDir, "android", "app", "build.gradle");
      writeFile(gradleFile, "android { }\n");

      const outputFolder = path.join(projectDir, "out");
      fs.mkdirSync(outputFolder, { recursive: true });

      return { projectDir, gradleFile, outputFolder };
    }

    function mockSpawnSyncToReactNative(projectDir: string): void {
      mockedSpawnSync.mockReturnValue({
        status: 0,
        stdout: Buffer.from(path.join(projectDir, "node_modules", "react-native", "package.json")),
        stderr: Buffer.from(""),
        pid: 1234,
        output: [],
        signal: null,
      } as any);
    }

    it("resolves successfully on a happy hermes run without sourcemap", async () => {
      const { projectDir, gradleFile, outputFolder } = buildProjectFixture("0.70.0");
      mockSpawnSyncToReactNative(projectDir);

      const bundleName = "main.jsbundle";
      writeFile(path.join(outputFolder, bundleName), "original-bundle");
      writeFile(path.join(outputFolder, bundleName + ".hbc"), "compiled-bytecode");

      mockedSpawn.mockImplementationOnce(() => {
        const proc = createFakeChildProcess();
        setImmediate(() => proc.emit("close", 0, null));
        return proc;
      });

      await withCwd(projectDir, async () => {
        await expect(rnUtils.runHermesEmitBinaryCommand(bundleName, outputFolder, "", [], gradleFile)).resolves.toBeUndefined();
      });

      expect(fs.readFileSync(path.join(outputFolder, bundleName), "utf8")).toBe("compiled-bytecode");
      expect(fs.existsSync(path.join(outputFolder, bundleName + ".hbc"))).toBe(false);
    });

    it("rejects when hermes exits with a non-zero code", async () => {
      const { projectDir, gradleFile, outputFolder } = buildProjectFixture("0.70.0");
      mockSpawnSyncToReactNative(projectDir);

      const bundleName = "main.jsbundle";
      writeFile(path.join(outputFolder, bundleName), "original-bundle");

      mockedSpawn.mockImplementationOnce(() => {
        const proc = createFakeChildProcess();
        setImmediate(() => proc.emit("close", 1, null));
        return proc;
      });

      await withCwd(projectDir, async () => {
        await expect(rnUtils.runHermesEmitBinaryCommand(bundleName, outputFolder, "", [], gradleFile)).rejects.toThrow(
          /"hermes" command failed.*exitCode=1/
        );
      });

      expect(fs.readFileSync(path.join(outputFolder, bundleName), "utf8")).toBe("original-bundle");
    });

    it("composes source maps when a sourcemap output path is provided", async () => {
      const { projectDir, gradleFile, outputFolder } = buildProjectFixture("0.70.0");
      mockSpawnSyncToReactNative(projectDir);

      const bundleName = "main.jsbundle";
      writeFile(path.join(outputFolder, bundleName), "original-bundle");
      writeFile(path.join(outputFolder, bundleName + ".hbc"), "compiled-bytecode");

      const sourcemapOutput = path.join(outputFolder, "main.jsbundle.map");
      writeFile(sourcemapOutput, '{"version":3,"mappings":""}');
      writeFile(path.join(outputFolder, bundleName + ".hbc.map"), '{"version":3,"mappings":""}');

      let spawnCallCount = 0;
      mockedSpawn.mockImplementation(() => {
        spawnCallCount += 1;
        const proc = createFakeChildProcess();
        setImmediate(() => proc.emit("close", 0, null));
        return proc;
      });

      await withCwd(projectDir, async () => {
        await expect(
          rnUtils.runHermesEmitBinaryCommand(bundleName, outputFolder, sourcemapOutput, [], gradleFile)
        ).resolves.toBeUndefined();
      });

      expect(spawnCallCount).toBe(2);
      expect(fs.existsSync(path.join(outputFolder, bundleName + ".hbc.map"))).toBe(false);
    });

    it("forwards CODE_PUSH_NODE_ARGS env var into the hermes argv", async () => {
      const { projectDir, gradleFile, outputFolder } = buildProjectFixture("0.70.0");
      mockSpawnSyncToReactNative(projectDir);

      const bundleName = "main.jsbundle";
      writeFile(path.join(outputFolder, bundleName), "original-bundle");
      writeFile(path.join(outputFolder, bundleName + ".hbc"), "compiled-bytecode");

      const originalEnv = process.env.CODE_PUSH_NODE_ARGS;
      process.env.CODE_PUSH_NODE_ARGS = "--max-old-space-size=4096   --no-warnings";

      try {
        mockedSpawn.mockImplementationOnce(() => {
          const proc = createFakeChildProcess();
          setImmediate(() => proc.emit("close", 0, null));
          return proc;
        });

        await withCwd(projectDir, async () => {
          await rnUtils.runHermesEmitBinaryCommand(bundleName, outputFolder, "", [], gradleFile);
        });

        const spawnArgs = mockedSpawn.mock.calls[0][1] as string[];
        expect(spawnArgs).toContain("--max-old-space-size=4096");
        expect(spawnArgs).toContain("--no-warnings");
        expect(spawnArgs).toContain("-emit-binary");
      } finally {
        if (originalEnv === undefined) {
          delete process.env.CODE_PUSH_NODE_ARGS;
        } else {
          process.env.CODE_PUSH_NODE_ARGS = originalEnv;
        }
      }
    });

    it("routes hermes progress to stderr and keeps stdout clean when json is true", async () => {
      const { projectDir, gradleFile, outputFolder } = buildProjectFixture("0.70.0");
      mockSpawnSyncToReactNative(projectDir);

      const bundleName = "main.jsbundle";
      writeFile(path.join(outputFolder, bundleName), "original-bundle");
      writeFile(path.join(outputFolder, bundleName + ".hbc"), "compiled-bytecode");

      mockedSpawn.mockImplementationOnce(() => {
        const proc = createFakeChildProcess();
        setImmediate(() => proc.emit("close", 0, null));
        return proc;
      });

      await withCwd(projectDir, async () => {
        await rnUtils.runHermesEmitBinaryCommand(bundleName, outputFolder, "", [], gradleFile, true);
      });

      const stdout = logSpy.mock.calls.map((c) => String(c[0]));
      const stderr = errSpy.mock.calls.map((c) => String(c[0]));
      expect(stdout.some((m) => m.includes("Converting JS bundle to byte code"))).toBe(false);
      expect(stderr.some((m) => m.includes("Converting JS bundle to byte code"))).toBe(true);
    });
  });
});
