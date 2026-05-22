// Copyright (c) Aether. All rights reserved.

import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as jwt from "jsonwebtoken";

import sign from "../script/sign";
import * as hashUtils from "../script/hash-utils";

function randomDirName(): string {
  return "aether-sign-test-" + crypto.randomBytes(6).toString("hex");
}

function generateRsaKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { privateKey, publicKey };
}

describe("sign", () => {
  let sandbox: string;
  let privateKeyPath: string;
  let publicKeyPem: string;
  let logSpy: jest.SpyInstance;

  beforeAll(() => {
    sandbox = path.join(os.tmpdir(), randomDirName());
    fs.mkdirSync(sandbox, { recursive: true });

    const { privateKey, publicKey } = generateRsaKeyPair();
    privateKeyPath = path.join(sandbox, "private-key.pem");
    fs.writeFileSync(privateKeyPath, privateKey);
    publicKeyPem = publicKey;
  });

  afterAll(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  beforeEach(() => {
    // sign() calls console.log on success paths — silence to keep test output clean.
    logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  describe("noop cases (no private key provided)", () => {
    it("resolves to null when privateKeyPath is empty string", async () => {
      const result = await sign("", "anything");
      expect(result).toBeNull();
    });

    it("resolves to null when privateKeyPath is undefined", async () => {
      const result = await sign(undefined as any, "anything");
      expect(result).toBeNull();
    });

    it("resolves to null when privateKeyPath is null", async () => {
      const result = await sign(null as any, "anything");
      expect(result).toBeNull();
    });
  });

  describe("input validation", () => {
    it("rejects with a descriptive error when the private key file does not exist", async () => {
      const missingKey = path.join(sandbox, "missing-private-key.pem");
      const updateDir = path.join(sandbox, "update-missing-key");
      fs.mkdirSync(updateDir);
      fs.writeFileSync(path.join(updateDir, "bundle.js"), "console.log('hi')");

      await expect(sign(missingKey, updateDir)).rejects.toThrow(/was not valid/);
    });

    it("rejects when updateContentsPath does not exist", async () => {
      const updateMissing = path.join(sandbox, "update-does-not-exist");
      await expect(sign(privateKeyPath, updateMissing)).rejects.toBeDefined();
    });
  });

  describe("signing a directory", () => {
    let updateDir: string;

    beforeEach(() => {
      updateDir = path.join(sandbox, "update-dir-" + crypto.randomBytes(4).toString("hex"));
      fs.mkdirSync(updateDir);
      fs.writeFileSync(path.join(updateDir, "bundle.js"), "console.log('app-v1')");
      fs.writeFileSync(path.join(updateDir, "asset.png"), "fake-png-bytes");
    });

    it("writes a .codepushrelease file containing a verifiable JWT", async () => {
      await sign(privateKeyPath, updateDir);

      const sigPath = path.join(updateDir, ".codepushrelease");
      expect(fs.existsSync(sigPath)).toBe(true);

      const signedToken = fs.readFileSync(sigPath, "utf8");

      // jwt.verify throws on tampered or wrongly-signed tokens — so a successful
      // verify proves the token was signed with the private key we generated.
      const decoded = jwt.verify(signedToken, publicKeyPem, { algorithms: ["RS256"] }) as any;

      expect(decoded.claimVersion).toBe("1.0.0");
      expect(typeof decoded.contentHash).toBe("string");
      expect(decoded.contentHash).toMatch(/^[a-f0-9]{64}$/); // sha256 hex
    });

    it("computes a contentHash equal to the directory hash", async () => {
      await sign(privateKeyPath, updateDir);

      const sigPath = path.join(updateDir, ".codepushrelease");
      const signedToken = fs.readFileSync(sigPath, "utf8");
      const decoded = jwt.verify(signedToken, publicKeyPem, { algorithms: ["RS256"] }) as any;

      // Delete the signature file so we can recompute the hash of the original
      // contents. sign() hashes the directory BEFORE writing the signature file,
      // so removing it restores the state that sign saw.
      fs.unlinkSync(sigPath);

      const recomputed = await hashUtils.generatePackageHashFromDirectory(updateDir, path.join(updateDir, ".."));

      expect(decoded.contentHash).toBe(recomputed);
    });

    it("overwrites an existing .codepushrelease when re-signing modified contents", async () => {
      // First signing
      await sign(privateKeyPath, updateDir);
      const sigPath = path.join(updateDir, ".codepushrelease");
      const firstToken = fs.readFileSync(sigPath, "utf8");
      const firstDecoded = jwt.verify(firstToken, publicKeyPem, { algorithms: ["RS256"] }) as any;

      // Modify the bundle so the next signing will produce a different contentHash
      fs.writeFileSync(path.join(updateDir, "bundle.js"), "console.log('app-v2')");

      // Re-sign — this exercises the prevSignatureExists=true branch and fs.unlink
      await sign(privateKeyPath, updateDir);
      const secondToken = fs.readFileSync(sigPath, "utf8");
      const secondDecoded = jwt.verify(secondToken, publicKeyPem, { algorithms: ["RS256"] }) as any;

      expect(secondToken).not.toBe(firstToken);
      expect(secondDecoded.contentHash).not.toBe(firstDecoded.contentHash);
      expect(secondDecoded.claimVersion).toBe("1.0.0");
    });
  });

  describe("signing a single file", () => {
    it("does not write a signature into the source directory", async () => {
      const sourceDir = path.join(sandbox, "single-source-" + crypto.randomBytes(4).toString("hex"));
      fs.mkdirSync(sourceDir);
      const sourceFile = path.join(sourceDir, "bundle.js");
      const sourceContents = "console.log('single-file-release')";
      fs.writeFileSync(sourceFile, sourceContents);

      await sign(privateKeyPath, sourceFile);

      // sign() should have copied the file to a temp dir and signed there — NOT in sourceDir.
      expect(fs.existsSync(path.join(sourceDir, ".codepushrelease"))).toBe(false);

      // The source file must be untouched
      expect(fs.readFileSync(sourceFile, "utf8")).toBe(sourceContents);
    });
  });

  describe("invalid private key", () => {
    it("rejects when the private key file contents are not a valid PEM", async () => {
      const garbageKey = path.join(sandbox, "garbage-key.pem");
      fs.writeFileSync(garbageKey, "this is not a valid pem private key, definitely not");

      const updateDir = path.join(sandbox, "update-invalid-key-" + crypto.randomBytes(4).toString("hex"));
      fs.mkdirSync(updateDir);
      fs.writeFileSync(path.join(updateDir, "bundle.js"), "x");

      await expect(sign(garbageKey, updateDir)).rejects.toThrow(/signing key/);
    });
  });
});
