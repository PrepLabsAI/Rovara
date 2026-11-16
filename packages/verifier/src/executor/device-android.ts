// Device testing slice 2 (DEC 244): the real Android driver behind the `DeviceDriver` port. It runs INSIDE the device executor container (environments/device-executor), which holds the Android emulator,
// adb and Maestro, has /dev/kvm and shares only the task sandbox's network (verifier/host/device-executor-container.ts). Per side (the base code, then the candidate) it starts a fresh emulator from the
// image's own read-only AVD (no snapshot, no accounts, nothing saved), turns the animations off, installs that side's app, and for each step runs the step's Maestro flow (device-maestro.ts) and reads
// the screen with adb: the view tree from Android's UI dump (contracts/device-evidence-android.ts) and the pixels from `screencap`. Masking, painting, caps and words are the runner's, not this file's.
// Fail closed: a dump that cannot be read is `DEVICE_UNREADABLE_TREE` (withheld), a screenshot that is not a whole RGBA frame is not a frame, and every program has a time limit and an output limit.
// Nothing a program prints is kept as words: failures are the runner's fixed reasons, and the optional `diag` lines (the CI test turns them on) name a stage and never the screen's own text.
import {
  DEVICE_EVIDENCE_APP_ID, DEVICE_EVIDENCE_FRAME_PIXELS_MAX, DEVICE_UNREADABLE_TREE, androidHierarchyToTree, ANDROID_HIERARCHY_MAX_BYTES, type DeviceEvidenceFlow,
} from "@agentx/contracts";
import type { DeviceDriver, DeviceEvidencePrepareAnswer, DeviceEvidenceSide, DeviceEvidenceStepAnswer, DeviceFrame } from "./device-evidence.js";
import { maestroLaunchFlow, maestroStepFlow } from "./device-maestro.js";
import type { DeviceBackground, DeviceCommandPort, DeviceCommandResult } from "./device-process.js";

/** The emulator's console port; its adb port is the next one, and adb names the device `emulator-<console port>`. */
export const ANDROID_EMULATOR_PORT = 5554;
/** The longest the emulator may take to finish booting (a cold start is 30 to 90 s; the run's own limit still applies on top). */
export const ANDROID_BOOT_MS = 240_000;
const POLL_MS = 1_500;
const ADB_MS = 15_000;
const INSTALL_MS = 120_000;
const STOP_GRACE_MS = 8_000;
const UI_DUMP_FILE = "/data/local/tmp/rovara-ui.xml";
/** Maestro's driver apps; they hold the device's one UI-automation connection while a flow runs, so they are stopped before the screen is read. */
const MAESTRO_PACKAGES = ["dev.mobile.maestro", "dev.mobile.maestro.test"];
/** An absolute path of plain characters with no empty, `.` or `..` segment. */
const plainPath = (value: unknown, max: number, suffix = ""): boolean => typeof value === "string" && value.length <= max && value.endsWith(suffix) && /^\/[A-Za-z0-9._/-]+$/u.test(value)
  && value.slice(1).split("/").every((part) => part !== "" && part !== "." && part !== "..");
const apkPath = (value: string) => plainPath(value, 200, ".apk");
const toolPath = (value: string) => plainPath(value, 100);
const NAME = /^[A-Za-z0-9_.-]{1,64}$/u;

/** The emulator's own arguments: headless, from the image's AVD without ever writing to it, no snapshot, no sound, no camera, no metrics, and KVM or nothing (`-accel on` stops it instead of falling back to a slow emulation). */
export function androidEmulatorArgs(options: { avd: string; port: number; verbose?: boolean }): string[] {
  if (!NAME.test(options.avd) || !Number.isInteger(options.port) || options.port < 5554 || options.port > 5584 || options.port % 2 !== 0) throw new Error("the emulator settings are not valid");
  return ["-avd", options.avd, "-port", String(options.port), "-read-only", "-no-snapshot", "-no-window", "-no-audio", "-no-boot-anim", "-no-metrics", "-gpu", "swiftshader_indirect", "-accel", "on",
    "-camera-back", "none", "-camera-front", "none", "-netdelay", "none", "-netspeed", "full", "-memory", "2048", "-cores", "2",
    // Only for the CI test's diagnostics (the entry program turns them on on request): what the emulator says while it starts.
    ...(options.verbose === true ? ["-verbose", "-debug-init"] : [])];
}

