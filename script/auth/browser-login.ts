import { generatePkcePair, generateState } from "./pkce";
import { openBrowser as defaultOpenBrowser } from "./browser-launcher";
import { LoopbackListener, startLoopbackListener as defaultStartLoopbackListener } from "./loopback-listener";

export interface BrowserLoginResult {
  accessKey: string;
  expires: number;
  credentialId?: string;
  email?: string;
}

export interface BrowserLoginOptions {
  serverUrl: string;
  deviceId: string;
  deviceName: string;
  clientVersion: string;
  clientPlatform: string;
  headers: Record<string, string>;
  log: (message: string) => void;
  /** Skip the loopback attempt and go straight to the printed code. */
  forceDeviceFlow?: boolean;
  openBrowser?: (url: string) => boolean;
  startLoopbackListener?: () => Promise<LoopbackListener>;
  sleep?: (ms: number) => Promise<void>;
}

/** Raised when the server predates browser login, so the CLI can say so plainly. */
export class UnsupportedServerError extends Error {
  constructor(serverUrl: string) {
    super(
      `${serverUrl} does not support browser sign-in. Update the Aether server, ` +
        `or sign in with a key: aether login --accessKey <key>`
    );
  }
}

export class AuthorizationDeniedError extends Error {
  constructor() {
    super("Authorization was denied in the browser.");
  }
}

export class AuthorizationExpiredError extends Error {
  constructor() {
    super("The authorization request expired. Run 'aether login' again.");
  }
}

const LOOPBACK_TIMEOUT_MS = 10 * 60 * 1000;
const SLOW_DOWN_STEP_SECONDS = 5;

interface ApiResponse {
  status: number;
  body: any;
}

