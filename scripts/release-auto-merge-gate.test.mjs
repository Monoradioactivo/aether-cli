import test from "node:test";
import assert from "node:assert/strict";

import {
  buildVerdict,
  classifyCommit,
  hasVerifiedTrailer,
  pickLatestTestConclusion,
  REQUIRED_TEST_CHECK,
  trailerBlockOf,
} from "./release-auto-merge-gate.mjs";
import { contentsFetchFailedAsMissing, versionFromPayloads } from "./check-release-auto-merge.mjs";

const noPullRequest = () => ({ missing: true });
const verifiedPr = (number, testConclusion = "success", labelActor = "Monoradioactivo") => () => ({
  number,
  labels: ["brief-verified"],
  labelActor,
  testConclusion,
});
const trailerPr = (number, testConclusion = "success") => () => ({
  number,
  labels: [],
  testConclusion,
});
const testRun = (conclusion, completed_at, overrides = {}) => ({
  name: REQUIRED_TEST_CHECK,
  app: "github-actions",
  status: "completed",
  conclusion,
  completed_at,
  ...overrides,
});

test("the trailer counts only inside the final trailer block", () => {
  assert.equal(hasVerifiedTrailer("subject\n\nBrief-Verified: a-brief"), true);
  assert.equal(hasVerifiedTrailer("subject\n\nbrief-verified: a-brief"), true);
  assert.equal(hasVerifiedTrailer("subject\n\nRefs: x\nBrief-Verified: a-brief"), true);
  assert.equal(hasVerifiedTrailer("subject\n\nBrief-Verified:"), false);
  assert.equal(hasVerifiedTrailer("subject\n\nwe discussed Brief-Verified: in review"), false);
  assert.equal(hasVerifiedTrailer("subject only"), false);
});

test("a trailer stranded mid-body by a squash concatenation does not bless the commit", () => {
  const concatenated = [
    "feat: unverified work (#99)",
    "",
    "first commit body",
    "",
    "Brief-Verified: a-brief-from-a-cherry-pick",
    "",
    "second commit subject",
    "",
    "prose that ends the message",
  ].join("\n");
  assert.equal(hasVerifiedTrailer(concatenated), false);
});

test("a paragraph that is not a trailer block is not treated as one", () => {
  assert.deepEqual(trailerBlockOf("subject\n\njust prose here"), []);
  assert.deepEqual(trailerBlockOf("subject\n\nRefs: 1\nBrief-Verified: x"), ["Refs: 1", "Brief-Verified: x"]);
});

test("pickLatestTestConclusion uses the newest completed Test run", () => {
  assert.equal(
    pickLatestTestConclusion([
      testRun("cancelled", "2026-09-01T10:00:00Z"),
      testRun("success", "2026-09-01T11:00:00Z"),
    ]),
    "success",
  );
  assert.equal(
    pickLatestTestConclusion([
      testRun("success", "2026-09-01T10:00:00Z"),
      testRun("failure", "2026-09-01T12:00:00Z"),
    ]),
    "failure",
  );
  assert.equal(pickLatestTestConclusion([]), "absent");
  assert.equal(
    pickLatestTestConclusion([testRun("success", "2026-09-01T10:00:00Z", { name: "Lint & Typecheck" })]),
    "absent",
  );
});

test("a Test run posted by an app other than GitHub Actions is ignored", () => {
  assert.equal(
    pickLatestTestConclusion([testRun("success", "2026-09-01T10:00:00Z", { app: "some-other-app" })]),
    "absent",
  );
  assert.equal(
    pickLatestTestConclusion([
      testRun("failure", "2026-09-01T10:00:00Z"),
      testRun("success", "2026-09-01T12:00:00Z", { app: "some-other-app" }),
    ]),
    "failure",
  );
  assert.equal(pickLatestTestConclusion([testRun("success", "2026-09-01T10:00:00Z", { app: null })]), "absent");
});

test("a trailer commit still resolves the pull request and requires a successful Test", () => {
  let called = false;
  const resolve = () => {
    called = true;
    return { number: 269, labels: [], testConclusion: "success" };
  };
  const result = classifyCommit({ sha: "1007504abc", message: "fix: x\n\nBrief-Verified: a-brief" }, resolve);
  assert.equal(called, true);
  assert.equal(result.blessed, true);
  assert.equal(result.via, "Brief-Verified trailer");
  assert.equal(result.pr, 269);
});

test("a trailer whose Test check was skipped is not blessed", () => {
  const result = classifyCommit(
    { sha: "caf9942abc", message: "fix: x\n\nBrief-Verified: a-brief" },
    trailerPr(241, "skipped"),
  );
  assert.equal(result.blessed, false);
  assert.equal(result.missingTest, true);
  assert.equal(result.testConclusion, "skipped");
  assert.equal(result.pr, 241);
});

