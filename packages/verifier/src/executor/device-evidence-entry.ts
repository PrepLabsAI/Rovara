// Device testing slice 2 (DEC 244): the program that runs in the device executor container (environments/device-executor). The worker starts it beside the task sandbox (verifier/host/device-executor.ts:
// `--network container:<sandbox>`, `/dev/kvm`, the built apps read-only at /apps). It takes ONE argument, the plan, runs the device-evidence runner (slice 1) over the Android emulator driver and the
// real JPEG encoder, and prints ONE line: the runner's result, with the pictures as base64. It starts no listener, reads no file but the two apps, writes only under /tmp, has no secret and holds no
// credential, so there is nothing for the credential scan to look for. Anything wrong is one fixed sentence on standard error and exit code 2 (a plan) or 1 (a failed run); never a stack or a screen's words.
import { accessSync, constants, cpSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DeviceEvidenceCaptured } from "@agentx/contracts";
import { decodeDeviceExecutorPlan, DEVICE_EXECUTOR_APPS_DIR, encodeDeviceExecutorOutput, type DeviceExecutorPlan } from "../host/device-executor.js";
import { CAPTURE_SCREENSHOT_MAX_BYTES } from "./capture.js";
import { androidEmulatorArgs, createAndroidEmulatorDriver } from "./device-android.js";
import { runDeviceEvidence } from "./device-evidence.js";
import { encodeDeviceJpeg } from "./device-jpeg.js";
import { createNodeCommandPort, type DeviceCommandPort } from "./device-process.js";

/** Where the image keeps its tools (`environments/device-executor/Dockerfile`). */
export const DEVICE_TOOLS = Object.freeze({
  adb: "/opt/android-sdk/platform-tools/adb", emulator: "/opt/android-sdk/emulator/emulator", maestro: "/opt/maestro/bin/maestro", avd: "rovara",
});
/** The programs' environment: their own paths and a home directory in memory, nothing of the worker's (there is none) and nothing from outside. */
export const DEVICE_ENV = Object.freeze({
  PATH: "/opt/java/bin:/opt/android-sdk/platform-tools:/opt/maestro/bin:/usr/local/bin:/usr/bin:/bin", HOME: "/home/android", TMPDIR: "/tmp", LANG: "C.UTF-8", JAVA_HOME: "/opt/java",
  ANDROID_SDK_ROOT: "/opt/android-sdk", ANDROID_HOME: "/opt/android-sdk", ANDROID_AVD_HOME: "/tmp/rovara-avd", ANDROID_USER_HOME: "/home/android/.android",
});
export const DEVICE_SCRATCH_DIR = "/tmp/rovara-device";
/** The image's AVD (read-only, with the rest of the image) and the private copy the emulator is started from: the first real CI run showed the emulator refuses to start ("a snapshot operation ... is pending") when its AVD directory cannot be written. */
export const DEVICE_IMAGE_AVD_DIR = "/opt/android-avd";
export const DEVICE_AVD_HOME = "/tmp/rovara-avd";

/** Copies the image's AVD into memory (the container's own /tmp, gone with it) and points its .ini at the copy. Nothing in the image is ever written. */
export function prepareWritableAvd(name: string, from: string = DEVICE_IMAGE_AVD_DIR, to: string = DEVICE_AVD_HOME): void {
  mkdirSync(to, { recursive: true, mode: 0o700 });
  cpSync(`${from}/${name}.avd`, `${to}/${name}.avd`, { recursive: true });
  writeFileSync(`${to}/${name}.ini`, `avd.ini.encoding=UTF-8\npath=${to}/${name}.avd\ntarget=android-34\n`, { mode: 0o600 });
}

