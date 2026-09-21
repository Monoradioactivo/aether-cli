import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const RENOVATE_LOGINS = new Set(["renovate[bot]", "app/renovate", "renovate"]);
const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"]);
const FAILED_STATES = new Set(["failure", "error"]);
const WORKFLOW_PREFIX = ".github/workflows/";
const COMPARE_FILE_LIMIT = 300;
const HEAD_POLLS = 30;
const HEAD_POLL_MS = 3000;
const UNKNOWN_POLLS = 5;
const UNKNOWN_POLL_MS = 3000;
const SERIAL_WAIT_MAX_MS = 2 * 60 * 60 * 1000;
const COMMENT_PAGES = 10;

const OPEN_PRS_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 100, orderBy: {field: CREATED_AT, direction: ASC}) {
      nodes {
        number
        isDraft
        headRefName
        headRefOid
        mergeStateStatus
        headRepository { nameWithOwner }
        author { login }
        autoMergeRequest { enabledAt }
        reviewThreads(first: 100) { nodes { isResolved } }
      }
    }
  }
}`;

export function loginKey(login) {
  return String(login ?? "")
    .toLowerCase()
    .replace(/^app\//, "")
    .replace(/\[bot\]$/, "");
}

export function sameLogin(a, b) {
  return Boolean(a) && Boolean(b) && loginKey(a) === loginKey(b);
}

export function isRenovate(login) {
  return RENOVATE_LOGINS.has(String(login ?? "").toLowerCase());
}

export function isReleasePr(pr, config) {
  return pr.headRefName.startsWith(config.releaseBranchPrefix) || sameLogin(pr.author, config.releaseBotLogin);
}

export function utcDay(date) {
  return date.toISOString().slice(0, 10);
}

export function utcTime(date) {
  return date.toISOString().slice(11, 19);
}

export function isTrainDay(date, config) {
  return Boolean(config.train) && config.train.weekdays.includes(date.getUTCDay());
}

export function trainHold(prs, now, config) {
  if (!isTrainDay(now, config)) return false;
  if (utcTime(now) < config.train.updateCutoff) return false;
  return prs.some(
    (pr) =>
      pr.armedAt &&
      isReleasePr(pr, config) &&
      utcDay(new Date(pr.armedAt)) === utcDay(now) &&
      utcTime(new Date(pr.armedAt)) < config.train.closes,
  );
}

export function releaseArmIsCurrent(pr, now, config) {
  if (!config.train || !isReleasePr(pr, config)) return true;
  return utcDay(new Date(pr.armedAt)) === utcDay(now);
}

export function requiredCheckState(requiredContexts, checkRuns, statuses) {
  const latest = new Map();
  for (const run of checkRuns) {
    const previous = latest.get(run.name);
    if (!previous || run.id > previous.id) latest.set(run.name, run);
  }
  const statusByContext = new Map(statuses.map((status) => [status.context, status.state]));
  let pending = false;
  for (const context of requiredContexts) {
    const run = latest.get(context);
    if (run) {
      if (run.status !== "completed") {
        pending = true;
        continue;
      }
      if (FAILED_CONCLUSIONS.has(run.conclusion)) return "failing";
      continue;
    }
    const state = statusByContext.get(context);
    if (state === undefined || state === "pending") {
      pending = true;
      continue;
    }
    if (FAILED_STATES.has(state)) return "failing";
  }
  return pending ? "pending" : "passing";
}

export function touchesWorkflows(files) {
  if (!Array.isArray(files) || files.length >= COMPARE_FILE_LIMIT) return true;
  return files.some((file) => String(file.filename ?? "").startsWith(WORKFLOW_PREFIX));
}

export function workflowFiles(files) {
  if (!Array.isArray(files)) return [];
  return files.map((file) => String(file.filename ?? "")).filter((name) => name.startsWith(WORKFLOW_PREFIX));
}

export function baseSkipReason(pr, repository) {
  if (!pr.armedAt) return "not armed";
  if (pr.isDraft) return "draft";
  if (pr.headRepository !== repository) return "head outside this repository";
  if (isRenovate(pr.author)) return "Renovate maintains its own branches";
  if (pr.unresolvedThreads > 0) return "unresolved review threads";
  return null;
}

export function classifyUpdateError(error) {
  const text = `${error?.stderr ?? ""} ${error?.message ?? ""}`;
  const match = text.match(/HTTP (\d{3})/);
  const status = match ? Number(match[1]) : null;
  if (/workflow/i.test(text) && /(permission|scope)/i.test(text)) return { kind: "workflows", status, text };
  if (status === 422 && /expected head sha/i.test(text)) return { kind: "head-moved", status, text };
  if (status === 422 && /conflict/i.test(text)) return { kind: "conflict", status, text };
  if (status === null || status === 429 || status >= 500 || /rate limit/i.test(text)) return { kind: "transient", status, text };
  return { kind: "refused", status, text };
}

export function orderCandidates(prs, heads, config) {
  const touchedByBot = (pr) => {
    const head = heads.get(pr.number);
    return head && head.parents.length > 1 && sameLogin(head.author, config.releaseBotLogin) ? 1 : 0;
  };
  return [...prs].sort((a, b) => touchedByBot(a) - touchedByBot(b) || a.number - b.number);
}

function normalizePr(node) {
  return {
    number: node.number,
    isDraft: node.isDraft,
    headRefName: node.headRefName,
    headRefOid: node.headRefOid,
    mergeStateStatus: node.mergeStateStatus,
    headRepository: node.headRepository?.nameWithOwner ?? null,
    author: node.author?.login ?? null,
    armedAt: node.autoMergeRequest?.enabledAt ?? null,
    unresolvedThreads: (node.reviewThreads?.nodes ?? []).filter((thread) => !thread.isResolved).length,
  };
}

export function createGitHub({ gh, repository, readToken, updateToken }) {
  const [owner, name] = repository.split("/");
  const read = (args) => gh(args, readToken);
  const readJson = (args) => JSON.parse(read(args));
  return {
    mainSha: () => read(["api", `repos/${repository}/branches/main`, "--jq", ".commit.sha"]).trim(),
    openPrs: () =>
      readJson([
        "api",
        "graphql",
        "-f",
        `query=${OPEN_PRS_QUERY}`,
        "-f",
        `owner=${owner}`,
        "-f",
        `name=${name}`,
        "--jq",
        ".data.repository.pullRequests.nodes",
      ]).map(normalizePr),
    requiredContexts: () =>
      readJson([
        "api",
        `repos/${repository}/rules/branches/main`,
        "--jq",
        '[.[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context]',
      ]),
    checkRuns: (sha) =>
      readJson([
        "api",
        `repos/${repository}/commits/${sha}/check-runs?per_page=100`,
        "--jq",
        "[.check_runs[] | {id, name, status, conclusion}]",
      ]),
    statuses: (sha) =>
      readJson(["api", `repos/${repository}/commits/${sha}/status`, "--jq", "[.statuses[] | {context, state}]"]),
    commit: (sha) =>
      readJson([
        "api",
        `repos/${repository}/commits/${sha}`,
        "--jq",
        "{parents: [.parents[].sha], author: (.author.login // null), date: .commit.committer.date}",
      ]),
    compareFiles: (base, head) =>
      readJson(["api", `repos/${repository}/compare/${base}...${head}`, "--jq", "[.files[]? | {filename}]"]),
    mergeStateStatus: (number) =>
      read(["pr", "view", String(number), "--repo", repository, "--json", "mergeStateStatus", "--jq", ".mergeStateStatus"]).trim(),
    headSha: (number) =>
      read(["pr", "view", String(number), "--repo", repository, "--json", "headRefOid", "--jq", ".headRefOid"]).trim(),
    updateBranch: (number, expectedHeadSha) =>
      gh(
        [
          "api",
          "--method",
          "PUT",
          `repos/${repository}/pulls/${number}/update-branch`,
          "-f",
          `expected_head_sha=${expectedHeadSha}`,
        ],
        updateToken,
      ),
    comments: (number) => {
      const all = [];
      for (let page = 1; page <= COMMENT_PAGES; page += 1) {
        const batch = readJson([
          "api",
          `repos/${repository}/issues/${number}/comments?per_page=100&page=${page}`,
          "--jq",
          "[.[] | {login: .user.login, body}]",
        ]);
        all.push(...batch);
        if (batch.length < 100) break;
      }
      return all;
    },
    comment: (number, body) =>
      gh(["api", "--method", "POST", `repos/${repository}/issues/${number}/comments`, "-f", `body=${body}`], updateToken),
  };
}

function isServingMain(head, mainSha, now) {
  if (head.parents[1] !== mainSha) return false;
  const age = now.getTime() - new Date(head.date ?? 0).getTime();
  return Number.isFinite(age) && age < SERIAL_WAIT_MAX_MS;
}

export async function run({ github, config, now, sleep, notify, summary }) {
  const mainSha = github.mainSha();
  const prs = github.openPrs();
  const required = github.requiredContexts();
  const checksOf = (sha) => requiredCheckState(required, github.checkRuns(sha), github.statuses(sha));
  const armed = prs.filter((pr) => pr.armedAt);
  const heads = new Map(armed.map((pr) => [pr.number, github.commit(pr.headRefOid)]));
  let failures = 0;

  if (trainHold(armed, now, config)) {
    summary(`No update: past ${config.train.updateCutoff} UTC on a train day with a train-armed release pull request.`);
    return { action: "train-hold", failures };
  }

  for (const pr of armed) {
    if (isServingMain(heads.get(pr.number), mainSha, now) && checksOf(pr.headRefOid) === "pending") {
      summary(`No update: #${pr.number} already carries main ${mainSha.slice(0, 7)} and its required checks are still running.`);
      return { action: "serial-wait", pr: pr.number, failures };
    }
  }

  for (const pr of orderCandidates(armed, heads, config)) {
    const skip = baseSkipReason(pr, config.repository);
    if (skip) {
      summary(`Skip #${pr.number}: ${skip}.`);
      continue;
    }
    if (!releaseArmIsCurrent(pr, now, config)) {
      summary(`Skip #${pr.number}: release arm from an earlier UTC day.`);
      continue;
    }
    let mergeState = pr.mergeStateStatus;
    for (let poll = 0; mergeState === "UNKNOWN" && poll < UNKNOWN_POLLS; poll += 1) {
      await sleep(UNKNOWN_POLL_MS);
      mergeState = github.mergeStateStatus(pr.number);
    }
    summary(`#${pr.number}: merge state ${mergeState}.`);
    if (mergeState !== "BEHIND") continue;
    if (checksOf(pr.headRefOid) === "failing") {
      summary(`Skip #${pr.number}: a required check failed on its head.`);
      continue;
    }
    if (reportedMarker(github, pr, config, mainSha)) {
      summary(`Skip #${pr.number}: already reported for head ${pr.headRefOid.slice(0, 7)}; waiting for a push to the branch.`);
      continue;
    }

    try {
      github.updateBranch(pr.number, pr.headRefOid);
    } catch (error) {
      const failure = classifyUpdateError(error);
      summary(`Update of #${pr.number} failed (${failure.kind}, HTTP ${failure.status ?? "unknown"}): ${failure.text.trim().slice(0, 500)}`);
      if (failure.kind === "head-moved" || failure.kind === "conflict" || failure.kind === "transient") continue;
      const files = github.compareFiles(pr.headRefOid, mainSha);
      const kind = failure.kind === "workflows" || touchesWorkflows(files) ? "workflows" : "refused";
      if (await reportSkip({ github, notify, summary, pr, kind, files, status: failure.status, config, mainSha })) failures += 1;
      continue;
    }

    for (let poll = 0; poll < HEAD_POLLS; poll += 1) {
      await sleep(HEAD_POLL_MS);
      let current = "";
      try {
        current = github.headSha(pr.number);
      } catch {
        current = "";
      }
      if (current && current !== pr.headRefOid) {
        summary(`Updated #${pr.number} from ${pr.headRefOid.slice(0, 7)} to ${current.slice(0, 7)} with main ${mainSha.slice(0, 7)}.`);
        return { action: "updated", pr: pr.number, head: current, failures };
      }
    }
    const files = github.compareFiles(pr.headRefOid, mainSha);
    const kind = touchesWorkflows(files) ? "workflows" : "stalled";
    summary(`GitHub accepted the update of #${pr.number} but its head did not move within ${(HEAD_POLLS * HEAD_POLL_MS) / 1000} seconds.`);
    if (await reportSkip({ github, notify, summary, pr, kind, files, status: 202, config, mainSha })) failures += 1;
    return { action: "accepted-not-moved", pr: pr.number, failures };
  }

  summary("No armed pull request was updated.");
  return { action: "none", failures };
}

