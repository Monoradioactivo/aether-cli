import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

function gateSteps() {
  return gateWorkflow().jobs.gate.steps;
}

function indexOfStep(steps, name) {
  return steps.findIndex((step) => step.name === name);
}

function softensFailure(node) {
  return node["continue-on-error"] !== undefined;
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
