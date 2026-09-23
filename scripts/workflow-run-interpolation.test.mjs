import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import yaml from "js-yaml";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflowsDir = join(repoRoot, ".github", "workflows");

function runInterpolations(doc) {
  const hits = [];
  const jobs = doc?.jobs ?? {};
  for (const [jobId, job] of Object.entries(jobs)) {
    const steps = job?.steps ?? [];
    for (const [i, step] of steps.entries()) {
      if (typeof step?.run !== "string") continue;
      if (step.run.includes("${{")) {
        hits.push(`${jobId}[${i}] ${step.name ?? "(unnamed)"}`);
      }
    }
  }
  return hits;
}

test("no workflow interpolates expressions inside run:", () => {
  const files = readdirSync(workflowsDir).filter(
    (file) => file.endsWith(".yml") || file.endsWith(".yaml"),
  );
  assert.ok(files.length > 0);
  const allHits = [];
  for (const file of files) {
    const doc = yaml.load(readFileSync(join(workflowsDir, file), "utf8"));
    for (const hit of runInterpolations(doc)) {
      allHits.push(`${file}: ${hit}`);
    }
  }
  assert.deepEqual(allHits, []);
});

test("the scanner reports a run interpolation when one is present", () => {
  const doc = yaml.load(
    [
      "jobs:",
      "  example:",
      "    steps:",
      "      - name: bad",
      "        run: |",
      '          BRANCH="${{ github.head_ref }}"',
    ].join("\n"),
  );
  assert.deepEqual(runInterpolations(doc), ["example[0] bad"]);
});

test("the scanner reports ${{ env.* }} inside run the same as github.*", () => {
  const doc = yaml.load(
    [
      "jobs:",
      "  example:",
      "    steps:",
      "      - name: still-interpolated",
      "        env:",
      "          BRANCH: ${{ github.head_ref }}",
      "        run: |",
      '          echo "${{ env.BRANCH }}"',
    ].join("\n"),
  );
  assert.deepEqual(runInterpolations(doc), ["example[0] still-interpolated"]);
});

function gateWorkflow() {
  return yaml.load(readFileSync(join(workflowsDir, "auto-merge-release.yml"), "utf8"));
}

function cloneGate() {
  return structuredClone(gateWorkflow());
}

function gateSteps(doc = gateWorkflow()) {
  return doc.jobs.gate.steps;
}

function indexOfStep(steps, name) {
  return steps.findIndex((step) => step.name === name);
}

function softensFailure(node) {
  return node["continue-on-error"] !== undefined;
}

const EXPECTED_REFUSE_IF =
  "steps.gate.outputs.ok == 'false' && github.event_name != 'schedule'";