export type AndroidDriverOptions = Readonly<{
  command: DeviceCommandPort;
  /** The app's Android application id (the recipe's `appId`). */
  appId: string;
  /** The built app of each side: a path ending `.apk`. */
  apps: Readonly<Record<DeviceEvidenceSide, string>>;
  /** The picked flows: the driver reads each step's actions from them. */
  flows: readonly DeviceEvidenceFlow[];
  tools: Readonly<{ adb: string; emulator: string; maestro: string; avd: string }>;
  /** Where the flow files are written (a scratch directory the container can write). */
  scratchDir: string;
  /** The environment the programs get (their paths, their home directory): nothing else is passed on. */
  env: Readonly<Record<string, string>>;
  writeFile(path: string, text: string): Promise<void>;
  port?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** A stage name, a fixed note and, for a failure, the end of what the program printed: for the CI test's log only, never kept and never in the evidence (the entry program turns it on only on request). */
  diag?: (stage: string, note: string, detail?: string) => void;
}>;

const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });
const MAESTRO_ENV = Object.freeze({ MAESTRO_CLI_NO_ANALYTICS: "true", MAESTRO_DISABLE_UPDATE_CHECK: "true", MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: "true", MAESTRO_OPTS: "-Xmx768m" });

type SideState = { adbServer: DeviceBackground | undefined; emulator: DeviceBackground | undefined; ready: boolean; size: { width: number; height: number } | undefined; stopped: boolean };

