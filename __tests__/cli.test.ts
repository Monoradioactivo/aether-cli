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

function runCli(args: string[]): { exitCode: number | null; helpShown: boolean; executeCalled: boolean } {
  let exitCode: number | null = null;
  let helpShown = false;
  let executeCalled = false;

  jest.isolateModules(() => {
    const originalArgv = process.argv;
    const originalExit = process.exit;

    process.argv = ["node", "aether", ...args];
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw new Error(`__EXIT_${code ?? 0}__`);
    }) as any;

    jest.doMock("../script/command-executor", () => ({
      execute: jest.fn(() => {
        executeCalled = true;
        return Promise.resolve();
      }),
    }));

    try {
      const parser = require("../script/command-parser");
      const originalShowHelp = parser.showHelp;
      parser.showHelp = (...rest: any[]) => {
        helpShown = true;
        return originalShowHelp.apply(parser, rest);
      };

      try {
        require("../script/cli");
      } catch (e: any) {
        if (!String(e.message).startsWith("__EXIT_")) {
          throw e;
        }
      }
    } finally {
      process.argv = originalArgv;
      process.exit = originalExit;
    }
  });

  return { exitCode, helpShown, executeCalled };
}

describe("cli entry point", () => {
  beforeEach(() => {
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("exit codes", () => {
    it("exits 1 when an unknown command category is passed", () => {
      const { exitCode, executeCalled } = runCli(["nonsense-command"]);
      expect(exitCode).toBe(1);
      expect(executeCalled).toBe(false);
    });

    it("exits 1 when a known command is missing required args", () => {
      const { exitCode, executeCalled } = runCli(["app", "rm"]);
      expect(exitCode).toBe(1);
      expect(executeCalled).toBe(false);
    });

    it("exits 1 when an unknown subcommand is passed under a known category", () => {
      const { exitCode, executeCalled } = runCli(["app", "bogus-subcommand"]);
      expect(exitCode).toBe(1);
      expect(executeCalled).toBe(false);
    });

    it("exits 0 (no exit call) when invoked with no args at all", () => {
      const { exitCode, helpShown, executeCalled } = runCli([]);
      expect(exitCode).toBeNull();
      expect(helpShown).toBe(true);
      expect(executeCalled).toBe(false);
    });

    it("proceeds to execute() when a valid command is parsed", () => {
      const { exitCode, executeCalled } = runCli(["app", "list"]);
      expect(exitCode).toBeNull();
      expect(executeCalled).toBe(true);
    });
  });
});
