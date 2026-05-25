import { EventEmitter } from "events";
import * as childProcess from "child_process";

jest.mock("child_process");
jest.mock("which", () => ({ sync: jest.fn() }));
jest.mock("simctl", () => ({ list: jest.fn() }));

import debug from "../../script/commands/debug";

const which = require("which");
const simctl = require("simctl");

function makeFakeProc(): any {
  const proc: any = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
}

function setPlatform(platform: string): void {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
}

describe("commands/debug", () => {
  let consoleLogSpy: jest.SpyInstance;
  let originalPlatform: NodeJS.Platform;
  let originalHome: string | undefined;
  let spawnMock: jest.Mock;
  let execSyncMock: jest.Mock;
  let whichSyncMock: jest.Mock;
  let simctlListMock: jest.Mock;

  beforeEach(() => {
    originalPlatform = process.platform;
    originalHome = process.env.HOME;
    process.env.HOME = "/Users/test";

    consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);

    spawnMock = childProcess.spawn as unknown as jest.Mock;
    execSyncMock = childProcess.execSync as unknown as jest.Mock;
    whichSyncMock = which.sync as jest.Mock;
    simctlListMock = simctl.list as jest.Mock;

    spawnMock.mockReset();
    execSyncMock.mockReset();
    whichSyncMock.mockReset();
    simctlListMock.mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true,
    });
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  });

  describe("default export — dispatch", () => {
    it("unsupported platform rejects with the available options listed", async () => {
      await expect(debug({ platform: "windows-phone" } as any)).rejects.toThrow(
        /"windows-phone" is an unsupported platform\. Available options are android, ios\./
      );
    });

    it("platform name is lower-cased before dispatch (ANDROID → android)", async () => {
      whichSyncMock.mockReturnValue("/usr/local/bin/adb");
      execSyncMock.mockReturnValue(Buffer.from("List of devices attached\nemulator-5554\tdevice\n"));
      const fakeProc = makeFakeProc();
      spawnMock.mockReturnValue(fakeProc);

      const promise = debug({ platform: "ANDROID" } as any);
      fakeProc.emit("close");

      await expect(promise).resolves.toBeUndefined();
      expect(spawnMock).toHaveBeenCalledWith("adb", ["logcat"]);
    });

    it("an error thrown synchronously from getLogProcess rejects the promise", async () => {
      whichSyncMock.mockImplementation(() => {
        throw new Error("not found");
      });

      await expect(debug({ platform: "android" } as any)).rejects.toThrow(/ADB command not found/);
    });

    it("logs a 'Listening for ... debug logs' message on successful spawn", async () => {
      whichSyncMock.mockReturnValue("/usr/local/bin/adb");
      execSyncMock.mockReturnValue(Buffer.from("List of devices attached\nemulator-5554\tdevice\n"));
      const fakeProc = makeFakeProc();
      spawnMock.mockReturnValue(fakeProc);

      const promise = debug({ platform: "android" } as any);
      fakeProc.emit("close");
      await promise;

      expect(consoleLogSpy).toHaveBeenCalledWith("Listening for android debug logs (Press CTRL+C to exit)");
    });
  });

  describe("AndroidDebugPlatform.getLogProcess", () => {
    it("throws when adb is not on PATH", async () => {
      whichSyncMock.mockImplementation(() => {
        throw new Error("not found");
      });

      await expect(debug({ platform: "android" } as any)).rejects.toThrow(/ADB command not found\. Please ensure it is installed/);
    });

    it("throws when zero devices are connected", async () => {
      whichSyncMock.mockReturnValue("/usr/local/bin/adb");
      execSyncMock.mockReturnValue(Buffer.from("List of devices attached\n\n"));

      await expect(debug({ platform: "android" } as any)).rejects.toThrow(/No Android devices found/);
    });

    it("throws when more than one device is connected", async () => {
      whichSyncMock.mockReturnValue("/usr/local/bin/adb");
      execSyncMock.mockReturnValue(Buffer.from("List of devices attached\nemulator-5554\tdevice\n192.168.121.102:5555\tdevice\n"));

      await expect(debug({ platform: "android" } as any)).rejects.toThrow(/Found "2" android devices/);
    });

    it("spawns 'adb logcat' when exactly one device is connected", async () => {
      whichSyncMock.mockReturnValue("/usr/local/bin/adb");
      execSyncMock.mockReturnValue(Buffer.from("List of devices attached\nemulator-5554\tdevice\n"));
      const fakeProc = makeFakeProc();
      spawnMock.mockReturnValue(fakeProc);

      const promise = debug({ platform: "android" } as any);
      fakeProc.emit("close");
      await promise;

      expect(spawnMock).toHaveBeenCalledWith("adb", ["logcat"]);
    });
  });

  describe("iOSDebugPlatform.getLogProcess", () => {
    it("throws when not running on darwin", async () => {
      setPlatform("linux");

      await expect(debug({ platform: "ios" } as any)).rejects.toThrow(/iOS debug logs can only be viewed on OS X/);
    });

    it("throws when no booted simulators exist", async () => {
      setPlatform("darwin");
      simctlListMock.mockReturnValue({
        json: {
          devices: [{ devices: [{ id: "abc", state: "Shutdown" }] }, { devices: [{ id: "def", state: "Shutdown" }] }],
        },
      });

      await expect(debug({ platform: "ios" } as any)).rejects.toThrow(/No iOS simulators found/);
    });

    it("spawns 'tail -f' on the system.log of the booted simulator", async () => {
      setPlatform("darwin");
      simctlListMock.mockReturnValue({
        json: {
          devices: [{ devices: [{ id: "abc", state: "Shutdown" }] }, { devices: [{ id: "booted-sim-id", state: "Booted" }] }],
        },
      });
      const fakeProc = makeFakeProc();
      spawnMock.mockReturnValue(fakeProc);

      const promise = debug({ platform: "ios" } as any);
      fakeProc.emit("close");
      await promise;

      expect(spawnMock).toHaveBeenCalledWith("tail", ["-f", "/Users/test/Library/Logs/CoreSimulator/booted-sim-id/system.log"]);
    });
  });

  describe("processLogData (via stdout 'data' events)", () => {
    async function startAndroidProc(): Promise<{
      promise: Promise<void>;
      proc: any;
    }> {
      whichSyncMock.mockReturnValue("/usr/local/bin/adb");
      execSyncMock.mockReturnValue(Buffer.from("List of devices attached\nemulator-5554\tdevice\n"));
      const proc = makeFakeProc();
      spawnMock.mockReturnValue(proc);
      const promise = debug({ platform: "android" } as any);
      return { promise, proc };
    }

    async function startIosProc(): Promise<{
      promise: Promise<void>;
      proc: any;
    }> {
      setPlatform("darwin");
      simctlListMock.mockReturnValue({
        json: {
          devices: [{ devices: [{ id: "sim-1", state: "Booted" }] }],
        },
      });
      const proc = makeFakeProc();
      spawnMock.mockReturnValue(proc);
      const promise = debug({ platform: "ios" } as any);
      return { promise, proc };
    }

    it("filters out lines that do not contain the [CodePush] prefix", async () => {
      const { promise, proc } = await startAndroidProc();
      proc.stdout.emit("data", Buffer.from("I/ActivityManager: some random log\nW/Other: more noise\n"));
      proc.emit("close");
      await promise;

      const stdoutCalls = consoleLogSpy.mock.calls.map((c) => c[0]);
      expect(stdoutCalls.some((line: string) => /\d{2}:\d{2}:\d{2}/.test(line))).toBe(false);
    });

    it("emits filtered lines with a timestamp prefix and the [CodePush] prefix stripped", async () => {
      const { promise, proc } = await startAndroidProc();
      proc.stdout.emit("data", Buffer.from("[CodePush] update applied\n"));
      proc.emit("close");
      await promise;

      const matching = consoleLogSpy.mock.calls.map((c) => c[0]).filter((line: string) => /update applied/.test(line));
      expect(matching.length).toBe(1);
      expect(matching[0]).toMatch(/^\[\d{2}:\d{2}:\d{2}\] update applied$/);
    });

    it("applies Android normalizeLogMessage and strips Cordova source URL suffix", async () => {
      const { promise, proc } = await startAndroidProc();
      proc.stdout.emit("data", Buffer.from('[CodePush] hello world", source: file:///android_asset/www/index.html\n'));
      proc.emit("close");
      await promise;

      const matching = consoleLogSpy.mock.calls.map((c) => c[0]).filter((line: string) => /hello world/.test(line));
      expect(matching.length).toBe(1);
      expect(matching[0]).toMatch(/^\[\d{2}:\d{2}:\d{2}\] hello world$/);
      expect(matching[0]).not.toContain("source: file:///");
    });

    it("leaves messages without source URL suffix untouched on Android", async () => {
      const { promise, proc } = await startAndroidProc();
      proc.stdout.emit("data", Buffer.from("[CodePush] no source url here\n"));
      proc.emit("close");
      await promise;

      const matching = consoleLogSpy.mock.calls.map((c) => c[0]).filter((line: string) => /no source url here/.test(line));
      expect(matching.length).toBe(1);
      expect(matching[0]).toMatch(/^\[\d{2}:\d{2}:\d{2}\] no source url here$/);
    });

    it("iOS normalizeLogMessage is a no-op (passes source URLs through)", async () => {
      const { promise, proc } = await startIosProc();
      proc.stdout.emit("data", Buffer.from('[CodePush] ios log", source: file:///somewhere.js\n'));
      proc.emit("close");
      await promise;

      const matching = consoleLogSpy.mock.calls.map((c) => c[0]).filter((line: string) => /ios log/.test(line));
      expect(matching.length).toBe(1);
      expect(matching[0]).toContain("source: file:///somewhere.js");
    });

    it("processes multiple [CodePush] lines from a single data chunk", async () => {
      const { promise, proc } = await startAndroidProc();
      proc.stdout.emit("data", Buffer.from("[CodePush] line one\nrandom noise\n[CodePush] line two\n[CodePush] line three\n"));
      proc.emit("close");
      await promise;

      const matching = consoleLogSpy.mock.calls
        .map((c) => c[0])
        .filter((line: string) => /^\[\d{2}:\d{2}:\d{2}\] line (one|two|three)$/.test(line));
      expect(matching.length).toBe(3);
    });
  });

  describe("lifecycle handlers", () => {
    it("resolves when the log process emits 'close'", async () => {
      whichSyncMock.mockReturnValue("/usr/local/bin/adb");
      execSyncMock.mockReturnValue(Buffer.from("List of devices attached\nemulator-5554\tdevice\n"));
      const proc = makeFakeProc();
      spawnMock.mockReturnValue(proc);

      const promise = debug({ platform: "android" } as any);
      proc.emit("close");

      await expect(promise).resolves.toBeUndefined();
    });

    it("rejects when stderr emits a 'data' event with an error payload", async () => {
      whichSyncMock.mockReturnValue("/usr/local/bin/adb");
      execSyncMock.mockReturnValue(Buffer.from("List of devices attached\nemulator-5554\tdevice\n"));
      const proc = makeFakeProc();
      spawnMock.mockReturnValue(proc);

      const promise = debug({ platform: "android" } as any);
      const stderrErr = new Error("adb died");
      proc.stderr.emit("data", stderrErr);

      await expect(promise).rejects.toBe(stderrErr);
    });
  });
});
