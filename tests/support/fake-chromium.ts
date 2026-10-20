import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The helper: writes a file into the profile every few milliseconds, and keeps going for twenty more writes after its parent (the main process) is gone. */
const ORPHAN_WRITER = `const fs = require("node:fs"); const [profile, parent] = process.argv.slice(1); let written = 0; let after = 0;
const timer = setInterval(() => { fs.writeFileSync(profile + "/Default/helper-" + (written++), "x"); let gone = false;
  try { process.kill(Number(parent), 0); } catch { gone = true; } if (gone && ++after > 20) clearInterval(timer); }, 5);`;

/**
 * A stand-in browser executable: it records every launch's arguments, then either listens (writes DevToolsActivePort in its --user-data-dir like Chromium
 * does) or dies with Chromium's own message for a sandbox that cannot start. `orphan-writer` listens like Chromium and also starts a helper process (as
 * Chromium's network and GPU helpers are) that keeps writing into the profile for a while after the main process has exited on SIGTERM.
 * `directory` is where it lives, for the caller to remove.
 */
export async function fakeChromium(behaviour: "listen" | "no-usable-sandbox" | "orphan-writer"): Promise<{ directory: string; executable: string; launches(): Promise<string[][]>;
  /** The pid of the "orphan-writer" helper, once the browser has started it. */ helperPid(): Promise<number | null> }> {
  const directory = await mkdtemp(join(tmpdir(), "fake-chromium-"));
  const log = join(directory, "launches.jsonl");
  const executable = join(directory, "chrome");
  await writeFile(executable, `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");
if (${JSON.stringify(behaviour)} === "no-usable-sandbox") { process.stderr.write("FATAL:zygote_host_impl_linux.cc: No usable sandbox! Update your kernel or see https://chromium.googlesource.com/chromium/src/+/main/docs/linux/suid_sandbox_development.md\\n"); process.exit(133); }
const profile = process.argv.find((arg) => arg.startsWith("--user-data-dir=")).slice("--user-data-dir=".length);
if (${JSON.stringify(behaviour)} === "orphan-writer") {
  const helper = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(ORPHAN_WRITER)}, profile, String(process.pid)], { stdio: "ignore" });
  fs.writeFileSync(${JSON.stringify(join(directory, "helper.pid"))}, String(helper.pid));
  process.on("SIGTERM", () => process.exit(0));
}
fs.writeFileSync(profile + "/DevToolsActivePort", "9222\\n/devtools/browser/abc\\n");
setInterval(() => {}, 1000);
`);
  await chmod(executable, 0o755);
  return { directory, executable, helperPid: async () => { const text = await readFile(join(directory, "helper.pid"), "utf8").catch(() => ""); return text ? Number(text) : null; }, launches: async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]) };
}