/** The Android emulator driver. Throws on options it was not built for (a bad application id, path or tool name). */
export function createAndroidEmulatorDriver(options: AndroidDriverOptions): DeviceDriver {
  const port = options.port ?? ANDROID_EMULATOR_PORT;
  const serial = `emulator-${String(port)}`;
  if (!DEVICE_EVIDENCE_APP_ID.test(options.appId) || !apkPath(options.apps.before) || !apkPath(options.apps.after) || !toolPath(options.scratchDir)
    || !NAME.test(options.tools.avd) || [options.tools.adb, options.tools.emulator, options.tools.maestro].some((tool) => !toolPath(tool))) throw new Error("the Android driver settings are not valid");
  androidEmulatorArgs({ avd: options.tools.avd, port });
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? wait;
  const note = (stage: string, text: string, detail?: string) => { try { options.diag?.(stage, text, detail); } catch { /* a log that fails changes nothing */ } };
  const actionsOf = new Map<string, readonly unknown[]>();
  for (const flow of options.flows) for (const step of flow.steps) actionsOf.set(`${flow.id}/${step.id}`, step.actions ?? []);
  const state: Record<DeviceEvidenceSide, SideState> = {
    before: { adbServer: undefined, emulator: undefined, ready: false, size: undefined, stopped: false },
    after: { adbServer: undefined, emulator: undefined, ready: false, size: undefined, stopped: false },
  };
  let counter = 0;

  const adb = (args: readonly string[], timeoutMs: number, maxStdoutBytes = 64 * 1_024, mergeStderr = false): Promise<DeviceCommandResult> =>
    options.command.run(options.tools.adb, ["-s", serial, ...args], { timeoutMs: Math.max(1, timeoutMs), maxStdoutBytes, env: options.env, mergeStderr });
  const text = (result: DeviceCommandResult) => Buffer.from(result.stdout).toString("utf8");
  const tail = (result: DeviceCommandResult) => text(result).slice(-600);

  /** Runs one Maestro flow file on the emulator; the step's answer. */
  async function maestro(flow: string, timeoutMs: number): Promise<DeviceEvidenceStepAnswer> {
    counter += 1;
    const file = `${options.scratchDir}/flow-${String(counter)}.yaml`;
    try { await options.writeFile(file, flow); } catch { note("maestro", "flow file not written"); return "step_failed"; }
    const started = now();
    const result = await options.command.run(options.tools.maestro, ["--device", serial, "test", file],
      { timeoutMs: Math.max(1, timeoutMs), maxStdoutBytes: 1_048_576, mergeStderr: true, env: { ...options.env, ...MAESTRO_ENV, MAESTRO_DRIVER_STARTUP_TIMEOUT: String(Math.max(5_000, Math.min(120_000, timeoutMs))) } });
    note("maestro", `exit ${String(result.exitCode)} in ${String(now() - started)} ms${result.timedOut ? " (time limit)" : ""}`, result.exitCode === 0 ? undefined : tail(result));
    if (result.timedOut) return "time_limit";
    return result.exitCode === 0 ? "ok" : "step_failed";
  }

  return {
    kind: "android_emulator",

    async prepare(side, { timeoutMs }): Promise<DeviceEvidencePrepareAnswer> {
      const mine = state[side];
      mine.stopped = false;
      const deadline = now() + timeoutMs;
      const left = () => deadline - now();
      const out = (): DeviceEvidencePrepareAnswer | undefined => (mine.stopped || left() <= 0 ? "time_limit" : undefined);
      // adb's server runs in the foreground of its own group, so ending a client never ends it (a daemon forked by a client would die with that client's group).
      mine.adbServer = options.command.start(options.tools.adb, ["server", "nodaemon"], { env: options.env });
      mine.emulator = options.command.start(options.tools.emulator, androidEmulatorArgs({ avd: options.tools.avd, port, verbose: options.diag !== undefined }), { env: options.env, ...(options.diag === undefined ? {} : { capture: true }) });
      note("boot", "emulator started");
      const bootEnds = Math.min(deadline, now() + ANDROID_BOOT_MS);
      for (;;) {
        if (mine.stopped) return "time_limit";
        if (now() >= bootEnds) { note("boot", "no boot in time"); return left() <= 0 ? "time_limit" : "device_did_not_start"; }
        if (!mine.emulator.running()) {
          // The program's last words may still be in the pipe when it is reported gone: give them a moment (only when output was asked for).
          if (mine.emulator.tail !== undefined) await sleep(300);
          note("boot", "emulator exited", mine.emulator.how === undefined ? undefined : `${mine.emulator.how()} | ${mine.emulator.tail?.() ?? ""}`);
          return "device_did_not_start";
        }
        // adb's server could not take its port (something in the shared network namespace held it first): nothing it would say is believed.
        if (!mine.adbServer.running()) { note("boot", "adb server exited"); return "device_did_not_start"; }
        const booted = await adb(["shell", "getprop", "sys.boot_completed"], Math.min(ADB_MS, bootEnds - now()));
        if (booted.exitCode === 0 && text(booted).trim() === "1") break;
        await sleep(POLL_MS);
      }
      note("boot", "booted");
      const early = out(); if (early !== undefined) return early;
      // The screen: its size (the picture and the tree must agree), no animation (the screen settles, the UI dump can be read) and no screen-off.
      const wm = await adb(["shell", "wm", "size"], Math.min(ADB_MS, left()));
      const sizes = [...text(wm).matchAll(/(Physical|Override) size:\s*(\d{1,5})x(\d{1,5})/gu)];
      const chosen = sizes.find((row) => row[1] === "Override") ?? sizes[0];
      if (wm.exitCode !== 0 || chosen === undefined) { note("setup", "no screen size"); return "device_did_not_start"; }
      mine.size = { width: Number(chosen[2]), height: Number(chosen[3]) };
      for (const command of ["settings put global window_animation_scale 0; settings put global transition_animation_scale 0; settings put global animator_duration_scale 0", "svc power stayon true; input keyevent 82"]) {
        const done = await adb(["shell", command], Math.min(ADB_MS, Math.max(1, left())));
        if (done.exitCode !== 0) { note("setup", "a setting was refused"); return "device_did_not_start"; }
      }
      const afterSettings = out(); if (afterSettings !== undefined) return afterSettings;
      const installed = await adb(["install", "-r", options.apps[side]], Math.min(INSTALL_MS, left()), 4_096, true);
      if (installed.exitCode !== 0 || !/Success/u.test(text(installed))) { note("install", `exit ${String(installed.exitCode)}`, tail(installed)); return left() <= 0 ? "time_limit" : "app_did_not_build"; }
      note("install", "installed");
      const afterInstall = out(); if (afterInstall !== undefined) return afterInstall;
      // Maestro puts its own driver on the device the first time it runs: do it now, within the run's time, so a step's own limit is for the step.
      const warm = await maestro(maestroLaunchFlow(options.appId), left());
      if (warm !== "ok") return warm === "time_limit" || left() <= 0 ? "time_limit" : "device_did_not_start";
      mine.ready = true;
      return "ready";
    },

    startFlow(side, _flow, { timeoutMs }) {
      return state[side].ready && !state[side].stopped ? maestro(maestroLaunchFlow(options.appId), timeoutMs) : Promise.resolve("step_failed");
    },

    async performStep(side, flow, step, { timeoutMs }) {
      if (!state[side].ready || state[side].stopped) return "step_failed";
      const yaml = maestroStepFlow(options.appId, actionsOf.get(`${flow}/${step}`) ?? []);
      return yaml === null ? "ok" : maestro(yaml, timeoutMs);
    },

    async readTree(side, { timeoutMs }) {
      const mine = state[side];
      if (!mine.ready || mine.stopped || mine.size === undefined) return DEVICE_UNREADABLE_TREE;
      const deadline = now() + timeoutMs;
      const left = () => Math.max(1, deadline - now());
      await adb(["shell", `${MAESTRO_PACKAGES.map((name) => `am force-stop ${name}`).join("; ")}; rm -f ${UI_DUMP_FILE}`], Math.min(ADB_MS, left()));
      const dumped = await adb(["shell", "uiautomator", "dump", "--windows", UI_DUMP_FILE], Math.min(ADB_MS, left()));
      if (dumped.exitCode !== 0) { note("tree", `dump exit ${String(dumped.exitCode)}`); return DEVICE_UNREADABLE_TREE; }
      const read = await adb(["exec-out", "cat", UI_DUMP_FILE], Math.min(ADB_MS, left()), ANDROID_HIERARCHY_MAX_BYTES * 4 + 1_024);
      if (read.exitCode !== 0 || read.tooLarge || read.timedOut) { note("tree", "dump not read"); return DEVICE_UNREADABLE_TREE; }
      return androidHierarchyToTree(Buffer.from(read.stdout).toString("utf8"), mine.size);
    },

    async screenshot(side, { timeoutMs }) {
      const mine = state[side];
      if (!mine.ready || mine.stopped) return undefined;
      const result = await adb(["exec-out", "screencap"], timeoutMs, DEVICE_EVIDENCE_FRAME_PIXELS_MAX * 4 + 64);
      if (result.exitCode !== 0 || result.timedOut || result.tooLarge) { note("screen", `screencap exit ${String(result.exitCode)}`); return undefined; }
      return rawScreencapFrame(result.stdout);
    },

    async stop(side) {
      const mine = state[side];
      mine.stopped = true;
      mine.ready = false;
      const { emulator, adbServer } = mine;
      mine.emulator = undefined;
      mine.adbServer = undefined;
      if (emulator === undefined && adbServer === undefined) return;
      // Ask the emulator to end itself, then end its group, then adb's server: the next side starts from nothing.
      if (emulator !== undefined) {
        await adb(["emu", "kill"], 4_000).catch(() => undefined);
        await emulator.stop(STOP_GRACE_MS);
      }
      await adbServer?.stop(2_000);
    },
  };
}

/**
 * What `screencap` (without `-p`) writes: the width, height and pixel format as three 32-bit little-endian numbers (Android 10 and later add a colour-space number), then the pixels, RGBA, row by row.
 * Only a whole frame in RGBA_8888 (format 1) with exactly the bytes its size needs is a frame; anything else is undefined (the runner says "the screenshot could not be taken").
 */
export function rawScreencapFrame(bytes: Uint8Array): DeviceFrame | undefined {
  if (bytes.byteLength < 12) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(0, true);
  const height = view.getUint32(4, true);
  const format = view.getUint32(8, true);
  if (format !== 1 || width < 1 || height < 1 || width * height > DEVICE_EVIDENCE_FRAME_PIXELS_MAX) return undefined;
  const pixels = width * height * 4;
  const header = bytes.byteLength - pixels;
  if (header !== 12 && header !== 16) return undefined;
  return { width, height, rgba: bytes.slice(header) };
}
