import { execFileSync } from "node:child_process";
import { appendFileSync, realpathSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  buildVerdict,
  classifyCommit,
  DEFAULT_LABEL_ACTOR_ALLOWLIST,
  DEFAULT_RELEASE_BOT_LOGIN,
  DEFAULT_VERIFIED_LABEL,
  hasVerifiedTrailer,
  pickLatestTestConclusion,
  REQUIRED_TEST_CHECK,
  subjectOf,
} from "./release-auto-merge-gate.mjs";

const REPO = process.env.GITHUB_REPOSITORY;
const LABEL = process.env.VERIFIED_LABEL || DEFAULT_VERIFIED_LABEL;
const RELEASE_BOT_LOGIN = process.env.RELEASE_BOT_LOGIN || DEFAULT_RELEASE_BOT_LOGIN;
const LABEL_ACTORS = DEFAULT_LABEL_ACTOR_ALLOWLIST;

function gh(args, env = process.env) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    env,
  });
}

function ghJson(args, env = process.env) {
  const out = gh(args, env).trim();
  return out ? JSON.parse(out) : null;
}

function checksEnv() {
  if (!process.env.CHECKS_GH_TOKEN) return process.env;
  return { ...process.env, GH_TOKEN: process.env.CHECKS_GH_TOKEN };
}

export function versionFromPayloads({ manifest, packageJson }) {
  if (manifest && typeof manifest === "object") {
    const version = manifest["."] || Object.values(manifest)[0] || null;
    if (typeof version === "string") return version;
  }
  if (packageJson && typeof packageJson.version === "string") {
    return packageJson.version;
  }
  return null;
}

export function contentsFetchFailedAsMissing(text) {
  const body = String(text);
  return /\b404\b/.test(body) || /Not Found/i.test(body);
}

function fetchJsonFile(filePath, ref) {
  try {
    const encoded = encodeURIComponent(filePath);
    const raw = gh(["api", `repos/${REPO}/contents/${encoded}?ref=${ref}`, "--jq", ".content"]);
    return { json: JSON.parse(Buffer.from(raw.trim(), "base64").toString("utf8")) };
  } catch (err) {
    const text = `${err.stderr || ""}\n${err.message || ""}`;
    if (contentsFetchFailedAsMissing(text)) {
      return { missing: true };
    }
    return { error: true };
  }
}

function latestReleaseTag() {
  try {
    const tag = gh(["api", `repos/${REPO}/releases/latest`, "--jq", ".tag_name"]).trim();
    return tag || null;
  } catch {
    return null;
  }
}

function compareRange(baseTag) {
  try {
    const data = ghJson([
      "api",
      `repos/${REPO}/compare/${baseTag}...main`,
      "--jq",
      "{total: .total_commits, commits: [.commits[] | {sha: .sha, message: .commit.message}]}",
    ]);
    if (!data) return null;
    return { commits: data.commits || [], truncated: (data.total || 0) !== (data.commits || []).length };
  } catch {
    return null;
  }
}

function resolveTestOnHead(headSha) {
  try {
    const path = `repos/${REPO}/commits/${headSha}/check-runs?check_name=${encodeURIComponent(REQUIRED_TEST_CHECK)}&per_page=100`;
    const data = ghJson(
      [
        "api",
        path,
        "--jq",
        "{total: .total_count, runs: [.check_runs[] | {name: .name, app: (.app.slug // null), status: .status, conclusion: .conclusion, completed_at: .completed_at}]}",
      ],
      checksEnv(),
    );
    if (!data || !Array.isArray(data.runs)) {
      return { testUnread: true };
    }
    if (typeof data.total === "number" && data.total > data.runs.length) {
      return { testUnread: true };
    }
    return { testConclusion: pickLatestTestConclusion(data.runs) };
  } catch {
    return { testUnread: true };
  }
}

