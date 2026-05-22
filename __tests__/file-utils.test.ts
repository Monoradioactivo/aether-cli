// Copyright (c) Aether. All rights reserved.

import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import * as fileUtils from "../script/utils/file-utils";

function randomDirName(): string {
  return "aether-fileutils-test-" + crypto.randomBytes(6).toString("hex");
}

describe("file-utils", () => {
  let sandbox: string;

  beforeAll(() => {
    sandbox = path.join(os.tmpdir(), randomDirName());
    fs.mkdirSync(sandbox, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  describe("isBinaryOrZip", () => {
    it("returns true for .zip files", () => {
      expect(fileUtils.isBinaryOrZip("package.zip")).toBe(true);
      expect(fileUtils.isBinaryOrZip("/abs/path/to/release.zip")).toBe(true);
    });

    it("returns true for .apk files", () => {
      expect(fileUtils.isBinaryOrZip("app.apk")).toBe(true);
      expect(fileUtils.isBinaryOrZip("/abs/path/to/build.apk")).toBe(true);
    });

    it("returns true for .ipa files", () => {
      expect(fileUtils.isBinaryOrZip("app.ipa")).toBe(true);
      expect(fileUtils.isBinaryOrZip("/abs/path/to/build.ipa")).toBe(true);
    });

    it("is case-insensitive", () => {
      expect(fileUtils.isBinaryOrZip("package.ZIP")).toBe(true);
      expect(fileUtils.isBinaryOrZip("app.Apk")).toBe(true);
      expect(fileUtils.isBinaryOrZip("app.IPA")).toBe(true);
    });

    it("returns true for filenames that are just an extension", () => {
      // The regex matches anywhere the literal ".zip" appears at end-of-string,
      // so a bare ".zip" string also matches.
      expect(fileUtils.isBinaryOrZip(".zip")).toBe(true);
    });

    it("returns false for non-binary extensions", () => {
      expect(fileUtils.isBinaryOrZip("bundle.js")).toBe(false);
      expect(fileUtils.isBinaryOrZip("readme.md")).toBe(false);
      expect(fileUtils.isBinaryOrZip("Info.plist")).toBe(false);
    });

    it("returns false when the extension is not at the end of the path", () => {
      expect(fileUtils.isBinaryOrZip("file.zip.txt")).toBe(false);
      expect(fileUtils.isBinaryOrZip("path/to.apk/file")).toBe(false);
    });

    it("returns false for paths without an extension", () => {
      expect(fileUtils.isBinaryOrZip("noextension")).toBe(false);
      expect(fileUtils.isBinaryOrZip("")).toBe(false);
    });
  });

  describe("isDirectory", () => {
    it("returns true for an existing directory", () => {
      const dir = path.join(sandbox, "dir-yes");
      fs.mkdirSync(dir, { recursive: true });
      expect(fileUtils.isDirectory(dir)).toBe(true);
    });

    it("returns false for an existing regular file", () => {
      const file = path.join(sandbox, "file-yes.txt");
      fs.writeFileSync(file, "x");
      expect(fileUtils.isDirectory(file)).toBe(false);
    });

    it("throws when the path does not exist", () => {
      expect(() => fileUtils.isDirectory(path.join(sandbox, "does-not-exist"))).toThrow();
    });
  });

  describe("fileExists", () => {
    it("returns true for an existing regular file", () => {
      const file = path.join(sandbox, "exists.txt");
      fs.writeFileSync(file, "x");
      expect(fileUtils.fileExists(file)).toBe(true);
    });

    it("returns false for a directory", () => {
      const dir = path.join(sandbox, "dir-exists");
      fs.mkdirSync(dir, { recursive: true });
      expect(fileUtils.fileExists(dir)).toBe(false);
    });

    it("returns false (without throwing) for a nonexistent path", () => {
      expect(fileUtils.fileExists(path.join(sandbox, "missing.txt"))).toBe(false);
    });
  });

  describe("copyFileToTmpDir", () => {
    it("copies a file to a fresh tmp directory and returns that directory's path", () => {
      const sourceFile = path.join(sandbox, "to-copy.txt");
      const sourceContents = "contents-of-the-source-file";
      fs.writeFileSync(sourceFile, sourceContents);

      const outputDir = fileUtils.copyFileToTmpDir(sourceFile);

      expect(outputDir).toBeDefined();
      expect(fs.statSync(outputDir!).isDirectory()).toBe(true);

      const copiedPath = path.join(outputDir!, path.basename(sourceFile));
      expect(fs.existsSync(copiedPath)).toBe(true);
      expect(fs.readFileSync(copiedPath, "utf8")).toBe(sourceContents);

      // Cleanup
      fs.rmSync(outputDir!, { recursive: true, force: true });
    });

    it("returns undefined when given a directory instead of a file", () => {
      const dir = path.join(sandbox, "dir-skip-copy");
      fs.mkdirSync(dir, { recursive: true });
      expect(fileUtils.copyFileToTmpDir(dir)).toBeUndefined();
    });

    it("returns a different output directory on each call", () => {
      const sourceFile = path.join(sandbox, "to-copy-twice.txt");
      fs.writeFileSync(sourceFile, "x");

      const out1 = fileUtils.copyFileToTmpDir(sourceFile);
      const out2 = fileUtils.copyFileToTmpDir(sourceFile);

      expect(out1).toBeDefined();
      expect(out2).toBeDefined();
      expect(out1).not.toBe(out2);

      fs.rmSync(out1!, { recursive: true, force: true });
      fs.rmSync(out2!, { recursive: true, force: true });
    });
  });

  describe("fileDoesNotExistOrIsDirectory", () => {
    it("returns true for a directory", () => {
      const dir = path.join(sandbox, "dir-truthy");
      fs.mkdirSync(dir, { recursive: true });
      expect(fileUtils.fileDoesNotExistOrIsDirectory(dir)).toBe(true);
    });

    it("returns true for a nonexistent path", () => {
      expect(fileUtils.fileDoesNotExistOrIsDirectory(path.join(sandbox, "missing"))).toBe(true);
    });

    it("returns false for an existing regular file", () => {
      const file = path.join(sandbox, "real-file.txt");
      fs.writeFileSync(file, "x");
      expect(fileUtils.fileDoesNotExistOrIsDirectory(file)).toBe(false);
    });
  });

  describe("normalizePath", () => {
    it("converts backslashes to forward slashes", () => {
      expect(fileUtils.normalizePath("a\\b\\c.txt")).toBe("a/b/c.txt");
    });

    it("leaves forward-slash paths unchanged", () => {
      expect(fileUtils.normalizePath("a/b/c.txt")).toBe("a/b/c.txt");
    });

    it("converts mixed separators consistently", () => {
      expect(fileUtils.normalizePath("a\\b/c\\d.txt")).toBe("a/b/c/d.txt");
    });

    it("returns an empty string unchanged", () => {
      expect(fileUtils.normalizePath("")).toBe("");
    });

    it("does not modify a path with no separators", () => {
      expect(fileUtils.normalizePath("filename.txt")).toBe("filename.txt");
    });
  });
});
