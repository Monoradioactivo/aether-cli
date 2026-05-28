// Copyright (c) Aether. All rights reserved.

import { detectCiMetadata, formatCiMetadata, enrichDescriptionWithCiMetadata, CiMetadata } from "../../script/utils/ci-metadata";
import * as cli from "../../script/types/cli";

const CI_ENV_VARS = [
  "CI",
  "GITHUB_ACTIONS",
  "GITHUB_SHA",
  "GITHUB_REF",
  "GITHUB_REF_NAME",
  "GITHUB_SERVER_URL",
  "GITHUB_REPOSITORY",
  "GITHUB_RUN_ID",
  "GITLAB_CI",
  "CI_COMMIT_SHA",
  "CI_COMMIT_REF_NAME",
  "CI_MERGE_REQUEST_IID",
  "CI_JOB_URL",
  "CIRCLECI",
  "CIRCLE_SHA1",
  "CIRCLE_BRANCH",
  "CIRCLE_PR_NUMBER",
  "CIRCLE_BUILD_URL",
  "JENKINS_URL",
  "GIT_COMMIT",
  "GIT_BRANCH",
  "CHANGE_ID",
  "BUILD_URL",
];

describe("ci-metadata", () => {
  let savedCiEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedCiEnv = {};
    for (const key of CI_ENV_VARS) {
      savedCiEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of CI_ENV_VARS) {
      if (savedCiEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedCiEnv[key];
      }
    }
  });

  describe("detectCiMetadata", () => {
    it("returns null when no provider is detected", () => {
      expect(detectCiMetadata()).toBeNull();
    });

    it("ignores a bare CI=true with no provider env vars", () => {
      process.env.CI = "true";
      expect(detectCiMetadata()).toBeNull();
    });

    it("detects GitHub Actions with full metadata", () => {
      process.env.GITHUB_ACTIONS = "true";
      process.env.GITHUB_SHA = "abc1234567890def";
      process.env.GITHUB_REF_NAME = "main";
      process.env.GITHUB_REF = "refs/pull/42/merge";
      process.env.GITHUB_SERVER_URL = "https://github.com";
      process.env.GITHUB_REPOSITORY = "Monoradioactivo/aether-cli";
      process.env.GITHUB_RUN_ID = "9999";

      expect(detectCiMetadata()).toEqual({
        provider: "github",
        sha: "abc1234",
        branch: "main",
        pr: "42",
        run: "https://github.com/Monoradioactivo/aether-cli/actions/runs/9999",
      });
    });

    it("returns no PR for a GitHub Actions push event", () => {
      process.env.GITHUB_ACTIONS = "true";
      process.env.GITHUB_SHA = "abc1234567890";
      process.env.GITHUB_REF = "refs/heads/main";
      process.env.GITHUB_REF_NAME = "main";

      const meta = detectCiMetadata();
      expect(meta?.provider).toBe("github");
      expect(meta?.pr).toBeUndefined();
    });

    it("returns no run URL when GitHub run inputs are partial", () => {
      process.env.GITHUB_ACTIONS = "true";
      process.env.GITHUB_SHA = "abc1234";
      process.env.GITHUB_REPOSITORY = "owner/repo";

      const meta = detectCiMetadata();
      expect(meta?.run).toBeUndefined();
    });

    it("detects GitLab CI with merge request metadata", () => {
      process.env.GITLAB_CI = "true";
      process.env.CI_COMMIT_SHA = "fedcba9876543210";
      process.env.CI_COMMIT_REF_NAME = "feature/x";
      process.env.CI_MERGE_REQUEST_IID = "7";
      process.env.CI_JOB_URL = "https://gitlab.com/group/proj/-/jobs/123";

      expect(detectCiMetadata()).toEqual({
        provider: "gitlab",
        sha: "fedcba9",
        branch: "feature/x",
        pr: "7",
        run: "https://gitlab.com/group/proj/-/jobs/123",
      });
    });

    it("detects CircleCI", () => {
      process.env.CIRCLECI = "true";
      process.env.CIRCLE_SHA1 = "1234567abcdef";
      process.env.CIRCLE_BRANCH = "develop";
      process.env.CIRCLE_PR_NUMBER = "12";
      process.env.CIRCLE_BUILD_URL = "https://circleci.com/gh/x/y/123";

      expect(detectCiMetadata()).toEqual({
        provider: "circleci",
        sha: "1234567",
        branch: "develop",
        pr: "12",
        run: "https://circleci.com/gh/x/y/123",
      });
    });

    it("detects Jenkins via JENKINS_URL presence", () => {
      process.env.JENKINS_URL = "https://jenkins.internal/";
      process.env.GIT_COMMIT = "abcdef1234567890";
      process.env.GIT_BRANCH = "origin/main";
      process.env.CHANGE_ID = "55";
      process.env.BUILD_URL = "https://jenkins.internal/job/aether/42/";

      expect(detectCiMetadata()).toEqual({
        provider: "jenkins",
        sha: "abcdef1",
        branch: "origin/main",
        pr: "55",
        run: "https://jenkins.internal/job/aether/42/",
      });
    });

    it("prefers GitHub over GitLab when both signals are set", () => {
      process.env.GITHUB_ACTIONS = "true";
      process.env.GITHUB_SHA = "ghsha12";
      process.env.GITLAB_CI = "true";
      process.env.CI_COMMIT_SHA = "glsha34";

      expect(detectCiMetadata()?.provider).toBe("github");
    });

    it("returns sparse metadata when only the trigger var is set", () => {
      process.env.GITHUB_ACTIONS = "true";

      expect(detectCiMetadata()).toEqual({
        provider: "github",
        sha: undefined,
        branch: undefined,
        pr: undefined,
        run: undefined,
      });
    });
  });

  describe("formatCiMetadata", () => {
    it("formats the full set with provider first", () => {
      const meta: CiMetadata = {
        provider: "github",
        sha: "abc1234",
        branch: "main",
        pr: "42",
        run: "https://example.com/run/1",
      };
      expect(formatCiMetadata(meta)).toBe("[ci=github sha=abc1234 branch=main pr=42 run=https://example.com/run/1]");
    });

    it("omits fields that are undefined", () => {
      const meta: CiMetadata = {
        provider: "circleci",
        sha: "1234567",
      };
      expect(formatCiMetadata(meta)).toBe("[ci=circleci sha=1234567]");
    });

    it("emits only the provider when no other fields are present", () => {
      expect(formatCiMetadata({ provider: "jenkins" })).toBe("[ci=jenkins]");
    });
  });

  describe("enrichDescriptionWithCiMetadata", () => {
    function makeCmd(overrides: Partial<{ description: string; ciMetadata: boolean }> = {}): cli.ICommand & { description?: string } {
      return {
        type: cli.CommandType.release,
        ...overrides,
      } as any;
    }

    it("does nothing when no CI provider is detected", () => {
      const cmd = makeCmd({ description: "Fix bug" });
      enrichDescriptionWithCiMetadata(cmd);
      expect(cmd.description).toBe("Fix bug");
    });

    it("appends metadata with a blank line when description has content", () => {
      process.env.GITHUB_ACTIONS = "true";
      process.env.GITHUB_SHA = "abc1234";
      process.env.GITHUB_REF_NAME = "main";

      const cmd = makeCmd({ description: "Fix bug" });
      enrichDescriptionWithCiMetadata(cmd);
      expect(cmd.description).toBe("Fix bug\n\n[ci=github sha=abc1234 branch=main]");
    });

    it("uses metadata alone when description is undefined", () => {
      process.env.GITHUB_ACTIONS = "true";
      process.env.GITHUB_SHA = "abc1234";

      const cmd = makeCmd();
      enrichDescriptionWithCiMetadata(cmd);
      expect(cmd.description).toBe("[ci=github sha=abc1234]");
    });

    it("treats a whitespace-only description as empty", () => {
      process.env.GITHUB_ACTIONS = "true";
      process.env.GITHUB_SHA = "abc1234";

      const cmd = makeCmd({ description: "   \n  " });
      enrichDescriptionWithCiMetadata(cmd);
      expect(cmd.description).toBe("[ci=github sha=abc1234]");
    });

    it("opts out when ciMetadata is false, leaving description untouched", () => {
      process.env.GITHUB_ACTIONS = "true";
      process.env.GITHUB_SHA = "abc1234";

      const cmd = makeCmd({ description: "Fix bug", ciMetadata: false });
      enrichDescriptionWithCiMetadata(cmd);
      expect(cmd.description).toBe("Fix bug");
    });
  });
});
