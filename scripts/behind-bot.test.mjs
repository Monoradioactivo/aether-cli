import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  baseSkipReason,
  classifyUpdateError,
  configFromEnv,
  createGitHub,
  discordNotify,
  isReleasePr,
  isRenovate,
  markerFor,
  orderCandidates,
  requiredCheckState,
  run,
  sameLogin,
  touchesWorkflows,
  trainHold,
  trainReleaseWindow,
} from "./behind-bot.mjs";

const REPO = "Monoradioactivo/aetherpush-deploy-action";
const BOT = "aetherpush-release-bot[bot]";
const BOT_GRAPHQL = "aetherpush-release-bot";
const MAIN = "m".repeat(40);
const OLD_MAIN = "o".repeat(40);
const NOW = new Date("2026-09-21T16:00:00Z");
const BASE_CONFIG = {
  repository: REPO,
  releaseBranchPrefix: "release-please--branches--main",
  releaseBotLogin: BOT,
  train: null,
};
const SERVER_CONFIG = {
  ...BASE_CONFIG,
  train: { updateCutoff: "21:45:00", closes: "22:00:00", weekdays: [1, 4] },
};

function pr(number, overrides = {}) {
  return {
    number,
    isDraft: false,
    headRefName: `fix/change-${number}`,
    headRefOid: `h${number}`.padEnd(40, "0"),
    mergeStateStatus: "BEHIND",
    headRepository: REPO,
    author: "Monoradioactivo",
    armedAt: "2026-09-21T15:00:00Z",
    unresolvedThreads: 0,
    ...overrides,
  };
}

function fakeGitHub({
  prs,
  commits = {},
  checks = {},
  statuses = {},
  required = ["YAML lint"],
  mergeStates = {},
  updateResults = {},
  heads = {},
  compare = [],
  comments = {},
}) {
  const calls = { updates: [], comments: [], mergeStatePolls: 0 };
  const commentStore = structuredClone(comments);
  return {
    calls,
    mainSha: () => MAIN,
    openPrs: () => prs.map((item) => ({ ...item })),
    requiredContexts: () => required,
    checkRuns: (sha) => checks[sha] ?? [{ id: 1, name: "YAML lint", status: "completed", conclusion: "success" }],
    statuses: (sha) => statuses[sha] ?? [],
    commit: (sha) => commits[sha] ?? { parents: [OLD_MAIN], author: "Monoradioactivo", date: "2026-09-21T15:00:00Z" },
    compareFiles: () => compare,
    mergeStateStatus: (number) => {
      calls.mergeStatePolls += 1;
      const queue = mergeStates[number] ?? ["BEHIND"];
      return queue.length > 1 ? queue.shift() : queue[0];
    },
    headSha: (number) => {
      const queue = heads[number];
      if (!queue) return "n".repeat(40);
      return queue.length > 1 ? queue.shift() : queue[0];
    },
    updateBranch: (number, expected) => {
      calls.updates.push({ number, expected });
      const outcome = updateResults[number];
      if (outcome) throw outcome;
      return "{}";
    },
    comments: (number) => commentStore[number] ?? [],
    comment: (number, body) => {
      calls.comments.push({ number, body });
      commentStore[number] = [...(commentStore[number] ?? []), { login: BOT, body }];
    },
  };
}

async function exec(github, { config = BASE_CONFIG, now = NOW, delivered = true } = {}) {
  const lines = [];
  const notices = [];
  const result = await run({
    github,
    config,
    now,
    sleep: async () => {},
    notify: async (text) => {
      notices.push(text);
      return delivered;
    },
    summary: (line) => lines.push(line),
  });
  return { result, lines, notices };
}

function ghError(status, message) {
  const error = new Error(`gh: ${message} (HTTP ${status})`);
  error.stderr = `gh: ${message} (HTTP ${status})`;
  return error;
}

test("logins compare equal across the REST, GraphQL and app spellings", () => {
  assert.equal(sameLogin(BOT, BOT_GRAPHQL), true);
  assert.equal(sameLogin("app/aetherpush-release-bot", BOT), true);
  assert.equal(sameLogin("Monoradioactivo", BOT), false);
  assert.equal(sameLogin(null, BOT), false);
  for (const login of ["renovate[bot]", "app/renovate", "renovate", "Renovate[bot]"]) {
    assert.equal(isRenovate(login), true, login);
  }
  assert.equal(isRenovate(BOT), false);
});

test("a release PR is recognised by its branch prefix or by the GraphQL spelling of the bot", () => {
  assert.equal(isReleasePr(pr(1, { headRefName: "release-please--branches--main" }), BASE_CONFIG), true);
  assert.equal(isReleasePr(pr(1, { author: BOT_GRAPHQL }), BASE_CONFIG), true);
  assert.equal(isReleasePr(pr(1), BASE_CONFIG), false);
});

test("required check state takes the run per name that finished last whatever order the API returns", () => {
  const newestFirst = [
    { id: 20, name: "YAML lint", status: "completed", conclusion: "success", completed_at: "2026-09-21T15:20:00Z" },
    { id: 10, name: "YAML lint", status: "completed", conclusion: "failure", completed_at: "2026-09-21T15:10:00Z" },
  ];
  assert.equal(requiredCheckState(["YAML lint"], newestFirst, []), "passing");
  const oldestFirst = [...newestFirst].reverse();
  assert.equal(requiredCheckState(["YAML lint"], oldestFirst, []), "passing");
  const failingNewest = [
    { id: 5, name: "YAML lint", status: "completed", conclusion: "timed_out", completed_at: "2026-09-21T15:30:00Z" },
    { id: 30, name: "YAML lint", status: "completed", conclusion: "success", completed_at: "2026-09-21T15:05:00Z" },
  ];
  assert.equal(requiredCheckState(["YAML lint"], failingNewest, []), "failing");
  assert.equal(requiredCheckState(["YAML lint"], [{ id: 1, name: "YAML lint", status: "queued", conclusion: null, completed_at: null }], []), "pending");
  assert.equal(requiredCheckState(["Pages"], [], [{ context: "Pages", state: "error" }]), "failing");
  assert.equal(requiredCheckState(["Pages"], [], []), "pending");
});

const TWIN_CHECKS = ["Lint & Typecheck", "Test", "Docker Build"];

function twinRuns({ cancelledIds, survivorIds, survivorStatus = "completed" }) {
  const cancelled = [
    { name: "Lint & Typecheck", completed_at: "2026-09-26T19:32:28Z" },
    { name: "Test", completed_at: "2026-09-26T19:32:28Z" },
    { name: "Docker Build", completed_at: "2026-09-26T19:32:28Z" },
  ].map((run, index) => ({ ...run, id: cancelledIds[index], status: "completed", conclusion: "cancelled" }));
  const survivors = [
    { name: "Lint & Typecheck", completed_at: "2026-09-26T19:33:29Z" },
    { name: "Test", completed_at: "2026-09-26T19:36:25Z" },
    { name: "Docker Build", completed_at: "2026-09-26T19:33:36Z" },
  ].map((run, index) =>
    survivorStatus === "completed"
      ? { ...run, id: survivorIds[index], status: "completed", conclusion: "success" }
      : { name: run.name, id: survivorIds[index], status: survivorStatus, conclusion: null, completed_at: null },
  );
  return [...cancelled, ...survivors];
}