function normalizeIf(condition) {
  return String(condition ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function assertRefuseScheduleCarveOut(steps) {
  const refuse = indexOfStep(steps, "Fail when the release is not accounted for");
  assert.notEqual(refuse, -1, "the gate job has no 'Fail when the release is not accounted for' step");
  assert.equal(
    normalizeIf(steps[refuse].if),
    EXPECTED_REFUSE_IF,
    "the refuse step must fail closed on pull_request and dispatch while staying green on schedule. Doctrine pins the schedule carve-out (ci-release-gate-scheduled-hold-noise); dropping != 'schedule' reopens hold-noise email, and dropping the ok==false half greens an unaccounted release PR check.",
  );
  assert.match(
    steps[refuse].run,
    /^\s*exit 1\s*$/m,
    "the refuse step keeps its if: but no longer exits 1, so a held release PR can report the required check green",
  );
}

function readsVerdict(step) {
  const sources = [step.if, ...Object.values(step.env ?? {}), ...Object.values(step.with ?? {})];
  return sources.some((source) => typeof source === "string" && source.includes("gate.outputs."));
}

test("an absent verdict fails the job instead of reading as a satisfied check", () => {
  const steps = gateSteps();
  const verdict = indexOfStep(steps, "Require a verdict from the gate");
  assert.notEqual(verdict, -1);
  assert.equal(steps[verdict].if, "steps.pr.outputs.number != '' && steps.gate.outputs.ok == ''");
  assert.match(steps[verdict].run, /^\s*exit 1\s*$/m);
  assert.ok(!softensFailure(steps[verdict]), "the verdict step carries continue-on-error, so its failure may not red the job");
  const refuse = indexOfStep(steps, "Fail when the release is not accounted for");
  assert.notEqual(refuse, -1, "the gate job has no 'Fail when the release is not accounted for' step");
  assert.ok(!softensFailure(steps[refuse]), "the step that reds an unaccounted release carries continue-on-error");
  assertRefuseScheduleCarveOut(steps);
});

test("nothing above the steps waves the job through a failed verdict", () => {
  const doc = gateWorkflow();
  const job = doc.jobs.gate;
  assert.ok(!softensFailure(job), "the gate job carries continue-on-error, so the run may pass even when the job fails");
  assert.equal(job.strategy, undefined, "a matrix renames the check, so the required context never reports and every pull request waits on it");
  assert.equal(job.if, undefined, "these four deliberately carry no job-level if (doctrine/shipping.md); one that can skip the release pull request makes the required check report satisfied");
  assert.deepEqual(Object.keys(doc.jobs), ["gate"], "another job in this workflow can take the gate's required-check name or make it skip through needs");
  const context = doc.env?.GATE_CONTEXT;
  assert.equal(typeof context, "string");
  assert.ok(context.length > 0, "GATE_CONTEXT is empty, and the required-check lookup matches a blank line");
  assert.equal(job.name, context, "the gate job's name no longer matches GATE_CONTEXT, the name the ruleset requires");
});

test("the verdict step cannot fire where the gate itself was skipped", () => {
  const steps = gateSteps();
  const gate = indexOfStep(steps, "Evaluate the gate");
  const verdict = indexOfStep(steps, "Require a verdict from the gate");
  assert.notEqual(gate, -1);
  assert.equal(steps[gate].id, "gate", "the verdict step reads steps.gate.outputs.ok, which is empty on every run unless this step's id is gate");
  assert.ok(steps[verdict].if.startsWith(`${steps[gate].if} &&`));
});

test("no step reads the gate verdict before the absent-verdict check", () => {
  const steps = gateSteps();
  const verdict = indexOfStep(steps, "Require a verdict from the gate");
  const consumers = steps
    .map((step, index) => ({ index, step }))
    .filter(({ index, step }) => index !== verdict && readsVerdict(step));
  assert.ok(consumers.length > 0);
  for (const { index } of consumers) {
    assert.ok(index > verdict, `step ${index} (${steps[index].name}) reads the verdict before the check`);
  }
});

test("a failed verdict check still reaches the step that drops a stale arm", () => {
  const steps = gateSteps();
  const verdict = indexOfStep(steps, "Require a verdict from the gate");
  const disarm = indexOfStep(steps, "Disarm if this run failed");
  assert.ok(disarm > verdict);
  assert.match(steps[disarm].if, /failure\(\)/);
});

test("no step acts on the gate verdict without an explicit true or false", () => {
  const steps = gateSteps();
  const consumers = steps.filter(
    (step) =>
      typeof step.if === "string" &&
      step.if.includes("steps.gate.outputs.ok") &&
      step.name !== "Require a verdict from the gate",
  );
  assert.ok(consumers.length >= 3, "a step that acted on the verdict stopped naming steps.gate.outputs.ok");
  for (const step of consumers) {
    assert.match(step.if, /steps\.gate\.outputs\.ok == '(true|false)'/, `${step.name} reads ok without a literal`);
  }
});

test("the merge step reaches the verdict only through a step gated on a true verdict", () => {
  const steps = gateSteps();
  const arm = steps[indexOfStep(steps, "Arm the merge")];
  const required = steps[indexOfStep(steps, "Confirm this gate is a required check")];
  assert.ok(arm);
  assert.ok(required);
  assert.doesNotMatch(arm.if, /steps\.gate\.outputs\.ok/);
  assert.match(arm.if, /steps\.required\.outputs\.required == 'true'/);
  assert.match(required.if, /steps\.gate\.outputs\.ok == 'true'/);
});

test("the refuse step skips schedule and still fails closed on every other event", () => {
  assertRefuseScheduleCarveOut(gateSteps());
});

test("a planted refuse if that reds schedule fails the schedule carve-out check", () => {
  const doc = cloneGate();
  const steps = gateSteps(doc);
  const refuse = indexOfStep(steps, "Fail when the release is not accounted for");
  steps[refuse].if = "steps.gate.outputs.ok == 'false'";
  assert.throws(() => assertRefuseScheduleCarveOut(steps), /schedule carve-out|hold-noise|ok==false/);
});

test("a planted refuse if that never runs fails the schedule carve-out check", () => {
  const doc = cloneGate();
  const steps = gateSteps(doc);
  const refuse = indexOfStep(steps, "Fail when the release is not accounted for");
  steps[refuse].if = "false";
  assert.throws(() => assertRefuseScheduleCarveOut(steps), /schedule carve-out|hold-noise|ok==false/);
});

test("a planted refuse run that no longer exits 1 fails the schedule carve-out check", () => {
  const doc = cloneGate();
  const steps = gateSteps(doc);
  const refuse = indexOfStep(steps, "Fail when the release is not accounted for");
  steps[refuse].run = 'echo "::error::The release contains commits this gate cannot vouch for."';
  assert.throws(() => assertRefuseScheduleCarveOut(steps), /no longer exits 1|required check green/);
});

const RESOLVE_REPO = "Monoradioactivo/release-gate-fixture";
const RELEASE_HEAD = "release-please--branches--main--components--fixture";
const RELEASE_BOT = "aetherpush-release-bot[bot]";

const RESOLVE_STUB = [
  "#!/bin/sh",
  'printf "%s\\n" "$*" >> "$GH_CALLS"',
  'FILTER=""',
  'PREV=""',
  'for ARG in "$@"; do',
  '  if [ "$PREV" = "--jq" ]; then FILTER="$ARG"; fi',
  '  PREV="$ARG"',
  "done",
  'case "$1 $2" in',
  '  "pr list") BODY="$STUB_OPEN_PULLS" ;;',
  '  "api repos/$GITHUB_REPOSITORY/pulls/"*) BODY="$STUB_PULL" ;;',
  '  "pr merge") exit 0 ;;',
  '  "pr comment")',
  '    cat >> "$GH_BODIES"',
  '    if [ "$STUB_COMMENT_FAIL" = "1" ]; then echo "stub: refusing to comment" >&2; exit 1; fi',
  "    exit 0 ;;",
  '  "api --paginate")',
  '    if [ "$STUB_COMMENTS_FAIL" = "1" ]; then echo "stub: refusing the comments read" >&2; exit 1; fi',
  '    BODY="$STUB_COMMENTS" ;;',
  '  *) echo "unexpected gh: $*" >&2; exit 1 ;;',
  "esac",
  'printf "%s" "$BODY" | jq -r "$FILTER"',
  "",
].join("\n");

const STEP_EXPRESSIONS = {
  "${{ github.event_name }}": "event",
  "${{ github.head_ref }}": "headRef",
  "${{ github.event.pull_request.state }}": "prState",
  "${{ github.event.pull_request.number }}": "eventPr",
  "${{ steps.app-token.outputs.token }}": "token",
  "${{ steps.pr.outputs.number }}": "prNumber",
  "${{ steps.gate.outputs.reasons }}": "reasons",
  "${{ steps.gate.outputs.marker }}": "marker",
};

function stepEnv(step, context) {
  const env = {};
  for (const [key, expression] of Object.entries(step.env ?? {})) {
    const field = STEP_EXPRESSIONS[expression];
    assert.ok(field, `${step.name} reads ${expression}, which this harness does not model`);
    env[key] = context[field];
  }
  return env;
}

function parseOutputs(text) {
  const outputs = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) outputs[line.slice(0, at)] = line.slice(at + 1);
  }
  return outputs;
}

