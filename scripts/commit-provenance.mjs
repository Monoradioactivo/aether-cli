export const DEFAULT_TRUSTED_SIGNERS = ["Monoradioactivo"];
export const DEFAULT_VERIFIED_LABEL = "brief-verified";
export const DEFAULT_LABEL_ACTOR_ALLOWLIST = ["Monoradioactivo"];
export const DEFAULT_RELEASE_BOT_LOGIN = "aetherpush-release-bot[bot]";
export const PROTECTED_BRANCH = "main";
export const WEB_FLOW_LOGIN = "web-flow";
export const RELEASE_BRANCH_PREFIX = "release-please--branches--main";
export const RELEASE_CONFIG = "release-please-config.json";
export const REVENDOR_BRANCH = "chore/openapi-revendor";
export const REVENDOR_PATH = "openapi/openapi.yaml";
export const REVENDOR_SOURCE_URL = "https://api-staging.aetherpush.com/openapi.yaml";
export const VERSION_MARKER = "x-release-please-version";
export const VOUCH_RUN_NAME = "Commit provenance";
export const VOUCH_WORKFLOW_PATH = ".github/workflows/commit-provenance.yml";
export const VERSION_BLOCK_START = "x-release-please-start-version";
export const VERSION_BLOCK_END = "x-release-please-end";
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

export function vouchRunTitle(pullNumber, action, label) {
  return `${VOUCH_RUN_NAME} #${pullNumber} ${action} ${label}`.trim();
}

