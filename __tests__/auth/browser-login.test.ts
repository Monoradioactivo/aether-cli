import * as crypto from "crypto";

import {
  AuthorizationDeniedError,
  AuthorizationExpiredError,
  UnsupportedServerError,
  runBrowserLogin,
} from "../../script/auth/browser-login";
import { LoopbackListener } from "../../script/auth/loopback-listener";

const SERVER = "https://api.aetherpush.com";
const REDIRECT = "http://127.0.0.1:49152/callback";

let fetchSpy: jest.SpyInstance;
let logged: string[];

function baseOptions(overrides: Record<string, unknown> = {}) {
  return {
    serverUrl: SERVER,
    deviceId: "device-1",
    deviceName: "Test Box",
    clientVersion: "0.5.0",
    clientPlatform: "darwin-arm64",
    headers: { "X-Aether-CLI-Version": "0.5.0" },
    log: (message: string) => logged.push(message),
    openBrowser: jest.fn().mockReturnValue(true),
    sleep: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

function fakeListener(callback: Record<string, unknown>, overrides: Partial<LoopbackListener> = {}): LoopbackListener {
  return {
    redirectUri: REDIRECT,
    waitForCallback: jest.fn().mockResolvedValue({ code: "the-code", state: null, error: null, ...callback }),
    close: jest.fn(),
    ...overrides,
  } as any;
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status });
}

/** Captures the state the CLI generated so the fake browser can echo it back. */
function stateFromLastRequest(): string {
  const init = fetchSpy.mock.calls[0][1];
  return JSON.parse(init.body).state;
}

