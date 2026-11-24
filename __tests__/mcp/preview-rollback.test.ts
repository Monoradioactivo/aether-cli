import { previewRollback } from "../../script/mcp/tools";
import { pkg } from "./helpers";

describe("preview_rollback rules", () => {
  test("mirrors the server's refusals", () => {
    expect(previewRollback([], undefined).refusal).toMatchObject({ code: "rollback_no_releases" });
    expect(previewRollback([pkg("v1")], undefined).refusal).toMatchObject({ code: "rollback_no_prior_releases" });
    expect(previewRollback([pkg("v1"), pkg("v2")], "v2").refusal).toMatchObject({ code: "rollback_target_current" });
    expect(previewRollback([pkg("v1"), pkg("v2")], "v9").refusal).toMatchObject({ code: "rollback_target_not_found" });
    expect(previewRollback([pkg("v1", { appVersion: "2.3.0" }), pkg("v2")], undefined).refusal).toMatchObject({
      code: "rollback_version_mismatch",
    });
    expect(previewRollback([pkg("v1", { isAutoHalted: true }), pkg("v2")], undefined).refusal).toMatchObject({
      code: "release_halted",
    });
  });

  test("describes the release it would create and warns", () => {
    const plain = previewRollback([pkg("v1", { isMandatory: true, rollout: 25 }), pkg("v2")], undefined);
    expect(plain.outcome).toBe("would_roll_back");
    expect(plain.executed).toBe(false);
    expect(plain.newRelease).toEqual({
      copiesLabel: "v1",
      appVersion: "2.4.0",
      isMandatory: true,
      isDisabled: false,
      rolloutPercent: 100,
      releaseMethod: "Rollback",
    });
    expect(plain.warnings).toEqual([]);
    const disabled = previewRollback([pkg("v1", { isDisabled: true }), pkg("v2")], "v1");
    expect((disabled.warnings as string[])[0]).toMatch(/disabled now/);
    const afterRollback = previewRollback([pkg("v1"), pkg("v2"), pkg("v3", { releaseMethod: "Rollback" })], undefined);
    expect((afterRollback.warnings as string[])[0]).toMatch(/itself a rollback/);
    expect((afterRollback.targetRelease as { label: string }).label).toBe("v2");
  });
});