const MARKER_PREFIX = "<!-- behind-bot:";

export function markerFor(kind, headSha, mainSha) {
  return kind === "workflows" ? `${MARKER_PREFIX}workflows:${headSha} -->` : `${MARKER_PREFIX}${kind}:${headSha}:${mainSha} -->`;
}

function reportedMarker(github, pr, config, mainSha) {
  const markers = [
    markerFor("workflows", pr.headRefOid, mainSha),
    markerFor("stalled", pr.headRefOid, mainSha),
    markerFor("refused", pr.headRefOid, mainSha),
  ];
  return github
    .comments(pr.number)
    .some((entry) => entry.login === config.releaseBotLogin && markers.some((marker) => entry.body.includes(marker)));
}

async function reportSkip({ github, notify, summary, pr, kind, files, status, config, mainSha }) {
  const reasons = {
    workflows: `main carries workflow changes (${workflowFiles(files).join(", ") || "file list truncated"}) that the release bot App cannot merge without the workflows permission`,
    stalled: `GitHub accepted the update but the branch did not move within ${(HEAD_POLLS * HEAD_POLL_MS) / 1000} seconds`,
    refused: `GitHub refused the update (HTTP ${status ?? "unknown"})`,
  };
  const reason = reasons[kind];
  summary(`Could not update #${pr.number}: ${reason}.`);
  if (reportedMarker(github, pr, config, mainSha)) return false;
  const text = `The behind bot could not bring this pull request up to date with \`main\`: ${reason}. Update the branch by hand, or push to it, so auto-merge can fire.`;
  const delivered = await notify(`${config.repository}#${pr.number}: ${text}`);
  if (!delivered) return false;
  try {
    github.comment(pr.number, `${markerFor(kind, pr.headRefOid, mainSha)}\n${text}`);
  } catch (error) {
    summary(`Could not leave the marker comment on #${pr.number}: ${String(error?.message ?? error).slice(0, 300)}`);
    return false;
  }
  return true;
}

