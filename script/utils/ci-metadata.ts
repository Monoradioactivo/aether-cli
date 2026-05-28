// Copyright (c) Aether. All rights reserved.

import * as cli from "../types/cli";

export type CiProvider = "github" | "gitlab" | "circleci" | "jenkins";

export interface CiMetadata {
  provider: CiProvider;
  sha?: string;
  branch?: string;
  pr?: string;
  run?: string;
}

const SHA_SHORT_LENGTH = 7;

function shortSha(sha: string | undefined): string | undefined {
  if (!sha) {
    return undefined;
  }
  return sha.length > SHA_SHORT_LENGTH ? sha.substring(0, SHA_SHORT_LENGTH) : sha;
}

function parseGithubPrNumber(ref: string | undefined): string | undefined {
  if (!ref) {
    return undefined;
  }
  const match = ref.match(/^refs\/pull\/(\d+)\//);
  return match ? match[1] : undefined;
}

function detectGithub(env: NodeJS.ProcessEnv): CiMetadata | null {
  if (env.GITHUB_ACTIONS !== "true") {
    return null;
  }

  let run: string | undefined;
  if (env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID) {
    run = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  }

  return {
    provider: "github",
    sha: shortSha(env.GITHUB_SHA),
    branch: env.GITHUB_REF_NAME || undefined,
    pr: parseGithubPrNumber(env.GITHUB_REF),
    run,
  };
}

function detectGitlab(env: NodeJS.ProcessEnv): CiMetadata | null {
  if (env.GITLAB_CI !== "true") {
    return null;
  }

  return {
    provider: "gitlab",
    sha: shortSha(env.CI_COMMIT_SHA),
    branch: env.CI_COMMIT_REF_NAME || undefined,
    pr: env.CI_MERGE_REQUEST_IID || undefined,
    run: env.CI_JOB_URL || undefined,
  };
}

function detectCircleci(env: NodeJS.ProcessEnv): CiMetadata | null {
  if (env.CIRCLECI !== "true") {
    return null;
  }

  return {
    provider: "circleci",
    sha: shortSha(env.CIRCLE_SHA1),
    branch: env.CIRCLE_BRANCH || undefined,
    pr: env.CIRCLE_PR_NUMBER || undefined,
    run: env.CIRCLE_BUILD_URL || undefined,
  };
}

function detectJenkins(env: NodeJS.ProcessEnv): CiMetadata | null {
  if (!env.JENKINS_URL) {
    return null;
  }

  return {
    provider: "jenkins",
    sha: shortSha(env.GIT_COMMIT),
    branch: env.GIT_BRANCH || undefined,
    pr: env.CHANGE_ID || undefined,
    run: env.BUILD_URL || undefined,
  };
}

export function detectCiMetadata(): CiMetadata | null {
  const env = process.env;
  return detectGithub(env) || detectGitlab(env) || detectCircleci(env) || detectJenkins(env);
}

export function formatCiMetadata(meta: CiMetadata): string {
  const parts: string[] = [`ci=${meta.provider}`];
  if (meta.sha) {
    parts.push(`sha=${meta.sha}`);
  }
  if (meta.branch) {
    parts.push(`branch=${meta.branch}`);
  }
  if (meta.pr) {
    parts.push(`pr=${meta.pr}`);
  }
  if (meta.run) {
    parts.push(`run=${meta.run}`);
  }
  return `[${parts.join(" ")}]`;
}

export function enrichDescriptionWithCiMetadata(command: cli.ICommand): void {
  if (command.ciMetadata === false) {
    return;
  }

  const meta = detectCiMetadata();
  if (!meta) {
    return;
  }

  const formatted = formatCiMetadata(meta);
  const target = command as cli.ICommand & { description?: string };
  const existing = target.description ? target.description.trim() : "";

  if (existing) {
    target.description = `${existing}\n\n${formatted}`;
  } else {
    target.description = formatted;
  }
}
