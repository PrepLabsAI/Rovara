// Device testing slice 4 (DEC 244): the iOS simulator driver behind the `DeviceDriver` port, for a developer's Mac (Rovara Code). It runs ON THE MAC ITSELF, NOT IN A SANDBOX: a simulator is an ordinary
// macOS process and `xcodebuild` runs the project's own build scripts, so there is no sandboxed way to do either (plan 3.3). That is why nothing here runs unless the project opted in (contracts
// `deviceHostRunAllowed`, checked by verifier/executor/device-host.ts before this driver exists), why every pass says "not in a sandbox", and why this file is careful about the little it can control:
//   * the build runs with a SCRUBBED environment (device-host.ts `hostBuildEnv`: a fixed PATH and the account's home, no token, key or cloud credential of the caller's), in the side's own checkout;
//   * the built app must be a real `.app` folder INSIDE that checkout (a symlink out is refused);
//   * the simulator is one this run creates (a name of its own, a random suffix) and only that one is ever booted, used or deleted, so a developer's own simulators are never touched;
//   * every command is a file and arguments (no string to split, except the project's own build command, which is the project's by definition), with a time limit and an output limit.
// It builds the side's app, creates and boots a clean simulator (no accounts, fixture data only), installs the app, and per step runs the step's Maestro flow (device-maestro.ts: the same eight actions
// as Android) and reads the screen: the view tree from Maestro's `hierarchy` (contracts/device-evidence-ios.ts, points scaled to the screenshot's pixels) and the pixels from `simctl io screenshot`
// (device-png.ts). Masking, painting, caps and words are the runner's, not this file's. Fail closed everywhere; nothing a program prints is kept as words (failures are the runner's fixed reasons).
// UNVERIFIED on a real Mac in this lane (no Xcode there): the macOS CI job in tests/macos is the first real run.
import { DEVICE_EVIDENCE_BUNDLE_ID, DEVICE_EVIDENCE_FRAME_PIXELS_MAX, DEVICE_UNREADABLE_TREE, IOS_HIERARCHY_MAX_BYTES, iosHierarchyToTree, type DeviceEvidenceFlow } from "@agentx/contracts";
import type { DeviceDriver, DeviceEvidencePrepareAnswer, DeviceEvidenceSide, DeviceEvidenceStepAnswer, DeviceFrame } from "./device-evidence.js";
import { maestroLaunchFlow, maestroStepFlow } from "./device-maestro.js";
import { decodeDevicePng } from "./device-png.js";
import type { DeviceCommandPort, DeviceCommandResult } from "./device-process.js";