test("a trailer whose Test check failed is not blessed", () => {
  const result = classifyCommit(
    { sha: "deadbeef01", message: "fix: x\n\nBrief-Verified: a-brief" },
    trailerPr(7, "failure"),
  );
  assert.equal(result.blessed, false);
  assert.equal(result.missingTest, true);
  assert.equal(result.testConclusion, "failure");
});

test("a trailer with no pull request cannot prove Test and is not blessed", () => {
  const result = classifyCommit({ sha: "deadbeef02", message: "fix: x\n\nBrief-Verified: a-brief" }, noPullRequest);
  assert.equal(result.blessed, false);
  assert.equal(result.missingTest, true);
  assert.equal(result.testConclusion, "no-pull-request");
});

test("unreadable Test check-runs are unresolved rather than treated as clean", () => {
  const result = classifyCommit(
    { sha: "deadbeef03", message: "fix: x\n\nBrief-Verified: a-brief" },
    () => ({ number: 9, labels: [], testUnread: true }),
  );
  assert.equal(result.blessed, false);
  assert.equal(result.unresolved, true);
});

test("a commit blessed by the label still needs a successful Test", () => {
  const result = classifyCommit({ sha: "abcdef1234", message: "fix(deps): update node-pg-migrate to v9" }, verifiedPr(42));
  assert.equal(result.blessed, true);
  assert.equal(result.via, "brief-verified label");
  assert.equal(result.pr, 42);
});

test("a label without a successful Test is not blessed", () => {
  const result = classifyCommit(
    { sha: "abcdef9999", message: "fix(deps): update something" },
    verifiedPr(42, "skipped"),
  );
  assert.equal(result.blessed, false);
  assert.equal(result.missingTest, true);
});

test("a label applied by an actor outside the allowlist is refused, not blessed", () => {
  const result = classifyCommit(
    { sha: "abcdef8888", message: "fix(deps): update something" },
    verifiedPr(42, "success", "some-intruder"),
  );
  assert.equal(result.blessed, false);
  assert.equal(result.refusedLabel, true);
  assert.equal(result.labelActor, "some-intruder");
});

test("a label whose applier could not be read is unresolved rather than blessed", () => {
  const result = classifyCommit(
    { sha: "abcdef7777", message: "fix(deps): update something" },
    () => ({ number: 42, labels: ["brief-verified"], labelActorUnread: true, testConclusion: "success" }),
  );
  assert.equal(result.blessed, false);
  assert.equal(result.unresolved, true);
});

test("a label with no recorded applier is refused as an unknown actor", () => {
  const result = classifyCommit(
    { sha: "abcdef6666", message: "fix(deps): update something" },
    () => ({ number: 42, labels: ["brief-verified"], testConclusion: "success" }),
  );
  assert.equal(result.blessed, false);
  assert.equal(result.refusedLabel, true);
  assert.equal(result.labelActor, null);
});

test("the allowlist parameter decides which actors may vouch by label", () => {
  const resolver = verifiedPr(42, "success", "release-ops");
  const refused = classifyCommit({ sha: "abcdef5555", message: "fix: x" }, resolver);
  assert.equal(refused.refusedLabel, true);
  const blessed = classifyCommit({ sha: "abcdef5555", message: "fix: x" }, resolver, "brief-verified", ["release-ops"]);
  assert.equal(blessed.blessed, true);
  assert.equal(blessed.via, "brief-verified label");
});

test("a trailer commit is blessed on the trailer even when its label came from an unknown actor", () => {
  const result = classifyCommit(
    { sha: "abcdef4444", message: "fix: x\n\nBrief-Verified: a-brief" },
    () => ({ number: 42, labels: ["brief-verified"], labelActor: "some-intruder", testConclusion: "success" }),
  );
  assert.equal(result.blessed, true);
  assert.equal(result.via, "Brief-Verified trailer");
});

test("an allowlist that is not an array is unresolved rather than substring-matched", () => {
  const result = classifyCommit(
    { sha: "abcdef3333", message: "fix: x" },
    verifiedPr(42, "success", "Mono"),
    "brief-verified",
    "Monoradioactivo",
  );
  assert.equal(result.blessed, false);
  assert.equal(result.unresolved, true);
});

test("a refused label with no recorded actor blocks and says the actor is unknown", () => {
  const commits = [
    classifyCommit(
      { sha: "2222222bbb", message: "fix(deps): update x" },
      () => ({ number: 43, labels: ["brief-verified"], testConclusion: "success" }),
    ),
  ];
  const verdict = buildVerdict({ baseTag: "v1.0.0", commits, currentVersion: "1.0.0", releaseVersion: "1.0.1" });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reasons[0], /#43 \(2222222\).*applied by an unknown actor/);
});

