// Test support (device testing slice 2): what the Linux emulator test needs to say clearly when it cannot run. A test that needs KVM and has none is SKIPPED with the reason, on the log and as a
// warning annotation in the CI run, never passed without having run.
import { accessSync, constants, statSync } from "node:fs";
import { checkKvm, type KvmProbe, type KvmStatus } from "../../packages/verifier/src/host/device-executor.js";

/** This machine's /dev/kvm as `checkKvm` reads it. */
export function kvmHere(overrides: Partial<KvmProbe> = {}): KvmStatus {
  return checkKvm({
    platform: process.platform, arch: process.arch,
    stat: (path) => { try { const row = statSync(path); return { isCharacterDevice: row.isCharacterDevice(), gid: row.gid, mode: row.mode }; } catch { return undefined; } },
    canReadWrite: (path) => { try { accessSync(path, constants.R_OK | constants.W_OK); return true; } catch { return false; } },
    ...overrides,
  });
}

/** Skips the running test with its reason: a line on standard error, a GitHub warning annotation, and the test runner's own skip note (which makes the test show as skipped, not passed). Never returns. */
export function skipWithReason(skip: (note?: string) => never, reason: string, write: (text: string) => unknown = (text) => process.stderr.write(text), required: boolean = process.env["ROVARA_DEVICE_REQUIRE_KVM"] === "1"): never {
  // Where the emulator test must run (a job that sets ROVARA_DEVICE_REQUIRE_KVM=1), a machine without KVM fails it instead of skipping.
  if (required) throw new Error(`the emulator test needs KVM and ROVARA_DEVICE_REQUIRE_KVM is set: ${reason}`);
  write(`::warning title=Device emulator test SKIPPED::${reason}\n`);
  write(`SKIPPED (no emulator was run): ${reason}\n`);
  return skip(reason);
}
