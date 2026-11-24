import { test } from "node:test";
import assert from "node:assert/strict";

import { EXPECTED_TOOLS, PASS_THRESHOLD, PROMPTS, RUNS_PER_PROMPT, isValidRun, parseStream, requireLoopbackUrl, scoreRun, summarize } from "./mcp-tool-selection-eval.mjs";

const full = EXPECTED_TOOLS.map((name) => `mcp__aether__${name}`);

test("only runs that loaded every tool and finished are valid", () => {
  assert.equal(isValidRun({ exitCode: 0, resultSeen: true, availableTools: full }), true);
  assert.equal(isValidRun({ exitCode: 0, resultSeen: true, availableTools: full.slice(1) }), false);
  assert.equal(isValidRun({ exitCode: 1, resultSeen: true, availableTools: full }), false);
  assert.equal(isValidRun({ exitCode: 0, resultSeen: false, availableTools: full }), false);
});

test("the first meaningful call is scored, discovery calls aside", () => {
  assert.deepEqual(scoreRun(["get_live_release"], ["list_apps", "get_live_release"]), { picked: "get_live_release", correct: true });
  assert.deepEqual(scoreRun(["list_apps"], ["list_apps"]), { picked: "list_apps", correct: true });
  assert.deepEqual(scoreRun([null], []), { picked: null, correct: true });
  assert.deepEqual(scoreRun(["get_release_health"], ["list_apps", "get_live_release", "get_release_health"]), { picked: "get_live_release", correct: false });
});

test("the eval refuses anything but a loopback server", () => {
  assert.equal(requireLoopbackUrl("http://127.0.0.1:3100/"), "http://127.0.0.1:3100");
  assert.equal(requireLoopbackUrl("http://[::1]:3000"), "http://[::1]:3000");
  for (const value of [undefined, "", "https://api.aetherpush.com", "http://localhost:3000"]) {
    assert.throws(() => requireLoopbackUrl(value));
  }
});

test("each prompt runs three times and passing needs 39 correct of 45 with none invalid", () => {
  assert.equal(PROMPTS.length * RUNS_PER_PROMPT, 45);
  assert.equal(PASS_THRESHOLD, 39);
  const run = (correct, valid = true, errorResults = 0) => ({ correct, valid, errorResults });
  const passing = [...Array(39).fill(run(true)), ...Array(6).fill(run(false))];
  assert.deepEqual(summarize(passing), { runs: 45, valid: 45, invalid: 0, correct: 39, runsWithToolErrors: 0, passed: true });
  const short = [...Array(38).fill(run(true)), ...Array(7).fill(run(false))];
  assert.equal(summarize(short).passed, false);
  const withInvalid = [...Array(44).fill(run(true)), run(false, false)];
  assert.deepEqual(summarize(withInvalid), { runs: 45, valid: 44, invalid: 1, correct: 44, runsWithToolErrors: 0, passed: false });
  assert.equal(summarize([...Array(45).fill(run(true, true, 1))]).runsWithToolErrors, 45);
});

test("the stream parser reads tool calls, tool errors and the result", () => {
  const lines = [
    { type: "system", subtype: "init", tools: full },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__aether__list_apps" }] } },
    { type: "user", message: { content: [{ type: "tool_result", is_error: true }] } },
    { type: "result", result: "done" },
  ]
    .map((line) => JSON.stringify(line))
    .join("\n");
  assert.deepEqual(parseStream(`${lines}\nnot json`), { toolNames: ["list_apps"], errorResults: 1, availableTools: full, answer: "done", resultSeen: true });
});