test("a refused label blocks the release with a reason naming the actor", () => {
  const commits = [
    classifyCommit({ sha: "1111111aaa", message: "fix(deps): update x" }, verifiedPr(42, "success", "some-intruder")),
  ];
  const verdict = buildVerdict({ baseTag: "v1.0.0", commits, currentVersion: "1.0.0", releaseVersion: "1.0.1" });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reasons.length, 1);
  assert.match(verdict.reasons[0], /#42 \(1111111\).*brief-verified label.*applied by some-intruder.*does not accept/);
});

test("release-please is skipped only when the label, subject, and bot author agree", () => {
  const asRelease = () => ({
    number: 218,
    labels: ["autorelease: tagged"],
    author: "aetherpush-release-bot[bot]",
  });
  const blessed = classifyCommit({ sha: "a3456c9000", message: "chore(main): release 3.4.4" }, asRelease);
  assert.equal(blessed.blessed, true);
  assert.equal(blessed.via, "release-please pull request");

  const impostor = classifyCommit({ sha: "a3456c9000", message: "feat: sneak this in" }, asRelease);
  assert.equal(impostor.blessed, false);
});

test("a release-shaped commit from a non-bot author is not blessed via the release-please path", () => {
  const humanRelease = () => ({
    number: 218,
    labels: ["autorelease: tagged"],
    author: "some-human",
  });
  const result = classifyCommit({ sha: "a3456c9000", message: "chore(main): release 3.4.4" }, humanRelease);
  assert.equal(result.blessed, false);
  assert.equal(result.via, null);
  assert.equal(result.unresolved, undefined);
});

test("a release-shaped commit with a missing author fails closed as unresolved", () => {
  const noAuthor = () => ({ number: 218, labels: ["autorelease: tagged"], author: null });
  const result = classifyCommit({ sha: "a3456c9000", message: "chore(main): release 3.4.4" }, noAuthor);
  assert.equal(result.blessed, false);
  assert.equal(result.unresolved, true);
});

test("a release-shaped commit with an unreadable author fails closed as unresolved", () => {
  const unread = () => ({ number: 218, labels: ["autorelease: tagged"], authorUnread: true });
  const result = classifyCommit({ sha: "a3456c9000", message: "chore(main): release 3.4.4" }, unread);
  assert.equal(result.blessed, false);
  assert.equal(result.unresolved, true);
});

test("a non-bot release-shaped commit can still bless through the trailer path", () => {
  const humanRelease = () => ({
    number: 218,
    labels: ["autorelease: tagged"],
    author: "some-human",
    testConclusion: "success",
  });
  const result = classifyCommit(
    { sha: "a3456c9000", message: "chore(main): release 3.4.4\n\nBrief-Verified: a-brief" },
    humanRelease,
  );
  assert.equal(result.blessed, true);
  assert.equal(result.via, "Brief-Verified trailer");
});

test("an unmarked commit is not blessed", () => {
  const result = classifyCommit({ sha: "deadbeef00", message: "fix: x" }, () => ({ number: 7, labels: [] }));
  assert.equal(result.blessed, false);
});

test("an unresolvable pull request is reported rather than treated as clean", () => {
  const result = classifyCommit({ sha: "deadbeef00", message: "fix: x" }, () => null);
  assert.equal(result.blessed, false);
  assert.equal(result.unresolved, true);
});

test("unreadable labels are reported rather than treated as clean", () => {
  const result = classifyCommit({ sha: "deadbeef00", message: "fix: x" }, () => ({ number: 7, labels: null }));
  assert.equal(result.blessed, false);
  assert.equal(result.unresolved, true);
});

test("a commit belonging to no pull request is not blessed", () => {
  const result = classifyCommit({ sha: "deadbeef00", message: "hotfix straight to main" }, noPullRequest);
  assert.equal(result.blessed, false);
  assert.equal(result.pr, null);
});

test("the verdict passes only when every commit is accounted for", () => {
  const commits = [
    classifyCommit({ sha: "1111111aaa", message: "fix: a\n\nBrief-Verified: brief-a" }, trailerPr(1, "success")),
  ];
  const verdict = buildVerdict({
    baseTag: "v1.0.0",
    commits,
    currentVersion: "1.0.0",
    releaseVersion: "1.0.1",
    versionsRequired: true,
  });
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.reasons, []);
});