const ORDINARY_IDS = { cancelledIds: [108471815573, 108471818302, 108471818806], survivorIds: [108471819296, 108471981966, 108471981975] };
const INVERTED_IDS = { cancelledIds: ORDINARY_IDS.survivorIds, survivorIds: ORDINARY_IDS.cancelledIds };

test("a cancelled twin that finished before its successful twin reads as passing whichever run holds the higher id", () => {
  assert.equal(requiredCheckState(TWIN_CHECKS, twinRuns(ORDINARY_IDS), []), "passing");
  assert.equal(requiredCheckState(TWIN_CHECKS, twinRuns(INVERTED_IDS), []), "passing");
  assert.equal(requiredCheckState(TWIN_CHECKS, twinRuns(INVERTED_IDS).reverse(), []), "passing");
});

test("a cancelled set that finished after a successful set reads as failing whichever run holds the higher id", () => {
  const succeeded = TWIN_CHECKS.map((name, index) => ({
    id: [108497638901, 108497748469, 108497748501][index],
    name,
    status: "completed",
    conclusion: "success",
    completed_at: ["2026-09-26T22:14:59Z", "2026-09-26T22:17:16Z", "2026-09-26T22:15:05Z"][index],
  }));
  const cancelledLater = TWIN_CHECKS.map((name, index) => ({
    id: [108498254096, 108498388731, 108498388610][index],
    name,
    status: "completed",
    conclusion: "cancelled",
    completed_at: "2026-09-26T22:18:59Z",
  }));
  assert.equal(requiredCheckState(TWIN_CHECKS, [...succeeded, ...cancelledLater], []), "failing");
  const cancelledLaterWithLowerIds = cancelledLater.map((run, index) => ({ ...run, id: succeeded[index].id - 1000 }));
  assert.equal(requiredCheckState(TWIN_CHECKS, [...succeeded, ...cancelledLaterWithLowerIds], []), "failing");
});

test("a twin still running beside a cancelled one reads as pending whichever run holds the higher id", () => {
  assert.equal(requiredCheckState(TWIN_CHECKS, twinRuns({ ...ORDINARY_IDS, survivorStatus: "in_progress" }), []), "pending");
  assert.equal(requiredCheckState(TWIN_CHECKS, twinRuns({ ...INVERTED_IDS, survivorStatus: "in_progress" }), []), "pending");
  assert.equal(requiredCheckState(TWIN_CHECKS, twinRuns({ ...INVERTED_IDS, survivorStatus: "queued" }), []), "pending");
});

test("runs that finished in the same second fall back to the higher id", () => {
  const sameSecond = (failingId, passingId) => [
    { id: failingId, name: "Test", status: "completed", conclusion: "failure", completed_at: "2026-09-26T19:36:25Z" },
    { id: passingId, name: "Test", status: "completed", conclusion: "success", completed_at: "2026-09-26T19:36:25Z" },
  ];
  assert.equal(requiredCheckState(["Test"], sameSecond(1, 2), []), "passing");
  assert.equal(requiredCheckState(["Test"], sameSecond(2, 1), []), "failing");
  assert.equal(requiredCheckState(["Test"], sameSecond(2, 1).reverse(), []), "failing");
});

test("a completed run without a readable completion time counts as finishing before every timed run", () => {
  const runs = [
    { id: 2, name: "Test", status: "completed", conclusion: "failure", completed_at: null },
    { id: 1, name: "Test", status: "completed", conclusion: "success", completed_at: "2026-09-26T19:36:25Z" },
  ];
  assert.equal(requiredCheckState(["Test"], runs, []), "passing");
  assert.equal(requiredCheckState(["Test"], [...runs].reverse(), []), "passing");
  const untimed = [
    { id: 2, name: "Test", status: "completed", conclusion: "failure", completed_at: "not a time" },
    { id: 1, name: "Test", status: "completed", conclusion: "success" },
  ];
  assert.equal(requiredCheckState(["Test"], untimed, []), "failing");
});

