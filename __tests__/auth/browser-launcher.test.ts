import * as childProcess from "child_process";

import { openBrowser } from "../../script/auth/browser-launcher";

describe("openBrowser", () => {
  const originalPlatform = process.platform;

  function setPlatform(value: string): void {
    Object.defineProperty(process, "platform", { value, configurable: true });
  }

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    jest.restoreAllMocks();
  });

  it("survives a helper that does not exist on this machine", () => {
    // spawn reports ENOENT asynchronously. With no 'error' listener that becomes
    // an unhandled event and takes the process down, on exactly the headless
    // machines that need the printed-code fallback instead.
    const real = jest.requireActual("child_process") as typeof childProcess;
    jest
      .spyOn(childProcess, "spawn")
      .mockImplementation(((command: string, args: string[], options: any) =>
        real.spawn("aether-no-such-browser-helper", args, options)) as any);

    expect(() => openBrowser("http://127.0.0.1:49152/callback")).not.toThrow();

    return new Promise<void>((resolve, reject) => {
      // If the error were unhandled the process would die before this settles.
      setTimeout(() => resolve(), 150);
      process.once("uncaughtException", reject);
    });
  });

  it("detaches the child so the terminal is not held open", () => {
    const unref = jest.fn();
    const on = jest.fn();
    jest.spyOn(childProcess, "spawn").mockReturnValue({ on, unref } as any);

    expect(openBrowser("http://127.0.0.1:49152/callback")).toBe(true);
    expect(unref).toHaveBeenCalled();
    expect(on).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("reports failure rather than throwing when spawn itself throws", () => {
    jest.spyOn(childProcess, "spawn").mockImplementation(() => {
      throw new Error("EPERM");
    });

    expect(openBrowser("http://127.0.0.1:49152/callback")).toBe(false);
  });

  it("uses the platform's own opener", () => {
    const spawn = jest.spyOn(childProcess, "spawn").mockReturnValue({ on: jest.fn(), unref: jest.fn() } as any);

    setPlatform("darwin");
    openBrowser("http://example.test/");
    expect(spawn.mock.calls[0][0]).toBe("open");
    // `--` stops the opener reading a URL as one of its own flags.
    expect(spawn.mock.calls[0][1]).toEqual(["--", "http://example.test/"]);

    setPlatform("win32");
    openBrowser("http://example.test/");
    // Not `cmd /c start`: cmd re-parses its arguments, and a URL carrying a
    // double quote would break out of the quoted argument into command text.
    expect(spawn.mock.calls[1][0]).toBe("rundll32");
    expect(spawn.mock.calls[1][1]).toEqual(["url.dll,FileProtocolHandler", "http://example.test/"]);

    setPlatform("linux");
    openBrowser("http://example.test/");
    expect(spawn.mock.calls[2][0]).toBe("xdg-open");
    expect(spawn.mock.calls[2][1]).toEqual(["--", "http://example.test/"]);
  });

  it("refuses anything that is not an http address", () => {
    const spawn = jest.spyOn(childProcess, "spawn").mockReturnValue({ on: jest.fn(), unref: jest.fn() } as any);

    // The URL comes from the server, and --serverUrl means the server is not
    // always ours.
    expect(openBrowser("file:///etc/passwd")).toBe(false);
    expect(openBrowser("javascript:alert(1)")).toBe(false);
    expect(openBrowser("vscode://install")).toBe(false);
    expect(openBrowser("not a url")).toBe(false);
    expect(openBrowser("")).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });
});
