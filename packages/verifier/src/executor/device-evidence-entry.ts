// Device testing slice 2 (DEC 244): the program that runs in the device executor container (environments/device-executor). The worker starts it beside the task sandbox (verifier/host/device-executor.ts:
// `--network container:<sandbox>`, `/dev/kvm`, the built apps read-only at /apps). It takes ONE argument, the plan, runs the device-evidence runner (slice 1) over the Android emulator driver and the
// real JPEG encoder, and prints ONE line: the runner's result, with the pictures as base64. It starts no listener, reads no file but the two apps, writes only under /tmp, has no secret and holds no
// credential, so there is nothing for the credential scan to look for. Anything wrong is one fixed sentence on standard error and exit code 2 (a plan) or 1 (a failed run); never a stack or a screen's words.
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DeviceEvidenceCaptured } from "@agentx/contracts";
import { decodeDeviceExecutorPlan, DEVICE_EXECUTOR_APPS_DIR, encodeDeviceExecutorOutput, type DeviceExecutorPlan } from "../host/device-executor.js";
import { CAPTURE_SCREENSHOT_MAX_BYTES } from "./capture.js";
import { createAndroidEmulatorDriver } from "./device-android.js";
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
  ANDROID_SDK_ROOT: "/opt/android-sdk", ANDROID_HOME: "/opt/android-sdk", ANDROID_AVD_HOME: "/opt/android-avd", ANDROID_USER_HOME: "/home/android/.android",
});
export const DEVICE_SCRATCH_DIR = "/tmp/rovara-device";

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

async function main(): Promise<void> {
  const plan = decodeDeviceExecutorPlan(process.argv[2]);
  if (plan === undefined || process.argv.length !== 3) { process.stderr.write("device evidence plan is not valid\n"); process.exit(2); }
  const talk = process.env["ROVARA_DEVICE_DIAG"] === "1";
  // The whole program has its own limit past the run's, so a stuck tool can never hold the container.
  const timer = setTimeout(() => { process.stderr.write("device evidence run timed out\n"); process.exit(1); }, plan.runMs + 20_000);
  let code = 0;
  try {
    mkdirSync(DEVICE_SCRATCH_DIR, { recursive: true, mode: 0o700 });
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
