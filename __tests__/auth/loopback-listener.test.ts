import { startLoopbackListener } from "../../script/auth/loopback-listener";

describe("startLoopbackListener", () => {
  it("binds an ephemeral port on the loopback address only", async () => {
    const listener = await startLoopbackListener();

    try {
      const url = new URL(listener.redirectUri);
      expect(url.protocol).toBe("http:");
      expect(url.hostname).toBe("127.0.0.1");
      expect(url.pathname).toBe("/callback");
      expect(Number(url.port)).toBeGreaterThan(0);
    } finally {
      listener.close();
    }
  });

  it("hands the callback query back to the caller and answers the browser", async () => {
    const listener = await startLoopbackListener();

    try {
      const waiting = listener.waitForCallback(5000);
      const response = await fetch(`${listener.redirectUri}?code=the-code&state=the-state`);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      await expect(waiting).resolves.toEqual({ code: "the-code", state: "the-state", error: null });
    } finally {
      listener.close();
    }
  });

  it("reports a denial passed back on the redirect", async () => {
    const listener = await startLoopbackListener();

    try {
      const waiting = listener.waitForCallback(5000);
      await fetch(`${listener.redirectUri}?error=access_denied`);

      await expect(waiting).resolves.toMatchObject({ error: "access_denied" });
    } finally {
      listener.close();
    }
  });

  it("returns the callback even when it arrived before anyone waited", async () => {
    const listener = await startLoopbackListener();

    try {
      await fetch(`${listener.redirectUri}?code=early&state=s`);
      // Give the handler a turn to record it.
      await new Promise((resolve) => setTimeout(resolve, 20));

      await expect(listener.waitForCallback(5000)).resolves.toMatchObject({ code: "early" });
    } finally {
      listener.close();
    }
  });

  it("ignores requests to any other path", async () => {
    const listener = await startLoopbackListener();

    try {
      const url = new URL(listener.redirectUri);
      const response = await fetch(`${url.origin}/not-the-callback`);

      expect(response.status).toBe(404);
    } finally {
      listener.close();
    }
  });

  it("gives up waiting rather than hanging forever", async () => {
    const listener = await startLoopbackListener();

    try {
      await expect(listener.waitForCallback(50)).rejects.toThrow(/Timed out/);
    } finally {
      listener.close();
    }
  });
});
