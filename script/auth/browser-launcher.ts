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
  // The URL came from the server, and `--serverUrl` means the server is not
  // always ours. Anything but an http(s) address is refused before it reaches
  // the shell, and the openers are invoked in forms that cannot read it as a
  // flag or as command text.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }

  const { command, args } = resolveOpenCommand(parsed.toString());

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
    return { command: "open", args: ["--", url] };
  }
  if (process.platform === "win32") {
    // Not `cmd /c start`: cmd re-parses its arguments, and Node's Windows
    // quoting does not escape a double quote the way cmd reads one.
    return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  }
  return { command: "xdg-open", args: ["--", url] };
}
