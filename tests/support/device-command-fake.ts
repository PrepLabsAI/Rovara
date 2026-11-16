// Test support (device testing slice 2): a scripted `DeviceCommandPort` and a fake Android device behind it. The Android driver is tested against what adb, the emulator and Maestro print,
// without starting any of them: `fakeAndroid` answers the exact commands the driver sends and records every one.
import type { DeviceBackground, DeviceCommandOptions, DeviceCommandPort, DeviceCommandResult } from "../../packages/verifier/src/executor/device-process.js";

export type RecordedRun = { file: string; args: string[]; options: DeviceCommandOptions };
export type RecordedStart = { file: string; args: string[]; env?: Readonly<Record<string, string>> | undefined; stops: number[]; running: boolean; capture?: boolean | undefined; printed?: string };

const bytes = (text: string | Uint8Array) => (typeof text === "string" ? new TextEncoder().encode(text) : text);
export const answer = (stdout: string | Uint8Array = "", exitCode: number | null = 0, extra: Partial<DeviceCommandResult> = {}): DeviceCommandResult => ({ exitCode, stdout: bytes(stdout), timedOut: false, tooLarge: false, ...extra });

/** A port whose `run` is a function of the command, and whose started programs can be ended by the test. */
export function scriptedPort(handler: (file: string, args: readonly string[], options: DeviceCommandOptions) => DeviceCommandResult | Promise<DeviceCommandResult>): { port: DeviceCommandPort; runs: RecordedRun[]; starts: RecordedStart[] } {
  const runs: RecordedRun[] = [];
  const starts: RecordedStart[] = [];
  const port: DeviceCommandPort = {
    async run(file, args, options) { runs.push({ file, args: [...args], options }); return handler(file, args, options); },
    start(file, args, options) {
      const row: RecordedStart = { file, args: [...args], env: options.env, capture: options.capture, stops: [], running: true };
      starts.push(row);
      const background: DeviceBackground = { running: () => row.running, ...(options.capture === true ? { tail: () => row.printed ?? "" } : {}), stop: (graceMs) => { row.stops.push(graceMs); row.running = false; return Promise.resolve(); } };
      return background;
    },
  };
  return { port, runs, starts };
}

export type FakeAndroidScript = {
  /** `sys.boot_completed` answers in turn; the last one repeats. Default: booted at once. */
  boot?: string[];
  wmSize?: string;
  settings?: number;
  install?: DeviceCommandResult;
  maestro?: (flowText: string, args: readonly string[]) => DeviceCommandResult;
  /** The UI dump, or a result for the dump command. */
  dump?: string | DeviceCommandResult;
  cat?: DeviceCommandResult;
  screencap?: DeviceCommandResult | ((call: number) => DeviceCommandResult);
  /** A handler asked first for every command; return undefined to fall through to the defaults. */
  first?: (file: string, args: readonly string[]) => DeviceCommandResult | undefined;
};
export const ADB = "/opt/android-sdk/platform-tools/adb";
export const EMULATOR = "/opt/android-sdk/emulator/emulator";
export const MAESTRO = "/opt/maestro/bin/maestro";

/** The tools' answers for one fake phone. `files` holds each flow file the driver wrote. */
export function fakeAndroid(script: FakeAndroidScript = {}): { port: DeviceCommandPort; runs: RecordedRun[]; starts: RecordedStart[]; files: Map<string, string>; writeFile: (path: string, text: string) => Promise<void> } {
  const files = new Map<string, string>();
  let polls = 0;
  let screens = 0;
  const scripted = scriptedPort((file, args) => {
    const early = script.first?.(file, args);
    if (early !== undefined) return early;
    if (file === MAESTRO) return script.maestro?.(files.get(args.at(-1)!) ?? "", args) ?? answer("Flow completed");
    const rest = args[0] === "-s" ? args.slice(2) : [...args];
    if (rest[0] === "shell" && rest[1] === "getprop") { const list = script.boot ?? ["1"]; const value = list[Math.min(polls, list.length - 1)]!; polls += 1; return answer(`${value}\n`); }
    if (rest[0] === "shell" && rest[1] === "wm") return answer(script.wmSize ?? "Physical size: 720x1280\n");
    if (rest[0] === "shell" && rest[1] === "uiautomator") return typeof script.dump === "object" ? script.dump : answer("UI hierchary dumped to: /data/local/tmp/rovara-ui.xml\n");
    if (rest[0] === "shell") return answer("", script.settings ?? 0);
    if (rest[0] === "exec-out" && rest[1] === "cat") return script.cat ?? answer(typeof script.dump === "string" ? script.dump : "");
    if (rest[0] === "exec-out" && rest[1] === "screencap") { screens += 1; return typeof script.screencap === "function" ? script.screencap(screens) : script.screencap ?? answer(new Uint8Array(0), 1); }
    if (rest[0] === "install") return script.install ?? answer("Performing Streamed Install\nSuccess\n");
    return answer("");
  });
  return { ...scripted, files, writeFile: (path, text) => { files.set(path, text); return Promise.resolve(); } };
}

/** What `screencap` writes (no `-p`): width, height and format as little-endian 32-bit numbers, a colour-space number on Android 10 and later, then RGBA pixels. */
export function rawScreencap(width: number, height: number, options: { header?: 12 | 16; format?: number; shade?: number; paint?: (x: number, y: number) => [number, number, number] } = {}): Uint8Array {
  const header = options.header ?? 16;
  const out = new Uint8Array(header + width * height * 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, width, true);
  view.setUint32(4, height, true);
  view.setUint32(8, options.format ?? 1, true);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) out.set([...(options.paint?.(x, y) ?? [options.shade ?? 230, options.shade ?? 230, options.shade ?? 230]), 255], header + (y * width + x) * 4);
  return out;
}
