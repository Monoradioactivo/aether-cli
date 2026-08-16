import * as http from "http";

export interface LoopbackCallback {
  code: string;
  state: string | null;
  error: string | null;
}

export interface LoopbackListener {
  redirectUri: string;
  waitForCallback(timeoutMs: number): Promise<LoopbackCallback>;
  close(): void;
}

const CALLBACK_PATH = "/callback";

/**
 * A one-shot HTTP listener on the loopback interface that receives the
 * authorization code the browser is redirected to.
 *
 * Bound to 127.0.0.1 rather than every interface, and on an ephemeral port the
 * server pins to this ceremony, so nothing off this machine can reach it and a
 * second `aether login` cannot collide with the first.
 */
export function startLoopbackListener(): Promise<LoopbackListener> {
  return new Promise((resolve, reject) => {
    let settle: ((result: LoopbackCallback) => void) | null = null;
    let fail: ((error: Error) => void) | null = null;
    let received: LoopbackCallback | null = null;

    const server = http.createServer((req, res) => {
      const requestUrl = new URL(req.url || "/", "http://127.0.0.1");

      if (requestUrl.pathname !== CALLBACK_PATH) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }

      const result: LoopbackCallback = {
        code: requestUrl.searchParams.get("code") || "",
        state: requestUrl.searchParams.get("state"),
        error: requestUrl.searchParams.get("error"),
      };

      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(renderPage(result));

      received = result;
      if (settle) {
        settle(result);
      }
    });

    server.on("error", (err) => {
      if (fail) {
        fail(err);
        return;
      }
      reject(err);
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("The local callback listener did not report a port."));
        return;
      }

      resolve({
        redirectUri: `http://127.0.0.1:${address.port}${CALLBACK_PATH}`,
        waitForCallback(timeoutMs: number): Promise<LoopbackCallback> {
          if (received) {
            return Promise.resolve(received);
          }
          return new Promise<LoopbackCallback>((resolveWait, rejectWait) => {
            const timer = setTimeout(() => {
              settle = null;
              fail = null;
              rejectWait(new Error("Timed out waiting for the browser to complete authorization. Run 'aether login' again."));
            }, timeoutMs);

            settle = (result) => {
              clearTimeout(timer);
              settle = null;
              fail = null;
              resolveWait(result);
            };
            fail = (error) => {
              clearTimeout(timer);
              settle = null;
              fail = null;
              rejectWait(error);
            };
          });
        },
        close(): void {
          server.close();
        },
      });
    });
  });
}

function renderPage(result: LoopbackCallback): string {
  const heading = result.error ? "Authorization failed" : "You're signed in";
  const detail = result.error
    ? "Nothing was authorized. Return to your terminal for the details."
    : "You can close this tab and return to your terminal.";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${heading}</title>
    <style>
      body { font-family: system-ui, -apple-system, sans-serif; margin: 0; display: grid; place-items: center; min-height: 100vh; background: #0b0b10; color: #e7e7ee; }
      main { text-align: center; padding: 2rem; }
      h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
      p { margin: 0; color: #9a9aab; }
    </style>
  </head>
  <body>
    <main>
      <h1>${heading}</h1>
      <p>${detail}</p>
    </main>
  </body>
</html>`;
}
