export const DEFAULT_VERIFIED_LABEL = "brief-verified";
export const REQUIRED_TEST_CHECK = "Node 22";
export const REQUIRED_TEST_APP = "github-actions";
export const DEFAULT_LABEL_ACTOR_ALLOWLIST = ["Monoradioactivo"];
export const DEFAULT_RELEASE_BOT_LOGIN = "aetherpush-release-bot[bot]";

const TRAILER_LINE = /^Brief-Verified:[ \t]*\S/i;
const TRAILER_SHAPE = /^[A-Za-z][A-Za-z0-9-]*:[ \t]/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const RELEASE_SUBJECT = /^chore\(main\): release /;

export function subjectOf(message) {
  return String(message).split("\n")[0];
}

export function trailerBlockOf(message) {
  const paragraphs = String(message)
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (paragraphs.length === 0) return [];
  const last = paragraphs[paragraphs.length - 1].split("\n").map((l) => l.trim());
  return last.every((line) => TRAILER_SHAPE.test(line)) ? last : [];
}

export function hasVerifiedTrailer(message) {
  return trailerBlockOf(message).some((line) => TRAILER_LINE.test(line));
}

export function pickLatestTestConclusion(runs) {
  const completed = (Array.isArray(runs) ? runs : [])
    .filter(
      (run) =>
        run &&
        String(run.name) === REQUIRED_TEST_CHECK &&
        String(run.app) === REQUIRED_TEST_APP &&
        run.status === "completed" &&
        run.completed_at,
    )
    .slice()
    .sort((a, b) => String(b.completed_at).localeCompare(String(a.completed_at)));
  if (completed.length === 0) return "absent";
  return completed[0].conclusion ? String(completed[0].conclusion) : "absent";
}

function refuseForTest(sha, pr, subject, testConclusion) {
  return {
    sha,
    pr,
    subject,
    blessed: false,
    via: null,
    missingTest: true,
    testConclusion,
  };
}

export function classifyCommit(
  commit,
  resolvePullRequest,
  label = DEFAULT_VERIFIED_LABEL,
  allowedLabelActors = DEFAULT_LABEL_ACTOR_ALLOWLIST,
  releaseBotLogin = DEFAULT_RELEASE_BOT_LOGIN,
) {
  const sha = String(commit.sha).slice(0, 7);
  const subject = subjectOf(commit.message);
  const hasTrailer = hasVerifiedTrailer(commit.message);

  const resolved = resolvePullRequest(commit.sha);
  if (resolved === null || resolved === undefined) {
    return { sha, pr: null, subject, blessed: false, via: null, unresolved: true };
  }
  if (resolved.missing) {
    if (hasTrailer) {
      return refuseForTest(sha, null, subject, "no-pull-request");
    }
    return { sha, pr: null, subject, blessed: false, via: null };
  }

  const { number, labels } = resolved;
  if (!Array.isArray(labels)) {
    return { sha, pr: number, subject, blessed: false, via: null, unresolved: true };
  }
  if (labels.some((name) => String(name).startsWith("autorelease:")) && RELEASE_SUBJECT.test(subject)) {
    if (resolved.authorUnread) {
      return { sha, pr: number, subject, blessed: false, via: null, unresolved: true };
    }
    const author = resolved.author == null ? null : String(resolved.author);
    if (author === null || author.length === 0) {
      return { sha, pr: number, subject, blessed: false, via: null, unresolved: true };
    }
    if (author === releaseBotLogin) {
      return { sha, pr: number, subject, blessed: true, via: "release-please pull request" };
    }
  }

  const via = hasTrailer
    ? "Brief-Verified trailer"
    : labels.includes(label)
      ? `${label} label`
      : null;
  if (!via) {
    return { sha, pr: number, subject, blessed: false, via: null };
  }

  if (!hasTrailer) {
    if (resolved.labelActorUnread || !Array.isArray(allowedLabelActors)) {
      return { sha, pr: number, subject, blessed: false, via: null, unresolved: true };
    }
    const actor = resolved.labelActor == null ? null : String(resolved.labelActor);
    if (actor === null || !allowedLabelActors.includes(actor)) {
      return {
        sha,
        pr: number,
        subject,
        blessed: false,
        via: null,
        refusedLabel: true,
        labelActor: actor,
      };
    }
  }

  if (resolved.testUnread) {
    return { sha, pr: number, subject, blessed: false, via: null, unresolved: true };
  }

  const testConclusion = resolved.testConclusion == null ? "absent" : String(resolved.testConclusion);
  if (testConclusion !== "success") {
    return refuseForTest(sha, number, subject, testConclusion);
  }

  return { sha, pr: number, subject, blessed: true, via };
}

export function majorOf(version) {
  return Number(String(version).split(".")[0]);
}

export function buildVerdict({
  baseTag,
  commits,
  currentVersion,
  releaseVersion,
  label = DEFAULT_VERIFIED_LABEL,
  rangeTruncated = false,
  versionsRequired = false,
}) {
  if (!baseTag) {
    return {
      ok: false,
      baseTag: null,
      releaseVersion: null,
      reasons: ["no previous release tag was found, so the release range cannot be established"],
      commits: [],
    };
  }

  const reasons = [];

  if (rangeTruncated) {
    reasons.push("the compare range was truncated by the API, so not every commit in this release was inspected");
  }

  if (commits.length === 0) {
    reasons.push(`no commits found between ${baseTag} and main, which is not a shape this gate understands`);
  }

  for (const commit of commits) {
    if (commit.blessed) continue;
    if (commit.unresolved) {
      reasons.push(`could not establish whether ${commit.sha} was verified`);
    } else if (commit.refusedLabel) {
      reasons.push(
        `#${commit.pr} (${commit.sha}) carries the ${label} label, but it was applied by ${
          commit.labelActor == null ? "an unknown actor" : commit.labelActor
        }, whose vouch this gate does not accept`,
      );
    } else if (commit.missingTest) {
      if (commit.pr) {
        reasons.push(
          `#${commit.pr} (${commit.sha}) has no successful ${REQUIRED_TEST_CHECK} check (conclusion: ${commit.testConclusion})`,
        );
      } else {
        reasons.push(
          `commit ${commit.sha} carries a Brief-Verified trailer but belongs to no pull request, so ${REQUIRED_TEST_CHECK} cannot be verified`,
        );
      }
    } else if (commit.pr) {
      reasons.push(`#${commit.pr} (${commit.sha}) carries neither a Brief-Verified trailer nor the ${label} label`);
    } else {
      reasons.push(`commit ${commit.sha} carries no Brief-Verified trailer and belongs to no pull request`);
    }
  }

  if (versionsRequired) {
    if (!SEMVER.test(String(currentVersion)) || !SEMVER.test(String(releaseVersion))) {
      reasons.push("could not read a valid version on both sides of the release pull request");
    } else if (majorOf(releaseVersion) > majorOf(currentVersion)) {
      reasons.push(`a major bump, ${currentVersion} to ${releaseVersion}, always needs a human`);
    }
  }

  return {
    ok: reasons.length === 0,
    baseTag,
    releaseVersion: SEMVER.test(String(releaseVersion)) ? releaseVersion : null,
    reasons,
    commits,
  };
}
