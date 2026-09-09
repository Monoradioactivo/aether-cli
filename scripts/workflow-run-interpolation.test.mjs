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
