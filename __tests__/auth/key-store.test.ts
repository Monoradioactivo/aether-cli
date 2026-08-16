import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import * as keyStore from "../../script/auth/key-store";

let home: string;
let savedHome: string | undefined;
let savedLocalAppData: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "aether-keystore-"));
  savedHome = process.env.HOME;
  savedLocalAppData = process.env.LOCALAPPDATA;
  process.env.HOME = home;
  delete process.env.LOCALAPPDATA;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = savedLocalAppData;
  fs.rmSync(home, { recursive: true, force: true });
});

function writeLegacyConfig(contents: unknown): void {
  fs.mkdirSync(path.join(home, ".aether"), { recursive: true });
  fs.writeFileSync(path.join(home, ".aether", "config.json"), JSON.stringify(contents));
}

describe("writeCredential", () => {
  it("keeps the secret in its own file and everything else in the config", () => {
    keyStore.writeCredential({
      accessKey: "the-secret",
      serverUrl: "https://api.aetherpush.com",
      credentialId: "cred-1",
      deviceId: "device-1",
      accountEmail: "user@example.com",
      preserveAccessKeyOnLogout: false,
    });

    const config = JSON.parse(fs.readFileSync(keyStore.getConfigPath(), "utf8"));
    const secret = JSON.parse(fs.readFileSync(keyStore.getCredentialPath(), "utf8"));

    expect(secret).toEqual({ accessKey: "the-secret" });
    expect(config).toEqual({
      serverUrl: "https://api.aetherpush.com",
      credentialId: "cred-1",
      deviceId: "device-1",
      accountEmail: "user@example.com",
      preserveAccessKeyOnLogout: false,
    });
    expect(JSON.stringify(config)).not.toContain("the-secret");
  });

  it("writes the credential file so only the owner can read it", () => {
    keyStore.writeCredential({ accessKey: "the-secret" });

    const mode = fs.statSync(keyStore.getCredentialPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("tightens the mode on a credential file that was already world-readable", () => {
    keyStore.writeCredential({ accessKey: "first" });
    fs.chmodSync(keyStore.getCredentialPath(), 0o644);

    keyStore.writeCredential({ accessKey: "second" });

    expect(fs.statSync(keyStore.getCredentialPath()).mode & 0o777).toBe(0o600);
  });

  it("round-trips through readCredential", () => {
    keyStore.writeCredential({ accessKey: "the-secret", serverUrl: "https://example.com", credentialId: "cred-1" });

    expect(keyStore.readCredential()).toMatchObject({
      accessKey: "the-secret",
      serverUrl: "https://example.com",
      credentialId: "cred-1",
    });
  });
});

describe("readCredential", () => {
  it("returns null when nothing is stored", () => {
    expect(keyStore.readCredential()).toBeNull();
  });

  it("returns null when the config exists but holds no secret", () => {
    fs.mkdirSync(path.join(home, ".aether"), { recursive: true });
    fs.writeFileSync(keyStore.getConfigPath(), JSON.stringify({ deviceId: "device-1" }));

    expect(keyStore.readCredential()).toBeNull();
  });
});

describe("legacy config migration", () => {
  it("moves a pre-0.5 config into the split files and removes it", () => {
    writeLegacyConfig({
      accessKey: "legacy-secret",
      customServerUrl: "https://api.aetherpush.com",
      preserveAccessKeyOnLogout: true,
    });

    const migrated = keyStore.readCredential();

    expect(migrated).toMatchObject({
      accessKey: "legacy-secret",
      serverUrl: "https://api.aetherpush.com",
      preserveAccessKeyOnLogout: true,
    });
    // An older CLI reading a key-less config.json would refuse to log in while
    // every other command failed, so the file has to go rather than linger.
    expect(fs.existsSync(keyStore.getLegacyConfigPath())).toBe(false);
    expect(fs.statSync(keyStore.getCredentialPath()).mode & 0o777).toBe(0o600);
  });

  it("understands the even older accessKeyName shape", () => {
    writeLegacyConfig({ accessKeyName: "ancient-secret" });

    expect(keyStore.readCredential()).toMatchObject({ accessKey: "ancient-secret" });
  });

  it("discards a legacy config that carries no key at all", () => {
    writeLegacyConfig({ preserveAccessKeyOnLogout: true });

    expect(keyStore.readCredential()).toBeNull();
    expect(fs.existsSync(keyStore.getLegacyConfigPath())).toBe(false);
  });

  it("prefers the new credential file when both exist", () => {
    keyStore.writeCredential({ accessKey: "current-secret" });
    writeLegacyConfig({ accessKey: "stale-secret" });

    expect(keyStore.readCredential()!.accessKey).toBe("current-secret");
  });
});

describe("clearCredential", () => {
  it("removes the secret and the legacy file but remembers the machine", () => {
    keyStore.writeCredential({ accessKey: "the-secret", deviceId: "device-1", credentialId: "cred-1" });
    writeLegacyConfig({ accessKey: "stale" });

    keyStore.clearCredential();

    expect(fs.existsSync(keyStore.getCredentialPath())).toBe(false);
    expect(fs.existsSync(keyStore.getLegacyConfigPath())).toBe(false);
    expect(JSON.parse(fs.readFileSync(keyStore.getConfigPath(), "utf8"))).toEqual({ deviceId: "device-1" });
    expect(keyStore.readCredential()).toBeNull();
  });

  it("removes the config entirely when there is no device identity to keep", () => {
    keyStore.writeCredential({ accessKey: "the-secret" });

    keyStore.clearCredential();

    expect(fs.existsSync(keyStore.getConfigPath())).toBe(false);
  });
});

describe("readOrCreateDeviceId", () => {
  it("generates an id once and reuses it afterwards", () => {
    const generate = jest.fn().mockReturnValue("generated-device");

    const first = keyStore.readOrCreateDeviceId(generate);
    const second = keyStore.readOrCreateDeviceId(generate);

    expect(first).toBe("generated-device");
    expect(second).toBe("generated-device");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("survives a logout so the dashboard keeps seeing one device", () => {
    const deviceId = keyStore.readOrCreateDeviceId(() => "stable-device");
    keyStore.writeCredential({ accessKey: "the-secret", deviceId });

    keyStore.clearCredential();

    expect(keyStore.readOrCreateDeviceId(() => "different-device")).toBe("stable-device");
  });
});
