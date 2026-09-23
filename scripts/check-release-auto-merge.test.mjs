import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { REQUIRED_TEST_CHECK } from "./release-auto-merge-gate.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(scriptDir, "check-release-auto-merge.mjs");
const scriptUrl = pathToFileURL(scriptPath).href;

const REPO = "Monoradioactivo/release-gate-fixture";
const BASE_TAG = "v3.12.27";
const APP_TOKEN = "stub-app-token";
const CHECKS_TOKEN = "stub-checks-token";
const MERGE_SHA = "76b2aee4ded8d5269678645f543e024b98ae51d4";
const HEAD_SHA = "d47ca4779e01583ee51d3426890325ba99232392";
const SPAWN_TIMEOUT_MS = 30_000;

const STUB = [
  "#!/bin/sh",
  'case " $* " in',
  '  *"/compare/"*) printf "%s" "$STUB_COMPARE"; exit 0 ;;',
  '  *"/releases/latest"*) printf "%s" "$STUB_LATEST_TAG"; exit 0 ;;',
  '  *"/contents/package.json"*)',
  '    if [ "$STUB_PACKAGE_MISSING" = "1" ]; then',
  '      echo "gh: Not Found (HTTP 404)" >&2',
  "      exit 1",
  "    fi",
  '    case " $* " in',
  '      *"ref=main "*) printf "%s" "$STUB_PACKAGE_BASE" ;;',
  '      *) printf "%s" "$STUB_PACKAGE_HEAD" ;;',
  "    esac",
  "    exit 0",
  "    ;;",
  '  *"/contents/"*)',
  '    if [ "$STUB_CONTENTS_FAIL" = "1" ]; then',
  '      echo "stub: refusing contents" >&2',
  "      exit 1",
  "    fi",
  '    if [ "$STUB_MANIFEST_MISSING" = "1" ]; then',
  '      echo "gh: Not Found (HTTP 404)" >&2',
  "      exit 1",
  "    fi",
  '    case " $* " in',
  '      *"ref=main "*) printf "%s" "$STUB_MANIFEST_BASE" ;;',
  '      *) printf "%s" "$STUB_MANIFEST_HEAD" ;;',
  "    esac",
  "    exit 0",
  "    ;;",
  '  *"/issues/"*"/events"*)',
  '    if [ -n "$STUB_EVENTS_FAIL_FOR_TOKEN" ] && [ "$GH_TOKEN" = "$STUB_EVENTS_FAIL_FOR_TOKEN" ]; then',
  '      echo "stub: refusing events for this token" >&2',
  "      exit 1",
  "    fi",
  '    if [ "$STUB_EVENTS_FAIL_ALWAYS" = "1" ]; then',
  '      echo "stub: refusing events" >&2',
  "      exit 1",
  "    fi",
  '    printf "%s" "$STUB_EVENTS"',
  "    exit 0",
  "    ;;",
  '  *"/check-runs"*)',
  '    if [ "$STUB_CHECK_RUNS_UNEXPECTED" = "1" ]; then',
  '      echo "UNEXPECTED_CHECK_RUNS_CALL" >&2',
  "      exit 1",
  "    fi",
  '    if [ -n "$STUB_CHECK_RUNS_FAIL_FOR_TOKEN" ] && [ "$GH_TOKEN" = "$STUB_CHECK_RUNS_FAIL_FOR_TOKEN" ]; then',
  '      echo "stub: refusing check-runs for this token" >&2',
  "      exit 1",
  "    fi",
  '    printf "%s" "$STUB_CHECK_RUNS"',
  "    exit 0",
  "    ;;",
  '  *"/commits/"*"/pulls"*) printf "%s" "$STUB_COMMIT_PULLS"; exit 0 ;;',
  '  *"/pulls/"*)',
  '    if [ "$STUB_RELEASE_PR_FAIL" = "1" ]; then',
  '      echo "stub: refusing the release pull request read" >&2',
  "      exit 1",
  "    fi",
  '    printf "%s" "$STUB_RELEASE_PR"',
  "    exit 0",
  "    ;;",
  "esac",
  'echo "unexpected gh: $*" >&2',
  "exit 1",
  "",
].join("\n");

function compareBody(commits, total = commits.length) {
  return JSON.stringify({ total, commits });
}

function commitPulls(pr) {
  return JSON.stringify([pr]);
}

