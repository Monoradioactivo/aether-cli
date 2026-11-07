import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RELEASE_BRANCH = "release-please--branches--main";
const OTHER_RELEASE_BRANCH = "release-please--other";
const ORDINARY_BRANCH = "feat/some-change";
const NEAR_MISS_BRANCH = "release-notes/rewrite-the-intro";
const SHORT_PREFIX_BRANCH = "release-pleasant/note";
const SHA_A = "b23f3238047b47f7d968e8c304575dcf739985dc";
const SHA_B = "f77d1b2eb2b2ce8137ebcb3c9869f175fa8803b9";
const OLD_PROVENANCE_GROUP = "commit-provenance-${{ github.event.pull_request.number }}";
const PROVENANCE_TYPES = [
  "opened",
  "reopened",
  "synchronize",
  "labeled",
  "unlabeled",
  "ready_for_review",
];

function repoRoot() {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let hop = 0; hop < 4; hop += 1) {
    if (existsSync(join(dir, ".github", "workflows", "commit-provenance.yml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("workflow root not found");
}

const root = repoRoot();

function workflowText(file) {
  return readFileSync(join(root, ".github", "workflows", file), "utf8");
}

function indentOf(line) {
  let count = 0;
  while (line[count] === " ") count += 1;
  return count;
}

function topLevelBlocks(text) {
  const lines = text.split("\n");
  const blocks = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.length === 0 || line[0] === " " || line[0] === "#") continue;
    if (!line.endsWith(":")) continue;
    const key = line.slice(0, -1).replaceAll('"', "");
    const body = [];
    let next = index + 1;
    while (next < lines.length) {
      const candidate = lines[next];
      if (candidate.length > 0 && candidate[0] !== " " && candidate[0] !== "#") break;
      body.push(candidate);
      next += 1;
    }
    blocks.set(key, body);
    index = next - 1;
  }
  return blocks;
}

function parseMap(lines, baseIndent) {
  const map = {};
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const indent = indentOf(line);
    if (indent < baseIndent) break;
    if (indent !== baseIndent) {
      throw new Error(`unexpected indent in ${line.trim()}`);
    }
    const trimmed = line.trim();
    const colon = trimmed.indexOf(":");
    if (colon < 1) throw new Error(`not a key: ${trimmed}`);
    const key = trimmed.slice(0, colon).trim();
    const rest = trimmed.slice(colon + 1).trim();
    if (rest !== "") {
      if (rest.startsWith("[") && rest.endsWith("]")) {
        map[key] = rest
          .slice(1, -1)
          .split(",")
          .map((part) => part.trim())
          .filter((part) => part !== "");
      } else {
        map[key] = rest;
      }
      continue;
    }
    const child = [];
    let next = index + 1;
    while (next < lines.length) {
      const candidate = lines[next];
      if (candidate.trim() === "") {
        next += 1;
        continue;
      }
      if (indentOf(candidate) <= baseIndent) break;
      child.push(candidate);
      next += 1;
    }
    if (child.length === 0) {
      map[key] = {};
    } else if (child[0].trim().startsWith("- ")) {
      map[key] = child.map((entry) => {
        const item = entry.trim();
        if (!item.startsWith("- ")) throw new Error(`mixed list under ${key}: ${item}`);
        return item.slice(2).trim();
      });
    } else {
      map[key] = parseMap(child, baseIndent + 2);
    }
    index = next - 1;
  }
  return map;
}

function isTruthy(value) {
  return value !== false && value !== null && value !== undefined && value !== "" && value !== 0;
}

class Parser {
  constructor(source) {
    this.source = source;
    this.pos = 0;
  }

  done() {
    return this.pos >= this.source.length;
  }

  peek() {
    return this.source[this.pos];
  }

  skipSpace() {
    while (this.peek() === " ") this.pos += 1;
  }

  expect(char) {
    this.skipSpace();
    if (this.peek() !== char) {
      throw new Error(`unrecognised concurrency expression \`${this.source}\``);
    }
    this.pos += 1;
  }

  parseOr() {
    const items = [this.parseAnd()];
    while (true) {
      this.skipSpace();
      if (!this.source.startsWith("||", this.pos)) break;
      this.pos += 2;
      items.push(this.parseAnd());
    }
    return items.length === 1 ? items[0] : { type: "or", items };
  }

  parseAnd() {
    const items = [this.parseCmp()];
    while (true) {
      this.skipSpace();
      if (!this.source.startsWith("&&", this.pos)) break;
      this.pos += 2;
      items.push(this.parseCmp());
    }
    return items.length === 1 ? items[0] : { type: "and", items };
  }