async function post(serverUrl: string, path: string, body: unknown, headers: Record<string, string>): Promise<ApiResponse> {
  let response: Response;
  try {
    response = await fetch(`${serverUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(`Unable to reach Aether at ${serverUrl}. Are you offline, or behind a firewall or proxy?`);
  }

  const parsed = await response.json().catch(() => ({}));
  return { status: response.status, body: parsed };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runBrowserLogin(options: BrowserLoginOptions): Promise<BrowserLoginResult> {
  if (options.forceDeviceFlow) {
    return runDeviceFlow(options);
  }

  const startListener = options.startLoopbackListener || defaultStartLoopbackListener;

  let listener: LoopbackListener;
  try {
    listener = await startListener();
  } catch {
    options.log("Could not open a local callback port; switching to code entry.");
    return runDeviceFlow(options);
  }

  try {
    return await runLoopbackFlow(options, listener);
  } finally {
    listener.close();
  }
}

async function runLoopbackFlow(options: BrowserLoginOptions, listener: LoopbackListener): Promise<BrowserLoginResult> {
  const { verifier, challenge } = generatePkcePair();
  const state = generateState();

  const started = await post(
    options.serverUrl,
    "/v1/auth/cli/authorizations",
    {
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      redirectUri: listener.redirectUri,
      state,
      deviceId: options.deviceId,
      deviceName: options.deviceName,
      clientName: "aether-cli",
      clientVersion: options.clientVersion,
      clientPlatform: options.clientPlatform,
    },
    options.headers
  );

  if (started.status === 404) {
    throw new UnsupportedServerError(options.serverUrl);
  }
  if (started.status !== 201) {
    throw new Error(started.body?.error || `Could not start browser sign-in (HTTP ${started.status}).`);
  }

  const authorizeUrl: string = started.body.authorizeUrl;
  if (typeof authorizeUrl !== "string" || authorizeUrl.length === 0) {
    throw new Error("The server did not return an address to authorize at.");
  }

  options.log("Opening Aether in your browser...");
  if (!(options.openBrowser || defaultOpenBrowser)(authorizeUrl)) {
    // The docs promise this fallback, and a machine with no opener is exactly
    // the machine that needs it.
    options.log("Could not open a browser on this machine; switching to code entry.");
    return runDeviceFlow(options);
  }
  options.log(`If nothing opens, visit:\n${authorizeUrl}`);
  options.log("Waiting for authorization...");

  const callback = await listener.waitForCallback(LOOPBACK_TIMEOUT_MS);

  // State is checked first, including on the failure path: a response carrying
  // someone else's outcome is not worth acting on either way.
  if (callback.state !== state) {
    throw new Error("The browser returned an authorization response that does not match this sign-in. Nothing was exchanged.");
  }
  if (callback.error === "access_denied") {
    throw new AuthorizationDeniedError();
  }
  if (callback.error) {
    throw new Error(`The browser reported ${callback.error}. Run 'aether login' again.`);
  }
  if (!callback.code) {
    throw new Error("The browser did not return an authorization code.");
  }

  const exchanged = await post(
    options.serverUrl,
    "/v1/auth/cli/token",
    {
      grantType: "authorization_code",
      code: callback.code,
      codeVerifier: verifier,
      redirectUri: listener.redirectUri,
    },
    options.headers
  );

  if (exchanged.status !== 200) {
    throw new Error(describeTokenError(exchanged.body));
  }

  return toResult(exchanged.body);
}

async function runDeviceFlow(options: BrowserLoginOptions): Promise<BrowserLoginResult> {
  const sleep = options.sleep || defaultSleep;

  const started = await post(
    options.serverUrl,
    "/v1/auth/cli/device",
    {
      deviceId: options.deviceId,
      deviceName: options.deviceName,
      clientName: "aether-cli",
      clientVersion: options.clientVersion,
      clientPlatform: options.clientPlatform,
    },
    options.headers
  );

  if (started.status === 404) {
    throw new UnsupportedServerError(options.serverUrl);
  }
  if (started.status !== 201) {
    throw new Error(started.body?.error || `Could not start device sign-in (HTTP ${started.status}).`);
  }

  const deviceCode: string = started.body.device_code;
  const userCode: string = started.body.user_code;
  const verificationUri: string = started.body.verification_uri;
  if (!deviceCode || !userCode || !verificationUri) {
    throw new Error("The server did not return a usable device authorization.");
  }
  const expiresInSeconds: number = typeof started.body.expires_in === "number" ? started.body.expires_in : 600;
  let intervalSeconds: number = typeof started.body.interval === "number" && started.body.interval > 0 ? started.body.interval : 5;

  options.log(`Open:\n${verificationUri}\n\nEnter code:\n${userCode}`);
  (options.openBrowser || defaultOpenBrowser)(started.body.verification_uri_complete || verificationUri);
  options.log("Waiting for authorization...");

  const deadline = Date.now() + expiresInSeconds * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalSeconds * 1000);

    let polled: ApiResponse;
    try {
      polled = await post(options.serverUrl, "/v1/auth/cli/token", { grantType: "device_code", deviceCode }, options.headers);
    } catch {
      // A dropped connection or a server restart mid-ceremony is not a reason
      // to abandon a request the user may already have approved. Back off and
      // keep asking until the request itself expires.
      intervalSeconds += SLOW_DOWN_STEP_SECONDS;
      continue;
    }

    if (polled.status === 200) {
      return toResult(polled.body);
    }

    // Throttling and server faults are transient by definition, and neither
    // carries a device-flow code to branch on.
    if (polled.status === 429 || polled.status >= 500) {
      intervalSeconds += SLOW_DOWN_STEP_SECONDS;
      continue;
    }

    const error = polled.body?.error;
    if (error === "authorization_pending") {
      continue;
    }
    if (error === "slow_down") {
      intervalSeconds += SLOW_DOWN_STEP_SECONDS;
      continue;
    }
    if (error === "access_denied") {
      throw new AuthorizationDeniedError();
    }
    if (error === "expired_token") {
      throw new AuthorizationExpiredError();
    }
    throw new Error(describeTokenError(polled.body));
  }

  throw new AuthorizationExpiredError();
}

function describeTokenError(body: any): string {
  if (body?.error_description) {
    return body.error_description;
  }
  if (body?.error) {
    return `Sign-in failed: ${body.error}`;
  }
  return "Sign-in failed.";
}

function toResult(body: any): BrowserLoginResult {
  if (!body?.accessKey) {
    throw new Error("The server did not return a credential.");
  }
  return {
    accessKey: body.accessKey,
    expires: body.expires,
    credentialId: body.credentialId,
    email: body.account?.email,
  };
}