test("a compare touching workflows, or one GitHub truncated, counts as touching", () => {
  assert.equal(touchesWorkflows([{ filename: ".github/workflows/ci.yml" }]), true);
  assert.equal(touchesWorkflows([{ filename: "README.md" }, { filename: ".github/scripts/x.mjs" }]), false);
  assert.equal(touchesWorkflows(Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}` }))), true);
  assert.equal(touchesWorkflows(undefined), true);
});

test("base skip reasons cover drafts, forks, Renovate, threads and unarmed PRs", () => {
  assert.equal(baseSkipReason(pr(1, { armedAt: null }), REPO), "not armed");
  assert.equal(baseSkipReason(pr(1, { isDraft: true }), REPO), "draft");
  assert.equal(baseSkipReason(pr(1, { headRepository: "someone/fork" }), REPO), "head outside this repository");
  assert.equal(baseSkipReason(pr(1, { headRepository: null }), REPO), "head outside this repository");
  assert.equal(baseSkipReason(pr(1, { author: "app/renovate" }), REPO), "Renovate maintains its own branches");
  assert.equal(baseSkipReason(pr(1, { unresolvedThreads: 2 }), REPO), "unresolved review threads");
  assert.equal(baseSkipReason(pr(1), REPO), null);
});

test("update errors are classified by GitHub's message, not guessed from the status alone", () => {
  assert.equal(classifyUpdateError(ghError(422, "expected head sha didn't match current head ref.")).kind, "head-moved");
  assert.equal(classifyUpdateError(ghError(422, "merge conflict between base and head")).kind, "conflict");
  assert.equal(
    classifyUpdateError(ghError(422, "refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission")).kind,
    "workflows",
  );
  assert.equal(classifyUpdateError(ghError(403, "Resource not accessible by integration")).kind, "refused");
  assert.equal(classifyUpdateError(ghError(502, "Bad Gateway")).kind, "transient");
  assert.equal(classifyUpdateError(ghError(403, "API rate limit exceeded")).kind, "transient");
  assert.equal(classifyUpdateError(new Error("spawn gh ENOENT")).kind, "transient");
  assert.equal(classifyUpdateError(ghError(401, "Bad credentials")).kind, "refused");
});

test("the oldest eligible armed BEHIND pull request is updated, pinned to its head", async () => {
  const github = fakeGitHub({
    prs: [
      pr(9),
      pr(3, { author: "renovate[bot]" }),
      pr(5, { isDraft: true }),
      pr(4, { headRepository: "someone/fork" }),
      pr(6, { unresolvedThreads: 1 }),
      pr(7),
      pr(8, { armedAt: null }),
    ],
  });
  const { result, lines } = await exec(github);
  assert.deepEqual(result, { action: "updated", pr: 7, head: "n".repeat(40), failures: 0 });
  assert.deepEqual(github.calls.updates, [{ number: 7, expected: pr(7).headRefOid }]);
  assert.ok(lines.some((line) => line.startsWith("Updated #7 from")));
});

test("a PR the bot already updated goes behind fresh ones but is still updated when it is the only candidate", async () => {
  const touched = pr(1);
  const botMerge = { parents: [OLD_MAIN, "s".repeat(40)], author: BOT, date: "2026-09-21T15:10:00Z" };
  const order = orderCandidates([touched, pr(2)], new Map([[1, botMerge], [2, { parents: [OLD_MAIN], author: "x" }]]), BASE_CONFIG);
  assert.deepEqual(order.map((item) => item.number), [2, 1]);

  const alone = fakeGitHub({ prs: [touched], commits: { [touched.headRefOid]: botMerge } });
  const { result } = await exec(alone);
  assert.equal(result.action, "updated");
  assert.deepEqual(alone.calls.updates.map((call) => call.number), [1]);
});

test("the queue waits while a bot merge carrying main still has required checks running", async () => {
  const waiting = pr(2);
  const github = fakeGitHub({
    prs: [pr(1), waiting],
    commits: { [waiting.headRefOid]: { parents: [OLD_MAIN, MAIN], author: BOT, date: "2026-09-21T15:55:00Z" } },
    checks: { [waiting.headRefOid]: [{ id: 1, name: "YAML lint", status: "in_progress", conclusion: null }] },
  });
  const { result } = await exec(github);
  assert.deepEqual(result, { action: "serial-wait", pr: 2, failures: 0 });
  assert.deepEqual(github.calls.updates, []);
});

test("the serial wait ignores a merge older than two hours and a branch whose only parent is main", async () => {
  const stale = pr(2);
  const rebased = pr(3);
  const github = fakeGitHub({
    prs: [pr(1), stale, rebased],
    commits: {
      [stale.headRefOid]: { parents: [OLD_MAIN, MAIN], author: BOT, date: "2026-09-21T13:00:00Z" },
      [rebased.headRefOid]: { parents: [MAIN], author: "renovate[bot]", date: "2026-09-21T15:59:00Z" },
    },
    checks: {
      [stale.headRefOid]: [{ id: 1, name: "YAML lint", status: "in_progress", conclusion: null }],
      [rebased.headRefOid]: [{ id: 1, name: "YAML lint", status: "in_progress", conclusion: null }],
    },
  });
  const { result } = await exec(github);
  assert.equal(result.action, "updated");
  assert.equal(result.pr, 1);
});

test("a failing required check skips to the next candidate", async () => {
  const failing = pr(1);
  const github = fakeGitHub({
    prs: [failing, pr(2)],
    checks: { [failing.headRefOid]: [{ id: 1, name: "YAML lint", status: "completed", conclusion: "failure" }] },
  });
  const { result } = await exec(github);
  assert.equal(result.pr, 2);
  assert.deepEqual(github.calls.updates.map((call) => call.number), [2]);
});

test("a head whose cancelled twin holds the higher id is updated instead of skipped as failing", async () => {
  const twinned = pr(1);
  const github = fakeGitHub({
    prs: [twinned, pr(2)],
    required: TWIN_CHECKS,
    checks: { [twinned.headRefOid]: twinRuns(INVERTED_IDS), [pr(2).headRefOid]: twinRuns(ORDINARY_IDS) },
  });
  const { result, lines } = await exec(github);
  assert.equal(result.action, "updated");
  assert.equal(result.pr, 1);
  assert.deepEqual(github.calls.updates, [{ number: 1, expected: twinned.headRefOid }]);
  assert.ok(!lines.some((line) => line.includes("a required check failed")));
});

test("the queue waits on a bot merge carrying main whose cancelled twin holds the higher id while the survivor runs", async () => {
  const waiting = pr(2);
  const github = fakeGitHub({
    prs: [pr(1), waiting],
    required: TWIN_CHECKS,
    commits: { [waiting.headRefOid]: { parents: [OLD_MAIN, MAIN], author: BOT, date: "2026-09-21T15:55:00Z" } },
    checks: {
      [pr(1).headRefOid]: twinRuns(ORDINARY_IDS),
      [waiting.headRefOid]: twinRuns({ ...INVERTED_IDS, survivorStatus: "in_progress" }),
    },
  });
  const { result } = await exec(github);
  assert.deepEqual(result, { action: "serial-wait", pr: 2, failures: 0 });
  assert.deepEqual(github.calls.updates, []);
});

test("an UNKNOWN merge state is polled until GitHub computes it", async () => {
  const github = fakeGitHub({ prs: [pr(1, { mergeStateStatus: "UNKNOWN" })], mergeStates: { 1: ["UNKNOWN", "BEHIND"] } });
  const { result } = await exec(github);
  assert.equal(result.action, "updated");
  assert.equal(github.calls.mergeStatePolls, 2);
});

test("a merge state that is not BEHIND or BLOCKED is left alone", async () => {
  const github = fakeGitHub({ prs: [pr(1, { mergeStateStatus: "CLEAN" }), pr(2, { mergeStateStatus: "UNSTABLE" })] });
  const { result, notices } = await exec(github);
  assert.deepEqual(result, { action: "none", failures: 0 });
  assert.deepEqual(github.calls.updates, []);
  assert.deepEqual(notices, []);
});

test("BLOCKED with passing required checks is reported once per head and never updated", async () => {
  const blocked = pr(1, { mergeStateStatus: "BLOCKED" });
  const options = { prs: [blocked, pr(2, { mergeStateStatus: "CLEAN" })] };
  const first = fakeGitHub(options);
  const run1 = await exec(first);
  assert.deepEqual(run1.result, { action: "none", failures: 1 });
  assert.deepEqual(first.calls.updates, []);
  assert.equal(run1.notices.length, 1);
  assert.match(run1.notices[0], /BLOCKED \(for example a code-scanning alert\)/);
  assert.equal(first.calls.comments.length, 1);
  assert.match(first.calls.comments[0].body, new RegExp(`<!-- behind-bot:blocked:${blocked.headRefOid} -->`));
  assert.ok(run1.lines.some((line) => line.includes("required checks pass but GitHub still reports")));

  const second = fakeGitHub({ ...options, comments: { 1: [{ login: BOT, body: first.calls.comments[0].body }] } });
  const run2 = await exec(second);
  assert.deepEqual(second.calls.updates, []);
  assert.equal(second.calls.comments.length, 0);
  assert.equal(run2.notices.length, 0);
  assert.equal(run2.result.failures, 0);
  assert.ok(run2.lines.some((line) => line.includes("already reported for head")));
});

test("a blocked marker on the head stops a later BEHIND update of that head", async () => {
  const behind = pr(1);
  const github = fakeGitHub({
    prs: [behind, pr(2)],
    comments: { 1: [{ login: BOT, body: `${markerFor("blocked", behind.headRefOid, MAIN)}\ntext` }] },
  });
  const { result } = await exec(github);
  assert.deepEqual(github.calls.updates.map((call) => call.number), [2]);
  assert.equal(result.pr, 2);
});

test("BLOCKED with a failing required check is skipped without a notice", async () => {
  const blocked = pr(1, { mergeStateStatus: "BLOCKED" });
  const github = fakeGitHub({
    prs: [blocked, pr(2, { mergeStateStatus: "CLEAN" })],
    checks: { [blocked.headRefOid]: [{ id: 1, name: "YAML lint", status: "completed", conclusion: "failure" }] },
  });
  const { result, notices } = await exec(github);
  assert.deepEqual(result, { action: "none", failures: 0 });
  assert.deepEqual(github.calls.updates, []);
  assert.deepEqual(notices, []);
  assert.deepEqual(github.calls.comments, []);
});

test("a moved head, a conflict or a transient error moves on silently", async () => {
  const github = fakeGitHub({
    prs: [pr(1), pr(2), pr(3), pr(4)],
    updateResults: {
      1: ghError(422, "expected head sha didn't match current head ref."),
      2: ghError(422, "merge conflict"),
      3: ghError(502, "Bad Gateway"),
    },
  });
  const { result, notices } = await exec(github);
  assert.equal(result.pr, 4);
  assert.equal(result.failures, 0);
  assert.deepEqual(notices, []);
  assert.deepEqual(github.calls.comments, []);
});

test("a workflow refusal, even as a 422, notifies, then comments once per head, and moves on", async () => {
  const refusal = ghError(422, "refusing to allow a GitHub App to create or update workflow `.github/workflows/x.yml` without `workflows` permission");
  const options = {
    prs: [pr(1), pr(2, { mergeStateStatus: "CLEAN" })],
    updateResults: { 1: refusal },
    compare: [{ filename: ".github/workflows/auto-merge-release.yml" }, { filename: "README.md" }],
  };
  const first = fakeGitHub(options);
  const run1 = await exec(first);
  assert.equal(run1.result.action, "none");
  assert.equal(run1.result.failures, 1);
  assert.equal(run1.notices.length, 1);
  assert.match(run1.notices[0], new RegExp(`^${REPO}#1: `));
  assert.match(run1.notices[0], /workflow changes \(\.github\/workflows\/auto-merge-release\.yml\)/);
  assert.equal(first.calls.comments.length, 1);
  assert.match(first.calls.comments[0].body, new RegExp(`<!-- behind-bot:workflows:${pr(1).headRefOid} -->`));
  assert.ok(run1.lines.some((line) => line.includes("refusing to allow a GitHub App")));

  const second = fakeGitHub({ ...options, comments: { 1: [{ login: BOT, body: first.calls.comments[0].body }] } });
  const run2 = await exec(second);
  assert.deepEqual(second.calls.updates, []);
  assert.equal(second.calls.comments.length, 0);
  assert.equal(run2.notices.length, 0);
  assert.equal(run2.result.failures, 0);
  assert.ok(run2.lines.some((line) => line.includes("already reported for head")));
});

test("a marker comment that fails after the notice is delivered does not crash the run", async () => {
  const github = fakeGitHub({ prs: [pr(1)], updateResults: { 1: ghError(403, "Resource not accessible by integration") } });
  github.comment = () => {
    throw new Error("HTTP 403 Resource not accessible by integration");
  };
  const { result, notices, lines } = await exec(github);
  assert.equal(notices.length, 1);
  assert.equal(result.failures, 0);
  assert.ok(lines.some((line) => line.startsWith("Could not leave the marker comment on #1")));
});

test("a marker posted by someone other than the bot does not silence the notice", async () => {
  const github = fakeGitHub({
    prs: [pr(1)],
    updateResults: { 1: ghError(403, "Resource not accessible by integration") },
    comments: { 1: [{ login: "stranger", body: markerFor("refused", pr(1).headRefOid, MAIN) }] },
  });
  const { notices } = await exec(github);
  assert.equal(notices.length, 1);
  assert.equal(github.calls.comments.length, 1);
});

test("an undelivered notice leaves no marker, so the next run tries again", async () => {
  const github = fakeGitHub({ prs: [pr(1)], updateResults: { 1: ghError(403, "Resource not accessible by integration") } });
  const { notices } = await exec(github, { delivered: false });
  assert.equal(notices.length, 1);
  assert.deepEqual(github.calls.comments, []);
});

test("an accepted update whose head never moves is reported once and stops the run", async () => {
  const github = fakeGitHub({ prs: [pr(1), pr(2)], heads: { 1: [pr(1).headRefOid] } });
  const { result, notices, lines } = await exec(github);
  assert.deepEqual(result, { action: "accepted-not-moved", pr: 1, failures: 1 });
  assert.deepEqual(github.calls.updates.map((call) => call.number), [1]);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /did not move within 90 seconds/);
  assert.ok(lines.some((line) => line.includes("#1 but its head did not move within 90 seconds")));
  assert.match(github.calls.comments[0].body, new RegExp(`<!-- behind-bot:stalled:${pr(1).headRefOid}:${MAIN} -->`));
});

