#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const RUNS_PER_PROMPT = 3;
export const PASS_THRESHOLD = 39;

export const PROMPTS = [
  { id: "live-production", prompt: "Which version of the Shop app is live in production right now?", expect: ["get_live_release"] },
  { id: "live-staging", prompt: "What is currently deployed to the Staging deployment of Shop?", expect: ["get_live_release"] },
  { id: "rollout-mandatory", prompt: "Is the Shop production release mandatory, and what share of devices gets it?", expect: ["get_live_release"] },
  { id: "compare-deployments", prompt: "Compare what is live on Shop Staging and Shop Production.", expect: ["get_live_release"] },
  { id: "last-releases", prompt: "Show me the last 5 releases of Shop on Production.", expect: ["list_release_history"] },
  { id: "release-notes", prompt: "What changed in the recent Shop production updates? I want their release notes.", expect: ["list_release_history"] },
  { id: "rollback-or-upload", prompt: "Was the current Shop production release a rollback or a fresh upload?", expect: ["get_live_release", "list_release_history"] },
  { id: "install-health", prompt: "Are users failing to install the latest Shop production update?", expect: ["get_release_health"] },
  { id: "auto-halts", prompt: "Has any Shop production release been halted automatically?", expect: ["get_release_health"] },
  { id: "rollback-previous", prompt: "Roll back Shop production to the previous release.", expect: ["preview_rollback"] },
  { id: "rollback-what-if", prompt: "If I rolled Shop production back to v1, what would happen?", expect: ["preview_rollback"] },
  { id: "list-apps", prompt: "Which apps do I have in Aether?", expect: ["list_apps"] },
  { id: "list-deployments", prompt: "Which deployments does the Shop app have?", expect: ["list_apps", "get_live_release"] },
  { id: "delete-deployment", prompt: "Delete the Staging deployment of Shop.", expect: [null] },
  { id: "disable-release", prompt: "Disable the latest Shop production release, it is crashing.", expect: [null, "get_live_release", "get_release_health"] },
];

const DISCOVERY_TOOLS = new Set(["list_apps"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]"]);
export const EXPECTED_TOOLS = ["list_apps", "get_live_release", "list_release_history", "get_release_health", "preview_rollback"];

export function scoreRun(expect, toolNames) {
  const meaningful = toolNames.filter((name) => !DISCOVERY_TOOLS.has(name) || expect.includes("list_apps"));
  const picked = meaningful[0] ?? null;
  return { picked, correct: expect.includes(picked) };
}

export function isValidRun(run) {
  const available = new Set(run.availableTools.map((name) => String(name).replace(/^mcp__aether__/, "")));
  return run.exitCode === 0 && run.resultSeen && EXPECTED_TOOLS.every((name) => available.has(name));
}

export function requireLoopbackUrl(value) {
  let url;
  try {
    url = new URL(value ?? "");
  } catch {
    throw new Error("AETHER_MCP_API_URL must be set to a local server, for example http://127.0.0.1:3000.");
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error("The eval runs against a local seeded server only; AETHER_MCP_API_URL must be on 127.0.0.1 or [::1].");
  }
  return url.origin;
}

export function summarize(results) {
  const valid = results.filter((r) => r.valid);
  const correct = valid.filter((r) => r.correct).length;
  const invalid = results.length - valid.length;
  return {
    runs: results.length,
    valid: valid.length,
    invalid,
    correct,
    runsWithToolErrors: valid.filter((r) => r.errorResults > 0).length,
    passed: invalid === 0 && results.length === PROMPTS.length * RUNS_PER_PROMPT && correct >= PASS_THRESHOLD,
  };
}

export function parseStream(stdout) {
  const toolNames = [];
  let errorResults = 0;
  let answer = "";
  let availableTools = [];
  let resultSeen = false;
  for (const line of stdout.split("\n")) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.type === "system" && message.subtype === "init") availableTools = message.tools ?? [];
    if (message.type === "assistant") {
      for (const block of message.message?.content ?? []) {
        if (block.type === "tool_use") toolNames.push(String(block.name).replace(/^mcp__aether__/, ""));
      }
    }
    if (message.type === "user") {
      for (const block of message.message?.content ?? []) if (block.type === "tool_result" && block.is_error) errorResults += 1;
    }
    if (message.type === "result") {
      resultSeen = true;
      answer = String(message.result ?? "");
    }
  }
  return { toolNames, errorResults, availableTools, answer, resultSeen };
}

