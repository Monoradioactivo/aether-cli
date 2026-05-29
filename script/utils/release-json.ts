// Copyright (c) Aether. All rights reserved.

import { Package } from "../types";

export function formatReleaseJson(pkg: Package): string {
  return JSON.stringify({
    label: pkg.label,
    packageHash: pkg.packageHash,
    size: pkg.size,
    appVersion: pkg.appVersion,
    blobUrl: pkg.blobUrl,
    manifestBlobUrl: pkg.manifestBlobUrl,
    description: pkg.description,
    releasedBy: pkg.releasedBy,
    releaseMethod: pkg.releaseMethod,
    uploadTime: pkg.uploadTime,
    rollout: pkg.rollout,
    isMandatory: pkg.isMandatory,
    isDisabled: pkg.isDisabled,
  });
}
