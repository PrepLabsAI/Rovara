// Device testing slice 4: the laptop's door (verifier/executor/device-host.ts). Nothing runs unless BOTH the project's switch and the recipe's own opt-in are on, and that is checked before any process, folder
// or simulator exists; the project's build and the tools get an allow-listed environment (never a token, key or cloud credential of the caller's); the Android emulator on the host gets ports and an adb server
// of its own; the built app must be a real .app folder inside the checkout; and a run says where it ran and is never proof.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEVICE_HOST_RUN_ACK, deviceEvidenceCheck, deviceEvidenceLines, type DeviceEvidenceOutcome } from "../../packages/contracts/src/device-evidence.js";
import { createHostDeviceFiles, hostBuildEnv, hostToolEnv, pickAdbServerPort, pickEmulatorPort, runHostDeviceEvidence, type HostDeviceRunInput } from "../../packages/verifier/src/executor/device-host.js";
import { encodeDeviceJpeg } from "../../packages/verifier/src/executor/device-jpeg.js";
import { answer } from "../support/device-command-fake.js";
import { MAESTRO_IOS, SHELL, UDID, XCRUN, fakeIos, simctlRuns } from "../support/device-ios-fake.js";
import { fakeAndroid, ADB } from "../support/device-command-fake.js";

const ON = { status: "resolved", values: { device_evidence: { value: "on", origin: "changed_here" } } };
const OFF = { status: "resolved", values: { device_evidence: { value: "off", origin: "default" } } };
const recipe = (over: Record<string, unknown> = {}) => ({
  platform: "ios", buildCommand: "xcodebuild -scheme App", appFile: "build/App.app", appId: "io.rovara.fixture-app", outsideSandbox: DEVICE_HOST_RUN_ACK,
  flows: [{ id: "main", files: ["App/**"], steps: [{ id: "open", label: "Open" }] }], ...over,
});
const SECRETS = { AWS_SECRET_ACCESS_KEY: "aws-secret", AWS_SESSION_TOKEN: "aws-session", GITHUB_TOKEN: "gh-token", NPM_TOKEN: "npm-token", ANTHROPIC_API_KEY: "model-key", SSH_AUTH_SOCK: "/tmp/ssh.sock", DATABASE_URL: "postgres://u:p@h/db", ROVARA_SECRET: "x" };
const SOURCE = { PATH: "/usr/bin:/bin:/opt/homebrew/bin", HOME: "/Users/dev", USER: "dev", LANG: "en_US.UTF-8", DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer", JAVA_HOME: "/opt/jdk", ...SECRETS };

describe("hostBuildEnv and hostToolEnv", () => {
  it("copies only an allow-list of the caller's environment: never a token, key, secret, socket or cloud credential", () => {
    for (const env of [hostBuildEnv(SOURCE, "/tmp/run"), hostToolEnv(SOURCE, "/tmp/run")]) {
      expect(Object.keys(env).sort()).toEqual(["DEVELOPER_DIR", "HOME", "JAVA_HOME", "LANG", "PATH", "TMPDIR", "USER"]);
      expect(JSON.stringify(env)).not.toMatch(/secret|token|model-key|ssh|postgres|aws|gh-/iu);
    }
  });
  it("uses a scratch temporary directory, not the caller's", () => {
    expect(hostBuildEnv({ ...SOURCE, TMPDIR: "/var/folders/caller" }, "/tmp/run").TMPDIR).toBe("/tmp/run");
  });
  it("keeps the caller's PATH only when every entry is an absolute directory (a relative or empty entry would put the project's folder first)", () => {
    expect(hostBuildEnv({ PATH: "/a:/b/c" }, "/t").PATH).toBe("/a:/b/c");
    for (const path of ["", undefined, ".:/usr/bin", "/usr/bin::/bin", "bin:/usr/bin", "/usr/bin:/a/../b", "/usr/bin\n:/bin", `/${"a".repeat(2_001)}`]) expect(hostBuildEnv({ PATH: path }, "/t").PATH, String(path)).toBe("/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin");
  });
  it("drops an allow-listed variable whose value has a control or hidden character or is empty or very long", () => {
    const env = hostBuildEnv({ HOME: "/Users/a\nb", USER: "", LANG: "x".repeat(501), LC_ALL: "en\u202e", JAVA_HOME: "/ok" }, "/t");
    expect(Object.keys(env).sort()).toEqual(["JAVA_HOME", "PATH", "TMPDIR"]);
  });
  it("adds only named variables the caller asks for, with plain names and values", () => {
    const env = hostToolEnv({}, "/t", { ANDROID_ADB_SERVER_PORT: "15037", "bad name": "x", lower: "x", X: "x", ANDROID_HOME: "/sdk\n" });
    expect(env).toMatchObject({ ANDROID_ADB_SERVER_PORT: "15037" });
    expect(Object.keys(env).sort()).toEqual(["ANDROID_ADB_SERVER_PORT", "PATH", "TMPDIR"]);
  });
});

describe("pickEmulatorPort and pickAdbServerPort", () => {
  it("never take the default ports (a developer's own emulator and adb server live there), and take the first free ones", async () => {
    const asked: number[] = [];
    expect(await pickEmulatorPort((port) => { asked.push(port); return Promise.resolve(true); })).toBe(5556);
    expect(asked).toEqual([5556, 5557]);
    expect(await pickAdbServerPort(() => Promise.resolve(true))).toBe(15037);
  });
  it("needs both the console port and the adb port free, skips a pair with either taken, and gives up (undefined) when none is free", async () => {
    expect(await pickEmulatorPort((port) => Promise.resolve(port !== 5557 && port !== 5561))).toBe(5558);
    expect(await pickEmulatorPort(() => Promise.resolve(false))).toBeUndefined();
    expect(await pickAdbServerPort((port) => Promise.resolve(port > 15_040))).toBe(15_041);
    expect(await pickAdbServerPort(() => Promise.resolve(false))).toBeUndefined();
  });
});

describe("createHostDeviceFiles().builtApp", () => {
  const root = mkdtempSync(join(tmpdir(), "rovara-host-files-"));
  afterAll(() => { rmSync(root, { recursive: true, force: true }); });
  const checkout = join(root, "checkout");
  const outside = join(root, "outside");
  mkdirSync(join(checkout, "build/App.app"), { recursive: true });
  mkdirSync(join(outside, "Evil.app"), { recursive: true });
  writeFileSync(join(checkout, "build/NotADir.app"), "file");
  symlinkSync(join(outside, "Evil.app"), join(checkout, "build/Linked.app"));
  symlinkSync(outside, join(checkout, "linkdir"));
  symlinkSync(join(checkout, "build/App.app"), join(checkout, "build/Inside.app"));
  const files = createHostDeviceFiles();
  it("gives the real path of a .app folder inside the checkout", async () => {
    const real = await files.builtApp(checkout, "build/App.app");
    expect(real?.endsWith("/checkout/build/App.app")).toBe(true);
    expect((await files.builtApp(checkout, "build/Inside.app"))?.endsWith("/checkout/build/App.app")).toBe(true);
  });
  it("refuses a path that is a file, is missing, or leads out of the checkout through a link (to a folder or through a linked directory)", async () => {
    for (const rel of ["build/NotADir.app", "build/Missing.app", "build/Linked.app", "linkdir/Evil.app"]) expect(await files.builtApp(checkout, rel), rel).toBeUndefined();
    expect(await files.builtApp(join(root, "nothing"), "build/App.app")).toBeUndefined();
  });
  it("writes a flow file readable only by its owner, reads a file back, says undefined for one that is not there, and removes quietly", async () => {
    const path = join(root, "flow.yaml");
    await files.writeFile(path, "x: 1\n");
    expect(Buffer.from((await files.readFile(path))!).toString("utf8")).toBe("x: 1\n");
    expect(await files.readFile(join(root, "missing"))).toBeUndefined();
    await files.removeFile(path);
    await files.removeFile(path);
    expect(await files.readFile(path)).toBeUndefined();
  });
});

function iosInput(over: Partial<HostDeviceRunInput> = {}) {
  const fake = fakeIos({ maestro: () => answer("Flow completed") });
  const input: HostDeviceRunInput = {
    policy: ON, recipe: recipe(), changedFiles: ["App/Checkout.swift"], host: { platform: "darwin" }, checkouts: { before: "/work/base", after: "/work/head" }, ios: { maestro: MAESTRO_IOS },
    scratchDir: "/tmp/rovara-run", env: SOURCE, command: fake.port,
    files: { writeFile: fake.writeFile, readFile: fake.readFile, removeFile: fake.removeFile, builtApp: (checkout) => Promise.resolve(`${checkout}/build/App.app`) },
    canBind: () => Promise.resolve(true), encodeJpeg: (frame) => encodeDeviceJpeg(frame, 512 * 1_024), randomHex: () => "abc123", ...over,
  };
  return { fake, input };
}

describe("runHostDeviceEvidence: the two switches", () => {
  it("does nothing at all, and starts nothing, when the project's switch is off or missing or not exactly on", async () => {
    for (const policy of [OFF, undefined, null, {}, "on", { status: "refused", values: {} }, { status: "resolved", values: { device_evidence: { value: "ON" } } }]) {
      const { fake, input } = iosInput({ policy });
      expect(await runHostDeviceEvidence(input), JSON.stringify(policy)).toEqual({ status: "off" });
      expect(fake.runs).toHaveLength(0);
    }
  });
  it("says it is not switched on for this project, and starts nothing, when the recipe has no opt-in or not exactly the words", async () => {
    for (const outsideSandbox of [undefined, true, "yes", "Not in a sandbox", "not in a sandbox ", "not in a sandbox\n", "accepted"]) {
      const { fake, input } = iosInput({ recipe: recipe({ outsideSandbox }) });
      const got = await runHostDeviceEvidence(input);
      expect(got, String(outsideSandbox)).toMatchObject({ status: "captured", captured: { device: "ios_simulator", isolation: "developer_machine", notRun: "host_run_not_allowed", steps: [] } });
      expect(fake.runs, String(outsideSandbox)).toHaveLength(0);
    }
  });
  it("says there is no recipe (and names no platform) for a recipe that is not valid, and starts nothing", async () => {
    for (const bad of [undefined, null, {}, recipe({ flows: [] }), recipe({ buildCommand: "" }), recipe({ extra: 1 }), "x"]) {
      const { fake, input } = iosInput({ recipe: bad });
      expect(await runHostDeviceEvidence(input), JSON.stringify(bad)).toEqual({ status: "no_run", reason: "no_recipe" });
      expect(fake.runs).toHaveLength(0);
    }
  });
  it("does not let anything in the repository switch it on: the opt-in is only read from the recipe argument", async () => {
    const { fake, input } = iosInput({ recipe: recipe({ outsideSandbox: undefined }), env: { ...SOURCE, ROVARA_DEVICE_OUTSIDE_SANDBOX: DEVICE_HOST_RUN_ACK } });
    expect(await runHostDeviceEvidence(input)).toMatchObject({ captured: { notRun: "host_run_not_allowed" } });
    expect(fake.runs).toHaveLength(0);
  });
});

describe("runHostDeviceEvidence: before anything starts", () => {
  it("says no changed flow, or that the changed files could not be read, without starting anything", async () => {
    const none = iosInput({ changedFiles: ["README.md"] });
    expect(await runHostDeviceEvidence(none.input)).toMatchObject({ status: "captured", captured: { notRun: "no_changed_flow" } });
    const bad = iosInput({ changedFiles: "App/x" });
    expect(await runHostDeviceEvidence(bad.input)).toMatchObject({ captured: { notRun: "changes_unreadable" } });
    expect(none.fake.runs.length + bad.fake.runs.length).toBe(0);
  });
  it("says needs macOS for iOS anywhere but a Mac, and the emulator did not start for Android anywhere but a Mac, without starting anything", async () => {
    for (const platform of ["linux", "win32"]) {
      const ios = iosInput({ host: { platform } });
      expect(await runHostDeviceEvidence(ios.input)).toMatchObject({ captured: { device: "ios_simulator", notRun: "needs_macos" } });
      expect(ios.fake.runs).toHaveLength(0);
      const android = iosInput({ host: { platform }, recipe: recipe({ platform: "android", appFile: "app.apk", appId: "io.rovara.fixture" }) });
      expect(await runHostDeviceEvidence(android.input)).toMatchObject({ captured: { device: "android_emulator", notRun: "device_did_not_start" } });
      expect(android.fake.runs).toHaveLength(0);
    }
  });
  it("says the app did not build, without starting anything, when an iOS recipe's app file is not a .app folder", async () => {
    const { fake, input } = iosInput({ recipe: recipe({ appFile: "build/App.ipa" }) });
    expect(await runHostDeviceEvidence(input)).toMatchObject({ captured: { device: "ios_simulator", notRun: "app_did_not_build" } });
    expect(fake.runs).toHaveLength(0);
  });
  it("says no recipe when the recipe has no application id, and the device did not start when the driver's settings are missing or not valid", async () => {
    expect(await runHostDeviceEvidence(iosInput({ recipe: recipe({ appId: undefined }) }).input)).toMatchObject({ captured: { notRun: "no_recipe" } });
    expect(await runHostDeviceEvidence(iosInput({ ios: undefined } as unknown as Partial<HostDeviceRunInput>).input)).toMatchObject({ captured: { notRun: "device_did_not_start" } });
    expect(await runHostDeviceEvidence(iosInput({ checkouts: { before: "/work/a b", after: "/work/head" } }).input)).toMatchObject({ captured: { notRun: "device_did_not_start" } });
    expect(await runHostDeviceEvidence(iosInput({ scratchDir: "relative" }).input)).toMatchObject({ captured: { notRun: "device_did_not_start" } });
  });
});

describe("runHostDeviceEvidence: iOS on a Mac", () => {
  it("builds each side in its own checkout with the scrubbed environment, runs the flows on simulators of its own, and returns pictures that say they ran on a developer machine", async () => {
    const { fake, input } = iosInput();
    const got = await runHostDeviceEvidence(input);
    if (got.status !== "captured") throw new Error("captured");
    expect(got.captured).toMatchObject({ device: "ios_simulator", isolation: "developer_machine", unmasked: 0 });
    expect(got.captured.notRun).toBeUndefined();
    expect(got.captured.steps.map((row) => `${row.flow}/${row.step}:${row.status}`)).toEqual(["main/open:shown"]);
    const builds = fake.runs.filter((row) => row.file === SHELL);
    expect(builds.map((row) => row.options.cwd)).toEqual(["/work/base", "/work/head"]);
    for (const build of builds) {
      expect(Object.keys(build.options.env ?? {}).sort()).toEqual(["DEVELOPER_DIR", "HOME", "JAVA_HOME", "LANG", "PATH", "TMPDIR", "USER"]);
      expect(JSON.stringify(build.options.env)).not.toMatch(/secret|token|model-key|ssh|postgres|aws|gh-/iu);
    }
    // Every simulator it made is gone, and only those.
    expect(fake.simulators.size).toBe(0);
    expect(simctlRuns(fake.runs).filter((row) => row[0] === "create")).toHaveLength(2);
    expect(simctlRuns(fake.runs).filter((row) => row[0] === "delete")).toEqual([["delete", UDID], ["delete", UDID]]);
    for (const row of fake.runs.filter((r) => r.file === XCRUN || r.file === MAESTRO_IOS)) expect(JSON.stringify(row.options.env)).not.toMatch(/secret|token|model-key|ssh|postgres|aws|gh-/iu);
  });
  it("is visual evidence only, never proof, with the words that say not in a sandbox and that the network was this machine's", async () => {
    const { input } = iosInput();
    const got = await runHostDeviceEvidence(input);
    if (got.status !== "captured") throw new Error("captured");
    const outcome: DeviceEvidenceOutcome = { ...got.captured, steps: got.captured.steps.map((row) => (row.status === "shown"
      ? { ...row, before: { kind: "jpeg" as const, sha256: row.before.sha256, bytes: row.before.bytes.byteLength, retentionClass: "evidence-std" as const }, after: { kind: "jpeg" as const, sha256: row.after.sha256, bytes: row.after.bytes.byteLength, retentionClass: "evidence-std" as const } } : row)) };
    const check = deviceEvidenceCheck(outcome).check;
    expect(check).toMatchObject({ kind: "visual", runBy: "rovara", class: "not_rerun" });
    const lines = deviceEvidenceLines(outcome, {});
    expect(lines[0]).toBe("Device evidence: Ran on an iOS simulator on a developer machine, not in a sandbox. Visual evidence only: it does not count as change proof.");
    expect(lines).toContain("- Built and run on this machine, outside a sandbox, with this machine's own network.");
  });
  it("answers the build's failure as 'the app did not build' for the whole run", async () => {
    const { fake, input } = iosInput();
    const failing = fakeIos({ build: answer("", 1) });
    void fake;
    const got = await runHostDeviceEvidence({ ...input, command: failing.port });
    expect(got).toMatchObject({ captured: { notRun: "app_did_not_build", steps: [] } });
    expect(failing.simulators.size).toBe(0);
  });
});

describe("runHostDeviceEvidence: the Android emulator on a Mac", () => {
  const androidRecipe = recipe({ platform: "android", appFile: "app/build/app.apk", appId: "io.rovara.fixture" });
  function androidInput(over: Partial<HostDeviceRunInput> = {}) {
    const fake = fakeAndroid({ dump: `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><displays><display id="0"><window id="1"><hierarchy rotation="0"><node class="android.widget.TextView" text="Total" bounds="[0,100][720,300]" /></hierarchy></window></display></displays>`, screencap: () => answer(rawScreencap720()) });
    const input: HostDeviceRunInput = {
      policy: ON, recipe: androidRecipe, changedFiles: ["App/x.kt"], host: { platform: "darwin" }, checkouts: { before: "/work/base", after: "/work/head" },
      android: { apps: { before: "/work/base/app.apk", after: "/work/head/app.apk" }, sdkRoot: "/Users/dev/Library/Android/sdk", avd: "Pixel_8_API_35", maestro: "/opt/homebrew/bin/maestro" },
      scratchDir: "/tmp/rovara-run", env: SOURCE, command: fake.port, files: { writeFile: fake.writeFile, readFile: () => Promise.resolve(undefined), removeFile: () => Promise.resolve(), builtApp: () => Promise.resolve(undefined) },
      canBind: () => Promise.resolve(true), encodeJpeg: (frame) => encodeDeviceJpeg(frame, 512 * 1_024), ...over,
    };
    return { fake, input };
  }
  it("runs the slice 2 driver over the Mac's own SDK, on an emulator port and an adb server of its own, with the scrubbed environment", async () => {
    const { fake, input } = androidInput();
    const got = await runHostDeviceEvidence(input);
    expect(got).toMatchObject({ status: "captured", captured: { device: "android_emulator", isolation: "developer_machine" } });
    expect(fake.starts.length).toBe(4);
    const [adbServer, emulator] = fake.starts;
    expect(adbServer!.file).toBe("/Users/dev/Library/Android/sdk/platform-tools/adb");
    expect(adbServer!.args).toEqual(["server", "nodaemon"]);
    expect(emulator!.file).toBe("/Users/dev/Library/Android/sdk/emulator/emulator");
    expect(emulator!.args.slice(0, 4)).toEqual(["-avd", "Pixel_8_API_35", "-port", "5556"]);
    expect(emulator!.args).toContain("-read-only");
    for (const start of fake.starts) {
      expect(start.env).toMatchObject({ ANDROID_ADB_SERVER_PORT: "15037", ANDROID_SDK_ROOT: "/Users/dev/Library/Android/sdk", HOME: "/Users/dev" });
      expect(JSON.stringify(start.env)).not.toMatch(/secret|token|model-key|ssh|postgres|aws|gh-/iu);
    }
    for (const row of fake.runs.filter((r) => r.file === ADB)) expect(row.args.slice(0, 2)).toEqual(["-s", "emulator-5556"]);
    expect(fake.runs.some((row) => row.args.join(" ").includes("emulator-5554"))).toBe(false);
  });
  it("says the device did not start, and starts nothing, when no emulator port or no adb port is free, or the SDK path is not a plain path", async () => {
    for (const over of [{ canBind: () => Promise.resolve(false) }, { canBind: (port: number) => Promise.resolve(port >= 15_000) }, { canBind: (port: number) => Promise.resolve(port < 15_000) },
      { android: { apps: { before: "/a.apk", after: "/b.apk" }, sdkRoot: "/Users/a b/sdk", avd: "x", maestro: "/m" } }, { android: undefined }]) {
      const { fake, input } = androidInput(over as Partial<HostDeviceRunInput>);
      expect(await runHostDeviceEvidence(input)).toMatchObject({ captured: { device: "android_emulator", notRun: "device_did_not_start", steps: [] } });
      expect(fake.runs).toHaveLength(0);
      expect(fake.starts).toHaveLength(0);
    }
  });
  it("needs the opt-in too: the emulator on the host shares the Mac's network, so it is not started without it", async () => {
    const { fake, input } = androidInput({ recipe: { ...androidRecipe, outsideSandbox: undefined } });
    expect(await runHostDeviceEvidence(input)).toMatchObject({ captured: { notRun: "host_run_not_allowed" } });
    expect(fake.runs).toHaveLength(0);
    expect(fake.starts).toHaveLength(0);
  });
});

function rawScreencap720(): Uint8Array {
  const out = new Uint8Array(16 + 720 * 1280 * 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, 720, true); view.setUint32(4, 1280, true); view.setUint32(8, 1, true);
  out.fill(230, 16);
  return out;
}