const SUCCESSFUL_TEST_CHECK = JSON.stringify({
  total: 1,
  runs: [
    {
      name: REQUIRED_TEST_CHECK,
      app: "github-actions",
      status: "completed",
      conclusion: "success",
      completed_at: "2026-09-10T19:43:43Z",
    },
  ],
});

function ndjson(events) {
  return events.map((event) => JSON.stringify(event)).join("\n");
}

function manifest(version) {
  return Buffer.from(JSON.stringify({ ".": version })).toString("base64");
}

function packageJson(version) {
  return Buffer.from(JSON.stringify({ name: "fixture", version })).toString("base64");
}

const RELEASE_PR_REFS = JSON.stringify({
  head: "release-please--branches--main--components--fixture",
  base: "main",
});

function runGate({ args = ["0", BASE_TAG], env = {}, repo = REPO } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "release-gate-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), STUB, { mode: 0o755 });
  const output = join(dir, "github_output");
  writeFileSync(output, "");

  const childEnv = {
    PATH: bin,
    GITHUB_OUTPUT: output,
    GH_TOKEN: APP_TOKEN,
    STUB_COMPARE: "",
    STUB_LATEST_TAG: "",
    STUB_COMMIT_PULLS: "",
    STUB_EVENTS: "",
    STUB_CHECK_RUNS: SUCCESSFUL_TEST_CHECK,
    STUB_RELEASE_PR: RELEASE_PR_REFS,
    STUB_MANIFEST_BASE: manifest("3.15.1"),
    STUB_MANIFEST_HEAD: manifest("3.15.2"),
    STUB_PACKAGE_BASE: packageJson("1.3.0"),
    STUB_PACKAGE_HEAD: packageJson("1.4.0"),
    ...env,
  };
  if (repo !== null) childEnv.GITHUB_REPOSITORY = repo;

  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    env: childEnv,
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.error, undefined, `the gate could not be spawned: ${result.error && result.error.message}`);
  assert.notEqual(result.signal, "SIGTERM", "the gate did not finish inside the spawn timeout");
  assert.doesNotMatch(
    result.stderr,
    /unexpected gh:/,
    `the gate asked the stub something it does not answer: ${result.stderr}`,
  );

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    output: readFileSync(output, "utf8"),
    verdict: result.stdout.trim() ? JSON.parse(result.stdout) : null,
  };
}

function labelVouchedCommit(overrides = {}) {
  return {
    STUB_COMPARE: compareBody([{ sha: MERGE_SHA, message: "fix(acquisition): bound the redis read" }]),
    STUB_COMMIT_PULLS: commitPulls({
      number: 376,
      labels: ["brief-verified"],
      headSha: HEAD_SHA,
      author: "Monoradioactivo",
    }),
    ...overrides,
  };
}

test("a label-vouched commit with a successful Test check is blessed", () => {
  const run = runGate({
    env: labelVouchedCommit({
      STUB_EVENTS: ndjson([{ actor: "Monoradioactivo", at: "2026-09-10T19:49:24Z" }]),
    }),
  });

  assert.equal(run.status, 0);
  assert.equal(run.verdict.ok, true);
  assert.equal(run.verdict.commits[0].via, "brief-verified label");
  assert.match(run.output, /^ok=true$/m);
  assert.match(run.output, /^reasons<<GATE_[0-9a-f]{32}$/m);
});

test("every line of a multi-page NDJSON body is parsed, not just the first", () => {
  const run = runGate({
    env: labelVouchedCommit({
      STUB_EVENTS: ndjson([
        { actor: "Monoradioactivo", at: "2026-09-01T10:00:00Z" },
        { actor: "Monoradioactivo", at: "2026-09-02T10:00:00Z" },
        { actor: "Monoradioactivo", at: "2026-09-03T10:00:00Z" },
        { actor: "Monoradioactivo", at: "2026-09-04T10:00:00Z" },
        { actor: "Monoradioactivo", at: "2026-09-05T10:00:00Z" },
        { actor: "Monoradioactivo", at: "2026-09-06T10:00:00Z" },
        { actor: "drive-by", at: "2026-09-07T10:00:00Z" },
      ]),
    }),
  });

  assert.equal(run.verdict.ok, false);
  assert.equal(run.verdict.commits[0].refusedLabel, true);
  assert.equal(run.verdict.commits[0].labelActor, "drive-by");
});

