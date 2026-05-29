// Copyright (c) Aether. All rights reserved.

import { formatReleaseJson } from "../../script/utils/release-json";
import { Package } from "../../script/types";

describe("formatReleaseJson", () => {
  it("emits every documented field when the package is fully populated", () => {
    const pkg: Package = {
      label: "v3",
      packageHash: "9b8c7d6e5f4a3b2c",
      size: 1234567,
      appVersion: "1.0.0",
      blobUrl: "https://cdn.example.com/blob/abc",
      manifestBlobUrl: "https://cdn.example.com/manifest/abc",
      description: "Bug fixes [ci=github sha=abc1234]",
      releasedBy: "adrian@aetherpush.com",
      releaseMethod: "Upload",
      uploadTime: 1714867200000,
      rollout: 100,
      isMandatory: false,
      isDisabled: false,
    } as any;

    expect(JSON.parse(formatReleaseJson(pkg))).toEqual({
      label: "v3",
      packageHash: "9b8c7d6e5f4a3b2c",
      size: 1234567,
      appVersion: "1.0.0",
      blobUrl: "https://cdn.example.com/blob/abc",
      manifestBlobUrl: "https://cdn.example.com/manifest/abc",
      description: "Bug fixes [ci=github sha=abc1234]",
      releasedBy: "adrian@aetherpush.com",
      releaseMethod: "Upload",
      uploadTime: 1714867200000,
      rollout: 100,
      isMandatory: false,
      isDisabled: false,
    });
  });

  it("drops fields that are undefined on the source package", () => {
    const pkg: Package = {
      label: "v3",
      packageHash: "9b8c7d6e",
      size: 100,
      appVersion: "1.0.0",
      blobUrl: "https://cdn.example.com/blob/abc",
    } as any;

    expect(JSON.parse(formatReleaseJson(pkg))).toEqual({
      label: "v3",
      packageHash: "9b8c7d6e",
      size: 100,
      appVersion: "1.0.0",
      blobUrl: "https://cdn.example.com/blob/abc",
    });
  });

  it("emits a single line of compact JSON", () => {
    const pkg: Package = {
      label: "v3",
      packageHash: "x",
      size: 1,
      appVersion: "1.0.0",
      blobUrl: "u",
    } as any;
    expect(formatReleaseJson(pkg).includes("\n")).toBe(false);
  });
});
