import { fitToByteBudget, truncateText, untrustedText } from "../../script/mcp/text";
import { harness, historyRoute, pkg, textBytes } from "./helpers";

const CJK = "支払い画面のクラッシュを修正し、カートのバッジを新しくして、チェックアウトの文言を全面的に見直しました。";

describe("untrusted text", () => {
  test("control characters are flattened and text is capped", () => {
    expect(untrustedText("a\n\tb\u0007c", 200)).toBe("a b c");
    expect(untrustedText("x".repeat(500), 200)).toHaveLength(200);
    expect(untrustedText(42, 200)).toBeNull();
  });

  test("invisible, bidirectional, variation-selector and tag characters are removed", () => {
    const hidden = [0x00ad, 0x061c, 0x200b, 0x202e, 0x2066, 0x206a, 0x3164, 0xfe0f, 0xfff9, 0xe0041, 0xe0042, 0xe0100, 0xe01ef]
      .map((code) => String.fromCodePoint(code))
      .join("");
    expect(untrustedText(`safe${hidden}text`, 200)).toBe("safetext");
    expect(untrustedText(`line${String.fromCodePoint(0x2028)}break${String.fromCodePoint(0x85)}next`, 200)).toBe("line break next");
  });

  test("truncation keeps whole code points and respects the byte cap", () => {
    const emoji = "😀".repeat(10);
    const cut = truncateText(emoji, 5);
    expect(Array.from(cut)).toHaveLength(5);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.includes("\ud83d…")).toBe(false);
    const cjk = truncateText(CJK.repeat(5), 120, 120);
    expect(Buffer.byteLength(cjk)).toBeLessThanOrEqual(120);
    expect(Array.from(cjk).length).toBeLessThanOrEqual(120);
    expect(truncateText("short", 120, 120)).toBe("short");
  });

  test("the budget helper drops trailing items until the JSON fits", () => {
    const items = Array.from({ length: 10 }, (_, i) => "x".repeat(100) + i);
    const result = fitToByteBudget(items, 500, (kept, truncated) => ({ kept, truncated }));
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(500);
    expect(result.truncated).toBe(true);
    expect(result.kept[0]).toBe(items[0]);
    expect(fitToByteBudget(["a"], 500, (kept, truncated) => ({ kept, truncated }))).toEqual({ kept: ["a"], truncated: false });
  });
});

describe("answer sizes with multibyte text", () => {
  const longCjk = CJK.repeat(4);

  test("the default ten-release history stays under 4 KB with CJK descriptions", async () => {
    const history = Array.from({ length: 12 }, (_, i) =>
      pkg(`v${i + 1}`, { description: `第${i + 1}版 ${longCjk}`, releaseMethod: "Upload" })
    );
    const app = "商店アプリ";
    const h = harness({ routes: { [`/v1/apps/${encodeURIComponent(app)}/deployments/Production/history`]: historyRoute(history) } });
    const response = await h.call("list_release_history", { app, deployment: "Production" });
    expect(response.result.structuredContent.releases).toHaveLength(10);
    expect(response.result.structuredContent.truncated).toBe(false);
    expect(textBytes(response)).toBeLessThan(4096);
    for (const release of response.result.structuredContent.releases) {
      expect(Buffer.byteLength(release.description)).toBeLessThanOrEqual(120);
    }
  });

  test("the twenty-release maximum stays inside the 8 KB history budget, even with quote-heavy text and long names", async () => {
    const quoted = '"\\'.repeat(200);
    const app = "商".repeat(255);
    const deployment = "デ".repeat(255);
    const history = Array.from({ length: 25 }, (_, i) => pkg(`v${i + 1}`, { description: quoted }));
    const h = harness({
      routes: { [`/v1/apps/${encodeURIComponent(app)}/deployments/${encodeURIComponent(deployment)}/history`]: historyRoute(history) },
    });
    const response = await h.call("list_release_history", { app, deployment, limit: 20 });
    expect(textBytes(response)).toBeLessThanOrEqual(8192);
    const { releases, truncated } = response.result.structuredContent;
    expect(truncated).toBe(releases.length < 20);
    expect(releases[0].label).toBe("v25");
  });

  test("get_live_release without a deployment stays under 4 KB at the 20-deployment cap with CJK text", async () => {
    const deployments = Array.from({ length: 24 }, (_, i) => ({
      name: `環境${i + 1}${"番".repeat(40)}`,
      key: `secret-${i}`,
      package: pkg(`v${i + 1}`, { description: longCjk }),
    }));
    const app = "商店アプリ";
    const h = harness({ routes: { [`/v1/apps/${encodeURIComponent(app)}/deployments`]: { deployments } } });
    const response = await h.call("get_live_release", { app });
    const result = response.result.structuredContent;
    expect(textBytes(response)).toBeLessThan(4096);
    expect(result.totalDeployments).toBe(24);
    expect(result.truncated).toBe(true);
    expect(result.deployments.length).toBeGreaterThan(0);
    expect(result.deployments[0].name.startsWith("環境1")).toBe(true);
  });

  test("a typical two-deployment CJK app answers in full under 4 KB", async () => {
    const app = "商店アプリ";
    const h = harness({
      routes: {
        [`/v1/apps/${encodeURIComponent(app)}/deployments`]: {
          deployments: [
            { name: "Production", key: "k1", package: pkg("v12", { description: longCjk }) },
            { name: "Staging", key: "k2", package: pkg("v3", { description: longCjk }) },
          ],
        },
      },
    });
    const response = await h.call("get_live_release", { app });
    expect(response.result.structuredContent.truncated).toBe(false);
    expect(response.result.structuredContent.deployments).toHaveLength(2);
    expect(textBytes(response)).toBeLessThan(4096);
  });

  test("list_apps stays under 4 KB with sixty apps of long CJK names and says it truncated", async () => {
    const apps = Array.from({ length: 60 }, (_, i) => ({
      name: `アプリ${String(i).padStart(2, "0")}${"名".repeat(60)}`,
      deployments: Array.from({ length: 6 }, (_, d) => `環境${d}${"番".repeat(30)}`),
    }));
    const h = harness({ routes: { "/v1/apps": { apps } } });
    const response = await h.call("list_apps", {});
    const result = response.result.structuredContent;
    expect(textBytes(response)).toBeLessThan(4096);
    expect(result.totalApps).toBe(60);
    expect(result.truncated).toBe(true);
    expect(result.apps.length).toBeGreaterThan(0);
  });

  test("one app too large for the budget alone yields an empty, truncated list rather than an oversized answer", async () => {
    const apps = [{ name: "名".repeat(255), deployments: Array.from({ length: 20 }, (_, d) => `${d}${"番".repeat(254)}`) }];
    const h = harness({ routes: { "/v1/apps": { apps } } });
    const response = await h.call("list_apps", {});
    expect(textBytes(response)).toBeLessThan(4096);
    expect(response.result.structuredContent).toMatchObject({ apps: [], totalApps: 1, truncated: true });
  });
});
