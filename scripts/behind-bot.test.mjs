import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

test("required check state takes the newest run per name whatever order the API returns", () => {
  const newestFirst = [
    { id: 20, name: "YAML lint", status: "completed", conclusion: "success" },
    { id: 10, name: "YAML lint", status: "completed", conclusion: "failure" },
  ];
  assert.equal(requiredCheckState(["YAML lint"], newestFirst, []), "passing");
  const oldestFirst = [...newestFirst].reverse();
  assert.equal(requiredCheckState(["YAML lint"], oldestFirst, []), "passing");
  const failingNewest = [
    { id: 30, name: "YAML lint", status: "completed", conclusion: "timed_out" },
    { id: 5, name: "YAML lint", status: "completed", conclusion: "success" },
  ];
  assert.equal(requiredCheckState(["YAML lint"], failingNewest, []), "failing");
  assert.equal(requiredCheckState(["YAML lint"], [{ id: 1, name: "YAML lint", status: "queued", conclusion: null }], []), "pending");
  assert.equal(requiredCheckState(["Pages"], [], [{ context: "Pages", state: "error" }]), "failing");
  assert.equal(requiredCheckState(["Pages"], [], []), "pending");
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

test("an UNKNOWN merge state is polled until GitHub computes it", async () => {
  const github = fakeGitHub({ prs: [pr(1, { mergeStateStatus: "UNKNOWN" })], mergeStates: { 1: ["UNKNOWN", "BEHIND"] } });
  const { result } = await exec(github);
  assert.equal(result.action, "updated");
  assert.equal(github.calls.mergeStatePolls, 2);
});

test("a merge state that is not BEHIND is left alone", async () => {
  const github = fakeGitHub({ prs: [pr(1, { mergeStateStatus: "BLOCKED" }), pr(2, { mergeStateStatus: "CLEAN" })] });
  const { result } = await exec(github);
  assert.deepEqual(result, { action: "none", failures: 0 });
  assert.deepEqual(github.calls.updates, []);
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

test("configuration reads the train only when a cutoff is set", () => {
  assert.equal(configFromEnv({ GITHUB_REPOSITORY: REPO }).train, null);
  assert.deepEqual(
    configFromEnv({ GITHUB_REPOSITORY: REPO, TRAIN_UPDATE_CUTOFF_UTC: "21:45:00", TRAIN_CLOSES_UTC: "22:00:00" }).train,
    { updateCutoff: "21:45:00", closes: "22:00:00", weekdays: [1, 4] },
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