test("an accepted update that never moves across workflow changes is reported as the refusal", async () => {
  const github = fakeGitHub({
    prs: [pr(1)],
    heads: { 1: [pr(1).headRefOid] },
    compare: [{ filename: ".github/workflows/ci.yml" }],
  });
  const { result, notices } = await exec(github);
  assert.equal(result.failures, 1);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /workflows permission/);
});

test("a reported head is skipped on later runs without another update attempt or failure", async () => {
  const reported = pr(1);
  const github = fakeGitHub({
    prs: [reported, pr(2)],
    comments: { 1: [{ login: BOT, body: `<!-- behind-bot:stalled:${reported.headRefOid}:${MAIN} -->\ntext` }] },
  });
  const { result } = await exec(github);
  assert.deepEqual(github.calls.updates.map((call) => call.number), [2]);
  assert.equal(result.failures, 0);
});

test("a stalled or refused report from an older main is retried after main moves, a workflows report is not", async () => {
  const stalled = pr(1);
  const workflowsBlocked = pr(2);
  const github = fakeGitHub({
    prs: [stalled, workflowsBlocked],
    comments: {
      1: [{ login: BOT, body: `<!-- behind-bot:stalled:${stalled.headRefOid}:${OLD_MAIN} -->\ntext` }],
      2: [{ login: BOT, body: `<!-- behind-bot:workflows:${workflowsBlocked.headRefOid} -->\ntext` }],
    },
  });
  const { result } = await exec(github);
  assert.deepEqual(github.calls.updates.map((call) => call.number), [1]);
  assert.equal(result.pr, 1);
});

test("a failed head read after an accepted update keeps polling", async () => {
  let reads = 0;
  const github = fakeGitHub({ prs: [pr(1)] });
  github.headSha = () => {
    reads += 1;
    if (reads < 3) throw new Error("HTTP 502");
    return "n".repeat(40);
  };
  const { result } = await exec(github);
  assert.equal(result.action, "updated");
  assert.equal(reads, 3);
});

