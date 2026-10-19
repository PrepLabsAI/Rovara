import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

export type LocalChromium = Readonly<{ cdpEndpoint: string; pid: number; close(): Promise<void> }>;

const STARTUP_TIMEOUT_MS = 30_000;

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason instanceof Error ? signal.reason : new Error("chromium launch was cancelled")); return; }
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
    const abort = () => { clearTimeout(timer); reject(signal.reason instanceof Error ? signal.reason : new Error("chromium launch was cancelled")); };
    signal.addEventListener("abort", abort, { once: true });
  });
}

/**
 * Starts the pinned Playwright Chromium inside the executor container and hands back its DevTools endpoint.
 *
 * `--no-sandbox` is deliberate: the container (internal network, every capability dropped, no-new-privileges, non-root)
 * is the sandbox boundary, and Chromium's own user-namespace sandbox cannot start inside it. The debugging port is bound
 * to loopback, so only processes inside this container can attach.
 */
export async function launchLocalChromium(input: { downloadDir: string; signal: AbortSignal;
  /** Test seam for a Chromium host-resolver rule, e.g. `MAP app:4317 127.0.0.1:5000`; production never sets it. */
  hostResolverRules?: string; executablePath?: string }): Promise<LocalChromium> {
  const executable = input.executablePath ?? chromium.executablePath();
  try { await access(executable); } catch { throw new Error(`chromium executable is not installed at ${executable}`); }
  await mkdir(input.downloadDir, { recursive: true, mode: 0o755 });
  const profile = await mkdtemp(join(tmpdir(), "rovara-chromium-"));
  await mkdir(join(profile, "Default"), { recursive: true });
  // Downloads that Chromium itself saves land in the ledger's downloads directory; the owning Playwright context still
  // fetches its own copy through DevTools.
  await writeFile(join(profile, "Default", "Preferences"), JSON.stringify({ download: { default_directory: input.downloadDir,
    prompt_for_download: false, directory_upgrade: true } }));
  const args = ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-extensions", "--metrics-recording-only",
    "--mute-audio", "--password-store=basic", "--use-mock-keychain", `--user-data-dir=${profile}`,
    "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
    ...(input.hostResolverRules === undefined ? [] : [`--host-resolver-rules=${input.hostResolverRules}`]), "about:blank"];
  // Chromium sees only what it needs: the host's own environment may hold credentials that no page may ever read.
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: profile, TMPDIR: tmpdir(), LANG: "C.UTF-8" };
  const child: ChildProcess = spawn(executable, args, { env, stdio: ["ignore", "ignore", "pipe"], shell: false });
  let stderrTail = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-8192); });
  let exited = false;
  const exit = new Promise<void>((resolve) => { child.once("exit", () => { exited = true; resolve(); }); });
  child.once("error", () => { exited = true; });

  const close = async (): Promise<void> => {
    if (!exited) {
      child.kill("SIGTERM");
      const killer = setTimeout(() => { if (!exited) child.kill("SIGKILL"); }, 3_000);
      await exit;
      clearTimeout(killer);
    }
    await rm(profile, { recursive: true, force: true });
  };

  try {
    const startup = AbortSignal.any([input.signal, AbortSignal.timeout(STARTUP_TIMEOUT_MS)]);
    for (;;) {
      if (exited) throw new Error(`chromium exited before it opened a debugging port: ${stderrTail.trim().slice(-500)}`);
      try {
        const [port, path] = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n");
        if (port && /^\d{2,5}$/.test(port) && path?.startsWith("/devtools/browser/")) {
          return Object.freeze({ cdpEndpoint: `ws://127.0.0.1:${port}${path}`, pid: child.pid ?? 0, close });
        }
      } catch { /* the file appears once the browser listens */ }
      await wait(50, startup);
    }
  } catch (error) {
    await close();
    throw error;
  }
}
