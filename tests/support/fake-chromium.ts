import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A stand-in browser executable: it records every launch's arguments, then either listens (writes DevToolsActivePort in its --user-data-dir like Chromium
 * does) or dies with Chromium's own message for a sandbox that cannot start. `directory` is where it lives, for the caller to remove.
 */
export async function fakeChromium(behaviour: "listen" | "no-usable-sandbox"): Promise<{ directory: string; executable: string; launches(): Promise<string[][]> }> {
  const directory = await mkdtemp(join(tmpdir(), "fake-chromium-"));
  const log = join(directory, "launches.jsonl");
  const executable = join(directory, "chrome");
  await writeFile(executable, `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");
if (${JSON.stringify(behaviour)} === "no-usable-sandbox") { process.stderr.write("FATAL:zygote_host_impl_linux.cc: No usable sandbox! Update your kernel or see https://chromium.googlesource.com/chromium/src/+/main/docs/linux/suid_sandbox_development.md\\n"); process.exit(133); }
const profile = process.argv.find((arg) => arg.startsWith("--user-data-dir=")).slice("--user-data-dir=".length);
fs.writeFileSync(profile + "/DevToolsActivePort", "9222\\n/devtools/browser/abc\\n");
setInterval(() => {}, 1000);
`);
  await chmod(executable, 0o755);
  return { directory, executable, launches: async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]) };
}
