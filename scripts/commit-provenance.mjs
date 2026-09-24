import {
  DEFAULT_LABEL_ACTOR_ALLOWLIST,
  DEFAULT_RELEASE_BOT_LOGIN,
  DEFAULT_VERIFIED_LABEL,
} from "./release-auto-merge-gate.mjs";

export const DEFAULT_TRUSTED_SIGNERS = ["Monoradioactivo"];
export const PROTECTED_BRANCH = "main";
export const WEB_FLOW_LOGIN = "web-flow";
export const RELEASE_BRANCH_PREFIX = "release-please--branches--main";
export const VERSION_MARKER = "x-release-please-version";
export const MAX_COMPARE_COMMITS = 250;

const SSH_SIGNATURE = "-----BEGIN SSH SIGNATURE-----";
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const SEMVER_TOKEN = /\d+\.\d+\.\d+/g;
const RELEASE_MANIFEST = ".release-please-manifest.json";

function short(sha) {
  return String(sha ?? "").slice(0, 7);
}

export function parseNameStatus(nameStatus, numstat) {
  const deletions = new Map();
  for (const line of numstat.split("\n")) {
    if (!line.trim()) continue;
    const [, removed, ...pathParts] = line.split("\t");
    deletions.set(pathParts.join("\t"), removed === "-" ? Number.NaN : Number(removed));
  }
  const changes = [];
  for (const line of nameStatus.split("\n")) {
    if (!line.trim()) continue;
    const [status, ...pathParts] = line.split("\t");
    const path = pathParts.join("\t");
    changes.push({ path, status: status.charAt(0), deletions: deletions.get(path) ?? Number.NaN });
  }
  return changes;
}

export function extraFilesFrom(config) {
  const entries = [
    ...(Array.isArray(config?.["extra-files"]) ? config["extra-files"] : []),
    ...(Array.isArray(config?.packages?.["."]?.["extra-files"]) ? config.packages["."]["extra-files"] : []),
  ];
  return entries
    .map((entry) => (typeof entry === "string" ? entry : entry?.path))
    .filter((path) => typeof path === "string" && path.length > 0);
}

function verificationOf(commit) {
  return commit?.commit?.verification ?? {};
}

function hasValidSignature(commit) {
  const verification = verificationOf(commit);
  return verification.verified === true && verification.reason === "valid";
}

export function isTrustedSignerCommit(commit, signers = DEFAULT_TRUSTED_SIGNERS) {
  if (!hasValidSignature(commit)) return false;
  if (!String(verificationOf(commit).signature ?? "").startsWith(SSH_SIGNATURE)) return false;
  const committer = commit?.committer?.login;
  return typeof committer === "string" && committer !== WEB_FLOW_LOGIN && signers.includes(committer);
}

export function isWebFlowCommit(commit) {
  return hasValidSignature(commit) && commit?.committer?.login === WEB_FLOW_LOGIN;
}

function isMergeShape(commit) {
  return isWebFlowCommit(commit) && Array.isArray(commit?.parents) && commit.parents.length === 2;
}

export function classifyCommit(commit, { signers = DEFAULT_TRUSTED_SIGNERS, isAncestorOfMain, mergeTreeOf }) {
  const sha = commit?.sha;
  if (isTrustedSignerCommit(commit, signers)) {
    return { sha, ok: true, via: "trusted signature" };
  }
  if (isMergeShape(commit)) {
    const [first, second] = commit.parents.map((parent) => parent.sha);
    if (!isAncestorOfMain(second)) {
      return { sha, ok: false, webFlow: true, reason: `merge commit ${short(sha)} brings in ${short(second)}, which is not on main` };
    }
    const cleanTree = mergeTreeOf(first, second);
    if (cleanTree === null) {
      return { sha, ok: false, webFlow: true, reason: `merge commit ${short(sha)} does not merge its parents cleanly` };
    }
    if (cleanTree !== commit?.commit?.tree?.sha) {
      return { sha, ok: false, webFlow: true, reason: `merge commit ${short(sha)} carries a tree that differs from a clean merge of its parents` };
    }
    return { sha, ok: true, via: "clean merge of main" };
  }
  return {
    sha,
    ok: false,
    webFlow: isWebFlowCommit(commit),
    reason: `commit ${short(sha)} is not signed by a trusted key`,
  };
}

