// Copyright (c) Aether. All rights reserved.

import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import * as hashUtils from "../script/hash-utils";

const yazl: any = require("yazl");

const HASH_ALGORITHM = "sha256";

function sha256(content: string | Buffer): string {
  return crypto.createHash(HASH_ALGORITHM).update(content).digest("hex");
}

function randomDirName(): string {
  return "aether-hash-test-" + crypto.randomBytes(6).toString("hex");
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function makeZip(filePath: string, entries: Array<[string, string]>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const zipfile = new yazl.ZipFile();
    for (const [name, content] of entries) {
      zipfile.addBuffer(Buffer.from(content), name);
    }
    zipfile.outputStream
      .pipe(fs.createWriteStream(filePath))
      .on("close", () => resolve())
      .on("error", reject);
    zipfile.end();
  });
}

describe("hash-utils", () => {
  let sandbox: string;

  beforeAll(() => {
    sandbox = path.join(os.tmpdir(), randomDirName());
    fs.mkdirSync(sandbox, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  describe("hashStream", () => {
    it("hashes a known stream to the expected sha256", async () => {
      const filePath = path.join(sandbox, "stream-known.txt");
      fs.writeFileSync(filePath, "hello world");
      const stream = fs.createReadStream(filePath);
      const hash = await hashUtils.hashStream(stream);
      expect(hash).toBe(sha256("hello world"));
    });

    it("hashes an empty stream", async () => {
      const filePath = path.join(sandbox, "stream-empty.txt");
      fs.writeFileSync(filePath, "");
      const stream = fs.createReadStream(filePath);
      const hash = await hashUtils.hashStream(stream);
      expect(hash).toBe(sha256(""));
    });

    it("rejects when the underlying stream errors", async () => {
      const stream = fs.createReadStream(path.join(sandbox, "does-not-exist.txt"));
      await expect(hashUtils.hashStream(stream)).rejects.toBeDefined();
    });
  });

  describe("hashFile", () => {
    it("hashes a file's contents to the expected sha256", async () => {
      const filePath = path.join(sandbox, "file-known.txt");
      fs.writeFileSync(filePath, "the quick brown fox");
      const hash = await hashUtils.hashFile(filePath);
      expect(hash).toBe(sha256("the quick brown fox"));
    });

    it("rejects when the file does not exist", async () => {
      await expect(hashUtils.hashFile(path.join(sandbox, "missing.txt"))).rejects.toBeDefined();
    });
  });

  describe("PackageManifest", () => {
    it("constructs with an empty map when no argument is passed", () => {
      const m = new hashUtils.PackageManifest();
      expect(m.toMap().size).toBe(0);
    });

    it("preserves the provided map", () => {
      const input = new Map<string, string>([["a.txt", "hash-a"]]);
      const m = new hashUtils.PackageManifest(input);
      expect(m.toMap().get("a.txt")).toBe("hash-a");
      expect(m.toMap().size).toBe(1);
    });

    it("computes a deterministic, alphabetically sorted package hash", async () => {
      const unsorted = new hashUtils.PackageManifest(
        new Map<string, string>([
          ["c.txt", "hash-c"],
          ["a.txt", "hash-a"],
          ["b.txt", "hash-b"],
        ])
      );
      const sorted = new hashUtils.PackageManifest(
        new Map<string, string>([
          ["a.txt", "hash-a"],
          ["b.txt", "hash-b"],
          ["c.txt", "hash-c"],
        ])
      );

      const hashUnsorted = await unsorted.computePackageHash();
      const hashSorted = await sorted.computePackageHash();

      expect(hashUnsorted).toBe(hashSorted);
      expect(hashSorted).toBe(sha256(JSON.stringify(["a.txt:hash-a", "b.txt:hash-b", "c.txt:hash-c"])));
    });

    it("computes a hash for an empty manifest", async () => {
      const m = new hashUtils.PackageManifest();
      const hash = await m.computePackageHash();
      expect(hash).toBe(sha256(JSON.stringify([])));
    });

    it("serializes to JSON and roundtrips via deserialize", () => {
      const input = new Map<string, string>([
        ["a.txt", "hash-a"],
        ["b.txt", "hash-b"],
      ]);
      const m = new hashUtils.PackageManifest(input);

      const serialized = m.serialize();
      const parsed = JSON.parse(serialized);
      expect(parsed).toEqual({ "a.txt": "hash-a", "b.txt": "hash-b" });

      const roundtripped = hashUtils.PackageManifest.deserialize(serialized);
      expect(roundtripped).toBeDefined();
      expect(roundtripped!.toMap().get("a.txt")).toBe("hash-a");
      expect(roundtripped!.toMap().get("b.txt")).toBe("hash-b");
      expect(roundtripped!.toMap().size).toBe(2);
    });

    it("returns undefined when deserializing malformed JSON", () => {
      const result = hashUtils.PackageManifest.deserialize("not-valid-json{");
      expect(result).toBeUndefined();
    });

    it("normalizes backslashes to forward slashes", () => {
      expect(hashUtils.PackageManifest.normalizePath("a\\b\\c.txt")).toBe("a/b/c.txt");
    });

    it("leaves forward slashes alone", () => {
      expect(hashUtils.PackageManifest.normalizePath("a/b/c.txt")).toBe("a/b/c.txt");
    });

    it("ignores __MACOSX/ paths", () => {
      expect(hashUtils.PackageManifest.isIgnored("__MACOSX/foo")).toBe(true);
      expect(hashUtils.PackageManifest.isIgnored("__MACOSX/nested/path/file")).toBe(true);
    });

    it("ignores root-level .DS_Store", () => {
      expect(hashUtils.PackageManifest.isIgnored(".DS_Store")).toBe(true);
    });

    it("ignores nested .DS_Store", () => {
      expect(hashUtils.PackageManifest.isIgnored("subdir/.DS_Store")).toBe(true);
      expect(hashUtils.PackageManifest.isIgnored("a/b/c/.DS_Store")).toBe(true);
    });

    it("does not ignore regular files", () => {
      expect(hashUtils.PackageManifest.isIgnored("index.js")).toBe(false);
      expect(hashUtils.PackageManifest.isIgnored("subdir/index.js")).toBe(false);
      expect(hashUtils.PackageManifest.isIgnored("README.md")).toBe(false);
    });

    it("does not ignore files whose name merely contains DS_Store", () => {
      // The check is for the exact filename ".DS_Store", not a substring.
      expect(hashUtils.PackageManifest.isIgnored("my.DS_Store.txt")).toBe(false);
    });
  });

  describe("generatePackageManifestFromDirectory", () => {
    it("hashes every file in a directory and returns a populated manifest", async () => {
      const dir = path.join(sandbox, "dir-basic");
      writeFile(path.join(dir, "a.txt"), "alpha");
      writeFile(path.join(dir, "b.txt"), "bravo");

      const manifest = await hashUtils.generatePackageManifestFromDirectory(dir, dir);
      const map = manifest.toMap();

      expect(map.size).toBe(2);
      expect(map.get("a.txt")).toBe(sha256("alpha"));
      expect(map.get("b.txt")).toBe(sha256("bravo"));
    });

    it("recursively hashes files in nested directories", async () => {
      const dir = path.join(sandbox, "dir-nested");
      writeFile(path.join(dir, "a.txt"), "alpha");
      writeFile(path.join(dir, "sub", "b.txt"), "bravo");
      writeFile(path.join(dir, "sub", "deeper", "c.txt"), "charlie");

      const manifest = await hashUtils.generatePackageManifestFromDirectory(dir, dir);
      const map = manifest.toMap();

      expect(map.size).toBe(3);
      expect(map.get("a.txt")).toBe(sha256("alpha"));
      expect(map.get("sub/b.txt")).toBe(sha256("bravo"));
      expect(map.get("sub/deeper/c.txt")).toBe(sha256("charlie"));
    });

    it("skips .DS_Store and __MACOSX/ entries", async () => {
      const dir = path.join(sandbox, "dir-ignored");
      writeFile(path.join(dir, "a.txt"), "alpha");
      writeFile(path.join(dir, ".DS_Store"), "junk");
      writeFile(path.join(dir, "sub", ".DS_Store"), "junk");
      writeFile(path.join(dir, "__MACOSX", "foo"), "junk");

      const manifest = await hashUtils.generatePackageManifestFromDirectory(dir, dir);
      const map = manifest.toMap();

      expect(map.size).toBe(1);
      expect(map.get("a.txt")).toBe(sha256("alpha"));
    });

    it("rejects when the directory is empty", async () => {
      const dir = path.join(sandbox, "dir-empty");
      fs.mkdirSync(dir, { recursive: true });

      await expect(hashUtils.generatePackageManifestFromDirectory(dir, dir)).rejects.toMatch(/no files were found/);
    });

    it("computes paths relative to the provided basePath", async () => {
      const base = path.join(sandbox, "dir-relative");
      const inner = path.join(base, "inner");
      writeFile(path.join(inner, "a.txt"), "alpha");

      const manifest = await hashUtils.generatePackageManifestFromDirectory(inner, base);
      const map = manifest.toMap();

      expect(map.size).toBe(1);
      expect(map.get("inner/a.txt")).toBe(sha256("alpha"));
    });
  });

  describe("generatePackageHashFromDirectory", () => {
    it("throws synchronously when path is not a directory", () => {
      const filePath = path.join(sandbox, "not-a-dir.txt");
      fs.writeFileSync(filePath, "x");
      expect(() => hashUtils.generatePackageHashFromDirectory(filePath, filePath)).toThrow(/Not a directory/);
    });

    it("returns the same hash as computing a manifest hash for the same directory", async () => {
      const dir = path.join(sandbox, "dir-hash");
      writeFile(path.join(dir, "a.txt"), "alpha");
      writeFile(path.join(dir, "b.txt"), "bravo");

      const directHash = await hashUtils.generatePackageHashFromDirectory(dir, dir);
      const manifest = await hashUtils.generatePackageManifestFromDirectory(dir, dir);
      const manifestHash = await manifest.computePackageHash();

      expect(directHash).toBe(manifestHash);
    });
  });

  describe("generatePackageManifestFromZip", () => {
    it("hashes every entry in a zip and returns a populated manifest", async () => {
      const zipPath = path.join(sandbox, "basic.zip");
      await makeZip(zipPath, [
        ["a.txt", "alpha"],
        ["b.txt", "bravo"],
      ]);

      const manifest = await hashUtils.generatePackageManifestFromZip(zipPath);
      const map = manifest.toMap();

      expect(map.size).toBe(2);
      expect(map.get("a.txt")).toBe(sha256("alpha"));
      expect(map.get("b.txt")).toBe(sha256("bravo"));
    });

    it("skips .DS_Store and __MACOSX/ entries inside a zip", async () => {
      const zipPath = path.join(sandbox, "ignored.zip");
      await makeZip(zipPath, [
        ["a.txt", "alpha"],
        [".DS_Store", "junk"],
        ["__MACOSX/foo", "junk"],
      ]);

      const manifest = await hashUtils.generatePackageManifestFromZip(zipPath);
      const map = manifest.toMap();

      expect(map.size).toBe(1);
      expect(map.get("a.txt")).toBe(sha256("alpha"));
    });

    it("normalizes backslash paths inside a zip", async () => {
      const zipPath = path.join(sandbox, "backslash.zip");
      // Zip entries with backslash names (atypical but possible).
      await makeZip(zipPath, [["sub\\nested\\a.txt", "alpha"]]);

      const manifest = await hashUtils.generatePackageManifestFromZip(zipPath);
      const map = manifest.toMap();

      expect(map.size).toBe(1);
      expect(map.get("sub/nested/a.txt")).toBe(sha256("alpha"));
    });

    it("returns null when the file is not a valid zip", async () => {
      const notZip = path.join(sandbox, "not-a-zip.txt");
      fs.writeFileSync(notZip, "this is just text, definitely not a zip header");

      const result = await hashUtils.generatePackageManifestFromZip(notZip);
      expect(result).toBeNull();
    });
  });
});
