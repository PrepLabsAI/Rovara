// Device testing slice 4 (DEC 244): the laptop's side. Rovara Code on a developer's Mac runs a project's mobile flows ON THAT MACHINE, not in a sandbox: an iOS simulator is an ordinary macOS process and
// `xcodebuild` runs the project's own build scripts (no sandboxed way exists), and the Android emulator on a Mac runs on the host (Docker on a Mac has no KVM), in its own VM but on the Mac's network.
// This file is the one door to both, and it is shut unless BOTH switches are on (contracts `deviceHostRunAllowed`): the project's `device_evidence` setting AND the recipe's own opt-in
// (`outsideSandbox`, exactly "not in a sandbox", written by the settings screen after it showed `DEVICE_HOST_RUN_WARNING`; never read from the repository). Checked here BEFORE any process, folder or
// simulator exists; an opt-in missing gives the fixed reason "running on this machine is not switched on for this project". After that it only chooses a driver (iOS: device-ios.ts; Android on the
// host: the slice 2 driver with the Mac's own SDK) and hands it to the runner, whose evidence says "developer machine" (and, for iOS, "not in a sandbox") and is visual only, never proof.
//   * `hostBuildEnv` / `hostToolEnv`: what the project's build and Apple's and Google's tools get as environment: a short allow-list (the caller's PATH, home, language), NEVER a token, key or cloud credential.
//   * `pickEmulatorPort` / `pickAdbServerPort`: the Android emulator on the host gets ports and an adb server of its own, so a developer's own running emulator or adb server is never addressed.
//   * `createHostDeviceFiles`: the real files port; the built app must be a real `.app` folder inside the checkout.
// Nothing here is wired to a task yet (slice 3 wires every driver); with the setting off (the default) nothing here does anything.
import { lstat, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import {
  checkedDeviceEvidenceCaptured, deviceEvidenceOn, deviceHostRunAllowed, pickChangedFlows, type DeviceEvidenceCaptured, type DeviceEvidenceDevice, type DeviceEvidenceNotRunReason, type DeviceEvidenceRecipe,
} from "@agentx/contracts";
import { createAndroidEmulatorDriver } from "./device-android.js";
import { runDeviceEvidence, type DeviceDriver, type DeviceEvidenceRunInput } from "./device-evidence.js";
import { createIosSimulatorDriver, type IosDriverOptions } from "./device-ios.js";
import type { DeviceCommandPort } from "./device-process.js";

// ---- the environment

const SAFE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin";
/** The only variables copied from the caller's own environment: who and where, the language, and where Xcode and the JDK are. Everything else (every token, key, secret, socket, cloud profile) is left behind. */
const COPIED = ["HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "DEVELOPER_DIR", "JAVA_HOME"] as const;
const PLAIN_VALUE = /^[^\p{Cc}\p{Cf}]{1,500}$/u;
/** The caller's PATH when every entry is an absolute directory (no empty or relative entry, which would put the project's own folder first), else the fixed one. */
function pathOf(source: Readonly<Record<string, string | undefined>>): string {
  const value = source["PATH"];
  if (typeof value !== "string" || value.length === 0 || value.length > 2_000 || !PLAIN_VALUE.test(value)) return SAFE_PATH;
  return value.split(":").every((entry) => entry.startsWith("/") && !entry.split("/").includes("..")) ? value : SAFE_PATH;
}
/** The environment of the project's own build on the host: the allow-list above, a PATH, and a scratch temporary directory. Pure. */
export function hostBuildEnv(source: Readonly<Record<string, string | undefined>>, tmpDir: string): Record<string, string> {
  const env: Record<string, string> = { PATH: pathOf(source), TMPDIR: tmpDir };
  for (const key of COPIED) { const value = source[key]; if (typeof value === "string" && PLAIN_VALUE.test(value)) env[key] = value; }
  return env;
}
/** The environment of Apple's tools, adb, the emulator and Maestro: the same allow-list (they need no secret), plus the variables a caller adds for its own paths. */
export function hostToolEnv(source: Readonly<Record<string, string | undefined>>, tmpDir: string, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const env = hostBuildEnv(source, tmpDir);
  for (const [key, value] of Object.entries(extra)) if (/^[A-Z][A-Z0-9_]{1,40}$/u.test(key) && PLAIN_VALUE.test(value)) env[key] = value;
  return env;
}

// ---- ports for the Android emulator on the host

/** The first even console port of 5556 to 5584 (never the default 5554, where a developer's own emulator runs) with it and the next port free, or undefined. */
export async function pickEmulatorPort(canBind: (port: number) => Promise<boolean>): Promise<number | undefined> {
  for (let port = 5556; port <= 5584; port += 2) if (await canBind(port) && await canBind(port + 1)) return port;
  return undefined;
}
/** The first free port of 15037 to 15137 for the run's own adb server (never 5037, the developer's own). */
export async function pickAdbServerPort(canBind: (port: number) => Promise<boolean>): Promise<number | undefined> {
  for (let port = 15_037; port <= 15_137; port += 1) if (await canBind(port)) return port;
  return undefined;
}

// ---- the real files port

/** The files the iOS driver needs, over `node:fs`: the built app must be a real directory INSIDE the checkout once every link is resolved. */
export function createHostDeviceFiles(): IosDriverOptions["files"] {
  return {
    writeFile: (path, text) => writeFile(path, text, { mode: 0o600 }),
    readFile: async (path) => { try { return new Uint8Array(await readFile(path)); } catch { return undefined; } },
    removeFile: (path) => rm(path, { force: true }),
    async builtApp(checkout, appFile) {
      try {
        const root = await realpath(checkout);
        const app = await realpath(join(root, appFile));
        return app.startsWith(`${root}${sep}`) && (await lstat(app)).isDirectory() ? app : undefined;
      } catch { return undefined; }
    },
  };
}

// ---- the run

/** The name every Android virtual device Rovara may start on a host begins with; the developer makes one, clean and with no account, for this. */
export const HOST_AVD_PREFIX = "rovara-device-";
export type HostProbe = Readonly<{ platform: string }>;
export type HostAndroidConfig = Readonly<{
  /** The two built apps (`.apk`): the build is not this file's (slice 3 builds them in the task sandbox). */
  apps: Readonly<{ before: string; after: string }>;
  /** The Android SDK (platform-tools and emulator are under it), the name of the Android virtual device to start and Maestro's program. */
  sdkRoot: string;
  avd: string;
  maestro: string;
}>;
export type HostIosConfig = Readonly<{ maestro: string; xcrun?: string }>;
export type HostDeviceRunInput = Readonly<{
  /** The resolved policy (the project's `device_evidence` switch) and the recipe (Rovara's settings, never the repository). Both unknown: checked here. */
  policy: unknown;
  recipe: unknown;
  changedFiles: unknown;
  host: HostProbe;
  /** Each side's checkout (the base commit's and the candidate's): absolute plain paths. */
  checkouts: Readonly<{ before: string; after: string }>;
  android?: HostAndroidConfig;
  ios?: HostIosConfig;
  /** A scratch directory this run owns (mode 0700). */
  scratchDir: string;
  /** The caller's own environment: only the allow-list of `hostBuildEnv` is read from it. */
  env: Readonly<Record<string, string | undefined>>;
  command: DeviceCommandPort;
  files: IosDriverOptions["files"];
  canBind: (port: number) => Promise<boolean>;
  encodeJpeg: DeviceEvidenceRunInput["encodeJpeg"];
  paint?: DeviceEvidenceRunInput["paint"];
  redactor?: DeviceEvidenceRunInput["redactor"];
  now?: () => number;
  limits?: DeviceEvidenceRunInput["limits"];
  randomHex?: () => string;
  diag?: (stage: string, note: string, detail?: string) => void;
}>;
/** `off`: the project's switch is off (nothing ran, nothing to show). `no_run`: no usable recipe (no platform to name). `captured`: the run's result, which may itself be "not run" with its fixed reason. */
export type HostDeviceResult = { status: "off" } | { status: "no_run"; reason: "no_recipe" } | { status: "captured"; captured: DeviceEvidenceCaptured };

const DEVICE_OF = { android: "android_emulator", ios: "ios_simulator" } as const satisfies Record<DeviceEvidenceRecipe["platform"], DeviceEvidenceDevice>;
function notRun(platform: DeviceEvidenceRecipe["platform"], reason: DeviceEvidenceNotRunReason): HostDeviceResult {
  return { status: "captured", captured: checkedDeviceEvidenceCaptured({ device: DEVICE_OF[platform], isolation: "developer_machine", durationMs: 0, steps: [], notShown: [], moreNotShown: 0, unmasked: 0, notRun: reason }) };
}

/**
 * Runs a project's changed mobile flows on this machine, outside a sandbox, when (and only when) the project opted in. In this order, each before anything is started: the project's switch (off: `off`),
 * the recipe and the recipe's own opt-in (missing: "not switched on for this project"), the changed flows, the machine (a Mac: iOS elsewhere is "needs macOS"; the host Android emulator elsewhere
 * is "did not start"), the settings for the driver. Then the runner, with the iOS simulator driver or the Android emulator driver over the Mac's own SDK on ports and an adb server of its own.
 * The pictures are visual evidence only and say where they ran. Never throws on what the machine or the project does.
 */
export async function runHostDeviceEvidence(input: HostDeviceRunInput): Promise<HostDeviceResult> {
  if (!deviceEvidenceOn(input.policy)) return { status: "off" };
  const allowed = deviceHostRunAllowed({ policy: input.policy, recipe: input.recipe });
  if (!allowed.allowed) {
    const raw = typeof input.recipe === "object" && input.recipe !== null ? (input.recipe as Record<string, unknown>)["platform"] : undefined;
    return allowed.reason === "host_run_not_allowed" && (raw === "android" || raw === "ios") ? notRun(raw, allowed.reason) : { status: "no_run", reason: "no_recipe" };
  }
  const { recipe } = allowed;
  const platform = recipe.platform;
  const picked = pickChangedFlows({ changedFiles: input.changedFiles, recipe });
  if (picked.status === "not_run") return notRun(platform, picked.reason);
  if (input.host.platform !== "darwin") return notRun(platform, platform === "ios" ? "needs_macos" : "device_did_not_start");
  if (recipe.appId === undefined) return notRun(platform, "no_recipe");
  // An iOS build's product is a `.app` folder; any other file cannot be installed on a simulator.
  if (platform === "ios" && !recipe.appFile.endsWith(".app")) return notRun(platform, "app_did_not_build");

  let driver: DeviceDriver;
  try {
    const toolEnv = hostToolEnv(input.env, input.scratchDir);
    if (platform === "ios") {
      if (input.ios === undefined) return notRun(platform, "device_did_not_start");
      driver = createIosSimulatorDriver({
        command: input.command, bundleId: recipe.appId, buildCommand: recipe.buildCommand, appFile: recipe.appFile, checkouts: input.checkouts, flows: picked.flows,
        tools: { shell: "/bin/sh", xcrun: input.ios.xcrun ?? "/usr/bin/xcrun", maestro: input.ios.maestro }, scratchDir: input.scratchDir,
        buildEnv: hostBuildEnv(input.env, input.scratchDir), toolEnv, files: input.files, ...(input.randomHex === undefined ? {} : { randomHex: input.randomHex }),
        ...(input.now === undefined ? {} : { now: input.now }), ...(input.diag === undefined ? {} : { diag: input.diag }),
      });
    } else {
      if (input.android === undefined) return notRun(platform, "device_did_not_start");
      const [emulatorPort, adbPort] = [await pickEmulatorPort(input.canBind), await pickAdbServerPort(input.canBind)];
      if (emulatorPort === undefined || adbPort === undefined) return notRun(platform, "device_did_not_start");
      // Only a virtual device made for Rovara (its name starts `rovara-device-`) is started: never the developer's own, which may hold their accounts and data.
      if (!input.android.avd.startsWith(HOST_AVD_PREFIX)) return notRun(platform, "device_did_not_start");
      const sdk = input.android.sdkRoot;
      driver = createAndroidEmulatorDriver({
        command: input.command, appId: recipe.appId, apps: input.android.apps, flows: picked.flows, scratchDir: input.scratchDir, port: emulatorPort,
        tools: { adb: `${sdk}/platform-tools/adb`, emulator: `${sdk}/emulator/emulator`, maestro: input.android.maestro, avd: input.android.avd },
        env: hostToolEnv(input.env, input.scratchDir, { ANDROID_SDK_ROOT: sdk, ANDROID_HOME: sdk, ANDROID_ADB_SERVER_PORT: String(adbPort) }),
        writeFile: (path, text) => input.files.writeFile(path, text), ...(input.now === undefined ? {} : { now: input.now }), ...(input.diag === undefined ? {} : { diag: input.diag }),
      });
    }
  } catch {
    // Settings the driver was not built for (a path with a space, a bad name): a fixed reason, never the settings themselves.
    return notRun(platform, "device_did_not_start");
  }
  const captured = await runDeviceEvidence({
    platform, isolation: "developer_machine", flows: picked.flows, notShown: picked.notShown, moreNotShown: picked.moreNotShown, maskIds: recipe.maskIds ?? [],
    ...(recipe.fixtureDataOnly === true ? { fixtureDataOnly: true } : {}), driver, encodeJpeg: input.encodeJpeg,
    ...(input.paint === undefined ? {} : { paint: input.paint }), ...(input.redactor === undefined ? {} : { redactor: input.redactor }),
    ...(input.now === undefined ? {} : { now: input.now }), ...(input.limits === undefined ? {} : { limits: input.limits }),
  });
  return { status: "captured", captured };
}