export function isLabelVouch(event, label = DEFAULT_VERIFIED_LABEL, actors = DEFAULT_LABEL_ACTOR_ALLOWLIST) {
  return event?.action === "labeled" && event?.label === label && actors.includes(event?.sender);
}

export function isReleasePullRequest(pullRequest, releaseBotLogin = DEFAULT_RELEASE_BOT_LOGIN) {
  return pullRequest?.author === releaseBotLogin && String(pullRequest?.headRef ?? "").startsWith(RELEASE_BRANCH_PREFIX);
}

function parseVersion(version) {
  const match = SEMVER.exec(String(version ?? ""));
  return match ? match.slice(1).map(Number) : null;
}

export function isNextVersion(from, to) {
  const base = parseVersion(from);
  if (base === null || parseVersion(to) === null) return false;
  const [major, minor, patch] = base;
  return [`${major}.${minor}.${patch + 1}`, `${major}.${minor + 1}.0`, `${major + 1}.0.0`].includes(to);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function sameJson(a, b) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function parseJson(text) {
  if (text === null || text === undefined) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function withoutVersions(document, strip) {
  const copy = structuredClone(document);
  strip(copy);
  return copy;
}

function packageJsonReason(base, head, newVersion) {
  if (base === null || head === null) return "package.json is not valid JSON on both sides";
  if (head.version !== newVersion) return "package.json does not carry the new version";
  const strip = (doc) => {
    delete doc.version;
  };
  if (!sameJson(withoutVersions(base, strip), withoutVersions(head, strip))) {
    return "package.json changes more than its version";
  }
  return null;
}

function packageLockReason(base, head, newVersion) {
  if (base === null || head === null) return "package-lock.json is not valid JSON on both sides";
  if (head.version !== newVersion || head.packages?.[""]?.version !== newVersion) {
    return "package-lock.json does not carry the new version in both places";
  }
  const strip = (doc) => {
    delete doc.version;
    if (doc.packages?.[""]) delete doc.packages[""].version;
  };
  if (!sameJson(withoutVersions(base, strip), withoutVersions(head, strip))) {
    return "package-lock.json changes more than its two version fields";
  }
  return null;
}

function manifestReason(base, head, newVersion) {
  if (base === null || head === null) return `${RELEASE_MANIFEST} is not valid JSON on both sides`;
  if (head["."] !== newVersion) return `${RELEASE_MANIFEST} does not carry the new version`;
  const strip = (doc) => {
    delete doc["."];
  };
  if (!sameJson(withoutVersions(base, strip), withoutVersions(head, strip))) {
    return `${RELEASE_MANIFEST} changes more than the root version`;
  }
  return null;
}

function versionLinesReason(path, base, head, newVersion) {
  if (base === null || head === null) return `${path} is added or removed`;
  const baseLines = base.split("\n");
  const headLines = head.split("\n");
  if (baseLines.length !== headLines.length) return `${path} changes its line count`;
  for (let i = 0; i < headLines.length; i++) {
    if (headLines[i] === baseLines[i]) continue;
    if (!headLines[i].includes(VERSION_MARKER)) {
      return `${path}:${i + 1} changes a line that carries no ${VERSION_MARKER} marker`;
    }
    if (headLines[i].replace(SEMVER_TOKEN, "#") !== baseLines[i].replace(SEMVER_TOKEN, "#")) {
      return `${path}:${i + 1} changes more than the version`;
    }
    const tokens = headLines[i].match(SEMVER_TOKEN) ?? [];
    if (tokens.length === 0 || tokens.some((token) => token !== newVersion)) {
      return `${path}:${i + 1} does not carry ${newVersion}`;
    }
  }
  return null;
}

function changeReason(change, { read, extraFiles, newVersion }) {
  const { path, status, deletions } = change;
  if (path === "CHANGELOG.md") {
    if (status !== "M" && status !== "A") return "CHANGELOG.md is removed or changes type";
    if (deletions !== 0) return "CHANGELOG.md removes lines";
    return null;
  }
  if (status !== "M") return `${path} is added, removed or renamed`;
  const base = read(path, "base");
  const head = read(path, "head");
  if (path === "package.json") return packageJsonReason(parseJson(base), parseJson(head), newVersion);
  if (path === "package-lock.json") return packageLockReason(parseJson(base), parseJson(head), newVersion);
  if (path === RELEASE_MANIFEST) return manifestReason(parseJson(base), parseJson(head), newVersion);
  if (extraFiles.includes(path)) return versionLinesReason(path, base, head, newVersion);
  return `${path} is outside the release footprint`;
}

export function releaseFootprintReasons({ changes, read, extraFiles = [] }) {
  const oldVersion = parseJson(read("package.json", "base"))?.version;
  const newVersion = parseJson(read("package.json", "head"))?.version;
  const reasons = [];
  if (!isNextVersion(oldVersion, newVersion)) {
    reasons.push(`package.json moves the version from ${oldVersion} to ${newVersion}, which is not the next patch, minor or major`);
  }
  for (const change of changes) {
    const reason = changeReason(change, { read, extraFiles, newVersion });
    if (reason) reasons.push(reason);
  }
  return reasons;
}

function refused(reason) {
  return { ok: false, via: null, reasons: [reason], commits: [] };
}

export function judgePullRequest({
  baseRef,
  pullRequest,
  event,
  commits,
  totalCommits,
  gitCommitShas,
  changes,
  read,
  extraFiles = [],
  signers = DEFAULT_TRUSTED_SIGNERS,
  label = DEFAULT_VERIFIED_LABEL,
  labelActors = DEFAULT_LABEL_ACTOR_ALLOWLIST,
  releaseBotLogin = DEFAULT_RELEASE_BOT_LOGIN,
  isAncestorOfMain,
  mergeTreeOf,
}) {
  if (baseRef !== PROTECTED_BRANCH) {
    return refused(`the pull request targets ${baseRef}; the check judges pull requests into ${PROTECTED_BRANCH}`);
  }
  if (totalCommits > MAX_COMPARE_COMMITS || commits.length !== totalCommits) {
    return refused(
      `the pull request has ${totalCommits} commits and the check read ${commits.length}; it judges at most ${MAX_COMPARE_COMMITS}`,
    );
  }
  if (commits.length === 0) {
    return refused(`the pull request carries no commits ahead of ${PROTECTED_BRANCH}`);
  }
  const apiShas = new Set(commits.map((commit) => commit.sha));
  const gitShas = new Set(gitCommitShas);
  if (apiShas.size !== gitShas.size || [...gitShas].some((sha) => !apiShas.has(sha))) {
    return refused("the commits GitHub reports differ from the commits in the fetched history");
  }

  const classified = commits.map((commit) => classifyCommit(commit, { signers, isAncestorOfMain, mergeTreeOf }));
  if (classified.every((entry) => entry.ok)) {
    return { ok: true, via: "every commit is trusted", reasons: [], commits: classified };
  }
  if (isLabelVouch(event, label, labelActors)) {
    return { ok: true, via: `${label} label applied by ${event.sender}`, reasons: [], commits: classified };
  }

  const reasons = classified.filter((entry) => !entry.ok).map((entry) => entry.reason);
  if (isReleasePullRequest(pullRequest, releaseBotLogin)) {
    const untrusted = classified.filter((entry) => !entry.ok && !entry.webFlow);
    const footprint = releaseFootprintReasons({ changes, read, extraFiles });
    if (untrusted.length === 0 && footprint.length === 0) {
      return { ok: true, via: "release pull request inside the release-please footprint", reasons: [], commits: classified };
    }
    return {
      ok: false,
      via: null,
      reasons: [...untrusted.map((entry) => entry.reason), ...footprint],
      commits: classified,
    };
  }
  return { ok: false, via: null, reasons, commits: classified };
}