function ordinal(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function identifier(value) {
  return typeof value === "string" && value.length > 0 ? value : typeof value === "number" ? String(value) : null;
}

export function latestLabelEvent(labelEvents, label) {
  const matching = (Array.isArray(labelEvents) ? labelEvents : []).filter(
    (entry) =>
      entry?.label === label &&
      (entry?.action === "labeled" || entry?.action === "unlabeled") &&
      ordinal(entry?.id) !== null,
  );
  if (matching.length === 0) return null;
  return matching.reduce((newest, entry) => (ordinal(entry.id) > ordinal(newest.id) ? entry : newest));
}

export function latestVouchRun(runs, pullNumber, label) {
  const actions = new Map(
    ["labeled", "unlabeled"].map((action) => [vouchRunTitle(pullNumber, action, label), action]),
  );
  const matching = (Array.isArray(runs) ? runs : []).filter(
    (run) => actions.has(String(run?.title ?? "").trim()) && ordinal(run?.runNumber) !== null,
  );
  if (matching.length === 0) return null;
  const newest = matching.reduce((best, run) => (ordinal(run.runNumber) > ordinal(best.runNumber) ? run : best));
  return { ...newest, action: actions.get(String(newest.title).trim()) };
}

export function judgeStandingVouch({
  pullNumber,
  headSha,
  runId,
  labels,
  labelEvents,
  runs,
  unread,
  workflowMismatch,
  label = DEFAULT_VERIFIED_LABEL,
  actors = DEFAULT_LABEL_ACTOR_ALLOWLIST,
}) {
  if (unread) return { ok: false, reason: `the ${label} vouch on this pull request could not be read: ${unread}` };
  if (workflowMismatch) return { ok: false, reason: workflowMismatch };
  if (identifier(pullNumber) === null || identifier(headSha) === null) {
    return { ok: false, reason: `the ${label} vouch needs the pull request number and the head it is judging` };
  }
  if (!(Array.isArray(labels) && labels.includes(label))) {
    return { ok: false, reason: `the pull request does not carry the ${label} label` };
  }

  const event = latestLabelEvent(labelEvents, label);
  if (event === null) return { ok: false, reason: `no ${label} label event is recorded on this pull request` };
  if (event.action !== "labeled") return { ok: false, reason: `the newest ${label} label event removed the label` };
  if (!actors.includes(event.actor)) {
    return { ok: false, reason: `the newest ${label} label event was sent by ${event.actor ?? "an unknown account"}` };
  }

  if (identifier(runId) === null || !(Array.isArray(runs) && runs.some((run) => identifier(run?.id) === identifier(runId)))) {
    return { ok: false, reason: `this run is missing from the ${VOUCH_RUN_NAME} runs of this branch, so their order cannot be trusted` };
  }
  const run = latestVouchRun(runs, pullNumber, label);
  if (run === null) {
    return { ok: false, reason: `no ${VOUCH_RUN_NAME} run on this branch records a ${label} label event on this pull request` };
  }
  if (run.action !== "labeled") return { ok: false, reason: `the newest ${label} run on this branch removed the label` };
  if (!actors.includes(run.actor)) {
    return { ok: false, reason: `the newest ${label} run on this branch was started by ${run.actor ?? "an unknown account"}` };
  }
  if (identifier(run.headSha) === null || run.headSha !== headSha) {
    return { ok: false, reason: `the ${label} label was applied to ${short(run.headSha) || "another head"}, not to ${short(headSha)}` };
  }
  return { ok: true, actor: event.actor };
}

export function isReleasePullRequest(pullRequest, releaseBotLogin = DEFAULT_RELEASE_BOT_LOGIN) {
  return pullRequest?.author === releaseBotLogin && String(pullRequest?.headRef ?? "").startsWith(RELEASE_BRANCH_PREFIX);
}

export function isRevendorPullRequest(pullRequest, releaseBotLogin = DEFAULT_RELEASE_BOT_LOGIN) {
  return pullRequest?.author === releaseBotLogin && pullRequest?.headRef === REVENDOR_BRANCH;
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

export function versionMarkedLines(lines) {
  const marked = new Set();
  let inBlock = false;
  lines.forEach((line, index) => {
    if (line.includes(VERSION_BLOCK_START)) {
      inBlock = true;
    } else if (line.includes(VERSION_BLOCK_END)) {
      inBlock = false;
    } else if (inBlock || line.includes(VERSION_MARKER)) {
      marked.add(index);
    }
  });
  return { marked, unterminated: inBlock };
}

function versionLinesReason(path, base, head, newVersion) {
  if (base === null || head === null) return `${path} is added or removed`;
  const baseLines = base.split("\n");
  const headLines = head.split("\n");
  if (baseLines.length !== headLines.length) return `${path} changes its line count`;
  const { marked, unterminated } = versionMarkedLines(baseLines);
  if (unterminated) return `${path} opens a ${VERSION_BLOCK_START} block that no ${VERSION_BLOCK_END} closes`;
  for (let i = 0; i < headLines.length; i++) {
    if (headLines[i] === baseLines[i]) continue;
    if (!marked.has(i)) {
      return `${path}:${i + 1} changes a line that carries no ${VERSION_MARKER} marker and sits in no ${VERSION_BLOCK_START} block`;
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

function releaseVersions(read) {
  if (read("package.json", "base") !== null) {
    return {
      source: "package.json",
      oldVersion: parseJson(read("package.json", "base"))?.version,
      newVersion: parseJson(read("package.json", "head"))?.version,
    };
  }
  return {
    source: RELEASE_MANIFEST,
    oldVersion: parseJson(read(RELEASE_MANIFEST, "base"))?.["."],
    newVersion: parseJson(read(RELEASE_MANIFEST, "head"))?.["."],
  };
}

export function releaseFootprintReasons({ changes, read, extraFiles = [] }) {
  const { source, oldVersion, newVersion } = releaseVersions(read);
  const reasons = [];
  if (!isNextVersion(oldVersion, newVersion)) {
    reasons.push(`${source} moves the version from ${oldVersion} to ${newVersion}, which is not the next patch, minor or major`);
  }
  for (const change of changes) {
    const reason = changeReason(change, { read, extraFiles, newVersion });
    if (reason) reasons.push(reason);
  }
  return reasons;
}

export function revendorFootprintReasons(changes) {
  const reasons = changes
    .filter((change) => !(change.path === REVENDOR_PATH && change.status === "M"))
    .map((change) => `${change.path} is outside the re-vendor footprint, which is a modified ${REVENDOR_PATH} alone`);
  if (!changes.some((change) => change.path === REVENDOR_PATH && change.status === "M")) {
    reasons.push(`the re-vendor pull request does not modify ${REVENDOR_PATH}`);
  }
  return reasons;
}

export function compareRevendorSource({ head, source, error, baseBlob, mainBlob }) {
  if (typeof baseBlob !== "string" || baseBlob !== mainBlob) {
    return `${REVENDOR_PATH} on main (${short(mainBlob) || "absent"}) differs from the pull request's base (${short(baseBlob) || "absent"}), so a squash would land a merge the check did not compare`;
  }
  if (error) return `could not read ${REVENDOR_SOURCE_URL}: ${error}`;
  if (!Buffer.isBuffer(head)) return `${REVENDOR_PATH} is missing at the head`;
  if (!Buffer.isBuffer(source) || !source.equals(head)) {
    return `${REVENDOR_PATH} at the head (${head.length} bytes) differs from ${REVENDOR_SOURCE_URL} (${Buffer.isBuffer(source) ? source.length : 0} bytes)`;
  }
  return null;
}

function refused(reason) {
  return { ok: false, via: null, reasons: [reason], commits: [] };
}

function footprintVerdict(classified, footprint, via) {
  const untrusted = classified.filter((entry) => !entry.ok && !entry.webFlow);
  if (untrusted.length === 0 && footprint.length === 0) {
    return { ok: true, via, reasons: [], commits: classified };
  }
  return {
    ok: false,
    via: null,
    reasons: [...untrusted.map((entry) => entry.reason), ...footprint],
    commits: classified,
  };
}

export function judgePullRequest({
  baseRef,
  pullRequest,
  event,
  labels = [],
  labelsMayBeStale = false,
  resolveVouch = null,
  commits,
  totalCommits,
  gitCommitShas,
  changes,
  read,
  releaseConfigured = false,
  revendorSourceReason = `the vendored spec was not compared with ${REVENDOR_SOURCE_URL}`,
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
  if (!labelsMayBeStale && isLabelVouch(event, label, labelActors)) {
    return { ok: true, via: `${label} label applied by ${event.sender}`, reasons: [], commits: classified };
  }
  const pullNumber = pullRequest?.number;
  const headSha = pullRequest?.headSha;
  const standing =
    (labels.includes(label) || labelsMayBeStale) && resolveVouch
      ? judgeStandingVouch({
          ...resolveVouch({ pullNumber, headSha }),
          pullNumber,
          headSha,
          label,
          actors: labelActors,
        })
      : null;
  if (standing?.ok) {
    return { ok: true, via: `${label} label applied by ${standing.actor}`, reasons: [], commits: classified };
  }

  if (isReleasePullRequest(pullRequest, releaseBotLogin)) {
    if (!releaseConfigured) {
      return {
        ok: false,
        via: null,
        reasons: [`${PROTECTED_BRANCH} carries no ${RELEASE_CONFIG}, so this repository has no release pull request to recognise`],
        commits: classified,
      };
    }
    return footprintVerdict(
      classified,
      releaseFootprintReasons({ changes, read, extraFiles }),
      "release pull request inside the release-please footprint",
    );
  }
  if (isRevendorPullRequest(pullRequest, releaseBotLogin)) {
    const footprint = revendorFootprintReasons(changes);
    if (revendorSourceReason) footprint.push(revendorSourceReason);
    return footprintVerdict(classified, footprint, `re-vendor pull request whose ${REVENDOR_PATH} matches ${REVENDOR_SOURCE_URL}`);
  }
  const reasons = classified.filter((entry) => !entry.ok).map((entry) => entry.reason);
  if (standing) reasons.push(standing.reason);
  return { ok: false, via: null, reasons, commits: classified };
}