test("server train days hold every update from the cutoff while a train-armed release PR waits", () => {
  const release = pr(10, { headRefName: "release-please--branches--main", author: BOT_GRAPHQL, armedAt: "2026-09-21T15:23:39Z" });
  const monday = (time) => new Date(`2026-09-21T${time}Z`);
  assert.equal(trainHold([release], monday("21:50:00"), SERVER_CONFIG), true);
  assert.equal(trainHold([release], monday("21:40:00"), SERVER_CONFIG), false);
  assert.equal(trainHold([release], new Date("2026-09-22T21:50:00Z"), SERVER_CONFIG), false);
  assert.equal(trainHold([release], monday("21:50:00"), BASE_CONFIG), false);
  assert.equal(trainHold([{ ...release, armedAt: "2026-09-21T22:10:00Z" }], monday("22:20:00"), SERVER_CONFIG), false);
});

test("a server release arm from an earlier UTC day is not updated, and a train hold stops the run", async () => {
  const stale = pr(10, { headRefName: "release-please--branches--main", author: BOT_GRAPHQL, armedAt: "2026-09-18T15:23:00Z" });
  const github = fakeGitHub({ prs: [stale] });
  const { result, lines } = await exec(github, { config: SERVER_CONFIG });
  assert.deepEqual(result, { action: "none", failures: 0 });
  assert.ok(lines.some((line) => line.includes("earlier UTC day")));

  const held = await exec(fakeGitHub({ prs: [{ ...stale, armedAt: "2026-09-21T15:23:39Z" }, pr(11)] }), {
    config: SERVER_CONFIG,
    now: new Date("2026-09-21T21:46:00Z"),
  });
  assert.deepEqual(held.result, { action: "train-hold", failures: 0 });
});

test("an armed BEHIND release pull request is updated here, where no train holds it", async () => {
  const release = pr(10, {
    headRefName: "release-please--branches--main",
    author: BOT_GRAPHQL,
    armedAt: "2026-09-18T15:23:00Z",
  });
  const github = fakeGitHub({ prs: [release] });
  const { result, lines } = await exec(github, { now: new Date("2026-09-21T21:50:00Z") });
  assert.deepEqual(result, { action: "updated", pr: 10, head: "n".repeat(40), failures: 0 });
  assert.deepEqual(github.calls.updates, [{ number: 10, expected: release.headRefOid }]);
  assert.ok(lines.some((line) => line.startsWith("Updated #10 from")));

  const held = await exec(fakeGitHub({ prs: [release] }), {
    config: SERVER_CONFIG,
    now: new Date("2026-09-21T21:50:00Z"),
  });
  assert.deepEqual(
    held.result,
    { action: "none", failures: 0 },
    "the same pull request is updated under a train too, so this test would pass on a bot that ignores the train rather than on one that has none",
  );
});

test("this repository's behind bot is wired without a train, so a release arm never ages out of its reach", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const workflow = readFileSync(join(here, "..", ".github", "workflows", "behind-bot.yml"), "utf8");
  assert.doesNotMatch(
    workflow,
    /TRAIN_[A-Z_]*\s*(:|=)/,
    "the workflow names a TRAIN_ variable, by YAML key or by a write to GITHUB_ENV, so configFromEnv builds a train and an armed release pull request from an earlier UTC day is skipped instead of updated",
  );
});

const WINDOW_CONFIG = {
  ...SERVER_CONFIG,
  train: { ...SERVER_CONFIG.train, opens: "15:00:00" },
};

function releaseAndFeature() {
  return {
    feature: pr(7),
    release: pr(20, {
      headRefName: "release-please--branches--main",
      author: BOT_GRAPHQL,
      armedAt: "2026-09-21T15:23:39Z",
    }),
  };
}

test("during the train window the bot updates only the release armed that day", async () => {
  const monday = (time) => new Date(`2026-09-21T${time}Z`);
  const { feature, release } = releaseAndFeature();

  const atOpen = fakeGitHub({ prs: [feature, release] });
  const opened = await exec(atOpen, { config: WINDOW_CONFIG, now: monday("15:00:00") });
  assert.equal(opened.result.action, "updated");
  assert.equal(opened.result.pr, 20);
  assert.deepEqual(atOpen.calls.updates.map((call) => call.number), [20]);

  const beforeOpen = await exec(fakeGitHub({ prs: [feature, release] }), {
    config: WINDOW_CONFIG,
    now: monday("14:59:59"),
  });
  assert.equal(beforeOpen.result.pr, 7);

  const clean = fakeGitHub({
    prs: [feature, { ...release, mergeStateStatus: "CLEAN" }],
  });
  const idle = await exec(clean, { config: WINDOW_CONFIG, now: monday("16:00:00") });
  assert.deepEqual(idle.result, { action: "none", failures: 0 });
  assert.deepEqual(clean.calls.updates, []);

  const waiting = pr(7);
  const queued = fakeGitHub({
    prs: [waiting, release],
    commits: {
      [waiting.headRefOid]: { parents: [OLD_MAIN, MAIN], author: BOT, date: "2026-09-21T15:55:00Z" },
    },
    checks: {
      [waiting.headRefOid]: [{ id: 1, name: "YAML lint", status: "in_progress", conclusion: null }],
    },
  });
  const duringWait = await exec(queued, { config: WINDOW_CONFIG, now: monday("16:00:00") });
  assert.equal(duringWait.result.action, "updated");
  assert.equal(duringWait.result.pr, 20);

  const heldAtCutoff = await exec(fakeGitHub({ prs: [feature, release] }), {
    config: WINDOW_CONFIG,
    now: monday("21:45:00"),
  });
  assert.deepEqual(heldAtCutoff.result, { action: "train-hold", failures: 0 });

  const atClose = await exec(fakeGitHub({ prs: [feature, release] }), {
    config: WINDOW_CONFIG,
    now: monday("22:00:00"),
  });
  assert.deepEqual(atClose.result, { action: "train-hold", failures: 0 });

  const afterClose = await exec(fakeGitHub({ prs: [pr(7), pr(8)] }), {
    config: WINDOW_CONFIG,
    now: monday("22:00:00"),
  });
  assert.equal(afterClose.result.pr, 7);

  const tuesday = await exec(fakeGitHub({ prs: [feature, release] }), {
    config: WINDOW_CONFIG,
    now: new Date("2026-09-22T16:00:00Z"),
  });
  assert.equal(tuesday.result.pr, 7);

  const noTrain = await exec(fakeGitHub({ prs: [feature, release] }), {
    config: BASE_CONFIG,
    now: monday("16:00:00"),
  });
  assert.equal(noTrain.result.pr, 7);
});