  parseCmp() {
    const left = this.parseUnary();
    this.skipSpace();
    const op = this.source.startsWith("==", this.pos)
      ? "=="
      : this.source.startsWith("!=", this.pos)
        ? "!="
        : "";
    if (!op) return left;
    this.pos += 2;
    return { type: "cmp", op, left, right: this.parseUnary() };
  }

  parseUnary() {
    this.skipSpace();
    if (this.peek() === "!" && this.source[this.pos + 1] !== "=") {
      this.pos += 1;
      return { type: "not", item: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  parsePrimary() {
    this.skipSpace();
    if (this.peek() === "(") {
      this.pos += 1;
      const value = this.parseOr();
      this.expect(")");
      return value;
    }
    if (this.peek() === "'") return { type: "lit", value: this.parseString() };
    if (this.peek() >= "0" && this.peek() <= "9") return { type: "lit", value: this.parseNumber() };
    const ident = this.parseIdent();
    this.skipSpace();
    if (this.peek() === "(") return this.parseCall(ident);
    if (ident === "true") return { type: "lit", value: true };
    if (ident === "false") return { type: "lit", value: false };
    return { type: "path", name: ident };
  }

  parseString() {
    this.pos += 1;
    let value = "";
    while (!this.done() && this.peek() !== "'") {
      value += this.peek();
      this.pos += 1;
    }
    this.expect("'");
    return value;
  }

  parseNumber() {
    let digits = "";
    while (this.peek() >= "0" && this.peek() <= "9") {
      digits += this.peek();
      this.pos += 1;
    }
    return Number(digits);
  }

  parseIdent() {
    let value = "";
    while (!this.done()) {
      const char = this.peek();
      const ok =
        (char >= "a" && char <= "z") ||
        (char >= "A" && char <= "Z") ||
        (char >= "0" && char <= "9") ||
        char === "_" ||
        char === ".";
      if (!ok) break;
      value += char;
      this.pos += 1;
    }
    if (value === "") throw new Error(`unrecognised concurrency expression \`${this.source}\``);
    return value;
  }

  parseCall(name) {
    this.expect("(");
    const args = [];
    this.skipSpace();
    if (this.peek() !== ")") {
      args.push(this.parseOr());
      while (true) {
        this.skipSpace();
        if (this.peek() !== ",") break;
        this.pos += 1;
        args.push(this.parseOr());
      }
    }
    this.expect(")");
    if (name !== "startsWith" && name !== "format") {
      throw new Error(`unrecognised concurrency expression \`${this.source}\``);
    }
    return { type: "call", name, args };
  }
}

function resolvePath(path, ctx, source) {
  if (path === "github.event_name") return ctx.eventName;
  if (path === "github.head_ref") return ctx.headRef;
  if (path === "github.workflow") return ctx.workflow;
  if (path === "github.ref") return ctx.ref;
  if (path === "github.event.pull_request.number") return ctx.prNumber;
  if (path === "github.event.pull_request.head.sha") {
    if (ctx.forbidSha) throw new Error(`head.sha read on ${ctx.eventName}`);
    return ctx.headSha;
  }
  throw new Error(`unrecognised concurrency expression \`${source}\``);
}

function applyFormat(template, args, source) {
  let out = "";
  let index = 0;
  while (index < template.length) {
    const brace = template.indexOf("{", index);
    if (brace === -1) {
      out += template.slice(index);
      break;
    }
    const end = template.indexOf("}", brace + 1);
    const digits = end === -1 ? "" : template.slice(brace + 1, end);
    if (end === -1 || digits === "" || [...digits].some((char) => char < "0" || char > "9")) {
      throw new Error(`unrecognised concurrency expression \`${source}\``);
    }
    const arg = args[Number(digits)];
    if (arg === undefined) throw new Error(`unrecognised concurrency expression \`${source}\``);
    out += template.slice(index, brace);
    out += String(arg);
    index = end + 1;
  }
  return out;
}

function evalNode(node, ctx, source) {
  if (node.type === "lit") return node.value;
  if (node.type === "path") return resolvePath(node.name, ctx, source);
  if (node.type === "not") return !isTruthy(evalNode(node.item, ctx, source));
  if (node.type === "cmp") {
    const left = evalNode(node.left, ctx, source);
    const right = evalNode(node.right, ctx, source);
    return node.op === "==" ? left === right : left !== right;
  }
  if (node.type === "and") {
    let value = true;
    for (const item of node.items) {
      value = evalNode(item, ctx, source);
      if (!isTruthy(value)) return value;
    }
    return value;
  }
  if (node.type === "or") {
    let value = false;
    for (const item of node.items) {
      value = evalNode(item, ctx, source);
      if (isTruthy(value)) return value;
    }
    return value;
  }
  if (node.type === "call" && node.name === "startsWith") {
    if (node.args.length !== 2) throw new Error(`unrecognised concurrency expression \`${source}\``);
    const text = String(evalNode(node.args[0], ctx, source));
    const prefix = String(evalNode(node.args[1], ctx, source));
    return text.toLowerCase().startsWith(prefix.toLowerCase());
  }
  if (node.type === "call" && node.name === "format") {
    if (node.args.length < 1) throw new Error(`unrecognised concurrency expression \`${source}\``);
    const template = String(evalNode(node.args[0], ctx, source));
    const args = node.args.slice(1).map((arg) => evalNode(arg, ctx, source));
    return applyFormat(template, args, source);
  }
  throw new Error(`unrecognised concurrency expression \`${source}\``);
}

function evaluate(source, ctx) {
  const parser = new Parser(source);
  const node = parser.parseOr();
  parser.skipSpace();
  if (!parser.done()) throw new Error(`unrecognised concurrency expression \`${source}\``);
  return evalNode(node, ctx, source);
}

function render(template, ctx) {
  let out = "";
  let index = 0;
  while (index < template.length) {
    const start = template.indexOf("${{", index);
    if (start === -1) {
      out += template.slice(index);
      break;
    }
    const end = template.indexOf("}}", start + 3);
    if (end === -1) throw new Error(`unclosed expression in \`${template}\``);
    out += template.slice(index, start);
    out += String(evaluate(template.slice(start + 3, end).trim(), ctx));
    index = end + 2;
  }
  return out;
}

function cancels(value, ctx) {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value.startsWith("${{") && value.endsWith("}}") && value.indexOf("${{") === 0) {
    const inner = value.slice(3, -2).trim();
    if (inner.includes("${{")) {
      throw new Error(`cannot evaluate cancel-in-progress \`${value}\``);
    }
    return isTruthy(evaluate(inner, ctx));
  }
  throw new Error(`cannot evaluate cancel-in-progress \`${value}\``);
}

function pull(headRef, headSha, prNumber) {
  return {
    eventName: "pull_request",
    headRef,
    headSha,
    prNumber,
    ref: `refs/pull/${prNumber}/merge`,
    workflow: "CI",
    forbidSha: false,
  };
}

function pushMain() {
  return {
    eventName: "push",
    headRef: "",
    headSha: "",
    prNumber: 0,
    ref: "refs/heads/main",
    workflow: "CI",
    forbidSha: true,
  };
}

function concurrencyOf(file) {
  const blocks = topLevelBlocks(workflowText(file));
  const body = blocks.get("concurrency");
  assert.ok(body, `${file} declares no concurrency block`);
  const block = parseMap(body, 2);
  assert.equal(typeof block.group, "string", `${file} group is not a scalar`);
  assert.equal(typeof block["cancel-in-progress"], "string", `${file} cancel-in-progress is not a scalar`);
  return block;
}

function triggersOf(file) {
  const blocks = topLevelBlocks(workflowText(file));
  const body = blocks.get("on");
  assert.ok(body, `${file} declares no on block`);
  return parseMap(body, 2);
}

function jobConcurrency(file) {
  const blocks = topLevelBlocks(workflowText(file));
  const jobs = blocks.get("jobs") ?? [];
  return jobs.filter((line) => indentOf(line) === 4 && line.trim() === "concurrency:");
}

const provenance = concurrencyOf("commit-provenance.yml");
const ci = concurrencyOf("ci.yml");

test("commit provenance is triggered by pull_request alone", () => {
  const on = triggersOf("commit-provenance.yml");
  assert.deepEqual(Object.keys(on), ["pull_request"]);
  assert.deepEqual(on.pull_request.types, PROVENANCE_TYPES);
});

test("two heads of a release branch never share a commit provenance group", () => {
  assert.notEqual(
    render(provenance.group, pull(RELEASE_BRANCH, SHA_A, 495)),
    render(provenance.group, pull(RELEASE_BRANCH, SHA_B, 495)),
  );
});

test("one release sha keeps one commit provenance group", () => {
  assert.equal(
    render(provenance.group, pull(RELEASE_BRANCH, SHA_A, 495)),
    render(provenance.group, pull(RELEASE_BRANCH, SHA_A, 495)),
  );
});

test("an ordinary branch keeps one commit provenance group across heads", () => {
  assert.equal(
    render(provenance.group, pull(ORDINARY_BRANCH, SHA_A, 7)),
    render(provenance.group, pull(ORDINARY_BRANCH, SHA_B, 7)),
  );
});

test("a near-miss branch keeps one commit provenance group across heads", () => {
  assert.equal(
    render(provenance.group, pull(NEAR_MISS_BRANCH, SHA_A, 7)),
    render(provenance.group, pull(NEAR_MISS_BRANCH, SHA_B, 7)),
  );
  assert.equal(
    render(provenance.group, pull(SHORT_PREFIX_BRANCH, SHA_A, 7)),
    render(provenance.group, pull(SHORT_PREFIX_BRANCH, SHA_B, 7)),
  );
});

test("two pull requests never share a commit provenance group", () => {
  assert.notEqual(
    render(provenance.group, pull(ORDINARY_BRANCH, SHA_A, 1)),
    render(provenance.group, pull(ORDINARY_BRANCH, SHA_A, 2)),
  );
});

test("a release head still cancels an in-flight commit provenance run", () => {
  assert.equal(cancels(provenance["cancel-in-progress"], pull(RELEASE_BRANCH, SHA_A, 495)), true);
  assert.equal(cancels(provenance["cancel-in-progress"], pull(ORDINARY_BRANCH, SHA_A, 7)), true);
  assert.equal(cancels(provenance["cancel-in-progress"], pull(NEAR_MISS_BRANCH, SHA_A, 7)), true);
});

test("the pull-request-number group this replaced shares two release heads", () => {
  assert.equal(
    render(OLD_PROVENANCE_GROUP, pull(RELEASE_BRANCH, SHA_A, 495)),
    render(OLD_PROVENANCE_GROUP, pull(RELEASE_BRANCH, SHA_B, 495)),
  );
});

test("a release head and an ordinary head do not share a commit provenance group", () => {
  assert.notEqual(
    render(provenance.group, pull(RELEASE_BRANCH, SHA_A, 495)),
    render(provenance.group, pull(ORDINARY_BRANCH, SHA_A, 495)),
  );
  assert.notEqual(
    render(provenance.group, pull(OTHER_RELEASE_BRANCH, SHA_A, 495)),
    render(provenance.group, pull(ORDINARY_BRANCH, SHA_A, 495)),
  );
});

test("CI runs on pull_request and on push to main", () => {
  const text = workflowText("ci.yml");
  assert.equal(text.split("\n")[0], "name: CI");
  const on = triggersOf("ci.yml");
  assert.deepEqual(Object.keys(on).sort(), ["pull_request", "push"]);
  assert.deepEqual(on.push.branches, ["main"]);
  if (on.pull_request.branches) assert.deepEqual(on.pull_request.branches, ["main"]);
});

test("two heads of a release branch never share a CI group and do not cancel", () => {
  const left = pull(RELEASE_BRANCH, SHA_A, 12);
  const right = pull(RELEASE_BRANCH, SHA_B, 12);
  assert.equal(render(ci.group, left), `ci-${RELEASE_BRANCH}-${SHA_A}`);
  assert.notEqual(render(ci.group, left), render(ci.group, right));
  assert.equal(cancels(ci["cancel-in-progress"], left), false);
});

test("an ordinary pull request keeps today's CI group and still cancels", () => {
  const first = pull(ORDINARY_BRANCH, SHA_A, 12);
  const second = pull(ORDINARY_BRANCH, SHA_B, 12);
  assert.equal(render(ci.group, first), "CI-refs/pull/12/merge");
  assert.equal(render(ci.group, first), render(ci.group, second));
  assert.equal(cancels(ci["cancel-in-progress"], first), true);
  assert.notEqual(render(ci.group, first), render(ci.group, pull(ORDINARY_BRANCH, SHA_A, 13)));
});

test("a push to main keeps today's CI group, cancels, and does not read head.sha", () => {
  const push = pushMain();
  assert.equal(render(ci.group, push), "CI-refs/heads/main");
  assert.equal(cancels(ci["cancel-in-progress"], push), true);
  assert.notEqual(render(ci.group, push), render(ci.group, pull(RELEASE_BRANCH, SHA_A, 12)));
});

test("a near-miss branch still cancels CI", () => {
  assert.equal(cancels(ci["cancel-in-progress"], pull(NEAR_MISS_BRANCH, SHA_A, 4)), true);
  assert.equal(cancels(ci["cancel-in-progress"], pull(SHORT_PREFIX_BRANCH, SHA_A, 4)), true);
  assert.equal(
    render(ci.group, pull(SHORT_PREFIX_BRANCH, SHA_A, 4)),
    render(ci.group, pull(SHORT_PREFIX_BRANCH, SHA_B, 4)),
  );
});

test("no job declares its own concurrency", () => {
  assert.deepEqual(jobConcurrency("ci.yml"), []);
  assert.deepEqual(jobConcurrency("commit-provenance.yml"), []);
});

test("an expression this test cannot evaluate fails", () => {
  assert.throws(
    () => render("ci-${{ github.run_id }}", pull(ORDINARY_BRANCH, SHA_A, 1)),
    /unrecognised concurrency expression/,
  );
});