beforeEach(() => {
  logged = [];
  fetchSpy = jest.spyOn(globalThis, "fetch" as any);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("loopback flow", () => {
  it("starts a ceremony, opens the browser, and exchanges the code for a credential", async () => {
    let listener: LoopbackListener;
    fetchSpy
      .mockImplementationOnce(async () =>
        jsonResponse(201, { authorizationId: "req-1", authorizeUrl: `${SERVER}/authorize`, expiresAt: 1 })
      )
      .mockImplementationOnce(async () =>
        jsonResponse(200, { accessKey: "the-key", expires: 123, credentialId: "cred-1", account: { email: "user@example.com" } })
      );

    const options = baseOptions({
      startLoopbackListener: async () => {
        listener = fakeListener({});
        return listener;
      },
    });
    // The fake browser echoes whatever state the CLI generated.
    const original = options.startLoopbackListener;
    options.startLoopbackListener = async () => {
      const created = await original();
      (created.waitForCallback as jest.Mock).mockImplementation(async () => ({
        code: "the-code",
        state: stateFromLastRequest(),
        error: null,
      }));
      return created;
    };

    const result = await runBrowserLogin(options);

    expect(result).toEqual({ accessKey: "the-key", expires: 123, credentialId: "cred-1", email: "user@example.com" });

    const [startUrl, startInit] = fetchSpy.mock.calls[0];
    expect(startUrl).toBe(`${SERVER}/v1/auth/cli/authorizations`);
    const startBody = JSON.parse(startInit.body);
    expect(startBody.codeChallengeMethod).toBe("S256");
    expect(startBody.redirectUri).toBe(REDIRECT);
    expect(startBody.deviceName).toBe("Test Box");
    // Only the challenge goes out; the verifier stays on this machine.
    expect(startBody.codeVerifier).toBeUndefined();

    const [tokenUrl, tokenInit] = fetchSpy.mock.calls[1];
    expect(tokenUrl).toBe(`${SERVER}/v1/auth/cli/token`);
    const tokenBody = JSON.parse(tokenInit.body);
    expect(tokenBody.grantType).toBe("authorization_code");
    expect(tokenBody.redirectUri).toBe(REDIRECT);
    expect(crypto.createHash("sha256").update(tokenBody.codeVerifier, "ascii").digest("base64url")).toBe(startBody.codeChallenge);

    expect(options.openBrowser).toHaveBeenCalledWith(`${SERVER}/authorize`);
    expect(logged.join("\n")).toContain("Waiting for authorization...");
  });

  it("switches to code entry when no browser could be opened", async () => {
    fetchSpy
      .mockImplementationOnce(async () =>
        jsonResponse(201, { authorizationId: "req-1", authorizeUrl: `${SERVER}/authorize`, expiresAt: 1 })
      )
      .mockImplementationOnce(async () =>
        jsonResponse(201, {
          device_code: "dev-code",
          user_code: "K27P-B744",
          verification_uri: `${SERVER}/activate`,
          expires_in: 600,
          interval: 5,
        })
      )
      .mockImplementationOnce(async () => jsonResponse(200, { accessKey: "the-key", expires: 1 }));

    const options = baseOptions({
      openBrowser: jest.fn().mockReturnValue(false),
      startLoopbackListener: async () => fakeListener({}),
    });

    // A machine with no opener is exactly the machine the printed code exists
    // for; waiting ten minutes on a browser nobody can see is the wrong answer.
    const result = await runBrowserLogin(options);

    expect(result.accessKey).toBe("the-key");
    expect(logged.join("\n")).toContain("switching to code entry");
    expect(logged.join("\n")).toContain("K27P-B744");
  });

  it("refuses to start when the server answers without an address to authorize at", async () => {
    fetchSpy.mockImplementationOnce(async () => jsonResponse(201, { authorizationId: "req-1", expiresAt: 1 }));

    const options = baseOptions({ startLoopbackListener: async () => fakeListener({}) });

    await expect(runBrowserLogin(options)).rejects.toThrow(/did not return an address/);
  });

  it("refuses to exchange when the returned state does not match", async () => {
    fetchSpy.mockImplementationOnce(async () =>
      jsonResponse(201, { authorizationId: "req-1", authorizeUrl: `${SERVER}/authorize`, expiresAt: 1 })
    );

    const options = baseOptions({
      startLoopbackListener: async () => fakeListener({ state: "someone-elses-state" }),
    });

    await expect(runBrowserLogin(options)).rejects.toThrow(/does not match this sign-in/);
    // The verifier was never presented.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("reports a denial signalled on the redirect", async () => {
    fetchSpy.mockImplementationOnce(async () =>
      jsonResponse(201, { authorizationId: "req-1", authorizeUrl: `${SERVER}/authorize`, expiresAt: 1 })
    );

    const options = baseOptions();
    options.startLoopbackListener = async () => {
      const created = fakeListener({});
      (created.waitForCallback as jest.Mock).mockImplementation(async () => ({
        code: "",
        state: stateFromLastRequest(),
        error: "access_denied",
      }));
      return created;
    };

    await expect(runBrowserLogin(options)).rejects.toBeInstanceOf(AuthorizationDeniedError);
  });

  it("ignores a denial that does not carry this sign-in's state", async () => {
    fetchSpy.mockImplementationOnce(async () =>
      jsonResponse(201, { authorizationId: "req-1", authorizeUrl: `${SERVER}/authorize`, expiresAt: 1 })
    );

    const options = baseOptions({
      startLoopbackListener: async () => fakeListener({ error: "access_denied", state: "someone-elses-state" }),
    });

    // A local process that finds the port must not be able to pass its own
    // outcome off as this ceremony's.
    await expect(runBrowserLogin(options)).rejects.toThrow(/does not match this sign-in/);
  });

  it("surfaces the server's reason when the exchange is rejected", async () => {
    fetchSpy
      .mockImplementationOnce(async () =>
        jsonResponse(201, { authorizationId: "req-1", authorizeUrl: `${SERVER}/authorize`, expiresAt: 1 })
      )
      .mockImplementationOnce(async () =>
        jsonResponse(400, {
          error: "invalid_grant",
          error_description: "The authorization code is invalid, expired, or already used.",
        })
      );

    const options = baseOptions();
    options.startLoopbackListener = async () => {
      const created = fakeListener({});
      (created.waitForCallback as jest.Mock).mockImplementation(async () => ({
        code: "the-code",
        state: stateFromLastRequest(),
        error: null,
      }));
      return created;
    };

    await expect(runBrowserLogin(options)).rejects.toThrow(/already used/);
  });

  it("closes the listener whether the ceremony succeeds or fails", async () => {
    fetchSpy.mockImplementationOnce(async () =>
      jsonResponse(201, { authorizationId: "req-1", authorizeUrl: `${SERVER}/authorize`, expiresAt: 1 })
    );
    const listener = fakeListener({ state: "mismatch" });

    await expect(runBrowserLogin(baseOptions({ startLoopbackListener: async () => listener }))).rejects.toThrow();

    expect(listener.close).toHaveBeenCalled();
  });

  it("falls back to the printed code when the loopback port cannot be bound", async () => {
    fetchSpy
      .mockImplementationOnce(async () =>
        jsonResponse(201, {
          device_code: "dev-code",
          user_code: "K27P-B744",
          verification_uri: `${SERVER}/activate`,
          verification_uri_complete: `${SERVER}/activate?user_code=K27P-B744`,
          expires_in: 600,
          interval: 5,
        })
      )
      .mockImplementationOnce(async () => jsonResponse(200, { accessKey: "the-key", expires: 1 }));

    const options = baseOptions({
      startLoopbackListener: async () => {
        throw new Error("EADDRINUSE");
      },
    });

    const result = await runBrowserLogin(options);

    expect(result.accessKey).toBe("the-key");
    expect(logged.join("\n")).toContain("switching to code entry");
    expect(fetchSpy.mock.calls[0][0]).toBe(`${SERVER}/v1/auth/cli/device`);
  });
});

describe("device flow", () => {
  const startDevice = () =>
    jsonResponse(201, {
      device_code: "dev-code",
      user_code: "K27P-B744",
      verification_uri: `${SERVER}/activate`,
      verification_uri_complete: `${SERVER}/activate?user_code=K27P-B744`,
      expires_in: 600,
      interval: 5,
    });

  it("prints the code and polls until the request is approved", async () => {
    fetchSpy
      .mockImplementationOnce(async () => startDevice())
      .mockImplementationOnce(async () => jsonResponse(400, { error: "authorization_pending" }))
      .mockImplementationOnce(async () => jsonResponse(400, { error: "authorization_pending" }))
      .mockImplementationOnce(async () =>
        jsonResponse(200, { accessKey: "the-key", expires: 1, account: { email: "user@example.com" } })
      );

    const options = baseOptions({ forceDeviceFlow: true });
    const result = await runBrowserLogin(options);

    expect(result.email).toBe("user@example.com");
    expect(logged.join("\n")).toContain("K27P-B744");
    expect(logged.join("\n")).toContain(`${SERVER}/activate`);
    expect(options.sleep).toHaveBeenCalledWith(5000);
  });

  it("backs off when the server says to slow down", async () => {
    fetchSpy
      .mockImplementationOnce(async () => startDevice())
      .mockImplementationOnce(async () => jsonResponse(400, { error: "slow_down" }))
      .mockImplementationOnce(async () => jsonResponse(200, { accessKey: "the-key", expires: 1 }));

    const options = baseOptions({ forceDeviceFlow: true });
    await runBrowserLogin(options);

    expect(options.sleep.mock.calls.map((call: number[]) => call[0])).toEqual([5000, 10000]);
  });

  it("keeps polling through a dropped connection", async () => {
    fetchSpy
      .mockImplementationOnce(async () => startDevice())
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockImplementationOnce(async () => jsonResponse(200, { accessKey: "the-key", expires: 1 }));

    // The user may already have approved; abandoning here would lose a valid
    // ceremony over one bad packet.
    const result = await runBrowserLogin(baseOptions({ forceDeviceFlow: true }));

    expect(result.accessKey).toBe("the-key");
  });

  it("keeps polling through throttling and server faults", async () => {
    fetchSpy
      .mockImplementationOnce(async () => startDevice())
      .mockImplementationOnce(async () => jsonResponse(429, { error: "Too many token requests. Please try again later." }))
      .mockImplementationOnce(async () => jsonResponse(503, { error: "Internal server error." }))
      .mockImplementationOnce(async () => jsonResponse(200, { accessKey: "the-key", expires: 1 }));

    const options = baseOptions({ forceDeviceFlow: true });
    const result = await runBrowserLogin(options);

    expect(result.accessKey).toBe("the-key");
    expect(options.sleep.mock.calls.map((call: number[]) => call[0])).toEqual([5000, 10000, 15000]);
  });

  it("stops on a denial", async () => {
    fetchSpy
      .mockImplementationOnce(async () => startDevice())
      .mockImplementationOnce(async () => jsonResponse(400, { error: "access_denied" }));

    await expect(runBrowserLogin(baseOptions({ forceDeviceFlow: true }))).rejects.toBeInstanceOf(AuthorizationDeniedError);
  });

  it("stops when the request expires server-side", async () => {
    fetchSpy
      .mockImplementationOnce(async () => startDevice())
      .mockImplementationOnce(async () => jsonResponse(400, { error: "expired_token" }));

    await expect(runBrowserLogin(baseOptions({ forceDeviceFlow: true }))).rejects.toBeInstanceOf(AuthorizationExpiredError);
  });

  it("gives up once the advertised lifetime has passed", async () => {
    fetchSpy.mockImplementationOnce(async () =>
      jsonResponse(201, {
        device_code: "dev-code",
        user_code: "K27P-B744",
        verification_uri: `${SERVER}/activate`,
        expires_in: 0,
        interval: 5,
      })
    );

    await expect(runBrowserLogin(baseOptions({ forceDeviceFlow: true }))).rejects.toBeInstanceOf(AuthorizationExpiredError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("a server that does not implement the ceremony", () => {
  it("says so instead of surfacing a bare 404, for the loopback flow", async () => {
    fetchSpy.mockImplementation(async () => jsonResponse(404, { error: "Not found" }));

    const options = baseOptions({ startLoopbackListener: async () => fakeListener({}) });

    await expect(runBrowserLogin(options)).rejects.toBeInstanceOf(UnsupportedServerError);
    await expect(runBrowserLogin(baseOptions({ startLoopbackListener: async () => fakeListener({}) }))).rejects.toThrow(/--accessKey/);
  });

  it("says so for the device flow too", async () => {
    fetchSpy.mockImplementation(async () => jsonResponse(404, { error: "Not found" }));

    await expect(runBrowserLogin(baseOptions({ forceDeviceFlow: true }))).rejects.toBeInstanceOf(UnsupportedServerError);
  });
});

describe("network failure", () => {
  it("explains that the server could not be reached", async () => {
    fetchSpy.mockRejectedValue(new TypeError("network down"));

    await expect(runBrowserLogin(baseOptions({ forceDeviceFlow: true }))).rejects.toThrow(/Unable to reach Aether/);
  });
});
