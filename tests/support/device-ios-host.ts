// Test support (device testing slice 4): what the macOS test needs to say clearly when it cannot run. A test that needs Xcode's simulator and Maestro and has none is SKIPPED with the reason, on the log and
// as a warning annotation in the CI run, never passed without having run (the same rule as the Android test's KVM check). `ROVARA_DEVICE_REQUIRE_IOS=1` (the macOS CI job sets it) makes it fail instead.
import { spawnSync } from "node:child_process";
import { chooseIosSimulator } from "../../packages/verifier/src/executor/device-ios.js";

export type IosHostStatus = { ok: true; maestro: string } | { ok: false; reason: string };

/** Whether this machine can run an iOS simulator test: macOS, `xcrun simctl` with an available iOS runtime and an iPhone, and Maestro (ROVARA_MAESTRO, or `maestro` on the PATH). Fixed reasons. */
export function iosHere(run: (file: string, args: string[]) => { status: number | null; stdout: string } = (file, args) => { const row = spawnSync(file, args, { encoding: "utf8", timeout: 30_000 }); return { status: row.status, stdout: row.stdout ?? "" }; },
  platform: string = process.platform, env: Record<string, string | undefined> = process.env): IosHostStatus {
  if (platform !== "darwin") return { ok: false, reason: "this machine is not macOS, so there is no iOS simulator" };
  const listed = run("/usr/bin/xcrun", ["simctl", "list", "runtimes", "-j"]);
  if (listed.status !== 0) return { ok: false, reason: "`xcrun simctl` is not available (no Xcode on this machine)" };
  try { if (chooseIosSimulator(JSON.parse(listed.stdout)) === undefined) return { ok: false, reason: "no available iOS runtime with an iPhone" }; } catch { return { ok: false, reason: "`xcrun simctl list runtimes` did not print JSON" }; }
  const maestro = env["ROVARA_MAESTRO"] !== undefined && env["ROVARA_MAESTRO"] !== "" ? env["ROVARA_MAESTRO"] : run("/usr/bin/which", ["maestro"]).stdout.trim();
  if (maestro === "" || maestro === undefined) return { ok: false, reason: "Maestro is not installed (set ROVARA_MAESTRO or put maestro on the PATH)" };
  return { ok: true, maestro };
}

/** Skips the running test with its reason (a line on standard error, a GitHub warning annotation, the runner's own skip note); fails instead where the job requires iOS. Never returns. */
export function skipIosWithReason(skip: (note?: string) => never, reason: string, write: (text: string) => unknown = (text) => process.stderr.write(text), required: boolean = process.env["ROVARA_DEVICE_REQUIRE_IOS"] === "1"): never {
  if (required) throw new Error(`the iOS simulator test needs Xcode and Maestro and ROVARA_DEVICE_REQUIRE_IOS is set: ${reason}`);
  write(`::warning title=iOS simulator test SKIPPED::${reason}\n`);
  write(`SKIPPED (no simulator was run): ${reason}\n`);
  return skip(reason);
}
