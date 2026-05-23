const mockCreateCommand = jest.fn();
const mockShowHelp = jest.fn();
const mockExecute = jest.fn();

jest.mock("../script/command-parser", () => ({
  createCommand: mockCreateCommand,
  showHelp: mockShowHelp,
}));

jest.mock("../script/command-executor", () => ({
  execute: mockExecute,
}));

describe("cli", () => {
  let consoleErrorSpy: jest.SpyInstance;
  let processExitSpy: jest.SpyInstance;

  beforeEach(() => {
    mockCreateCommand.mockReset();
    mockShowHelp.mockReset();
    mockExecute.mockReset();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    processExitSpy = jest.spyOn(process, "exit").mockImplementation(((_code?: number) => undefined) as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function runCli(): void {
    jest.isolateModules(() => {
      require("../script/cli");
    });
  }

  it("calls showHelp without root description when createCommand returns undefined", () => {
    mockCreateCommand.mockReturnValue(undefined);
    runCli();
    expect(mockShowHelp).toHaveBeenCalledWith(false);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("dispatches to execute when createCommand returns a valid command", () => {
    const cmd = { type: 0 };
    mockCreateCommand.mockReturnValue(cmd);
    mockExecute.mockResolvedValue(undefined);
    runCli();
    expect(mockExecute).toHaveBeenCalledWith(cmd);
    expect(mockShowHelp).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it("on execute rejection logs the red [Error] message and exits with code 1", async () => {
    const cmd = { type: 0 };
    mockCreateCommand.mockReturnValue(cmd);
    mockExecute.mockReturnValue(Promise.reject(new Error("boom")));
    runCli();
    await new Promise((r) => setImmediate(r));
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringMatching(/\[Error\]\s+boom/));
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });
});