test("the newest labeled event decides, even when it arrives first in the stream", () => {
  const run = runGate({
    env: labelVouchedCommit({
      STUB_EVENTS: ndjson([
        { actor: "drive-by", at: "2026-09-11T08:00:00Z" },
        { actor: "Monoradioactivo", at: "2026-09-10T19:49:24Z" },
      ]),
    }),
  });

  assert.equal(run.verdict.ok, false);
  assert.equal(run.verdict.commits[0].labelActor, "drive-by");
  assert.match(run.verdict.reasons[0], /applied by drive-by, whose vouch this gate does not accept/);
});

test("the newest labeled event decides when it arrives last in the stream too", () => {
  const run = runGate({
    env: labelVouchedCommit({
      STUB_EVENTS: ndjson([
        { actor: "drive-by", at: "2026-09-10T19:49:24Z" },
        { actor: "Monoradioactivo", at: "2026-09-11T08:00:00Z" },
      ]),
    }),
  });

  assert.equal(run.verdict.ok, true);
  assert.equal(run.verdict.commits[0].via, "brief-verified label");
});

test("a malformed NDJSON line refuses the release instead of blessing it", () => {
  const run = runGate({
    env: labelVouchedCommit({
      STUB_EVENTS: [
        JSON.stringify({ actor: "Monoradioactivo", at: "2026-09-10T19:49:24Z" }),
        "not json at all",
      ].join("\n"),
    }),
  });

  assert.equal(run.verdict.ok, false);
  assert.equal(run.verdict.commits[0].unresolved, true);
  assert.match(run.stderr, /reading brief-verified events on #376 with token 1 of 1 failed/);
  assert.match(run.verdict.reasons[0], /could not establish whether/);
});

test("an empty labeled-event read refuses the release and says why", () => {
  const run = runGate({
    env: labelVouchedCommit({ STUB_EVENTS: "" }),
  });

  assert.equal(run.verdict.ok, false);
  assert.equal(run.verdict.commits[0].unresolved, true);
  assert.match(run.stderr, /#376 carries the brief-verified label but no labeled event names it/);
});

test("the second token is tried when the first fails, and its read decides", () => {
  const run = runGate({
    env: labelVouchedCommit({
      CHECKS_GH_TOKEN: CHECKS_TOKEN,
      STUB_EVENTS_FAIL_FOR_TOKEN: APP_TOKEN,
      STUB_EVENTS: ndjson([{ actor: "Monoradioactivo", at: "2026-09-10T19:49:24Z" }]),
    }),
  });

  assert.match(run.stderr, /with token 1 of 2 failed/);
  assert.doesNotMatch(run.stderr, /with token 2 of 2 failed/);
  assert.equal(run.verdict.ok, true);
  assert.equal(run.verdict.commits[0].via, "brief-verified label");
});

test("both tokens failing refuses the release", () => {
  const run = runGate({
    env: labelVouchedCommit({
      CHECKS_GH_TOKEN: CHECKS_TOKEN,
      STUB_EVENTS_FAIL_ALWAYS: "1",
    }),
  });

  assert.match(run.stderr, /with token 1 of 2 failed/);
  assert.match(run.stderr, /with token 2 of 2 failed/);
  assert.equal(run.verdict.ok, false);
  assert.equal(run.verdict.commits[0].unresolved, true);
});

test("only one token is tried when CHECKS_GH_TOKEN is unset", () => {
  const run = runGate({
    env: labelVouchedCommit({ STUB_EVENTS_FAIL_ALWAYS: "1" }),
  });

  assert.match(run.stderr, /with token 1 of 1 failed/);
  assert.doesNotMatch(run.stderr, /token 2 of/);
  assert.equal(run.verdict.ok, false);
});

test("a check-runs read the API says is truncated refuses the release", () => {
  const run = runGate({
    env: labelVouchedCommit({
      STUB_EVENTS: ndjson([{ actor: "Monoradioactivo", at: "2026-09-10T19:49:24Z" }]),
      STUB_CHECK_RUNS: JSON.stringify({
        total: 2,
        runs: [
          {
            name: REQUIRED_TEST_CHECK,
            app: "github-actions",
            status: "completed",
            conclusion: "success",
            completed_at: "2026-09-10T19:43:43Z",
          },
        ],
      }),
    }),
  });

  assert.equal(run.verdict.ok, false);
  assert.equal(run.verdict.commits[0].unresolved, true);
  assert.doesNotMatch(run.stderr, /no labeled event names it/);
  assert.doesNotMatch(run.stderr, /reading brief-verified events/);
});

test("a failed Test check refuses the release and names the conclusion", () => {
  const run = runGate({
    env: labelVouchedCommit({
      STUB_EVENTS: ndjson([{ actor: "Monoradioactivo", at: "2026-09-10T19:49:24Z" }]),
      STUB_CHECK_RUNS: JSON.stringify({
        total: 1,
        runs: [
          {
            name: REQUIRED_TEST_CHECK,
            app: "github-actions",
            status: "completed",
            conclusion: "failure",
            completed_at: "2026-09-10T19:43:43Z",
          },
        ],
      }),
    }),
  });

  assert.equal(run.verdict.ok, false);
  assert.equal(run.verdict.commits[0].missingTest, true);
  assert.equal(run.verdict.commits[0].testConclusion, "failure");
});

test("a Brief-Verified trailer is vouched without reading labeled events", () => {
  const run = runGate({
    env: {
      STUB_COMPARE: compareBody([
        {
          sha: MERGE_SHA,
          message: "fix(acquisition): bound the redis read\n\nBrief-Verified: acquisition-redis-read-bound",
        },
      ]),
      STUB_COMMIT_PULLS: commitPulls({
        number: 376,
        labels: ["brief-verified"],
        headSha: HEAD_SHA,
        author: "Monoradioactivo",
      }),
      STUB_EVENTS_FAIL_ALWAYS: "1",
    },
  });

  assert.equal(run.verdict.ok, true);
  assert.equal(run.verdict.commits[0].via, "Brief-Verified trailer");
  assert.doesNotMatch(run.stderr, /reading brief-verified events/);
});

test("a Renovate pull request is vouched by its author without reading labeled events", () => {
  const run = runGate({
    env: {
      STUB_COMPARE: compareBody([{ sha: MERGE_SHA, message: "chore(deps): bump pg to 8.16.4" }]),
      STUB_COMMIT_PULLS: commitPulls({
        number: 376,
        labels: [],
        headSha: HEAD_SHA,
        author: "renovate[bot]",
      }),
      STUB_EVENTS_FAIL_ALWAYS: "1",
    },
  });

  assert.equal(run.verdict.ok, true);
  assert.equal(run.verdict.commits[0].via, "Renovate pull request");
  assert.doesNotMatch(run.stderr, /reading brief-verified events/);
});

test("an unvouched commit is refused without any Test check being read", () => {
  const run = runGate({
    env: {
      STUB_COMPARE: compareBody([{ sha: MERGE_SHA, message: "fix(acquisition): bound the redis read" }]),
      STUB_COMMIT_PULLS: commitPulls({
        number: 376,
        labels: [],
        headSha: HEAD_SHA,
        author: "Monoradioactivo",
      }),
      STUB_CHECK_RUNS_UNEXPECTED: "1",
    },
  });

  assert.equal(run.verdict.ok, false);
  assert.match(run.verdict.reasons[0], /carries neither a Brief-Verified trailer nor the brief-verified label/);
  assert.doesNotMatch(run.stderr, /UNEXPECTED_CHECK_RUNS_CALL/);
});

test("a commit belonging to no merged pull request is refused", () => {
  const run = runGate({
    env: {
      STUB_COMPARE: compareBody([{ sha: MERGE_SHA, message: "fix(acquisition): bound the redis read" }]),
      STUB_COMMIT_PULLS: "[]",
    },
  });

  assert.equal(run.verdict.ok, false);
  assert.match(run.verdict.reasons[0], /carries no Brief-Verified trailer and belongs to no pull request/);
});

test("the base tag is read from the latest release when no tag argument is given", () => {
  const run = runGate({
    args: [],
    env: labelVouchedCommit({
      STUB_LATEST_TAG: BASE_TAG,
      STUB_EVENTS: ndjson([{ actor: "Monoradioactivo", at: "2026-09-10T19:49:24Z" }]),
    }),
  });

  assert.equal(run.verdict.baseTag, BASE_TAG);
  assert.equal(run.verdict.ok, true);
});

test("a release with no readable previous tag is refused", () => {
  const run = runGate({ args: [], env: { STUB_LATEST_TAG: "" } });

  assert.equal(run.verdict.ok, false);
  assert.equal(run.verdict.baseTag, null);
  assert.match(run.verdict.reasons[0], /no previous release tag was found/);
});

test("the release pull request shape reads a version from both sides", () => {
  const run = runGate({
    args: ["448", BASE_TAG],
    env: labelVouchedCommit({
      STUB_EVENTS: ndjson([{ actor: "Monoradioactivo", at: "2026-09-10T19:49:24Z" }]),
    }),
  });

  assert.equal(run.verdict.ok, true);
  assert.equal(run.verdict.releaseVersion, "3.15.2");
});

test("a major bump always needs a human", () => {
  const run = runGate({
    args: ["448", BASE_TAG],
    env: labelVouchedCommit({
      STUB_EVENTS: ndjson([{ actor: "Monoradioactivo", at: "2026-09-10T19:49:24Z" }]),
      STUB_MANIFEST_HEAD: manifest("4.0.0"),
    }),
  });

  assert.equal(run.verdict.ok, false);
  assert.match(run.verdict.reasons[0], /a major bump, 3\.15\.1 to 4\.0\.0, always needs a human/);
});

test("a manifest that cannot be read refuses the release", () => {
  const run = runGate({
    args: ["448", BASE_TAG],
    env: labelVouchedCommit({
      STUB_EVENTS: ndjson([{ actor: "Monoradioactivo", at: "2026-09-10T19:49:24Z" }]),
      STUB_CONTENTS_FAIL: "1",
    }),
  });

  assert.equal(run.verdict.ok, false);
  assert.equal(run.verdict.releaseVersion, null);
  assert.match(run.verdict.reasons[0], /could not read a valid version on both sides/);
});

test("a missing manifest falls back to package.json on both sides", () => {
  const run = runGate({
    args: ["448", BASE_TAG],
    env: labelVouchedCommit({
      STUB_EVENTS: ndjson([{ actor: "Monoradioactivo", at: "2026-09-10T19:49:24Z" }]),
      STUB_MANIFEST_MISSING: "1",
    }),
  });

  assert.equal(run.verdict.ok, true);
  assert.equal(run.verdict.releaseVersion, "1.4.0");
});

test("a major bump read from package.json still needs a human", () => {
  const run = runGate({
    args: ["448", BASE_TAG],
    env: labelVouchedCommit({
      STUB_EVENTS: ndjson([{ actor: "Monoradioactivo", at: "2026-09-10T19:49:24Z" }]),
      STUB_MANIFEST_MISSING: "1",
      STUB_PACKAGE_HEAD: packageJson("2.0.0"),
    }),
  });

  assert.equal(run.verdict.ok, false);
  assert.match(run.verdict.reasons[0], /a major bump, 1\.3\.0 to 2\.0\.0, always needs a human/);
});

test("a missing manifest and a missing package.json refuse the release", () => {
  const run = runGate({
    args: ["448", BASE_TAG],
    env: labelVouchedCommit({
      STUB_EVENTS: ndjson([{ actor: "Monoradioactivo", at: "2026-09-10T19:49:24Z" }]),
      STUB_MANIFEST_MISSING: "1",
      STUB_PACKAGE_MISSING: "1",
    }),
  });

  assert.equal(run.verdict.ok, false);
  assert.equal(run.verdict.releaseVersion, null);
  assert.match(run.verdict.reasons[0], /could not read a valid version on both sides/);
});

test("a manifest read that fails for another reason does not fall back to package.json", () => {
  const run = runGate({
    args: ["448", BASE_TAG],
    env: labelVouchedCommit({
      STUB_EVENTS: ndjson([{ actor: "Monoradioactivo", at: "2026-09-10T19:49:24Z" }]),
      STUB_CONTENTS_FAIL: "1",
    }),
  });

  assert.equal(run.verdict.ok, false);
  assert.equal(run.verdict.releaseVersion, null);
  assert.doesNotMatch(run.stderr, /Not Found/);
});

test("the Test check is read with the checks token, not the app token", () => {
  const run = runGate({
    env: labelVouchedCommit({
      CHECKS_GH_TOKEN: CHECKS_TOKEN,
      STUB_EVENTS: ndjson([{ actor: "Monoradioactivo", at: "2026-09-10T19:49:24Z" }]),
      STUB_CHECK_RUNS_FAIL_FOR_TOKEN: APP_TOKEN,
    }),
  });

  assert.equal(run.verdict.ok, true);
  assert.equal(run.verdict.commits[0].via, "brief-verified label");
});

test("a compare range the API says it truncated refuses the release", () => {
  const run = runGate({
    env: labelVouchedCommit({
      STUB_COMPARE: compareBody([{ sha: MERGE_SHA, message: "fix(acquisition): bound the redis read" }], 2),
      STUB_EVENTS: ndjson([{ actor: "Monoradioactivo", at: "2026-09-10T19:49:24Z" }]),
    }),
  });

  assert.equal(run.verdict.ok, false);
  assert.equal(run.verdict.commits[0].blessed, true);
  assert.match(run.verdict.reasons[0], /the compare range was truncated by the API/);
});

test("an unreadable compare range refuses the release without inspecting commits", () => {
  const run = runGate({ env: { STUB_COMPARE: "" } });

  assert.equal(run.verdict.ok, false);
  assert.deepEqual(run.verdict.commits, []);
  assert.match(run.verdict.reasons[0], /the compare range was truncated by the API/);
});

test("a failed release pull request read exits loudly rather than writing a verdict", () => {
  const run = runGate({
    args: ["448", BASE_TAG],
    env: labelVouchedCommit({
      STUB_EVENTS: ndjson([{ actor: "Monoradioactivo", at: "2026-09-10T19:49:24Z" }]),
      STUB_RELEASE_PR_FAIL: "1",
    }),
  });

  assert.notEqual(run.status, 0);
  assert.equal(run.verdict, null);
  assert.equal(run.output, "");
});

test("release-please's own commit is vouched by its author", () => {
  const run = runGate({
    env: {
      STUB_COMPARE: compareBody([{ sha: MERGE_SHA, message: "chore(main): release 3.15.2 (#448)" }]),
      STUB_COMMIT_PULLS: commitPulls({
        number: 448,
        labels: ["autorelease: tagged"],
        headSha: HEAD_SHA,
        author: "aetherpush-release-bot[bot]",
      }),
      STUB_EVENTS_FAIL_ALWAYS: "1",
      STUB_CHECK_RUNS_UNEXPECTED: "1",
    },
  });

  assert.equal(run.verdict.ok, true);
  assert.equal(run.verdict.commits[0].via, "release-please pull request");
  assert.doesNotMatch(run.stderr, /UNEXPECTED_CHECK_RUNS_CALL/);
});

test("a release-shaped commit from another author is not vouched for as a release", () => {
  const run = runGate({
    env: {
      STUB_COMPARE: compareBody([{ sha: MERGE_SHA, message: "chore(main): release 3.15.2 (#448)" }]),
      STUB_COMMIT_PULLS: commitPulls({
        number: 448,
        labels: ["autorelease: tagged"],
        headSha: HEAD_SHA,
        author: "not-the-release-bot",
      }),
      STUB_EVENTS_FAIL_ALWAYS: "1",
    },
  });

  assert.equal(run.verdict.ok, false);
  assert.equal(run.verdict.commits[0].blessed, false);
  assert.equal(run.verdict.commits[0].via, null);
  assert.match(run.verdict.reasons[0], /carries neither a Brief-Verified trailer nor the brief-verified label/);
});

test("running without GITHUB_REPOSITORY still exits 2 and says so", () => {
  const run = runGate({ repo: null });

  assert.equal(run.status, 2);
  assert.match(run.stderr, /GITHUB_REPOSITORY is required/);
  assert.equal(run.stdout.trim(), "");
});

test("importing the module runs no gate and writes no output", () => {
  const dir = mkdtempSync(join(tmpdir(), "release-gate-import-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), STUB, { mode: 0o755 });
  const output = join(dir, "github_output");
  writeFileSync(output, "");

  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const mod = await import(${JSON.stringify(scriptUrl)});\nconsole.log("IMPORTED " + JSON.stringify(Object.keys(mod)));`,
    ],
    {
      env: {
        PATH: bin,
        GITHUB_OUTPUT: output,
        GITHUB_REPOSITORY: REPO,
        GH_TOKEN: APP_TOKEN,
      },
      encoding: "utf8",
      timeout: SPAWN_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  assert.equal(result.status, 0);
  assert.match(result.stdout, /IMPORTED \["contentsFetchFailedAsMissing","versionFromPayloads"\]/);
  assert.doesNotMatch(result.stdout, /"ok":/);
  assert.equal(readFileSync(output, "utf8"), "");
});

test("importing the module without GITHUB_REPOSITORY does not exit the process", () => {
  const dir = mkdtempSync(join(tmpdir(), "release-gate-import-bare-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), STUB, { mode: 0o755 });

  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(scriptUrl)});\nconsole.log("STILL ALIVE");`],
    {
      env: { PATH: bin },
      encoding: "utf8",
      timeout: SPAWN_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  assert.equal(result.status, 0);
  assert.match(result.stdout, /STILL ALIVE/);
  assert.doesNotMatch(result.stderr, /GITHUB_REPOSITORY is required/);
});
