jest.mock("../../package.json", () => ({ version: "0.1.0-test" }), { virtual: true });

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import * as keyStore from "../script/auth/key-store";
import * as executorMod from "../script/command-executor";
import { AetherError } from "../script/errors";
import * as cli from "../script/types/cli";

const executor: any = executorMod;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("the 401 credential wipe around the real management SDK", () => {
  let sandboxHome: string;
  let savedHome: string | undefined;
  let savedLocalAppData: string | undefined;
  let fetchSpy: jest.SpyInstance;

  const createTransfer = () =>
    executor.execute({
      type: cli.CommandType.appTransferCreate,
      appName: "MyApp",
      email: "other@example.com",
      force: true,
      nonInteractive: true,
    });

  beforeEach(() => {
    sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "aether-cli-step-up-"));
    savedHome = process.env.HOME;
    savedLocalAppData = process.env.LOCALAPPDATA;
    process.env.HOME = sandboxHome;
    delete process.env.LOCALAPPDATA;
    keyStore.writeCredential({ accessKey: "stored-session-key", serverUrl: "http://test.aetherpush.local" });
    executor.sdk = null;
    fetchSpy = jest.spyOn(globalThis, "fetch");
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    executor.sdk = null;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = savedLocalAppData;
    fs.rmSync(sandboxHome, { recursive: true, force: true });
  });

  it("keeps the stored credential when the server answers 401 step_up_required", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(401, { error: "Confirm a second factor you already have before transferring this app.", code: "step_up_required" })
    );

    const error = await createTransfer().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(AetherError);
    expect(error.code).toBe("step_up_required");
    expect(fs.existsSync(keyStore.getCredentialPath())).toBe(true);
    expect(keyStore.readCredential()?.accessKey).toBe("stored-session-key");
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe("http://test.aetherpush.local/v1/app-transfers");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer stored-session-key" });
  });

  it("still removes the stored credential on any other 401", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(401, { error: "Unauthorized", code: "session_or_key_invalid" }));

    await expect(createTransfer()).rejects.toMatchObject({ statusCode: 401, code: "session_or_key_invalid" });

    expect(fs.existsSync(keyStore.getCredentialPath())).toBe(false);
    expect(keyStore.readCredential()).toBeNull();
  });

  it("keeps the stored credential on a 429 too_many_mfa_attempts", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(429, { error: "Too many failed step-up attempts. Please try again later.", code: "too_many_mfa_attempts" })
    );

    await expect(createTransfer()).rejects.toMatchObject({ statusCode: 429, code: "too_many_mfa_attempts" });

    expect(fs.existsSync(keyStore.getCredentialPath())).toBe(true);
  });
});
