import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";

import {
  extraFilesFrom,
  judgePullRequest,
  parseNameStatus,
  PROTECTED_BRANCH,
  VOUCH_RUN_NAME,
  VOUCH_WORKFLOW_PATH,
} from "./commit-provenance.mjs";

const REPO = process.env.GITHUB_REPOSITORY;
const MAIN_REF = `refs/remotes/origin/${PROTECTED_BRANCH}`;
const WORKFLOW_FILE = "commit-provenance.yml";
const RUN_PAGE_SIZE = 100;
const RUN_INDEX_RETRY_MS = 5_000;

function git(args, env = process.env) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024, env });
}

function gitSucceeds(args) {
  try {
    execFileSync("git", args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function ghJson(args) {
  const out = execFileSync("gh", args, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 }).trim();
  return out ? JSON.parse(out) : null;
}

function ghPages(path) {
  const pages = ghJson(["api", "--paginate", "--slurp", path]);
  return Array.isArray(pages) ? pages : [];
}

function currentLabels(pullNumber) {
  return ghPages(`repos/${REPO}/issues/${pullNumber}/labels?per_page=${RUN_PAGE_SIZE}`)
    .flat()
    .map((entry) => entry?.name)
    .filter((name) => typeof name === "string");
}

function labelEvents(pullNumber) {
  return ghPages(`repos/${REPO}/issues/${pullNumber}/events?per_page=${RUN_PAGE_SIZE}`)
    .flat()
    .map((entry) => ({
      id: entry?.id,
      action: entry?.event,
      label: entry?.label?.name,
      actor: entry?.actor?.login,
    }));
}

function vouchRuns(headRef) {
  const query = `event=pull_request&per_page=${RUN_PAGE_SIZE}&branch=${encodeURIComponent(headRef)}`;
  return ghPages(`repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?${query}`)
    .flatMap((page) => page?.workflow_runs ?? [])
    .map((run) => ({
      id: run?.id,
      runNumber: run?.run_number,
      title: run?.display_title,
      actor: run?.actor?.login,
      headSha: run?.head_sha,
    }));
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function workflowMismatch(mainSha, headSha) {
  const onMain = readAt(mainSha, VOUCH_WORKFLOW_PATH);
  const onHead = readAt(headSha, VOUCH_WORKFLOW_PATH);
  if (onMain !== null && onHead === onMain) return undefined;
  return `the head's ${VOUCH_WORKFLOW_PATH} differs from the one on ${PROTECTED_BRANCH}, so the titles of its ${VOUCH_RUN_NAME} runs are the head's to choose`;
}

function resolveVouch({ pullNumber, headSha, headRef, mainSha, runId }) {
  const mismatch = workflowMismatch(mainSha, headSha);
  if (mismatch) return { workflowMismatch: mismatch };
  try {
    const labels = currentLabels(pullNumber);
    const events = labelEvents(pullNumber);
    let runs = vouchRuns(headRef);
    if (!runs.some((run) => String(run.id) === String(runId))) {
      console.error(`this run is not in the ${VOUCH_RUN_NAME} listing for ${headRef} yet; reading it again in ${RUN_INDEX_RETRY_MS}ms`);
      sleep(RUN_INDEX_RETRY_MS);
      runs = vouchRuns(headRef);
    }
    return { labels, labelEvents: events, runs, runId };
  } catch (error) {
    return { unread: error instanceof Error ? error.message : String(error) };
  }
}

function authenticatedGitEnv() {
  const token = process.env.GH_TOKEN;
  if (!token) return process.env;
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  if (process.env.GITHUB_ACTIONS === "true") console.log(`::add-mask::${basic}`);
  return {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

function readExtraFiles() {
  if (!existsSync("release-please-config.json")) return [];
  try {
    return extraFilesFrom(JSON.parse(readFileSync("release-please-config.json", "utf8")));
  } catch {
    return [];
  }
}

function compareCommits(baseSha, headSha) {
  return ghJson([
    "api",
    `repos/${REPO}/compare/${baseSha}...${headSha}`,
    "--jq",
    "{total_commits, merge_base: .merge_base_commit.sha, commits: [.commits[] | {sha, parents: [.parents[] | {sha}], committer: {login: .committer.login}, commit: {tree: {sha: .commit.tree.sha}, verification: .commit.verification}}]}",
  ]);
}

function readAt(sha, path) {
  try {
    return git(["show", `${sha}:${path}`]);
  } catch {
    return null;
  }
}

function writeSummary(verdict) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const lines = [`## Commit provenance: ${verdict.ok ? "pass" : "fail"}`, ""];
  if (verdict.via) lines.push(`Passed by: ${verdict.via}`, "");
  for (const reason of verdict.reasons) lines.push(`- ${reason}`);
  if (verdict.commits.length > 0) {
    lines.push("", "| Commit | Verdict |", "|---|---|");
    for (const entry of verdict.commits) {
      lines.push(`| \`${String(entry.sha).slice(0, 7)}\` | ${entry.ok ? entry.via : entry.reason} |`);
    }
  }
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
}

function parseLabels(text) {
  try {
    const parsed = JSON.parse(text ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((name) => typeof name === "string") : [];
  } catch {
    return [];
  }
}

function main() {
  const headSha = process.env.HEAD_SHA;
  const headRef = process.env.HEAD_REF;
  const pullNumber = process.env.PR_NUMBER;
  const runId = process.env.GITHUB_RUN_ID;
  if (!REPO || !headSha) {
    console.error("GITHUB_REPOSITORY and HEAD_SHA are required");
    process.exit(2);
  }

  git(
    ["fetch", "--no-tags", "--quiet", "origin", `+refs/heads/${PROTECTED_BRANCH}:${MAIN_REF}`, headSha],
    authenticatedGitEnv(),
  );
  const mainSha = git(["rev-parse", MAIN_REF]).trim();

  const compare = compareCommits(mainSha, headSha);
  const mergeBase = compare.merge_base;
  const gitCommitShas = git(["rev-list", `${mergeBase}..${headSha}`]).split("\n").filter(Boolean);
  const changes = parseNameStatus(
    git(["diff", "--no-renames", "--name-status", mergeBase, headSha]),
    git(["diff", "--no-renames", "--numstat", mergeBase, headSha]),
  );

  const verdict = judgePullRequest({
    baseRef: process.env.BASE_REF,
    pullRequest: { author: process.env.PR_AUTHOR, headRef, number: pullNumber, headSha },
    event: { action: process.env.EVENT_ACTION, label: process.env.EVENT_LABEL, sender: process.env.EVENT_SENDER },
    labels: parseLabels(process.env.PR_LABELS),
    labelsMayBeStale: Number(process.env.RUN_ATTEMPT) > 1,
    resolveVouch: (pull) => resolveVouch({ ...pull, headRef, mainSha, runId }),
    commits: compare.commits,
    totalCommits: compare.total_commits,
    gitCommitShas,
    changes,
    read: (path, side) => readAt(side === "base" ? mergeBase : headSha, path),
    extraFiles: readExtraFiles(),
    isAncestorOfMain: (sha) => gitSucceeds(["merge-base", "--is-ancestor", sha, MAIN_REF]),
    mergeTreeOf: (first, second) => {
      try {
        return git(["merge-tree", "--write-tree", first, second]).split("\n")[0].trim();
      } catch {
        return null;
      }
    },
  });

  console.log(JSON.stringify({ main: mainSha, head: headSha, ...verdict }, null, 2));
  writeSummary(verdict);
  if (!verdict.ok) process.exit(1);
}

main();