test("a skipped Test blocks the release and names the conclusion", () => {
  const commits = [
    classifyCommit({ sha: "caf9942aaa", message: "fix: a\n\nBrief-Verified: brief-a" }, trailerPr(241, "skipped")),
  ];
  const verdict = buildVerdict({ baseTag: "v1.0.0", commits, currentVersion: "1.0.0", releaseVersion: "1.0.1" });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reasons.length, 1);
  assert.ok(verdict.reasons[0].includes(REQUIRED_TEST_CHECK));
  assert.match(verdict.reasons[0], /skipped/);
});

test("one unmarked commit blocks the release and says which", () => {
  const commits = [
    classifyCommit({ sha: "1111111aaa", message: "fix: a\n\nBrief-Verified: brief-a" }, trailerPr(1, "success")),
    classifyCommit({ sha: "3333333ccc", message: "fix: b" }, () => ({ number: 3, labels: [] })),
  ];
  const verdict = buildVerdict({ baseTag: "v1.0.0", commits, currentVersion: "1.0.0", releaseVersion: "1.0.1" });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reasons.length, 1);
  assert.match(verdict.reasons[0], /#3 \(3333333\)/);
});

test("a major bump always blocks", () => {
  const commits = [
    classifyCommit({ sha: "1111111aaa", message: "feat!: a\n\nBrief-Verified: brief-a" }, trailerPr(1, "success")),
  ];
  const verdict = buildVerdict({
    baseTag: "v1.9.0",
    commits,
    currentVersion: "1.9.0",
    releaseVersion: "2.0.0",
    versionsRequired: true,
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reasons[0], /major bump/);
});

test("both versions unreadable blocks rather than passing silently", () => {
  const commits = [
    classifyCommit({ sha: "1111111aaa", message: "fix: a\n\nBrief-Verified: brief-a" }, trailerPr(1, "success")),
  ];
  const verdict = buildVerdict({
    baseTag: "v1.0.0",
    commits,
    currentVersion: null,
    releaseVersion: null,
    versionsRequired: true,
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reasons[0], /valid version on both sides/);
});

test("a non-semver version blocks rather than comparing as NaN", () => {
  const commits = [
    classifyCommit({ sha: "1111111aaa", message: "fix: a\n\nBrief-Verified: brief-a" }, trailerPr(1, "success")),
  ];
  const verdict = buildVerdict({
    baseTag: "v1.0.0",
    commits,
    currentVersion: "1.0.0",
    releaseVersion: "garbage\nGATE_EOF\nok=true",
    versionsRequired: true,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.releaseVersion, null);
});

test("a truncated compare range blocks", () => {
  const commits = [
    classifyCommit({ sha: "1111111aaa", message: "fix: a\n\nBrief-Verified: brief-a" }, trailerPr(1, "success")),
  ];
  const verdict = buildVerdict({ baseTag: "v1.0.0", commits, rangeTruncated: true });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reasons[0], /truncated/);
});

test("an empty range blocks rather than passing vacuously", () => {
  const verdict = buildVerdict({ baseTag: "v1.0.0", commits: [] });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reasons[0], /no commits found/);
});

test("a missing base tag blocks", () => {
  const verdict = buildVerdict({ baseTag: null, commits: [] });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reasons[0], /no previous release tag/);
});

test("a manifest version wins over package.json", () => {
  assert.equal(
    versionFromPayloads({ manifest: { ".": "0.6.0" }, packageJson: { version: "1.3.0" } }),
    "0.6.0",
  );
});

test("package.json is used when the manifest is absent", () => {
  assert.equal(versionFromPayloads({ manifest: null, packageJson: { version: "0.9.0" } }), "0.9.0");
});

test("a 1.x to 2.0.0 pair is a major the verdict holds", () => {
  const commits = [
    classifyCommit({ sha: "1111111aaa", message: "feat!: a\n\nBrief-Verified: brief-a" }, trailerPr(1, "success")),
  ];
  const verdict = buildVerdict({
    baseTag: "v1.3.0",
    commits,
    currentVersion: "1.3.0",
    releaseVersion: "2.0.0",
    versionsRequired: true,
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reasons[0], /major bump, 1.3.0 to 2.0.0/);
});

test("missing both payloads yields no version", () => {
  assert.equal(versionFromPayloads({ manifest: null, packageJson: null }), null);
  assert.equal(versionFromPayloads({ manifest: {}, packageJson: {} }), null);
});

test("a contents 404 is missing; a 403 or 500 is not", () => {
  assert.equal(contentsFetchFailedAsMissing('{"message":"Not Found","status":"404"}'), true);
  assert.equal(contentsFetchFailedAsMissing("gh: Not Found (HTTP 404)"), true);
  assert.equal(contentsFetchFailedAsMissing('{"message":"Forbidden","status":"403"}'), false);
  assert.equal(contentsFetchFailedAsMissing('{"message":"Server Error","status":"500"}'), false);
});