export type DevicePlanDeps = Readonly<{
  command: DeviceCommandPort;
  writeFile(path: string, text: string): Promise<void>;
  diag?: (stage: string, note: string, detail?: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}>;

/** One plan, run: the runner over the Android driver with the real encoder. Returns the runner's result (never throws on what the device does). */
export async function runDevicePlan(plan: DeviceExecutorPlan, deps: DevicePlanDeps): Promise<DeviceEvidenceCaptured> {
  const flows = plan.flows.map((flow) => ({ id: flow.id, steps: flow.steps.map((step) => ({ id: step.id, label: step.label, ...(step.actions === undefined ? {} : { actions: step.actions }) })) }));
  const driver = createAndroidEmulatorDriver({
    command: deps.command, appId: plan.appId, apps: { before: `${DEVICE_EXECUTOR_APPS_DIR}/before.apk`, after: `${DEVICE_EXECUTOR_APPS_DIR}/after.apk` }, flows, tools: DEVICE_TOOLS, scratchDir: DEVICE_SCRATCH_DIR,
    env: DEVICE_ENV, writeFile: deps.writeFile, ...(deps.diag === undefined ? {} : { diag: deps.diag }), ...(deps.now === undefined ? {} : { now: deps.now }), ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
  });
  return runDeviceEvidence({
    platform: "android", isolation: "sandbox", flows, notShown: plan.notShown, moreNotShown: plan.moreNotShown, maskIds: plan.maskIds, ...(plan.fixtureDataOnly === true ? { fixtureDataOnly: true } : {}),
    driver, encodeJpeg: (frame) => encodeDeviceJpeg(frame, CAPTURE_SCREENSHOT_MAX_BYTES), ...(deps.now === undefined ? {} : { now: deps.now }), limits: { runMs: plan.runMs, stepMs: plan.stepMs },
  });
}

/** For the CI test's log only: short emulator starts with one setting changed each (on throw-away copies of the AVD), to find what the emulator's free-space check depends on. Each says how it ended and its FATAL line, or the end of its output. */
export async function emulatorProbes(command: DeviceCommandPort, say: (line: string) => void, avdFrom: string = DEVICE_IMAGE_AVD_DIR): Promise<void> {
  const base = androidEmulatorArgs({ avd: DEVICE_TOOLS.avd, port: 5556, verbose: true });
  const swap = (args: string[], flag: string, value: string) => args.map((arg, index) => (args[index - 1] === flag ? value : arg));
  const probes: Array<[string, string[]]> = [["as-run", base], ["memory-1024", swap(base, "-memory", "1024")], ["partition-256", swap(base, "-partition-size", "256")]];
  const df = await command.run("/bin/df", ["-m", "/tmp"], { timeoutMs: 5_000, maxStdoutBytes: 2_048, env: DEVICE_ENV, mergeStderr: true });
  say(`df: ${Buffer.from(df.stdout).toString("utf8").replace(/\s+/gu, " ")}`);
  for (const [label, args] of probes) {
    const home = `/tmp/rovara-probe-${label}`;
    try {
      prepareWritableAvd(DEVICE_TOOLS.avd, avdFrom, home);
      const result = await command.run(DEVICE_TOOLS.emulator, args, { timeoutMs: 12_000, maxStdoutBytes: 4_000_000, env: { ...DEVICE_ENV, ANDROID_AVD_HOME: home }, mergeStderr: true });
      const text = Buffer.from(result.stdout).toString("utf8").replace(/\s+/gu, " ");
      const fatal = text.indexOf("FATAL");
      say(`${label}: exit ${String(result.exitCode)}${result.timedOut ? " (still running at the time limit)" : ""} | ${fatal >= 0 ? text.slice(fatal, fatal + 300) : text.slice(-300)}`);
    } catch (error) {
      say(`${label}: could not run (${String((error as NodeJS.ErrnoException).code ?? "error")})`);
    } finally {
      try { rmSync(home, { recursive: true, force: true }); } catch { /* the container is thrown away */ }
    }
  }
}

/** What the container looks like from inside, for the CI test's log only (printed on request, never part of the evidence): who this is, which groups, /dev/kvm's owner and mode, and which paths can be written. */
export function deviceEnvironmentReport(): string[] {
  const lines: string[] = [];
  const groups = (() => { try { return readFileSync("/proc/self/status", "utf8").split("\n").find((row) => row.startsWith("Groups:")) ?? "Groups: ?"; } catch { return "Groups: unreadable"; } })();
  lines.push(`uid ${String(process.getuid?.())} gid ${String(process.getgid?.())} ${groups.replace(/\s+/gu, " ")}`);
  try { const row = statSync("/dev/kvm"); lines.push(`/dev/kvm mode ${(row.mode & 0o7777).toString(8)} uid ${String(row.uid)} gid ${String(row.gid)} char-device ${String(row.isCharacterDevice())}`); } catch { lines.push("/dev/kvm cannot be seen"); }
  for (const [path, mode] of [["/dev/kvm", constants.R_OK | constants.W_OK], ["/opt/android-avd/rovara.avd/config.ini", constants.R_OK], [DEVICE_AVD_HOME, constants.W_OK], [`${DEVICE_AVD_HOME}/rovara.avd`, constants.W_OK],
    ["/opt/android-sdk/emulator/emulator", constants.X_OK], ["/home/android", constants.W_OK], ["/home/android/.android", constants.W_OK], ["/tmp", constants.W_OK], [DEVICE_SCRATCH_DIR, constants.W_OK]] as const) {
    try { accessSync(path, mode); lines.push(`${path}: ${mode === constants.W_OK ? "writable" : mode === constants.X_OK ? "executable" : "accessible"}`); } catch (error) { lines.push(`${path}: NOT accessible (${String((error as NodeJS.ErrnoException).code)})`); }
  }
  return lines;
}

async function main(): Promise<void> {
  const plan = decodeDeviceExecutorPlan(process.argv[2]);
  if (plan === undefined || process.argv.length !== 3) { process.stderr.write("device evidence plan is not valid\n"); process.exit(2); }
  const talk = process.env["ROVARA_DEVICE_DIAG"] === "1";
  // The whole program has its own limit past the run's, so a stuck tool can never hold the container.
  const timer = setTimeout(() => { process.stderr.write("device evidence run timed out\n"); process.exit(1); }, plan.runMs + 20_000);
  let code = 0;
  try {
    mkdirSync(DEVICE_SCRATCH_DIR, { recursive: true, mode: 0o700 });
    prepareWritableAvd(DEVICE_TOOLS.avd);
    if (talk) {
      for (const line of deviceEnvironmentReport()) process.stderr.write(`device env: ${line}\n`);
      const check = await createNodeCommandPort().run(DEVICE_TOOLS.emulator, ["-accel-check"], { timeoutMs: 20_000, maxStdoutBytes: 4_096, env: DEVICE_ENV, mergeStderr: true });
      process.stderr.write(`device env: emulator -accel-check exit ${String(check.exitCode)} | ${Buffer.from(check.stdout).toString("utf8").replace(/\s+/gu, " ").slice(0, 600)}\n`);
    }
    if (talk) await emulatorProbes(createNodeCommandPort(), (line) => { process.stderr.write(`device probe: ${line}\n`); });
    const captured = await runDevicePlan(plan, {
      command: createNodeCommandPort(), writeFile: (path, text) => { writeFileSync(path, text, { mode: 0o600 }); return Promise.resolve(); },
      ...(talk ? { diag: (stage: string, note: string, detail?: string) => { process.stderr.write(`device ${stage}: ${note}${detail === undefined ? "" : ` | ${detail.replace(/\s+/gu, " ")}`}\n`); } } : {}),
    });
    process.stdout.write(`${encodeDeviceExecutorOutput(captured)}\n`);
  } catch {
    process.stderr.write("device evidence run failed\n");
    code = 1;
  } finally {
    clearTimeout(timer);
  }
  process.exit(code);
}

// Runs only as the program itself, never when a test imports `runDevicePlan`.
const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && (() => { try { return realpathSync(process.argv[1]) === realpathSync(thisFile); } catch { return false; } })()) void main();