/** The longest the simulator may take to finish booting. */
export const IOS_BOOT_MS = 240_000;
const LIST_MS = 20_000;
const CREATE_MS = 30_000;
const INSTALL_MS = 120_000;
const SHOT_MS = 20_000;
const CLEANUP_MS = 20_000;
/** The name every simulator this run creates starts with, so a person (or a sweep) can tell them apart. */
export const IOS_SIMULATOR_PREFIX = "rovara-device-";
const UDID = /^[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/u;
const IDENTIFIER = /^[A-Za-z0-9._-]{1,200}$/u;
const plainPath = (value: unknown, max: number, suffix = ""): boolean => typeof value === "string" && value.length <= max && value.endsWith(suffix) && /^\/[A-Za-z0-9._/-]+$/u.test(value)
  && value.slice(1).split("/").every((part) => part !== "" && part !== "." && part !== "..");
const NO_HIDDEN = /^[^\p{Cc}\p{Cf}]*$/u;
const MAESTRO_ENV = Object.freeze({ MAESTRO_CLI_NO_ANALYTICS: "true", MAESTRO_DISABLE_UPDATE_CHECK: "true", MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: "true", MAESTRO_OPTS: "-Xmx768m" });

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const dotted = (version: string): number[] | undefined => (/^\d{1,3}(?:\.\d{1,3}){0,3}$/u.test(version) ? version.split(".").map(Number) : undefined);
function compare(a: number[], b: number[]): number {
  for (let at = 0; at < Math.max(a.length, b.length); at += 1) { const delta = (a[at] ?? 0) - (b[at] ?? 0); if (delta !== 0) return delta; }
  return 0;
}

/**
 * Which simulator to make, from `xcrun simctl list runtimes -j`: the newest AVAILABLE iOS runtime, and on it the newest numbered iPhone (`iPhone 16`; never a Pro, a Plus or an SE, whose size can
 * differ), else the first iPhone by name. Deterministic. Undefined when there is no available iOS runtime with an iPhone, or the list is not that shape (never a guess). Never throws.
 */
export function chooseIosSimulator(runtimes: unknown): { runtime: string; deviceType: string } | undefined {
  if (!isRecord(runtimes) || !Array.isArray(runtimes["runtimes"]) || runtimes["runtimes"].length > 200) return undefined;
  let best: { version: number[]; runtime: string; deviceType: string } | undefined;
  for (const row of runtimes["runtimes"] as unknown[]) {
    if (!isRecord(row) || row["isAvailable"] !== true || typeof row["identifier"] !== "string" || !IDENTIFIER.test(row["identifier"]) || typeof row["version"] !== "string") continue;
    if (row["platform"] !== "iOS" && !(typeof row["name"] === "string" && row["name"].startsWith("iOS"))) continue;
    const version = dotted(row["version"]);
    if (version === undefined || !Array.isArray(row["supportedDeviceTypes"]) || row["supportedDeviceTypes"].length > 500) continue;
    const phones = (row["supportedDeviceTypes"] as unknown[]).flatMap((type) => (isRecord(type) && typeof type["name"] === "string" && typeof type["identifier"] === "string" && IDENTIFIER.test(type["identifier"]) && /^iPhone/u.test(type["name"])
      ? [{ name: type["name"], id: type["identifier"] }] : []));
    if (phones.length === 0) continue;
    const numbered = phones.flatMap((phone) => { const match = /^iPhone (\d{1,2})$/u.exec(phone.name); return match === null ? [] : [{ phone, number: Number(match[1]) }]; }).sort((a, b) => b.number - a.number);
    const chosen = numbered[0]?.phone ?? [...phones].sort((a, b) => a.name.localeCompare(b.name))[0]!;
    if (best === undefined || compare(version, best.version) > 0) best = { version, runtime: row["identifier"], deviceType: chosen.id };
  }
  return best === undefined ? undefined : { runtime: best.runtime, deviceType: best.deviceType };
}

export type IosDriverOptions = Readonly<{
  command: DeviceCommandPort;
  /** The app's bundle identifier (the recipe's `appId`). */
  bundleId: string;
  /** The project's own build command (the recipe's, one plain line): it runs in each side's checkout with the scrubbed `buildEnv`. */
  buildCommand: string;
  /** The built app, relative to the checkout: a `.app` folder. */
  appFile: string;
  /** Each side's checkout: an absolute plain path (the base commit's, then the candidate's). */
  checkouts: Readonly<Record<DeviceEvidenceSide, string>>;
  flows: readonly DeviceEvidenceFlow[];
  tools: Readonly<{ shell: string; xcrun: string; maestro: string }>;
  /** A scratch directory this run owns (mode 0700): flow files and screenshots. */
  scratchDir: string;
  /** The environment of the project's build (`hostBuildEnv`) and of Apple's tools and Maestro (`hostToolEnv`): nothing else is passed on. */
  buildEnv: Readonly<Record<string, string>>;
  toolEnv: Readonly<Record<string, string>>;
  files: Readonly<{
    writeFile(path: string, text: string): Promise<void>;
    /** The file's bytes, or undefined when it is not there or cannot be read. */
    readFile(path: string): Promise<Uint8Array | undefined>;
    removeFile(path: string): Promise<void>;
    /** The absolute path of the built `.app` folder: a real directory INSIDE the checkout with every link resolved, or undefined. */
    builtApp(checkout: string, appFile: string): Promise<string | undefined>;
  }>;
  /** A random lower-case hex word for the simulator's name (default: from `crypto`). */
  randomHex?: () => string;
  now?: () => number;
  /** A stage name, a fixed note and, for a failure, the end of what the program printed: for the macOS CI test's log only, never kept and never in the evidence. */
  diag?: (stage: string, note: string, detail?: string) => void;
}>;

type SideState = { udid: string | undefined; ready: boolean; pixels: { width: number; height: number } | undefined; stopped: boolean };

/** The iOS simulator driver. Throws on options it was not built for (a bad bundle id, command, path or tool). */
export function createIosSimulatorDriver(options: IosDriverOptions): DeviceDriver {
  if (!DEVICE_EVIDENCE_BUNDLE_ID.test(options.bundleId) || typeof options.buildCommand !== "string" || options.buildCommand.length < 1 || options.buildCommand.length > 500 || !NO_HIDDEN.test(options.buildCommand)
    || typeof options.appFile !== "string" || !options.appFile.endsWith(".app") || options.appFile.startsWith("/") || options.appFile.length > 200
    || options.appFile.split("/").some((part) => part === "" || part === "." || part === "..") || !NO_HIDDEN.test(options.appFile)
    || !plainPath(options.checkouts.before, 300) || !plainPath(options.checkouts.after, 300) || options.checkouts.before === options.checkouts.after
    || !plainPath(options.scratchDir, 200) || [options.tools.shell, options.tools.xcrun, options.tools.maestro].some((tool) => !plainPath(tool, 100))) throw new Error("the iOS driver settings are not valid");
  const now = options.now ?? Date.now;
  const note = (stage: string, text: string, detail?: string) => { try { options.diag?.(stage, text, detail); } catch { /* a log that fails changes nothing */ } };
  const randomHex = options.randomHex ?? (() => globalThis.crypto.getRandomValues(new Uint8Array(6)).reduce((text, byte) => text + byte.toString(16).padStart(2, "0"), ""));
  const actionsOf = new Map<string, readonly unknown[]>();
  for (const flow of options.flows) for (const step of flow.steps) actionsOf.set(`${flow.id}/${step.id}`, step.actions ?? []);
  const state: Record<DeviceEvidenceSide, SideState> = {
    before: { udid: undefined, ready: false, pixels: undefined, stopped: false },
    after: { udid: undefined, ready: false, pixels: undefined, stopped: false },
  };
  let counter = 0;

  const text = (result: DeviceCommandResult) => Buffer.from(result.stdout).toString("utf8");
  const tail = (result: DeviceCommandResult) => text(result).slice(-600);
  const simctl = (args: readonly string[], timeoutMs: number, maxStdoutBytes = 64 * 1_024, mergeStderr = false): Promise<DeviceCommandResult> =>
    options.command.run(options.tools.xcrun, ["simctl", ...args], { timeoutMs: Math.max(1, timeoutMs), maxStdoutBytes, env: options.toolEnv, mergeStderr });

  /** Runs one Maestro flow file on this side's simulator; the step's answer. */
  async function maestro(udid: string, flow: string, timeoutMs: number): Promise<DeviceEvidenceStepAnswer> {
    counter += 1;
    const file = `${options.scratchDir}/flow-${String(counter)}.yaml`;
    try { await options.files.writeFile(file, flow); } catch { note("maestro", "flow file not written"); return "step_failed"; }
    const started = now();
    const result = await options.command.run(options.tools.maestro, ["--device", udid, "test", file],
      { timeoutMs: Math.max(1, timeoutMs), maxStdoutBytes: 1_048_576, mergeStderr: true, env: { ...options.toolEnv, ...MAESTRO_ENV, MAESTRO_DRIVER_STARTUP_TIMEOUT: String(Math.max(5_000, Math.min(120_000, timeoutMs))) } });
    note("maestro", `exit ${String(result.exitCode)} in ${String(now() - started)} ms${result.timedOut ? " (time limit)" : ""}`, result.exitCode === 0 ? undefined : tail(result));
    if (result.timedOut) return "time_limit";
    return result.exitCode === 0 ? "ok" : "step_failed";
  }

  /** One screenshot as a frame: written to a file of the scratch directory, read, decoded, and the file removed. */
  async function shot(udid: string, timeoutMs: number): Promise<DeviceFrame | undefined> {
    counter += 1;
    const file = `${options.scratchDir}/shot-${String(counter)}.png`;
    try {
      const taken = await simctl(["io", udid, "screenshot", "--type=png", file], Math.min(SHOT_MS, timeoutMs), 4_096, true);
      if (taken.exitCode !== 0 || taken.timedOut) { note("screen", `screenshot exit ${String(taken.exitCode)}`); return undefined; }
      const bytes = await options.files.readFile(file);
      return bytes === undefined ? undefined : decodeDevicePng(bytes, DEVICE_EVIDENCE_FRAME_PIXELS_MAX);
    } catch { return undefined; } finally { await options.files.removeFile(file).catch(() => undefined); }
  }

  return {
    kind: "ios_simulator",

    async prepare(side, { timeoutMs }): Promise<DeviceEvidencePrepareAnswer> {
      const mine = state[side];
      mine.stopped = false;
      const deadline = now() + timeoutMs;
      const left = () => deadline - now();
      const out = (): DeviceEvidencePrepareAnswer | undefined => (mine.stopped || left() <= 0 ? "time_limit" : undefined);

      // 1. The project's own build, in this side's checkout, with the scrubbed environment. Its output is not kept.
      const built = await options.command.run(options.tools.shell, ["-c", options.buildCommand],
        { timeoutMs: Math.max(1, left()), maxStdoutBytes: 1, env: options.buildEnv, cwd: options.checkouts[side], discardOutput: true });
      note("build", `exit ${String(built.exitCode)}${built.timedOut ? " (time limit)" : ""}`);
      if (built.timedOut) return "time_limit";
      if (built.exitCode !== 0) return "app_did_not_build";
      const afterBuild = out(); if (afterBuild !== undefined) return afterBuild;
      const app = await options.files.builtApp(options.checkouts[side], options.appFile);
      if (app === undefined || !plainPath(app, 400, ".app")) { note("build", "no app folder in the checkout"); return "app_did_not_build"; }

      // 2. Which simulator. A Mac with no Xcode has no `xcrun simctl`: that is "needs macOS", not a failed boot.
      const listed = await simctl(["list", "runtimes", "-j"], Math.min(LIST_MS, Math.max(1, left())), 1_048_576);
      if (listed.exitCode === null || listed.exitCode === 127) { note("setup", "simctl is not available"); return "needs_macos"; }
      let choice: ReturnType<typeof chooseIosSimulator>;
      try { choice = listed.exitCode === 0 && !listed.tooLarge ? chooseIosSimulator(JSON.parse(text(listed))) : undefined; } catch { choice = undefined; }
      if (choice === undefined) { note("setup", "no usable iOS runtime"); return "device_did_not_start"; }
      const afterList = out(); if (afterList !== undefined) return afterList;

      // 3. A simulator of this run's own: created clean (nothing signed in, no data), booted, and remembered so `stop` deletes exactly it.
      const created = await simctl(["create", `${IOS_SIMULATOR_PREFIX}${randomHex()}`, choice.deviceType, choice.runtime], Math.min(CREATE_MS, Math.max(1, left())));
      const udid = text(created).trim();
      if (created.exitCode !== 0 || !UDID.test(udid)) { note("setup", `create exit ${String(created.exitCode)}`); return left() <= 0 ? "time_limit" : "device_did_not_start"; }
      mine.udid = udid;
      const booted = await simctl(["bootstatus", udid, "-b"], Math.min(IOS_BOOT_MS, Math.max(1, left())));
      if (booted.exitCode !== 0 || booted.timedOut) { note("boot", `bootstatus exit ${String(booted.exitCode)}`); return left() <= 0 || booted.timedOut ? "time_limit" : "device_did_not_start"; }
      note("boot", "booted");
      const afterBoot = out(); if (afterBoot !== undefined) return afterBoot;

      // 4. The screen's size in pixels (the tree is scaled to it), then the app.
      const frame = await shot(udid, Math.max(1, left()));
      if (frame === undefined) { note("setup", "no first screenshot"); return left() <= 0 ? "time_limit" : "device_did_not_start"; }
      mine.pixels = { width: frame.width, height: frame.height };
      const installed = await simctl(["install", udid, app], Math.min(INSTALL_MS, Math.max(1, left())), 4_096, true);
      if (installed.exitCode !== 0) { note("install", `exit ${String(installed.exitCode)}`, tail(installed)); return left() <= 0 ? "time_limit" : "app_did_not_build"; }
      note("install", "installed");
      const afterInstall = out(); if (afterInstall !== undefined) return afterInstall;

      // 5. Maestro puts its own driver on the simulator the first time it runs: do it now, within the run's time, so a step's own limit is for the step.
      const warm = await maestro(udid, maestroLaunchFlow(options.bundleId, "ios"), Math.max(1, left()));
      if (warm !== "ok") return warm === "time_limit" || left() <= 0 ? "time_limit" : "device_did_not_start";
      mine.ready = true;
      return "ready";
    },

    startFlow(side, _flow, { timeoutMs }) {
      const mine = state[side];
      return mine.ready && !mine.stopped && mine.udid !== undefined ? maestro(mine.udid, maestroLaunchFlow(options.bundleId, "ios"), timeoutMs) : Promise.resolve("step_failed");
    },

    async performStep(side, flow, step, { timeoutMs }) {
      const mine = state[side];
      if (!mine.ready || mine.stopped || mine.udid === undefined) return "step_failed";
      const yaml = maestroStepFlow(options.bundleId, actionsOf.get(`${flow}/${step}`) ?? [], "ios");
      return yaml === null ? "ok" : maestro(mine.udid, yaml, timeoutMs);
    },

    async readTree(side, { timeoutMs }) {
      const mine = state[side];
      if (!mine.ready || mine.stopped || mine.udid === undefined || mine.pixels === undefined) return DEVICE_UNREADABLE_TREE;
      const result = await options.command.run(options.tools.maestro, ["--device", mine.udid, "hierarchy"],
        { timeoutMs: Math.max(1, timeoutMs), maxStdoutBytes: IOS_HIERARCHY_MAX_BYTES + 1_024, env: { ...options.toolEnv, ...MAESTRO_ENV }, mergeStderr: false });
      if (result.exitCode !== 0 || result.timedOut || result.tooLarge) { note("tree", `hierarchy exit ${String(result.exitCode)}`); return DEVICE_UNREADABLE_TREE; }
      return iosHierarchyToTree(Buffer.from(result.stdout).toString("utf8"), mine.pixels);
    },

    async screenshot(side, { timeoutMs }) {
      const mine = state[side];
      if (!mine.ready || mine.stopped || mine.udid === undefined) return undefined;
      return shot(mine.udid, timeoutMs);
    },

    async stop(side) {
      const mine = state[side];
      mine.stopped = true;
      mine.ready = false;
      const { udid } = mine;
      mine.udid = undefined;
      // Only the simulator this run created is shut down and deleted, and only when its id is what `simctl create` printed.
      if (udid === undefined || !UDID.test(udid)) return;
      await simctl(["shutdown", udid], CLEANUP_MS).catch(() => undefined);
      await simctl(["delete", udid], CLEANUP_MS).catch(() => undefined);
    },
  };
}