test("trainReleaseWindow is on from 15:00 until 22:00 on a train day only", () => {
  const { release } = releaseAndFeature();
  const monday = (time) => new Date(`2026-09-21T${time}Z`);
  assert.equal(trainReleaseWindow([release], monday("15:00:00"), WINDOW_CONFIG), true);
  assert.equal(trainReleaseWindow([release], monday("14:59:59"), WINDOW_CONFIG), false);
  assert.equal(trainReleaseWindow([release], monday("21:45:00"), WINDOW_CONFIG), true);
  assert.equal(trainReleaseWindow([release], monday("22:00:00"), WINDOW_CONFIG), false);
  assert.equal(trainReleaseWindow([release], new Date("2026-09-22T16:00:00Z"), WINDOW_CONFIG), false);
  assert.equal(trainReleaseWindow([release], monday("16:00:00"), BASE_CONFIG), false);
  assert.equal(trainReleaseWindow([pr(7)], monday("16:00:00"), WINDOW_CONFIG), false);
  assert.equal(trainHold([release], monday("21:45:00"), WINDOW_CONFIG), true);
  assert.equal(trainHold([release], monday("22:00:00"), WINDOW_CONFIG), true);
});

const REVENDOR = "chore/openapi-revendor";
const REVENDOR_CONFIG = { ...BASE_CONFIG, revendorBranch: REVENDOR };
const REVENDOR_TRAIN_CONFIG = { ...WINDOW_CONFIG, revendorBranch: REVENDOR };
const ARMED_THIS_MONDAY = "2026-09-21T15:23:39Z";
const ARMED_LAST_FRIDAY = "2026-09-18T15:23:00Z";
const TUESDAY = new Date("2026-09-22T16:00:00Z");

function mondayAt(time) {
  return new Date(`2026-09-21T${time}Z`);
}

function revendor(number, overrides = {}) {
  return pr(number, { headRefName: REVENDOR, author: BOT_GRAPHQL, ...overrides });
}

function updatedNumbers(github) {
  return github.calls.updates.map((call) => call.number);
}

test("the bot's re-vendor branch is not a release, and no other branch the bot opens is exempt", () => {
  for (const author of [BOT, BOT_GRAPHQL, "app/aetherpush-release-bot"]) {
    assert.equal(isReleasePr(revendor(1, { author }), REVENDOR_CONFIG), false, author);
  }
  const otherBranches = [
    `${REVENDOR}-2`,
    REVENDOR.slice(0, -1),
    `x/${REVENDOR}`,
    REVENDOR.toUpperCase(),
    "fix/change-1",
    "release-please--branches--develop--components--aether-server",
  ];
  for (const headRefName of otherBranches) {
    assert.equal(isReleasePr(revendor(1, { headRefName }), REVENDOR_CONFIG), true, headRefName);
  }
});

test("a branch under the release prefix is a release whoever opened it, even when it is named as the re-vendor branch", () => {
  const branch = "release-please--branches--main--components--aether-dashboard";
  for (const author of [BOT_GRAPHQL, "Monoradioactivo", null]) {
    const release = pr(1, { headRefName: branch, author });
    assert.equal(isReleasePr(release, REVENDOR_CONFIG), true, String(author));
    assert.equal(isReleasePr(release, { ...BASE_CONFIG, revendorBranch: branch }), true, String(author));
  }
});

test("with no re-vendor branch configured every pull request the bot opens is a release", () => {
  for (const revendorBranch of [undefined, null]) {
    assert.equal(isReleasePr(revendor(1), { ...BASE_CONFIG, revendorBranch }), true, String(revendorBranch));
  }
});

test("configuration reads the re-vendor branch from the environment, and none when it is unset or empty", () => {
  assert.equal(configFromEnv({ GITHUB_REPOSITORY: REPO }).revendorBranch, null);
  assert.equal(configFromEnv({ GITHUB_REPOSITORY: REPO, REVENDOR_BRANCH: "" }).revendorBranch, null);
  assert.equal(configFromEnv({ GITHUB_REPOSITORY: REPO, REVENDOR_BRANCH: REVENDOR }).revendorBranch, REVENDOR);
});

test("a re-vendor pull request armed on an earlier UTC day is updated where a release would be skipped", async () => {
  const stale = revendor(30, { armedAt: ARMED_LAST_FRIDAY });

  const exempt = fakeGitHub({ prs: [stale] });
  const ordinary = await exec(exempt, { config: REVENDOR_TRAIN_CONFIG, now: TUESDAY });
  assert.equal(ordinary.result.action, "updated");
  assert.deepEqual(exempt.calls.updates, [{ number: 30, expected: stale.headRefOid }]);
  assert.equal(ordinary.lines.some((line) => line.includes("earlier UTC day")), false);

  const unnamed = fakeGitHub({ prs: [stale] });
  const asRelease = await exec(unnamed, { config: WINDOW_CONFIG, now: TUESDAY });
  assert.deepEqual(asRelease.result, { action: "none", failures: 0 });
  assert.deepEqual(unnamed.calls.updates, []);
  assert.ok(asRelease.lines.includes("Skip #30: release arm from an earlier UTC day."));
});

test("a re-vendor pull request armed on a train day holds no update past the cutoff", async () => {
  const armedToday = revendor(30, { armedAt: ARMED_THIS_MONDAY });
  const pastCutoff = mondayAt("21:50:00");
  assert.equal(trainHold([armedToday], pastCutoff, REVENDOR_TRAIN_CONFIG), false);
  assert.equal(trainHold([armedToday], pastCutoff, WINDOW_CONFIG), true);

  const exempt = fakeGitHub({ prs: [armedToday] });
  const ordinary = await exec(exempt, { config: REVENDOR_TRAIN_CONFIG, now: pastCutoff });
  assert.equal(ordinary.result.action, "updated");
  assert.deepEqual(updatedNumbers(exempt), [30]);

  const unnamed = fakeGitHub({ prs: [armedToday] });
  const asRelease = await exec(unnamed, { config: WINDOW_CONFIG, now: pastCutoff });
  assert.deepEqual(asRelease.result, { action: "train-hold", failures: 0 });
  assert.deepEqual(unnamed.calls.updates, []);
});

test("a re-vendor pull request armed on a train day does not open the release-only window", async () => {
  const armedToday = revendor(30, { armedAt: ARMED_THIS_MONDAY });
  const inWindow = mondayAt("16:00:00");
  assert.equal(trainReleaseWindow([armedToday], inWindow, REVENDOR_TRAIN_CONFIG), false);
  assert.equal(trainReleaseWindow([armedToday], inWindow, WINDOW_CONFIG), true);

  const exempt = fakeGitHub({ prs: [pr(7), armedToday] });
  const ordinary = await exec(exempt, { config: REVENDOR_TRAIN_CONFIG, now: inWindow });
  assert.deepEqual(updatedNumbers(exempt), [7]);
  assert.equal(ordinary.lines.some((line) => line.startsWith("Train window:")), false);

  const unnamed = fakeGitHub({ prs: [pr(7), armedToday] });
  const asRelease = await exec(unnamed, { config: WINDOW_CONFIG, now: inWindow });
  assert.deepEqual(updatedNumbers(unnamed), [30]);
  assert.ok(asRelease.lines.some((line) => line.startsWith("Train window:")));
});

