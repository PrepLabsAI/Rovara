// Device testing slice 4: the macOS test's own "can this machine run it" check. A test that needs the simulator and has none says so with a fixed reason (and is skipped, or fails where the job requires it).
import { describe, expect, it } from "vitest";
import { iosHere, skipIosWithReason } from "../support/device-ios-host.js";
import { RUNTIMES } from "../support/device-ios-fake.js";

const ok = (stdout: string) => ({ status: 0, stdout });
describe("iosHere", () => {
  it("is ok on a Mac with an iOS runtime and Maestro, taking ROVARA_MAESTRO over the PATH", () => {
    const run = (file: string) => (file.endsWith("xcrun") ? ok(RUNTIMES) : ok("/opt/homebrew/bin/maestro\n"));
    expect(iosHere(run, "darwin", {})).toEqual({ ok: true, maestro: "/opt/homebrew/bin/maestro" });
    expect(iosHere(run, "darwin", { ROVARA_MAESTRO: "/x/maestro" })).toEqual({ ok: true, maestro: "/x/maestro" });
  });
  it("gives a fixed reason for each thing that is missing", () => {
    const run = (xcrun: { status: number | null; stdout: string }, which = ok("/m\n")) => (file: string) => (file.endsWith("xcrun") ? xcrun : which);
    expect(iosHere(run(ok(RUNTIMES)), "linux", {})).toEqual({ ok: false, reason: "this machine is not macOS, so there is no iOS simulator" });
    expect(iosHere(run({ status: 1, stdout: "" }), "darwin", {})).toMatchObject({ ok: false, reason: expect.stringContaining("no Xcode") as string });
    expect(iosHere(run(ok("{}")), "darwin", {})).toEqual({ ok: false, reason: "no available iOS runtime with an iPhone" });
    expect(iosHere(run(ok("nope")), "darwin", {})).toEqual({ ok: false, reason: "`xcrun simctl list runtimes` did not print JSON" });
    expect(iosHere(run(ok(RUNTIMES), ok("")), "darwin", {})).toMatchObject({ ok: false, reason: expect.stringContaining("Maestro is not installed") as string });
  });
});
describe("skipIosWithReason", () => {
  it("writes the reason as a warning annotation and a log line, then skips", () => {
    const wrote: string[] = [];
    const skipped: unknown[] = [];
    skipIosWithReason((note) => { skipped.push(note); return undefined as never; }, "no Xcode", (text) => wrote.push(text), false);
    expect(wrote.join("")).toContain("::warning title=iOS simulator test SKIPPED::no Xcode");
    expect(skipped).toEqual(["no Xcode"]);
  });
  it("fails instead of skipping where the job requires the simulator", () => {
    const skipped: unknown[] = [];
    expect(() => skipIosWithReason((note) => { skipped.push(note); return undefined as never; }, "no Xcode", () => undefined, true)).toThrow("ROVARA_DEVICE_REQUIRE_IOS is set: no Xcode");
    expect(skipped).toEqual([]);
  });
});
