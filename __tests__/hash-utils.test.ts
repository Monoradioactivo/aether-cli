// Copyright (c) Aether. All rights reserved.

import * as assert from "assert";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as q from "q";
import * as hashUtils from "../script/hash-utils";
const yauzl = require("yauzl");

import PackageManifest = hashUtils.PackageManifest;
import Promise = q.Promise;

function randomString(): string {
  const stringLength = 10;
  return crypto
    .randomBytes(Math.ceil(stringLength / 2))
    .toString("hex")
    .slice(0, stringLength);
}

function unzipToDirectory(zipPath: string, directoryPath: string): Promise<void> {
  const deferred: q.Deferred<void> = q.defer<void>();
  const originalCwd: string = process.cwd();

  fs.mkdirSync(directoryPath, { recursive: true });
  process.chdir(directoryPath);

  yauzl.open(zipPath, { lazyEntries: true }, (err: Error, zipfile: any) => {
    if (err) {
      deferred.reject(err);
      return;
    }
    zipfile.readEntry();
    zipfile.on("entry", (entry: any) => {
      if (/\/$/.test(entry.fileName)) {
        fs.mkdirSync(entry.fileName, { recursive: true });
        zipfile.readEntry();
      } else {
        zipfile.openReadStream(entry, (err: Error, readStream: any) => {
          if (err) {
            deferred.reject(err);
            return;
          }
          fs.mkdirSync(path.dirname(entry.fileName), { recursive: true });
          readStream.pipe(fs.createWriteStream(entry.fileName));
          readStream.on("end", () => zipfile.readEntry());
        });
      }
    });
    zipfile.on("end", (err: Error) => {
      if (err) deferred.reject(err);
      else deferred.resolve(undefined);
    });
  });

  return deferred.promise.finally(() => {
    process.chdir(originalCwd);
  });
}

describe("Hashing utility", () => {
  const TEST_DIRECTORY = path.join(os.tmpdir(), "aethertests", randomString());

  const TEST_ARCHIVE_FILE_PATH = path.join(__dirname, "..", "test", "resources", "test.zip");
  const TEST_ZIP_HASH = "540fed8df3553079e81d1353c5cc4e3cac7db9aea647a85d550f646e8620c317";
  const TEST_ZIP_MANIFEST_HASH = "9e0499ce7df5c04cb304c9deed684dc137fc603cb484a5b027478143c595d80b";
  const HASH_B = "3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d";
  const HASH_C = "2e7d2c03a9507ae265ecf5b5356885a53393a2029d241394997265a1a25aefc6";
  const HASH_D = "18ac3e7343f016890c510e93f935261169d9e3f565436429830faf0934f4f8e4";

  const IGNORED_METADATA_ARCHIVE_FILE_PATH = path.join(__dirname, "..", "test", "resources", "ignoredMetadata.zip");
  const INDEX_HASH = "b0693dc92f76e08bf1485b3dd9b514a2e31dfd6f39422a6b60edb722671dc98f";

  it("generates a package hash from file", () => {
    return hashUtils.hashFile(TEST_ARCHIVE_FILE_PATH).then((packageHash: string) => {
      assert.strictEqual(packageHash, TEST_ZIP_HASH);
    });
  });

  it("generates a package manifest for an archive", () => {
    return hashUtils.generatePackageManifestFromZip(TEST_ARCHIVE_FILE_PATH).then((manifest: PackageManifest) => {
      const fileHashesMap = manifest.toMap();
      assert.strictEqual(fileHashesMap.size, 3);
      assert.strictEqual(fileHashesMap.get("b.txt"), HASH_B);
      assert.strictEqual(fileHashesMap.get("c.txt"), HASH_C);
      assert.strictEqual(fileHashesMap.get("d.txt"), HASH_D);
    });
  });

  it("generates a package manifest for a directory", () => {
    const directory = path.join(TEST_DIRECTORY, "testZip");
    return unzipToDirectory(TEST_ARCHIVE_FILE_PATH, directory)
      .then(() => hashUtils.generatePackageManifestFromDirectory(directory, directory))
      .then((manifest: PackageManifest) => {
        const fileHashesMap = manifest.toMap();
        assert.strictEqual(fileHashesMap.size, 3);
        assert.strictEqual(fileHashesMap.get("b.txt"), HASH_B);
        assert.strictEqual(fileHashesMap.get("c.txt"), HASH_C);
        assert.strictEqual(fileHashesMap.get("d.txt"), HASH_D);
      });
  });

  it("generates a package hash from manifest", () => {
    return hashUtils
      .generatePackageManifestFromZip(TEST_ARCHIVE_FILE_PATH)
      .then((manifest: PackageManifest) => manifest.computePackageHash())
      .then((packageHash: string) => {
        assert.strictEqual(packageHash, TEST_ZIP_MANIFEST_HASH);
      });
  });

  it("generates a package manifest for an archive with ignorable metadata", () => {
    return hashUtils.generatePackageManifestFromZip(IGNORED_METADATA_ARCHIVE_FILE_PATH).then((manifest: PackageManifest) => {
      assert.strictEqual(manifest.toMap().size, 1);
      assert.strictEqual(manifest.toMap().get("www/index.html"), INDEX_HASH);
    });
  });

  it("generates a package manifest for a directory with ignorable metadata", () => {
    const directory = path.join(TEST_DIRECTORY, "ignorableMetadata");
    return unzipToDirectory(IGNORED_METADATA_ARCHIVE_FILE_PATH, directory)
      .then(() => hashUtils.generatePackageManifestFromDirectory(directory, directory))
      .then((manifest: PackageManifest) => {
        assert.strictEqual(manifest.toMap().size, 1);
        assert.strictEqual(manifest.toMap().get("www/index.html"), INDEX_HASH);
      });
  });
});