test("inside a genuine release window the re-vendor pull request waits with the feature pull requests", async () => {
  const { feature, release } = releaseAndFeature();
  const waiting = revendor(5, { armedAt: ARMED_THIS_MONDAY });
  const inWindow = mondayAt("16:00:00");

  const releaseBehind = fakeGitHub({ prs: [waiting, feature, release] });
  const first = await exec(releaseBehind, { config: REVENDOR_TRAIN_CONFIG, now: inWindow });
  assert.deepEqual(updatedNumbers(releaseBehind), [20]);
  assert.ok(first.lines.some((line) => line.startsWith("Train window:")));

  const releaseClean = fakeGitHub({ prs: [waiting, feature, { ...release, mergeStateStatus: "CLEAN" }] });
  const idle = await exec(releaseClean, { config: REVENDOR_TRAIN_CONFIG, now: inWindow });
  assert.deepEqual(idle.result, { action: "none", failures: 0 });
  assert.deepEqual(releaseClean.calls.updates, []);

  const unnamed = fakeGitHub({ prs: [waiting, feature, { ...release, mergeStateStatus: "CLEAN" }] });
  await exec(unnamed, { config: WINDOW_CONFIG, now: inWindow });
  assert.deepEqual(updatedNumbers(unnamed), [5]);
});

test("any other branch the bot opens is held to the release rules where they act", async () => {
  const other = revendor(40, { headRefName: `${REVENDOR}-2`, armedAt: ARMED_THIS_MONDAY });

  const cutoff = fakeGitHub({ prs: [pr(7), other] });
  const held = await exec(cutoff, { config: REVENDOR_TRAIN_CONFIG, now: mondayAt("21:46:00") });
  assert.deepEqual(held.result, { action: "train-hold", failures: 0 });
  assert.deepEqual(cutoff.calls.updates, []);

  const window = fakeGitHub({ prs: [pr(7), other] });
  const inWindow = await exec(window, { config: REVENDOR_TRAIN_CONFIG, now: mondayAt("16:00:00") });
  assert.deepEqual(updatedNumbers(window), [40]);
  assert.ok(inWindow.lines.some((line) => line.startsWith("Train window:")));

  const earlierArm = fakeGitHub({ prs: [{ ...other, armedAt: ARMED_LAST_FRIDAY }] });
  const skipped = await exec(earlierArm, { config: REVENDOR_TRAIN_CONFIG, now: TUESDAY });
  assert.deepEqual(skipped.result, { action: "none", failures: 0 });
  assert.deepEqual(earlierArm.calls.updates, []);
  assert.ok(skipped.lines.includes("Skip #40: release arm from an earlier UTC day."));
});

test("the ordinary skips and merge states decide the re-vendor pull request, with or without a train", async () => {
  const failed = [{ id: 1, name: "YAML lint", status: "completed", conclusion: "failure" }];
  const cases = [
    { name: "armed and behind", overrides: {}, updated: 30 },
    { name: "draft", overrides: { isDraft: true }, updated: 31, line: "Skip #30: draft." },
    { name: "fork", overrides: { headRepository: "someone/fork" }, updated: 31, line: "Skip #30: head outside this repository." },
    { name: "unresolved thread", overrides: { unresolvedThreads: 1 }, updated: 31, line: "Skip #30: unresolved review threads." },
    { name: "Renovate", overrides: { author: "renovate[bot]" }, updated: 31, line: "Skip #30: Renovate maintains its own branches." },
    {
      name: "blocked with passing checks",
      overrides: { mergeStateStatus: "BLOCKED" },
      updated: 31,
      line: "Could not update #30: required checks pass but GitHub still reports the pull request as BLOCKED (for example a code-scanning alert), which updating the branch cannot clear.",
    },
    { name: "failing required check", overrides: {}, checks: failed, updated: 31, line: "Skip #30: a required check failed on its head." },
    { name: "not armed", overrides: { armedAt: null }, updated: 31 },
    { name: "up to date", overrides: { mergeStateStatus: "CLEAN" }, updated: 31, line: "#30: merge state CLEAN." },
  ];
  for (const [label, config] of [["no train", REVENDOR_CONFIG], ["train", REVENDOR_TRAIN_CONFIG]]) {
    for (const item of cases) {
      const subject = revendor(30, { armedAt: ARMED_LAST_FRIDAY, ...item.overrides });
      const github = fakeGitHub({
        prs: [subject, pr(31)],
        checks: item.checks ? { [subject.headRefOid]: item.checks } : {},
      });
      const { lines } = await exec(github, { config, now: TUESDAY });
      assert.deepEqual(updatedNumbers(github), [item.updated], `${label}: ${item.name}`);
      if (item.line) assert.ok(lines.includes(item.line), `${label}: ${item.name}`);
      assert.equal(lines.some((line) => line.includes("earlier UTC day")), false, `${label}: ${item.name}`);
    }
  }
});

test("a genuine release keeps every train rule when a re-vendor branch is configured", async () => {
  const { feature, release } = releaseAndFeature();
  const stale = { ...release, armedAt: ARMED_LAST_FRIDAY };
  for (const [label, config] of [["unnamed", WINDOW_CONFIG], ["named", REVENDOR_TRAIN_CONFIG]]) {
    assert.equal(isReleasePr(release, config), true, label);
    assert.equal(trainHold([release], mondayAt("21:45:00"), config), true, label);
    assert.equal(trainHold([release], mondayAt("21:44:59"), config), false, label);
    assert.equal(trainReleaseWindow([release], mondayAt("15:00:00"), config), true, label);
    assert.equal(trainReleaseWindow([release], mondayAt("22:00:00"), config), false, label);

    const earlierArm = fakeGitHub({ prs: [stale] });
    const skipped = await exec(earlierArm, { config, now: TUESDAY });
    assert.deepEqual(skipped.result, { action: "none", failures: 0 }, label);
    assert.deepEqual(earlierArm.calls.updates, [], label);
    assert.ok(skipped.lines.includes("Skip #20: release arm from an earlier UTC day."), label);

    const window = fakeGitHub({ prs: [feature, release] });
    await exec(window, { config, now: mondayAt("16:00:00") });
    assert.deepEqual(updatedNumbers(window), [20], label);

    const cutoff = fakeGitHub({ prs: [feature, release] });
    const held = await exec(cutoff, { config, now: mondayAt("21:46:00") });
    assert.deepEqual(held.result, { action: "train-hold", failures: 0 }, label);
    assert.deepEqual(cutoff.calls.updates, [], label);
  }
});

test("configuration reads the train only when a cutoff is set", () => {
  assert.equal(configFromEnv({ GITHUB_REPOSITORY: REPO }).train, null);
  assert.deepEqual(
    configFromEnv({ GITHUB_REPOSITORY: REPO, TRAIN_UPDATE_CUTOFF_UTC: "21:45:00", TRAIN_CLOSES_UTC: "22:00:00" }).train,
    { updateCutoff: "21:45:00", opens: null, closes: "22:00:00", weekdays: [1, 4] },
  );
  assert.equal(
    configFromEnv({
      GITHUB_REPOSITORY: REPO,
      TRAIN_UPDATE_CUTOFF_UTC: "21:45:00",
      TRAIN_OPENS_UTC: "15:00:00",
      TRAIN_CLOSES_UTC: "22:00:00",
    }).train.opens,
    "15:00:00",
  );
});