function ghRunner(args, token) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    env: { ...process.env, GH_TOKEN: token },
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
}

export function configFromEnv(env) {
  const train = env.TRAIN_UPDATE_CUTOFF_UTC
    ? {
        updateCutoff: env.TRAIN_UPDATE_CUTOFF_UTC,
        closes: env.TRAIN_CLOSES_UTC,
        weekdays: String(env.TRAIN_WEEKDAYS ?? "1,4")
          .split(",")
          .map((day) => Number(day.trim())),
      }
    : null;
  return {
    repository: env.GITHUB_REPOSITORY,
    releaseBranchPrefix: env.RELEASE_BRANCH_PREFIX,
    releaseBotLogin: env.RELEASE_BOT_LOGIN,
    train,
  };
}

export async function discordNotify(url, text, fetchImpl = fetch) {
  if (!url) {
    console.log(`::warning::${text}`);
    return true;
  }
  try {
    const response = await fetchImpl(`${url}?wait=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "AetherOps/1.0" },
      body: JSON.stringify({ content: text.slice(0, 1900), allowed_mentions: { parse: [] } }),
    });
    if (response.ok) return true;
    console.log(`::warning::Discord answered ${response.status}; ${text}`);
    return false;
  } catch {
    console.log(`::warning::Discord could not be reached; ${text}`);
    return false;
  }
}

async function main() {
  const config = configFromEnv(process.env);
  const github = createGitHub({
    gh: ghRunner,
    repository: config.repository,
    readToken: process.env.READ_TOKEN,
    updateToken: process.env.UPDATE_TOKEN,
  });
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  const summary = (line) => {
    console.log(line);
    if (summaryPath) appendFileSync(summaryPath, `${line}\n`);
  };
  const result = await run({
    github,
    config,
    now: new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    notify: (text) => discordNotify(process.env.DISCORD_OPS_WEBHOOK_URL, text),
    summary,
  });
  console.log(JSON.stringify(result));
  if (result.failures > 0) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