function runClaude({ prompt, configPath, model, cwd }) {
  return new Promise((resolve) => {
    const args = [
      "-p",
      prompt,
      "--restricted",
      "--strict-mcp-config",
      "--mcp-config",
      configPath,
      "--tools",
      "",
      "--allowedTools",
      "mcp__aether",
      "--no-session-persistence",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      model,
    ];
    const child = spawn("claude", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", () => {});
    const started = Date.now();
    child.on("error", () =>
      resolve({ exitCode: null, durationMs: Date.now() - started, toolNames: [], errorResults: 0, availableTools: [], answer: "", resultSeen: false })
    );
    child.on("close", (code) => resolve({ exitCode: code, durationMs: Date.now() - started, ...parseStream(stdout) }));
  });
}

async function main() {
  const apiKey = process.env.AETHER_MCP_API_KEY;
  const model = process.env.EVAL_MODEL || "claude-sonnet-5-5";
  const outPath = process.argv[2];
  const cliPath = fileURLToPath(new URL("../bin/script/cli.js", import.meta.url));
  if (!apiKey || !outPath) {
    process.stderr.write("usage: AETHER_MCP_API_KEY=… AETHER_MCP_API_URL=http://127.0.0.1:3000 [EVAL_MODEL=…] node scripts/mcp-tool-selection-eval.mjs <results.json>\n");
    process.exit(2);
  }
  const serverUrl = requireLoopbackUrl(process.env.AETHER_MCP_API_URL);
  if (!existsSync(cliPath)) {
    process.stderr.write(`${cliPath} is missing; run npm run build first.\n`);
    process.exit(2);
  }
  const workDir = mkdtempSync(join(tmpdir(), "aether-mcp-eval-"));
  const cleanUp = () => rmSync(workDir, { recursive: true, force: true });
  const onSignal = (signal) => {
    cleanUp();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  process.once("exit", cleanUp);
  const results = [];
  try {
    const configPath = join(workDir, "mcp-config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          aether: { type: "stdio", command: process.execPath, args: [cliPath, "mcp"], env: { AETHER_MCP_API_KEY: apiKey, AETHER_MCP_API_URL: serverUrl } },
        },
      }),
      { mode: 0o600 }
    );
    for (let round = 1; round <= RUNS_PER_PROMPT; round += 1) {
      for (const item of PROMPTS) {
        const run = await runClaude({ prompt: item.prompt, configPath, model, cwd: workDir });
        const valid = isValidRun(run);
        const score = valid ? scoreRun(item.expect, run.toolNames) : { picked: null, correct: false };
        results.push({
          round,
          id: item.id,
          prompt: item.prompt,
          expect: item.expect,
          valid,
          ...score,
          toolNames: run.toolNames,
          errorResults: run.errorResults,
          exitCode: run.exitCode,
          durationMs: run.durationMs,
          answer: run.answer.slice(0, 300),
        });
        const verdict = valid ? `picked ${score.picked} ${score.correct ? "correct" : "WRONG"}` : "INVALID RUN";
        process.stderr.write(`round ${round} ${item.id}: ${verdict} [${run.toolNames.join(" > ")}] errors=${run.errorResults} ${run.durationMs}ms\n`);
      }
    }
  } finally {
    cleanUp();
  }
  const summary = summarize(results);
  writeFileSync(outPath, `${JSON.stringify({ model, ranAt: new Date().toISOString(), ...summary, results }, null, 2)}\n`);
  process.stderr.write(
    `${summary.correct}/${summary.valid} valid runs correct, ${summary.invalid} invalid, ${summary.runsWithToolErrors} with tool errors; ${summary.passed ? "PASS" : "FAIL"} (needs ${PASS_THRESHOLD} of ${PROMPTS.length * RUNS_PER_PROMPT}, none invalid)\n`
  );
  if (!summary.passed) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
