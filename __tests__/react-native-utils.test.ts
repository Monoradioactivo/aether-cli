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
  let result: T;
  try {
    result = fn();
  } catch (err) {
    process.chdir(originalCwd);
    throw err;
  }
  if (result instanceof Promise) {
    return result.finally(() => process.chdir(originalCwd)) as unknown as T;
  }
  process.chdir(originalCwd);
  return result;
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
    sandbox = path.join(fs.realpathSync(os.tmpdir()), randomDirName());
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
    const HERMES_LOCK =
      "PODS:\n  - hermes-engine (0.81.4):\n    - hermes-engine/Pre-built (= 0.81.4)\n  - hermes-engine/Pre-built (0.81.4)\n  - React-hermes (0.81.4):\n    - hermes-engine\n\nDEPENDENCIES:\n  - hermes-engine (from `../node_modules/react-native/sdks/hermes-engine/hermes-engine.podspec`)\n\nSPEC CHECKSUMS:\n  hermes-engine: 0123456789abcdef\n";
    const THIRD_PARTY_JSC_LOCK =
      'PODS:\n  - React-jsc (0.2.0):\n    - React-jsi\n  - React-jsi (0.88.1)\n  - React-jsitooling (0.88.1)\n\nDEPENDENCIES:\n  - "React-jsc (from `../node_modules/@react-native-community/javascriptcore`)"\n';
    const PLAIN_LOCK = "PODS:\n  - React-jsi (0.81.4)\n  - React-jsitooling (0.81.4)\n  - RCT-Folly (2024.11.18.00)\n";

    function writePodProject(name: string, podfile: string, lock?: string): string {
      const podPath = path.join(sandbox, name, "ios", "Podfile");
      writeFile(podPath, podfile);
      if (lock !== undefined) {
        writeFile(path.join(sandbox, name, "ios", "Podfile.lock"), lock);
      }
      return podPath;
    }

    it("returns true when Podfile contains `:hermes_enabled => true`", () => {
      const podPath = writePodProject("pod-1", "use_react_native!(\n  :hermes_enabled => true\n)\n");
      expect(rnUtils.getiOSHermesEnabled(podPath).enabled).toBe(true);
    });

    it("returns true when Podfile contains `hermes_enabled: true`", () => {
      const podPath = writePodProject("pod-2", "use_react_native!(hermes_enabled: true)\n");
      expect(rnUtils.getiOSHermesEnabled(podPath).enabled).toBe(true);
    });

    it("returns false when hermes_enabled is missing and there is no Podfile.lock", () => {
      const podPath = writePodProject("pod-3", "use_react_native!()\n");
      const detection = rnUtils.getiOSHermesEnabled(podPath);
      expect(detection.enabled).toBe(false);
      expect(detection.reason).toMatch(/no Podfile\.lock next to/);
    });

    it("ignores commented-out hermes_enabled lines", () => {
      const podPath = writePodProject("pod-4", "# :hermes_enabled => true\n");
      expect(rnUtils.getiOSHermesEnabled(podPath).enabled).toBe(false);
    });

    it("throws when the Podfile does not exist", () => {
      expect(() => rnUtils.getiOSHermesEnabled(path.join(sandbox, "missing-podfile"))).toThrow(/Unable to find Podfile/);
    });

    it("returns true for the current template Podfile when Podfile.lock lists the hermes-engine pod", () => {
      const podPath = writePodProject("pod-lock-hermes", "use_react_native!(\n  :path => config[:reactNativePath]\n)\n", HERMES_LOCK);
      const detection = rnUtils.getiOSHermesEnabled(podPath);
      expect(detection.enabled).toBe(true);
      expect(detection.reason).toMatch(/Podfile\.lock lists the hermes-engine pod/);
    });

    it("returns false when Podfile.lock lists no hermes-engine pod", () => {
      const podPath = writePodProject("pod-lock-plain", "use_react_native!()\n", PLAIN_LOCK);
      const detection = rnUtils.getiOSHermesEnabled(podPath);
      expect(detection.enabled).toBe(false);
      expect(detection.reason).toMatch(/lists no hermes-engine pod/);
    });

    it("returns false when Podfile.lock lists the React-jsc pod", () => {
      const podPath = writePodProject("pod-lock-jsc", "use_react_native!()\n", THIRD_PARTY_JSC_LOCK);
      const detection = rnUtils.getiOSHermesEnabled(podPath);
      expect(detection.enabled).toBe(false);
      expect(detection.reason).toMatch(/lists the React-jsc pod/);
    });

    it("lets the React-jsc pod win over a hermes-engine pod in the same Podfile.lock", () => {
      const podPath = writePodProject("pod-lock-both", "use_react_native!()\n", HERMES_LOCK + THIRD_PARTY_JSC_LOCK);
      expect(rnUtils.getiOSHermesEnabled(podPath).enabled).toBe(false);
    });

    it("lets the React-jsc pod win over a hermes_enabled => true literal", () => {
      const podPath = writePodProject("pod-lock-jsc-literal", "use_react_native!(\n  :hermes_enabled => true\n)\n", THIRD_PARTY_JSC_LOCK);
      expect(rnUtils.getiOSHermesEnabled(podPath).enabled).toBe(false);
    });

    it("reads the quoted DEPENDENCIES form of the React-jsc pod", () => {
      const podPath = writePodProject(
        "pod-lock-jsc-quoted",
        "use_react_native!()\n",
        HERMES_LOCK + '  - "React-jsc (from `../node_modules/@react-native-community/javascriptcore`)"\n'
      );
      expect(rnUtils.getiOSHermesEnabled(podPath).enabled).toBe(false);
    });

    it("does not read React-jsi pods as React-jsc", () => {
      const podPath = writePodProject("pod-lock-jsi", "use_react_native!()\n", HERMES_LOCK + PLAIN_LOCK);
      expect(rnUtils.getiOSHermesEnabled(podPath).enabled).toBe(true);
    });

    it("does not read the SPEC CHECKSUMS entry as a hermes-engine pod", () => {
      const podPath = writePodProject("pod-lock-checksum", "use_react_native!()\n", "SPEC CHECKSUMS:\n  hermes-engine: 0123456789abcdef\n");
      expect(rnUtils.getiOSHermesEnabled(podPath).enabled).toBe(false);
    });

    it("reads the Podfile.lock next to a custom --podFile path", () => {
      const podPath = path.join(sandbox, "pod-custom", "native", "apple", "Podfile");
      writeFile(podPath, "use_react_native!()\n");
      writeFile(path.join(sandbox, "pod-custom", "native", "apple", "Podfile.lock"), HERMES_LOCK);
      writeFile(path.join(sandbox, "pod-custom", "ios", "Podfile.lock"), THIRD_PARTY_JSC_LOCK);
      expect(rnUtils.getiOSHermesEnabled(podPath).enabled).toBe(true);
    });
  });

  describe("getAndroidHermesEnabled", () => {
    function writeAndroidProject(
      name: string,
      files: { buildGradle?: string; rootProperties?: string; appProperties?: string }
    ): string {
      const gradlePath = path.join(sandbox, name, "android", "app", "build.gradle");
      writeFile(gradlePath, files.buildGradle ?? "android { }\n");
      if (files.rootProperties !== undefined) {
        writeFile(path.join(sandbox, name, "android", "gradle.properties"), files.rootProperties);
      }
      if (files.appProperties !== undefined) {
        writeFile(path.join(sandbox, name, "android", "app", "gradle.properties"), files.appProperties);
      }
      return gradlePath;
    }

    it("returns true when enableHermes is set to true in project.ext.react", async () => {
      const gradlePath = writeAndroidProject("gradle-hermes-on", { buildGradle: `project.ext.react = [\n  enableHermes: true\n]\n` });
      await expect(rnUtils.getAndroidHermesEnabled(gradlePath)).resolves.toMatchObject({ enabled: true });
    });

    it("returns false when enableHermes is set to false", async () => {
      const gradlePath = writeAndroidProject("gradle-hermes-off", { buildGradle: `project.ext.react = [\n  enableHermes: false\n]\n` });
      await expect(rnUtils.getAndroidHermesEnabled(gradlePath)).resolves.toMatchObject({ enabled: false });
    });

    it("rejects when the gradle file does not exist", async () => {
      await expect(rnUtils.getAndroidHermesEnabled(path.join(sandbox, "no-gradle-here", "build.gradle"))).rejects.toThrow(
        /Unable to find gradle file/
      );
    });

    it("returns true for the current template: hermesEnabled=true in android/gradle.properties", async () => {
      const gradlePath = writeAndroidProject("gradle-props-template", {
        rootProperties: "# Use this property to enable or disable the Hermes JS engine.\n# If set to false, you will be using JSC instead.\nhermesEnabled=true\n",
      });
      const detection = await rnUtils.getAndroidHermesEnabled(gradlePath);
      expect(detection.enabled).toBe(true);
      expect(detection.reason).toMatch(/hermesEnabled=true in .*gradle\.properties/);
    });

    it("accepts the android/app directory as --gradleFile", async () => {
      const gradlePath = writeAndroidProject("gradle-props-dir", { rootProperties: "hermesEnabled=true\n" });
      await expect(rnUtils.getAndroidHermesEnabled(path.dirname(gradlePath))).resolves.toMatchObject({ enabled: true });
    });

    it("returns false for hermesEnabled=false", async () => {
      const gradlePath = writeAndroidProject("gradle-props-off", { rootProperties: "hermesEnabled=false\n" });
      const detection = await rnUtils.getAndroidHermesEnabled(gradlePath);
      expect(detection.enabled).toBe(false);
      expect(detection.reason).toMatch(/hermesEnabled=false/);
    });

    it("reads the value case-insensitively and trimmed", async () => {
      const gradlePath = writeAndroidProject("gradle-props-case", { rootProperties: "hermesEnabled = False   \n" });
      await expect(rnUtils.getAndroidHermesEnabled(gradlePath)).resolves.toMatchObject({ enabled: false });
    });

    it("treats a value that is not a boolean as on, like the React Native Gradle plugin", async () => {
      const gradlePath = writeAndroidProject("gradle-props-empty", { rootProperties: "hermesEnabled=\n" });
      await expect(rnUtils.getAndroidHermesEnabled(gradlePath)).resolves.toMatchObject({ enabled: true });
    });

    it("lets android/app/gradle.properties override android/gradle.properties", async () => {
      const gradlePath = writeAndroidProject("gradle-props-app-wins", {
        rootProperties: "hermesEnabled=true\n",
        appProperties: "hermesEnabled=false\n",
      });
      await expect(rnUtils.getAndroidHermesEnabled(gradlePath)).resolves.toMatchObject({ enabled: false });
    });

    it("falls through to the root file when the app file does not define the key", async () => {
      const gradlePath = writeAndroidProject("gradle-props-root-only", {
        rootProperties: "hermesEnabled=true\n",
        appProperties: "android.useAndroidX=true\n",
      });
      const detection = await rnUtils.getAndroidHermesEnabled(gradlePath);
      expect(detection.enabled).toBe(true);
      expect(detection.reason).toMatch(/hermesEnabled=true in .*gradle-props-root-only[\\/]android[\\/]gradle\.properties\.$/);
    });

    it("reads react.hermesEnabled when hermesEnabled is absent", async () => {
      const gradlePath = writeAndroidProject("gradle-props-scoped", { rootProperties: "react.hermesEnabled=false\n" });
      const detection = await rnUtils.getAndroidHermesEnabled(gradlePath);
      expect(detection.enabled).toBe(false);
      expect(detection.reason).toMatch(/react\.hermesEnabled=false/);
    });

    it("prefers hermesEnabled over react.hermesEnabled", async () => {
      const gradlePath = writeAndroidProject("gradle-props-both", { rootProperties: "react.hermesEnabled=false\nhermesEnabled=true\n" });
      await expect(rnUtils.getAndroidHermesEnabled(gradlePath)).resolves.toMatchObject({ enabled: true });
    });

    it("lets the gradle.properties value win over a legacy project.ext.react marker", async () => {
      const gradlePath = writeAndroidProject("gradle-props-over-legacy", {
        buildGradle: `project.ext.react = [\n  enableHermes: true\n]\n`,
        rootProperties: "hermesEnabled=false\n",
      });
      await expect(rnUtils.getAndroidHermesEnabled(gradlePath)).resolves.toMatchObject({ enabled: false });
    });

    it("returns false for the third-party JSC setup, which pairs useThirdPartyJSC=true with hermesEnabled=false", async () => {
      const gradlePath = writeAndroidProject("gradle-props-jsc", { rootProperties: "hermesEnabled=false\nuseThirdPartyJSC=true\n" });
      await expect(rnUtils.getAndroidHermesEnabled(gradlePath)).resolves.toMatchObject({ enabled: false });
    });

    it("lets hermesEnabled=true win over useThirdPartyJSC=true, like the React Native Gradle plugin", async () => {
      const gradlePath = writeAndroidProject("gradle-props-jsc-and-hermes", { rootProperties: "hermesEnabled=true\nuseThirdPartyJSC=true\n" });
      await expect(rnUtils.getAndroidHermesEnabled(gradlePath)).resolves.toMatchObject({ enabled: true });
    });

    it("returns false when build.gradle scopes Hermes with enableHermesOnlyInVariants", async () => {
      const gradlePath = writeAndroidProject("gradle-variant-scoped", {
        buildGradle: 'react {\n    enableHermesOnlyInVariants = ["release"]\n}\n',
        rootProperties: "hermesEnabled=true\n",
      });
      const detection = await rnUtils.getAndroidHermesEnabled(gradlePath);
      expect(detection.enabled).toBe(false);
      expect(detection.reason).toMatch(/enableHermesOnlyInVariants/);
    });

    it("ignores a commented-out enableHermesOnlyInVariants", async () => {
      const gradlePath = writeAndroidProject("gradle-variant-commented", {
        buildGradle: 'react {\n    // enableHermesOnlyInVariants = ["release"]\n}\n',
        rootProperties: "hermesEnabled=true\n",
      });
      await expect(rnUtils.getAndroidHermesEnabled(gradlePath)).resolves.toMatchObject({ enabled: true });
    });

    it("reads a gradle.properties file that starts with a byte order mark", async () => {
      const gradlePath = writeAndroidProject("gradle-props-bom", { rootProperties: String.fromCharCode(0xfeff) + "hermesEnabled=true\n" });
      const detection = await rnUtils.getAndroidHermesEnabled(gradlePath);
      expect(detection.enabled).toBe(true);
      expect(detection.reason).toMatch(/hermesEnabled=true/);
    });

    it("returns false with a reason when neither marker is present", async () => {
      const gradlePath = writeAndroidProject("gradle-no-markers", { rootProperties: "android.useAndroidX=true\n" });
      const detection = await rnUtils.getAndroidHermesEnabled(gradlePath);
      expect(detection.enabled).toBe(false);
      expect(detection.reason).toMatch(/Hermes not detected/);
    });
  });

  describe("runHermesEmitBinaryCommand", () => {
    function buildProjectFixture(
      rnVersion: string,
      options: { includeBundledHermes?: boolean; includeHermesCompilerPackage?: boolean } = {}
    ): { projectDir: string; gradleFile: string; outputFolder: string } {
      const { includeBundledHermes = true, includeHermesCompilerPackage = false } = options;
      const projectDir = path.join(sandbox, "proj-" + crypto.randomBytes(4).toString("hex"));

      writeFile(
        path.join(projectDir, "package.json"),
        JSON.stringify({ name: "test-app", dependencies: { "react-native": rnVersion } })
      );

      const declaresHermesCompiler = parseInt(rnVersion.split(".")[1], 10) >= 84;
      writeFile(
        path.join(projectDir, "node_modules", "react-native", "package.json"),
        JSON.stringify({
          name: "react-native",
          version: rnVersion,
          ...(declaresHermesCompiler ? { dependencies: { "hermes-compiler": "260318099.0.5" } } : {}),
        })
      );

      if (includeBundledHermes) {
        writeFile(
          path.join(projectDir, "node_modules", "react-native", "sdks", "hermesc", hermesOsBin(), hermesOsExe(rnVersion)),
          "fake-hermes-bin"
        );
      }

      if (includeHermesCompilerPackage) {
        writeFile(
          path.join(projectDir, "node_modules", "hermes-compiler", "hermesc", hermesOsBin(), hermesOsExe(rnVersion)),
          "fake-hermes-compiler-bin"
        );
      }

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

    it("keeps the Node flags in CODE_PUSH_NODE_ARGS out of the hermes argv", async () => {
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
        expect(spawnArgs).not.toContain("--max-old-space-size=4096");
        expect(spawnArgs).not.toContain("--no-warnings");
        expect(spawnArgs.slice(0, 2)).toEqual(["-w", "-emit-binary"]);
      } finally {
        if (originalEnv === undefined) {
          delete process.env.CODE_PUSH_NODE_ARGS;
        } else {
          process.env.CODE_PUSH_NODE_ARGS = originalEnv;
        }
      }
    });

    it("uses the hermes-compiler package binary when the bundled react-native location is absent", async () => {
      const rnVersion = "0.86.0";
      const { projectDir, gradleFile, outputFolder } = buildProjectFixture(rnVersion, {
        includeBundledHermes: false,
        includeHermesCompilerPackage: true,
      });
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
        await rnUtils.runHermesEmitBinaryCommand(bundleName, outputFolder, "", [], gradleFile);
      });

      expect(mockedSpawn.mock.calls[0][0]).toBe(
        path.join(projectDir, "node_modules", "hermes-compiler", "hermesc", hermesOsBin(), hermesOsExe(rnVersion))
      );
    });

    it("prefers the hermes-compiler package binary over the bundled react-native location", async () => {
      const rnVersion = "0.86.0";
      const { projectDir, gradleFile, outputFolder } = buildProjectFixture(rnVersion, {
        includeBundledHermes: true,
        includeHermesCompilerPackage: true,
      });
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
        await rnUtils.runHermesEmitBinaryCommand(bundleName, outputFolder, "", [], gradleFile);
      });

      expect(mockedSpawn.mock.calls[0][0]).toBe(
        path.join(projectDir, "node_modules", "hermes-compiler", "hermesc", hermesOsBin(), hermesOsExe(rnVersion))
      );
    });

    it("uses the bundled react-native binary when the hermes-compiler package is absent", async () => {
      const rnVersion = "0.70.0";
      const { projectDir, gradleFile, outputFolder } = buildProjectFixture(rnVersion);
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
        await rnUtils.runHermesEmitBinaryCommand(bundleName, outputFolder, "", [], gradleFile);
      });

      expect(mockedSpawn.mock.calls[0][0]).toBe(
        path.join(projectDir, "node_modules", "react-native", "sdks", "hermesc", hermesOsBin(), hermesOsExe(rnVersion))
      );
    });

    it("rejects with the attempted locations when no hermes compiler is found", async () => {
      const { projectDir, gradleFile, outputFolder } = buildProjectFixture("0.86.0", {
        includeBundledHermes: false,
        includeHermesCompilerPackage: false,
      });
      mockSpawnSyncToReactNative(projectDir);

      const bundleName = "main.jsbundle";
      writeFile(path.join(outputFolder, bundleName), "original-bundle");

      await withCwd(projectDir, async () => {
        const pendingRun = rnUtils.runHermesEmitBinaryCommand(bundleName, outputFolder, "", [], gradleFile);
        await expect(pendingRun).rejects.toThrow(/Unable to find the Hermes compiler/);
        await expect(pendingRun).rejects.toThrow(/hermes-compiler/);
        await expect(pendingRun).rejects.toThrow(/sdks/);
        await expect(pendingRun).rejects.toBeInstanceOf(rnUtils.HermesCompilerUnavailableError);
      });

      expect(mockedSpawn).not.toHaveBeenCalled();
    });

    it("still reports the missing compiler when the project has no Android gradle file", async () => {
      const { projectDir, gradleFile, outputFolder } = buildProjectFixture("0.86.0", {
        includeBundledHermes: false,
        includeHermesCompilerPackage: false,
      });
      fs.rmSync(gradleFile);
      mockSpawnSyncToReactNative(projectDir);

      const bundleName = "main.jsbundle";
      writeFile(path.join(outputFolder, bundleName), "original-bundle");

      await withCwd(projectDir, async () => {
        await expect(rnUtils.runHermesEmitBinaryCommand(bundleName, outputFolder, "", [], gradleFile)).rejects.toBeInstanceOf(
          rnUtils.HermesCompilerUnavailableError
        );
      });
    });

    it("finds hermes-compiler through react-native's own dependencies when it is not at the project root", async () => {
      const rnVersion = "0.88.1";
      const { projectDir, gradleFile, outputFolder } = buildProjectFixture(rnVersion, { includeBundledHermes: false });
      writeFile(
        path.join(projectDir, "node_modules", "react-native", "package.json"),
        JSON.stringify({ name: "react-native", version: rnVersion, dependencies: { "hermes-compiler": "260318099.0.5" } })
      );
      const nestedCompilerDir = path.join(projectDir, "node_modules", "react-native", "node_modules", "hermes-compiler");
      writeFile(path.join(nestedCompilerDir, "package.json"), JSON.stringify({ name: "hermes-compiler", version: "260318099.0.5" }));
      writeFile(path.join(nestedCompilerDir, "hermesc", hermesOsBin(), hermesOsExe(rnVersion)), "fake-hermes-compiler-bin");
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
        await rnUtils.runHermesEmitBinaryCommand(bundleName, outputFolder, "", [], gradleFile);
      });

      expect(mockedSpawn.mock.calls[0][0]).toBe(path.join(nestedCompilerDir, "hermesc", hermesOsBin(), hermesOsExe(rnVersion)));
    });

    it("ignores a hoisted hermes-compiler that this project's react-native does not depend on", async () => {
      const workspaceDir = path.join(sandbox, "mixed-workspace-" + crypto.randomBytes(4).toString("hex"));
      const otherAppsCompiler = path.join(workspaceDir, "node_modules", "hermes-compiler");
      writeFile(path.join(otherAppsCompiler, "package.json"), JSON.stringify({ name: "hermes-compiler", version: "260318099.0.5" }));
      writeFile(path.join(otherAppsCompiler, "hermesc", hermesOsBin(), hermesOsExe("0.88.1")), "other-app-compiler");

      const appDir = path.join(workspaceDir, "packages", "legacy-app");
      const rnVersion = "0.81.4";
      writeFile(path.join(appDir, "package.json"), JSON.stringify({ name: "legacy-app", dependencies: { "react-native": rnVersion } }));
      writeFile(path.join(appDir, "node_modules", "react-native", "package.json"), JSON.stringify({ name: "react-native", version: rnVersion }));
      const bundledCompiler = path.join(appDir, "node_modules", "react-native", "sdks", "hermesc", hermesOsBin(), hermesOsExe(rnVersion));
      writeFile(bundledCompiler, "own-compiler");
      const gradleFile = path.join(appDir, "android", "app", "build.gradle");
      writeFile(gradleFile, "android { }\n");
      const outputFolder = path.join(appDir, "out");
      mockSpawnSyncToReactNative(appDir);

      const bundleName = "index.android.bundle";
      writeFile(path.join(outputFolder, bundleName), "original-bundle");
      writeFile(path.join(outputFolder, bundleName + ".hbc"), "compiled-bytecode");

      mockedSpawn.mockImplementationOnce(() => {
        const proc = createFakeChildProcess();
        setImmediate(() => proc.emit("close", 0, null));
        return proc;
      });

      await withCwd(appDir, async () => {
        await rnUtils.runHermesEmitBinaryCommand(bundleName, outputFolder, "", [], gradleFile);
      });

      expect(mockedSpawn.mock.calls[0][0]).toBe(bundledCompiler);
    });

    it("ignores a hermes-compiler at the project root when this project's react-native does not depend on it", async () => {
      const rnVersion = "0.81.4";
      const { projectDir, gradleFile, outputFolder } = buildProjectFixture(rnVersion, { includeHermesCompilerPackage: true });
      mockSpawnSyncToReactNative(projectDir);

      const bundleName = "index.android.bundle";
      writeFile(path.join(outputFolder, bundleName), "original-bundle");
      writeFile(path.join(outputFolder, bundleName + ".hbc"), "compiled-bytecode");

      mockedSpawn.mockImplementationOnce(() => {
        const proc = createFakeChildProcess();
        setImmediate(() => proc.emit("close", 0, null));
        return proc;
      });

      await withCwd(projectDir, async () => {
        await rnUtils.runHermesEmitBinaryCommand(bundleName, outputFolder, "", [], gradleFile);
      });

      expect(mockedSpawn.mock.calls[0][0]).toBe(
        path.join(projectDir, "node_modules", "react-native", "sdks", "hermesc", hermesOsBin(), hermesOsExe(rnVersion))
      );
    });

    it("does not pass -w twice when --extraHermesFlags already carries it", async () => {
      const { projectDir, gradleFile, outputFolder } = buildProjectFixture("0.81.4");
      mockSpawnSyncToReactNative(projectDir);

      const bundleName = "index.android.bundle";
      writeFile(path.join(outputFolder, bundleName), "original-bundle");
      writeFile(path.join(outputFolder, bundleName + ".hbc"), "compiled-bytecode");

      mockedSpawn.mockImplementationOnce(() => {
        const proc = createFakeChildProcess();
        setImmediate(() => proc.emit("close", 0, null));
        return proc;
      });

      await withCwd(projectDir, async () => {
        await rnUtils.runHermesEmitBinaryCommand(bundleName, outputFolder, "", ["-w", "-O"], gradleFile);
      });

      const spawnArgs = mockedSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs.filter((arg) => arg === "-w")).toHaveLength(1);
      expect(spawnArgs.slice(-2)).toEqual(["-w", "-O"]);
    });

    it("passes -w first so hermesc warnings stay out of the log, like the React Native Gradle task", async () => {
      const { projectDir, gradleFile, outputFolder } = buildProjectFixture("0.81.4");
      mockSpawnSyncToReactNative(projectDir);

      const bundleName = "index.android.bundle";
      writeFile(path.join(outputFolder, bundleName), "original-bundle");
      writeFile(path.join(outputFolder, bundleName + ".hbc"), "compiled-bytecode");

      mockedSpawn.mockImplementationOnce(() => {
        const proc = createFakeChildProcess();
        setImmediate(() => proc.emit("close", 0, null));
        return proc;
      });

      await withCwd(projectDir, async () => {
        await rnUtils.runHermesEmitBinaryCommand(bundleName, outputFolder, "", ["-O"], gradleFile);
      });

      expect(mockedSpawn.mock.calls[0][1]).toEqual([
        "-w",
        "-emit-binary",
        "-out",
        path.join(outputFolder, bundleName + ".hbc"),
        path.join(outputFolder, bundleName),
        "-O",
      ]);
    });

    it("resolves the compiler when package.json declares react-native with a range semver cannot coerce", async () => {
      const rnVersion = "0.88.1";
      const { projectDir, gradleFile, outputFolder } = buildProjectFixture(rnVersion, {
        includeBundledHermes: false,
        includeHermesCompilerPackage: true,
      });
      writeFile(path.join(projectDir, "package.json"), JSON.stringify({ name: "test-app", dependencies: { "react-native": "catalog:" } }));
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
        await rnUtils.runHermesEmitBinaryCommand(bundleName, outputFolder, "", [], gradleFile);
      });

      expect(mockedSpawn.mock.calls[0][0]).toBe(
        path.join(projectDir, "node_modules", "hermes-compiler", "hermesc", hermesOsBin(), hermesOsExe(rnVersion))
      );
    });

    it("rejects with HermesCompilerUnavailableError and keeps the JS bundle when the compiler cannot be spawned", async () => {
      const { projectDir, gradleFile, outputFolder } = buildProjectFixture("0.81.4");
      mockSpawnSyncToReactNative(projectDir);

      const bundleName = "index.android.bundle";
      writeFile(path.join(outputFolder, bundleName), "original-bundle");

      mockedSpawn.mockImplementationOnce(() => {
        const proc = createFakeChildProcess();
        setImmediate(() => {
          proc.emit("error", Object.assign(new Error("spawn ENOEXEC"), { code: "ENOEXEC" }));
          proc.emit("close", -8, null);
        });
        return proc;
      });

      await withCwd(projectDir, async () => {
        const pendingRun = rnUtils.runHermesEmitBinaryCommand(bundleName, outputFolder, "", [], gradleFile);
        await expect(pendingRun).rejects.toBeInstanceOf(rnUtils.HermesCompilerUnavailableError);
        await expect(pendingRun).rejects.toThrow(/ENOEXEC/);
      });

      expect(fs.readFileSync(path.join(outputFolder, bundleName), "utf8")).toBe("original-bundle");
    });

    it("rejects with HermesCompilerUnavailableError when spawn throws synchronously", async () => {
      const { projectDir, gradleFile, outputFolder } = buildProjectFixture("0.81.4");
      mockSpawnSyncToReactNative(projectDir);

      const bundleName = "index.android.bundle";
      writeFile(path.join(outputFolder, bundleName), "original-bundle");

      mockedSpawn.mockImplementationOnce(() => {
        throw Object.assign(new Error("spawn ENOEXEC"), { code: "ENOEXEC" });
      });

      await withCwd(projectDir, async () => {
        const pendingRun = rnUtils.runHermesEmitBinaryCommand(bundleName, outputFolder, "", [], gradleFile);
        await expect(pendingRun).rejects.toBeInstanceOf(rnUtils.HermesCompilerUnavailableError);
        await expect(pendingRun).rejects.toThrow(/Unable to run the Hermes compiler at .*\(ENOEXEC\)/);
      });

      expect(fs.readFileSync(path.join(outputFolder, bundleName), "utf8")).toBe("original-bundle");
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
