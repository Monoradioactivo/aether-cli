import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
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
} from "./release-auto-merge-gate.mjs";

const REPO = process.env.GITHUB_REPOSITORY;
const LABEL = process.env.VERIFIED_LABEL || DEFAULT_VERIFIED_LABEL;
const RELEASE_BOT_LOGIN = process.env.RELEASE_BOT_LOGIN || DEFAULT_RELEASE_BOT_LOGIN;
const configuredLabelActors = (process.env.VERIFIED_LABEL_ACTORS || "")
  .split(",")
  .map((actor) => actor.trim())
  .filter((actor) => actor.length > 0);
const LABEL_ACTORS = configuredLabelActors.length > 0 ? configuredLabelActors : DEFAULT_LABEL_ACTOR_ALLOWLIST;

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
    if (!Array.isArray(prs)) {
      resolved = null;
    } else if (prs.length === 0) {
      resolved = { missing: true };
    } else {
      const pr = prs[0];
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

function writeOutput(verdict) {
  if (!process.env.GITHUB_OUTPUT) return;
  const delimiter = `GATE_${randomUUID().replace(/-/g, "")}`;
  const reasons = verdict.reasons.length > 0 ? verdict.reasons.join("; ") : "every commit in the release is accounted for";
  const oneLine = reasons.replace(/[\r\n]+/g, " ");
  appendFileSync(process.env.GITHUB_OUTPUT, `ok=${verdict.ok}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `reasons<<${delimiter}\n${oneLine}\n${delimiter}\n`);
}

function main() {
  if (!REPO) {
    console.error("GITHUB_REPOSITORY is required");
    process.exit(2);
  }

  const releasePr = Number(process.argv[2] || 0);
  const baseTag = process.argv[3] || latestReleaseTag();

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
      writeOutput(verdict);
      return;
    }
    rangeTruncated = range.truncated;
    commits = range.commits.map((c) =>
      classifyCommit(c, (sha) => resolvePullRequest(sha, c), LABEL, LABEL_ACTORS, RELEASE_BOT_LOGIN),
    );
  }

  let currentVersion = null;
  let releaseVersion = null;
  let versionsRequired = false;
  if (releasePr) {
    versionsRequired = true;
    const pr = ghJson(["api", `repos/${REPO}/pulls/${releasePr}`, "--jq", "{head: .head.ref, base: .base.ref}"]);
    if (pr) {
      currentVersion = versionFromRef(pr.base);
      releaseVersion = versionFromRef(pr.head);
    }
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
  writeOutput(verdict);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main();
}