test("Discord delivery reports success only on a 2xx, and a missing webhook falls back to a warning", async () => {
  assert.equal(await discordNotify("", "x"), true);
  assert.equal(await discordNotify("https://discord.test/hook", "x", async () => ({ ok: true, status: 200 })), true);
  assert.equal(await discordNotify("https://discord.test/hook", "x", async () => ({ ok: false, status: 404 })), false);
  assert.equal(
    await discordNotify("https://discord.test/hook", "x", async () => {
      throw new Error("down");
    }),
    false,
  );
});

test("the GitHub adapter keeps PR data out of argv and uses the App token only for writes", () => {
  const seen = [];
  const gh = (args, token) => {
    seen.push({ args, token });
    return "[]";
  };
  const github = createGitHub({ gh, repository: REPO, readToken: "read", updateToken: "app" });
  github.updateBranch(7, "a".repeat(40));
  github.comment(7, "hello $(rm -rf /) `x`");
  github.openPrs();
  github.comments(7);
  assert.deepEqual(seen[0], {
    args: ["api", "--method", "PUT", `repos/${REPO}/pulls/7/update-branch`, "-f", `expected_head_sha=${"a".repeat(40)}`],
    token: "app",
  });
  assert.equal(seen[1].token, "app");
  assert.deepEqual(seen[1].args.slice(-2), ["-f", "body=hello $(rm -rf /) `x`"]);
  assert.equal(seen[2].token, "read");
  assert.equal(seen[3].token, "read");
  assert.match(seen[3].args[1], /per_page=100&page=1$/);
});

test("the GitHub adapter reads each check run's completion time", () => {
  const seen = [];
  const gh = (args, token) => {
    seen.push({ args, token });
    return "[]";
  };
  const github = createGitHub({ gh, repository: REPO, readToken: "read", updateToken: "app" });
  github.checkRuns("a".repeat(40));
  assert.deepEqual(seen, [
    {
      args: [
        "api",
        `repos/${REPO}/commits/${"a".repeat(40)}/check-runs?per_page=100`,
        "--jq",
        "[.check_runs[] | {id, name, status, conclusion, completed_at}]",
      ],
      token: "read",
    },
  ]);
});

test("the workflow keeps event data out of run and mints exactly contents and pull-requests write", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const workflow = readFileSync(join(here, "..", ".github", "workflows", "behind-bot.yml"), "utf8");
  let runIndent = -1;
  let runStatements = 0;
  for (const line of workflow.split("\n")) {
    const indent = line.search(/\S/);
    if (runIndent >= 0) {
      if (line.trim() === "" || indent > runIndent) {
        assert.equal(line.includes("${{"), false, line);
        continue;
      }
      runIndent = -1;
    }
    const match = line.match(/^(\s*)(?:- )?run:\s*(.*)$/);
    if (match) {
      runStatements += 1;
      assert.equal(match[2].includes("${{"), false, line);
      runIndent = match[1].length;
    }
  }
  assert.ok(runStatements >= 1);
  const permissions = [...workflow.matchAll(/^\s*(permission-[a-z-]+)\s*:\s*(.*)$/gim)]
    .map((m) => `${m[1].toLowerCase()}=${m[2].replace(/#.*$/, "").replace(/["']/g, "").trim().toLowerCase()}`)
    .sort();
  assert.deepEqual(permissions, ["permission-contents=write", "permission-pull-requests=write"]);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /ref: \$\{\{ github\.event/);
  assert.match(workflow, /head_repository\.full_name == github\.repository/);
  assert.doesNotMatch(workflow, /conclusion == 'cancelled'/);
});

const entryScript = join(dirname(fileURLToPath(import.meta.url)), "behind-bot.mjs");
const ENTRY_SPAWN_TIMEOUT_MS = 30_000;

function entryFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "behind-bot-entry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runEntry(dir, args) {
  const result = spawnSync(process.execPath, args, {
    env: {
      PATH: dir,
      GITHUB_REPOSITORY: "Monoradioactivo/behind-bot-fixture",
      READ_TOKEN: "stub-read-token",
      UPDATE_TOKEN: "stub-update-token",
    },
    encoding: "utf8",
    timeout: ENTRY_SPAWN_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.error, undefined, `the run did not finish: ${result.error && result.error.message}`);

  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function assertEntryPathFailure(run) {
  assert.equal(run.status, 1);
  assert.match(run.stderr, /ENOENT/);
  assert.match(run.stderr, /realpathSync/);
  assert.match(run.stderr, /behind-bot\.mjs:\d+/);
  assert.doesNotMatch(run.stderr, /spawnSync gh/);
  assert.equal(run.stdout, "");
}

test("a symlinked entry runs the bot as far as its first GitHub read", (t) => {
  const dir = entryFixture(t);
  const link = join(dir, "bot-link.mjs");
  symlinkSync(entryScript, link);

  const run = runEntry(dir, [link]);

  assert.equal(run.status, 1);
  assert.match(run.stderr, /spawnSync gh ENOENT/);
});

test("a symlinked entry that stops resolving fails the run instead of exiting 0 without running", (t) => {
  const dir = entryFixture(t);
  const link = join(dir, "bot-link.mjs");
  symlinkSync(entryScript, link);
  const preload = join(dir, "remove-entry.mjs");
  writeFileSync(preload, `import { unlinkSync } from "node:fs";\nunlinkSync(${JSON.stringify(link)});\n`);

  const run = runEntry(dir, ["--import", pathToFileURL(preload).href, link]);

  assert.equal(existsSync(link), false, "the preload left the entry in place, so the guard never met a path it could not resolve");
  assertEntryPathFailure(run);
});

test("a module whose own path stops resolving fails the import instead of passing as one", (t) => {
  const dir = entryFixture(t);
  const copy = join(dir, "behind-bot.mjs");
  copyFileSync(entryScript, copy);
  writeFileSync(
    join(dir, "remove-module.mjs"),
    `import { unlinkSync } from "node:fs";\nunlinkSync(${JSON.stringify(copy)});\n`,
  );
  const importer = join(dir, "importer.mjs");
  writeFileSync(importer, 'import "./remove-module.mjs";\nimport "./behind-bot.mjs";\nconsole.log("IMPORTED");\n');

  const run = runEntry(dir, [importer]);

  assert.equal(existsSync(copy), false, "the importer left the module in place, so the guard never met a path it could not resolve");
  assertEntryPathFailure(run);
});

test("importing the module runs no bot", (t) => {
  const dir = entryFixture(t);

  const run = runEntry(dir, [
    "--input-type=module",
    "-e",
    `await import(${JSON.stringify(pathToFileURL(entryScript).href)});\nconsole.log("IMPORTED");`,
  ]);

  assert.equal(run.status, 0);
  assert.equal(run.stdout, "IMPORTED\n");
  assert.doesNotMatch(run.stderr, /spawnSync gh/);
});