function labelEventsWith(prNumber, env) {
  const out = gh(
    [
      "api",
      "--paginate",
      `repos/${REPO}/issues/${prNumber}/events?per_page=100`,
      "--jq",
      `.[] | select(.event=="labeled" and .label.name==${JSON.stringify(LABEL)}) | {actor: (.actor.login // null), at: (.created_at // "")}`,
    ],
    env,
  ).trim();
  if (!out) return [];
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

function resolveLabelActor(prNumber) {
  const fallback = checksEnv();
  const envs = fallback === process.env ? [process.env] : [process.env, fallback];
  for (let i = 0; i < envs.length; i += 1) {
    try {
      const events = labelEventsWith(prNumber, envs[i]);
      if (events.length > 0) return { labelActor: events[events.length - 1].actor };
      console.error(
        `#${prNumber} carries the ${LABEL} label but no labeled event names it, so its applier cannot be established; a label renamed after it was applied looks like this`,
      );
      return { labelActorUnread: true };
    } catch (error) {
      console.error(
        `reading ${LABEL} events on #${prNumber} with token ${i + 1} of ${envs.length} failed: ${error && error.message ? error.message : error}`,
      );
    }
  }
  return { labelActorUnread: true };
}

const SQUASH_SUBJECT_PULL = /\(#([1-9][0-9]*)\)$/;
const GITHUB_WEB_FLOW_EMAIL = "noreply@github.com";

export function squashPullNumberOf(message) {
  const match = SQUASH_SUBJECT_PULL.exec(subjectOf(message == null ? "" : message).trim());
  return match ? Number(match[1]) : null;
}

export function isGitHubSquashCommit(commit) {
  return Boolean(
    commit &&
      commit.verified === true &&
      commit.committerEmail === GITHUB_WEB_FLOW_EMAIL &&
      typeof commit.tree === "string" &&
      commit.tree.length > 0 &&
      Array.isArray(commit.parents) &&
      commit.parents.length === 1 &&
      typeof commit.parents[0] === "string",
  );
}

export function isSquashOfHead(relation, squash) {
  return Boolean(
    relation && squash && relation.status === "diverged" && relation.mergeBase === squash.parents[0],
  );
}

function readNdjson(args) {
  const out = gh(args).trim();
  if (!out) return [];
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function resolveSquashedPullRequest(sha, commit) {
  const number = squashPullNumberOf(commit && commit.message != null ? commit.message : "");
  if (number === null) return { missing: true };
  const squash = ghJson([
    "api",
    `repos/${REPO}/git/commits/${sha}`,
    "--jq",
    "{tree: .tree.sha, parents: [.parents[].sha], verified: .verification.verified, committerEmail: .committer.email}",
  ]);
  if (!squash) return null;
  if (!isGitHubSquashCommit(squash)) return { missing: true };
  const pull = ghJson([
    "api",
    `repos/${REPO}/pulls/${number}`,
    "--jq",
    "{number: .number, merged: (.merged_at != null), base: .base.ref, headSha: .head.sha, labels: [.labels[].name], author: (.user.login // null)}",
  ]);
  if (!pull || !Array.isArray(pull.labels)) return null;
  if (pull.number !== number || pull.merged !== true || pull.base !== "main") return { missing: true };
  const pullCommits = readNdjson([
    "api",
    "--paginate",
    `repos/${REPO}/pulls/${number}/commits?per_page=100`,
    "--jq",
    ".[] | {sha: .sha, tree: .commit.tree.sha}",
  ]);
  const finalHeadMatches = pullCommits.some(
    (head) => head && typeof pull.headSha === "string" && head.sha === pull.headSha && head.tree === squash.tree,
  );
  if (!finalHeadMatches) return { missing: true };
  const heads = pullCommits.filter((head) => head && typeof head.sha === "string" && head.tree === squash.tree);
  for (const head of heads.reverse()) {
    const relation = ghJson([
      "api",
      `repos/${REPO}/compare/${sha}...${head.sha}`,
      "--jq",
      "{status: .status, mergeBase: .merge_base_commit.sha}",
    ]);
    if (isSquashOfHead(relation, squash)) {
      console.error(
        `commit ${sha.slice(0, 7)} belongs to no pull request; GitHub wrote it as the squash of #${number}, whose commit ${head.sha.slice(0, 7)} has the same tree on the same base`,
      );
      return { number, labels: pull.labels, headSha: head.sha, author: pull.author };
    }
  }
  return { missing: true };
}

const pullRequestCache = new Map();
function resolvePullRequest(sha, commit) {
  const cacheKey = `${sha}\0${commit && commit.message != null ? String(commit.message) : ""}`;
  if (pullRequestCache.has(cacheKey)) return pullRequestCache.get(cacheKey);
  let resolved;
  try {
    const prs = ghJson([
      "api",
      `repos/${REPO}/commits/${sha}/pulls`,
      "--jq",
      "[.[] | select(.merged_at != null) | {number: .number, labels: [.labels[].name], headSha: .head.sha, author: (.user.login // null)}]",
    ]);
    const pr = !Array.isArray(prs) ? null : prs.length === 0 ? resolveSquashedPullRequest(sha, commit) : prs[0];
    if (pr === null) {
      resolved = null;
    } else if (pr.missing) {
      resolved = { missing: true };
    } else {
      const labels = pr.labels;
      const commitHasTrailer = hasVerifiedTrailer(commit && commit.message != null ? commit.message : "");
      const labelVouch = !commitHasTrailer && Array.isArray(labels) && labels.includes(LABEL);
      const needsTest = commitHasTrailer || labelVouch;
      resolved = { number: pr.number, labels, author: pr.author };
      if (needsTest) {
        if (labelVouch) {
          Object.assign(resolved, resolveLabelActor(pr.number));
        }
        if (!pr.headSha) {
          resolved.testUnread = true;
        } else {
          Object.assign(resolved, resolveTestOnHead(pr.headSha));
        }
      }
    }
  } catch {
    resolved = null;
  }
  pullRequestCache.set(cacheKey, resolved);
  return resolved;
}

function versionFromRef(ref) {
  const manifest = fetchJsonFile(".release-please-manifest.json", ref);
  if (manifest.error) return null;
  if (!manifest.missing) {
    const fromManifest = versionFromPayloads({ manifest: manifest.json, packageJson: null });
    if (fromManifest) return fromManifest;
  }
  const pkg = fetchJsonFile("package.json", ref);
  if (pkg.error) return null;
  if (pkg.missing) return null;
  return versionFromPayloads({ manifest: null, packageJson: pkg.json });
}

export const HOLD_COMMENT_MARKER_PREFIX = "<!-- release-auto-merge-gate";

export function holdCommentMarker(reasons) {
  const digest = createHash("sha256").update(String(reasons ?? ""), "utf8").digest("hex").slice(0, 16);
  return `${HOLD_COMMENT_MARKER_PREFIX}:${digest} -->`;
}

function writeOutput(verdict, evaluatedHead = "") {
  if (!process.env.GITHUB_OUTPUT) return;
  const delimiter = `GATE_${randomUUID().replace(/-/g, "")}`;
  const reasons = verdict.reasons.length > 0 ? verdict.reasons.join("; ") : "every commit in the release is accounted for";
  const oneLine = reasons.replace(/[\r\n]+/g, " ");
  appendFileSync(process.env.GITHUB_OUTPUT, `ok=${verdict.ok}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `reasons<<${delimiter}\n${oneLine}\n${delimiter}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `marker=${holdCommentMarker(oneLine)}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `head=${evaluatedHead}\n`);
}

function main() {
  if (!REPO) {
    console.error("GITHUB_REPOSITORY is required");
    process.exit(2);
  }

  const releasePr = Number(process.argv[2] || 0);
  const baseTag = process.argv[3] || latestReleaseTag();

  let evaluatedHead = "";
  let currentVersion = null;
  let releaseVersion = null;
  let versionsRequired = false;
  if (releasePr) {
    versionsRequired = true;
    const pr = ghJson([
      "api",
      `repos/${REPO}/pulls/${releasePr}`,
      "--jq",
      "{head: .head.ref, base: .base.ref, sha: .head.sha}",
    ]);
    if (pr) {
      evaluatedHead = typeof pr.sha === "string" ? pr.sha : "";
      currentVersion = versionFromRef(pr.base);
      releaseVersion = versionFromRef(pr.head);
    }
  }

  let commits = [];
  let rangeTruncated = false;
  if (baseTag) {
    const range = compareRange(baseTag);
    if (range === null) {
      const verdict = buildVerdict({
        baseTag,
        commits: [],
        rangeTruncated: true,
        versionsRequired: false,
      });
      console.log(JSON.stringify(verdict, null, 2));
      writeOutput(verdict, evaluatedHead);
      return;
    }
    rangeTruncated = range.truncated;
    commits = range.commits.map((c) =>
      classifyCommit(c, (sha) => resolvePullRequest(sha, c), LABEL, LABEL_ACTORS, RELEASE_BOT_LOGIN),
    );
  }

  const verdict = buildVerdict({
    baseTag,
    commits,
    currentVersion,
    releaseVersion,
    label: LABEL,
    rangeTruncated,
    versionsRequired,
  });

  console.log(JSON.stringify(verdict, null, 2));
  writeOutput(verdict, evaluatedHead);
}

const entry = process.argv[1];
if (entry && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  main();
}