function runStep(doc, step, context) {
  assert.equal(typeof step?.run, "string");
  const dir = mkdtempSync(join(tmpdir(), "release-pr-resolve-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), RESOLVE_STUB, { mode: 0o755 });
  const script = join(dir, "step.sh");
  writeFileSync(script, step.run);
  const output = join(dir, "github_output");
  writeFileSync(output, "");
  const calls = join(dir, "gh_calls");
  writeFileSync(calls, "");
  const bodies = join(dir, "gh_bodies");
  writeFileSync(bodies, "");
  const summary = join(dir, "step_summary");
  writeFileSync(summary, "");

  const result = spawnSync("bash", ["-e", script], {
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      GITHUB_OUTPUT: output,
      GITHUB_REPOSITORY: RESOLVE_REPO,
      GITHUB_STEP_SUMMARY: summary,
      GH_CALLS: calls,
      GH_BODIES: bodies,
      STUB_OPEN_PULLS: context.openPulls ?? "[]",
      STUB_PULL: context.pull ?? "",
      STUB_COMMENTS: context.comments ?? "[]",
      STUB_COMMENTS_FAIL: context.commentsFail ?? "",
      STUB_COMMENT_FAIL: context.commentFail ?? "",
      ...doc.env,
      ...stepEnv(step, context),
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.error, undefined, `${step.name} could not be spawned: ${result.error && result.error.message}`);
  assert.doesNotMatch(result.stderr, /unexpected gh:/, `${step.name} asked the stub something it does not answer: ${result.stderr}`);
  if (context.expectFailure) {
    assert.notEqual(result.status, 0, `${step.name} exited 0 where it had to fail`);
  } else {
    assert.equal(result.status, 0, `${step.name} exited ${result.status}: ${result.stderr}`);
  }
  return {
    outputs: parseOutputs(readFileSync(output, "utf8")),
    calls: readFileSync(calls, "utf8"),
    bodies: readFileSync(bodies, "utf8"),
    summary: readFileSync(summary, "utf8"),
  };
}

const MARKER_A = "<!-- release-auto-merge-gate:aaaaaaaaaaaaaaaa -->";
const MARKER_B = "<!-- release-auto-merge-gate:bbbbbbbbbbbbbbbb -->";
const LEGACY_MARKER = "<!-- release-auto-merge-gate -->";
const REASONS_A = "#1 (1111111) carries neither a Brief-Verified trailer nor the brief-verified label";
const REASONS_B = `${REASONS_A}; #2 (2222222) carries neither a Brief-Verified trailer nor the brief-verified label`;

function heldComments(...bodies) {
  return JSON.stringify(bodies.map((body, index) => ({ id: index + 1, body })));
}

function holdComment(marker, reasons) {
  return `${marker}\nThis release is held for a human merge:\n\n${reasons}\n`;
}

function runHold(context) {
  const doc = gateWorkflow();
  const steps = gateSteps(doc);
  const hold = steps[indexOfStep(steps, "Hold the release for a human")];
  assert.ok(hold, "the gate job lost its hold step");
  return runStep(doc, hold, {
    token: "stub-app-token",
    prNumber: "42",
    reasons: REASONS_A,
    marker: MARKER_A,
    comments: heldComments(),
    ...context,
  });
}

test("the hold step reads its marker from the gate, so the two never drift apart", () => {
  const steps = gateSteps();
  const hold = steps[indexOfStep(steps, "Hold the release for a human")];
  assert.equal(hold.env.MARKER_ID, "${{ steps.gate.outputs.marker }}");
  assert.equal(hold.env.REASONS, "${{ steps.gate.outputs.reasons }}");
});

test("a held release with no hold comment yet gets one naming its reasons", () => {
  const run = runHold({});
  assert.match(run.calls, /pr comment/);
  assert.match(run.bodies, new RegExp(`^${MARKER_A}$`, "m"));
  assert.match(run.bodies, /#1 \(1111111\)/);
});

test("a hold whose reasons have not changed gets no second comment", () => {
  const run = runHold({ comments: heldComments(holdComment(MARKER_A, REASONS_A)) });
  assert.doesNotMatch(run.calls, /pr comment/);
  assert.match(run.summary, /already reports these reasons/);
});

test("a hold whose reasons changed gets a comment naming the commits that changed it", () => {
  const run = runHold({
    marker: MARKER_B,
    reasons: REASONS_B,
    comments: heldComments(holdComment(MARKER_A, REASONS_A)),
  });
  assert.match(run.calls, /pr comment/);
  assert.match(run.bodies, /#2 \(2222222\)/);
});

test("the newest hold comment decides, not an older one that still matches", () => {
  const run = runHold({
    comments: heldComments(holdComment(MARKER_A, REASONS_A), holdComment(MARKER_B, REASONS_B)),
  });
  assert.match(run.calls, /pr comment/);
});

test("a hold comment a person edited in the browser does not earn a fresh comment every run", () => {
  const run = runHold({ comments: heldComments(`${MARKER_A}\r\nThis release is held for a human merge:\r\n\r\nand a note`) });
  assert.doesNotMatch(run.calls, /pr comment/);
});

test("a comments read that fails turns the step red, because a broken release bot has no other alarm", () => {
  const run = runHold({ commentsFail: "1", expectFailure: true });
  assert.doesNotMatch(run.calls, /pr comment/);
  assert.match(run.summary, /Could not read the comments/);
});

test("a comment with no body does not break the read", () => {
  const run = runHold({ comments: JSON.stringify([{ id: 1, body: null }, { id: 2, body: holdComment(MARKER_A, REASONS_A) }]) });
  assert.doesNotMatch(run.calls, /pr comment/);
});

test("a gate that wrote no marker falls back to commenting only when nothing is there", () => {
  const already = runHold({ marker: "", comments: heldComments(holdComment(LEGACY_MARKER, REASONS_A)) });
  assert.doesNotMatch(already.calls, /pr comment/);

  const bare = runHold({ marker: "" });
  assert.match(bare.calls, /pr comment/);
  assert.match(bare.bodies, new RegExp(`^${LEGACY_MARKER}$`, "m"));
});

test("a comment the step could not post turns the step red, because nobody else will hear of the hold", () => {
  const run = runHold({ commentFail: "1", expectFailure: true });
  assert.match(run.calls, /pr comment/);
  assert.match(run.summary, /this hold is not reported/);
});

function resolveReleasePullRequest(doc, context) {
  const steps = gateSteps(doc);
  const scope = steps[indexOfStep(steps, "Decide whether this run has anything to do")];
  const resolve = steps[indexOfStep(steps, "Resolve the release pull request")];
  const gate = steps[indexOfStep(steps, "Evaluate the gate")];
  assert.ok(scope && resolve && gate, "the gate job lost its scope, resolve, or evaluate step");
  assert.equal(scope.id, "scope");
  assert.equal(resolve.id, "pr");
  assert.equal(normalizeIf(resolve.if), "steps.scope.outputs.applies == 'true'");
  assert.equal(normalizeIf(gate.if), "steps.pr.outputs.number != ''");

  const full = { token: "stub-app-token", eventPr: "", headRef: "", prState: "", ...context };
  const scoped = runStep(doc, scope, full);
  if (scoped.outputs.applies !== "true") return { applies: scoped.outputs.applies, number: "", calls: "" };
  const resolved = runStep(doc, resolve, full);
  assert.ok("number" in resolved.outputs, "the resolve step exited without writing number");
  return { applies: "true", number: resolved.outputs.number, calls: resolved.calls };
}

function pullFacts({ author = RELEASE_BOT, head = RELEASE_HEAD, state = "open" } = {}) {
  return JSON.stringify({ user: { login: author }, head: { ref: head }, state });
}

function openPulls(...pulls) {
  return JSON.stringify(pulls.map(([number, headRefName]) => ({ number, headRefName })));
}

function assertGenuineReleaseResolves(doc) {
  const onEvent = resolveReleasePullRequest(doc, {
    event: "pull_request",
    eventPr: "160",
    headRef: RELEASE_HEAD,
    prState: "open",
    pull: pullFacts(),
  });
  assert.equal(
    onEvent.number,
    "160",
    "a genuine release pull request event resolved empty, so the gate and its backstop skip and the check reports green",
  );

  const onSchedule = resolveReleasePullRequest(doc, {
    event: "schedule",
    openPulls: openPulls([12, "feat/unrelated"], [160, RELEASE_HEAD]),
    pull: pullFacts(),
  });
  assert.equal(
    onSchedule.number,
    "160",
    "a scheduled run resolved empty with a genuine release pull request open, so the gate never evaluates it",
  );
}

test("a genuine release pull request resolves to its number on events and on schedule", () => {
  assertGenuineReleaseResolves(gateWorkflow());
});

test("the resolve step reads the candidate the event names and lists nothing", () => {
  const run = resolveReleasePullRequest(gateWorkflow(), {
    event: "pull_request",
    eventPr: "160",
    headRef: RELEASE_HEAD,
    prState: "open",
    pull: pullFacts(),
  });
  assert.match(run.calls, new RegExp(`^api repos/${RESOLVE_REPO}/pulls/160 `, "m"));
  assert.doesNotMatch(run.calls, /^pr list/m);
});

test("no open release branch resolves empty without reading any pull request", () => {
  const run = resolveReleasePullRequest(gateWorkflow(), {
    event: "schedule",
    openPulls: openPulls([12, "feat/unrelated"]),
  });
  assert.equal(run.applies, "true");
  assert.equal(run.number, "");
  assert.match(run.calls, new RegExp(`^pr list --repo ${RESOLVE_REPO} --state open `, "m"));
  assert.doesNotMatch(run.calls, /pulls\//);
});

test("a release branch pull request not authored by the release bot resolves empty", () => {
  const run = resolveReleasePullRequest(gateWorkflow(), {
    event: "pull_request",
    eventPr: "161",
    headRef: RELEASE_HEAD,
    prState: "open",
    pull: pullFacts({ author: "drive-by" }),
  });
  assert.equal(run.applies, "true");
  assert.equal(run.number, "");
});

test("a release pull request that is no longer open resolves empty", () => {
  const run = resolveReleasePullRequest(gateWorkflow(), {
    event: "workflow_dispatch",
    openPulls: openPulls([160, RELEASE_HEAD]),
    pull: pullFacts({ state: "closed" }),
  });
  assert.equal(run.applies, "true");
  assert.equal(run.number, "");
});

test("a bot pull request whose head is not a release branch resolves empty", () => {
  const run = resolveReleasePullRequest(gateWorkflow(), {
    event: "workflow_dispatch",
    openPulls: openPulls([160, RELEASE_HEAD]),
    pull: pullFacts({ head: "feat/not-a-release" }),
  });
  assert.equal(run.applies, "true");
  assert.equal(run.number, "");
});

test("an ordinary pull request never reaches resolution", () => {
  const run = resolveReleasePullRequest(gateWorkflow(), {
    event: "pull_request",
    eventPr: "12",
    headRef: "feat/unrelated",
    prState: "open",
  });
  assert.equal(run.applies, "false");
  assert.equal(run.number, "");
});

test("a planted resolve step that drops the number fails the genuine release check", () => {
  const doc = cloneGate();
  const resolve = gateSteps(doc)[indexOfStep(gateSteps(doc), "Resolve the release pull request")];
  const planted = resolve.run.replace('echo "number=$CANDIDATE"', 'echo "number="');
  assert.notEqual(planted, resolve.run, "the resolve step no longer writes number=$CANDIDATE, so this mutation plants nothing");
  resolve.run = planted;
  assert.throws(() => assertGenuineReleaseResolves(doc), /resolved empty/);
});

test("a planted release branch prefix that misses release-please fails the genuine release check", () => {
  const doc = cloneGate();
  doc.env.RELEASE_BRANCH_PREFIX = "release-please--branches--master";
  assert.throws(() => assertGenuineReleaseResolves(doc), /resolved empty/);
});

test("a planted bot login that is not the release bot fails the genuine release check", () => {
  const doc = cloneGate();
  doc.env.RELEASE_BOT_LOGIN = "release-please[bot]";
  assert.throws(() => assertGenuineReleaseResolves(doc), /resolved empty/);
});
