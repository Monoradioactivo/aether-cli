import * as childProcess from "child_process";

/**
 * Opens a URL in whatever the platform considers the default browser.
 *
 * A zero exit code from the helper does not prove a browser actually appeared:
 * `xdg-open` succeeds in containers with no display, and a proxy can swallow a
 * loopback address afterwards. Callers therefore print the URL as well and keep
 * a way out that does not depend on this returning the truth.
 */
export function openBrowser(url: string): boolean {
  const { command, args } = resolveOpenCommand(url);

  try {
    const child = childProcess.spawn(command, args, { stdio: "ignore", detached: true });
    if (!child || typeof child.unref !== "function") {
      return false;
    }
    // spawn reports a missing helper asynchronously. Without a listener that
    // becomes an unhandled 'error' event, which takes the whole process down on
    // exactly the headless machines the device flow exists for.
    if (typeof child.on === "function") {
      child.on("error", () => undefined);
    }
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function resolveOpenCommand(url: string): { command: string; args: string[] } {
  if (process.platform === "darwin") {
    return { command: "open", args: [url] };
  }
  if (process.platform === "win32") {
    // The empty title argument keeps `start` from treating the URL as one.
    return { command: "cmd", args: ["/c", "start", "", url] };
  }
  return { command: "xdg-open", args: [url] };
}
