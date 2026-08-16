import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Local credential storage.
 *
 * Two files, deliberately. The secret lives alone in a 0600 file; everything
 * else is plain state that is fine to read. The legacy `config.json` held both
 * at whatever the umask allowed, and is removed once its contents are carried
 * over: a CLI old enough to still read it would otherwise find a file with no
 * key in it and refuse to log in while every other command failed.
 *
 * The OS keychain backends drop in behind this module later; callers only ever
 * see the functions below.
 */

const DIRECTORY_NAME = ".aether";
const CONFIG_FILE = "cli.json";
const CREDENTIAL_FILE = "credentials.json";
const LEGACY_CONFIG_FILE = "config.json";
const SECRET_FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

export interface StoredCredential {
  accessKey: string;
  serverUrl?: string;
  credentialId?: string;
  deviceId?: string;
  accountEmail?: string;
  preserveAccessKeyOnLogout?: boolean;
}

interface ConfigFileShape {
  serverUrl?: string;
  credentialId?: string;
  deviceId?: string;
  accountEmail?: string;
  preserveAccessKeyOnLogout?: boolean;
}

interface CredentialFileShape {
  accessKey?: string;
}

/** The shape written by CLI 0.4.x and earlier. */
interface LegacyConfigShape {
  accessKey?: string;
  accessKeyName?: string;
  customServerUrl?: string;
  preserveAccessKeyOnLogout?: boolean;
}

function baseDirectory(): string {
  return path.join(process.env.LOCALAPPDATA || process.env.HOME || os.homedir(), DIRECTORY_NAME);
}

export function getConfigPath(): string {
  return path.join(baseDirectory(), CONFIG_FILE);
}

export function getCredentialPath(): string {
  return path.join(baseDirectory(), CREDENTIAL_FILE);
}

export function getLegacyConfigPath(): string {
  return path.join(baseDirectory(), LEGACY_CONFIG_FILE);
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, { encoding: "utf8" })) as T;
  } catch {
    return null;
  }
}

function writeJson(filePath: string, value: unknown, mode?: number): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
  // mkdirSync applies its mode only to directories it creates, so a ~/.aether
  // left behind by an older CLI keeps whatever the old umask gave it.
  try {
    fs.chmodSync(directory, DIRECTORY_MODE);
  } catch {
    // No POSIX mode to set here.
  }

  if (mode === undefined) {
    fs.writeFileSync(filePath, JSON.stringify(value), { encoding: "utf8" });
    return;
  }

  // O_NOFOLLOW refuses a symlink planted at the path, and narrowing the mode
  // before the write means the secret is never briefly world-readable in an
  // existing file.
  let flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC;
  if (typeof fs.constants.O_NOFOLLOW === "number") {
    flags |= fs.constants.O_NOFOLLOW;
  }
  const handle = fs.openSync(filePath, flags, mode);
  try {
    try {
      fs.fchmodSync(handle, mode);
    } catch {
      // Windows and some network filesystems have no POSIX mode to set.
    }
    fs.writeFileSync(handle, JSON.stringify(value), { encoding: "utf8" });
  } finally {
    fs.closeSync(handle);
  }
}

/** Returns false only when the file is still there afterwards. */
function removeFile(filePath: string): boolean {
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return !fs.existsSync(filePath);
  }
}

/**
 * Moves a pre-0.5 `config.json` into the split files. Returns what it found so
 * the caller can keep using it in the same run.
 */
export function migrateLegacyConfig(): StoredCredential | null {
  const legacy = readJson<LegacyConfigShape>(getLegacyConfigPath());
  if (!legacy) {
    return null;
  }

  const accessKey = legacy.accessKey || legacy.accessKeyName;
  if (!accessKey) {
    removeFile(getLegacyConfigPath());
    return null;
  }

  const credential: StoredCredential = {
    accessKey,
    serverUrl: legacy.customServerUrl,
    preserveAccessKeyOnLogout: legacy.preserveAccessKeyOnLogout,
    deviceId: readConfig().deviceId,
  };

  try {
    writeCredential(credential);
    if (!removeFile(getLegacyConfigPath())) {
      // The key is now in two places, one of them world-readable.
      console.warn(`[Aether] Could not delete ${getLegacyConfigPath()}. It still holds your access key; remove it by hand.`);
    }
  } catch {
    // A read-only home must not break every command. Serve the credential from
    // memory this run and try the migration again next time.
  }
  return credential;
}

function readConfig(): ConfigFileShape {
  return readJson<ConfigFileShape>(getConfigPath()) || {};
}

export function readCredential(): StoredCredential | null {
  const secret = readJson<CredentialFileShape>(getCredentialPath());
  if (!secret || !secret.accessKey) {
    return migrateLegacyConfig();
  }

  const config = readConfig();
  return {
    accessKey: secret.accessKey,
    serverUrl: config.serverUrl,
    credentialId: config.credentialId,
    deviceId: config.deviceId,
    accountEmail: config.accountEmail,
    preserveAccessKeyOnLogout: config.preserveAccessKeyOnLogout,
  };
}

export function writeCredential(credential: StoredCredential): void {
  const config: ConfigFileShape = {
    serverUrl: credential.serverUrl,
    credentialId: credential.credentialId,
    deviceId: credential.deviceId || readConfig().deviceId,
    accountEmail: credential.accountEmail,
    preserveAccessKeyOnLogout: credential.preserveAccessKeyOnLogout,
  };

  writeJson(getConfigPath(), config);
  writeJson(getCredentialPath(), { accessKey: credential.accessKey }, SECRET_FILE_MODE);
}

/**
 * Drops the secret and forgets the session, but keeps the machine identity so
 * the next sign-in shows up as the same device in the dashboard.
 */
export function clearCredential(): void {
  const deviceId = readConfig().deviceId;

  const removed = removeFile(getCredentialPath());
  removeFile(getLegacyConfigPath());

  if (deviceId) {
    writeJson(getConfigPath(), { deviceId });
  } else {
    removeFile(getConfigPath());
  }

  if (!removed) {
    throw new Error(`Could not delete ${getCredentialPath()}. Remove it by hand to finish signing out.`);
  }
}

export function readOrCreateDeviceId(generate: () => string): string {
  const config = readConfig();
  if (config.deviceId) {
    return config.deviceId;
  }

  const deviceId = generate();
  try {
    writeJson(getConfigPath(), { ...config, deviceId });
  } catch {
    // A home we cannot write to still gets a working sign-in; the machine just
    // shows up as a new device next time.
  }
  return deviceId;
}
