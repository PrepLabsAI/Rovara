// Test support (device testing slice 4): a fake Mac behind the scripted command port. The iOS driver is tested against what the project's build, `xcrun simctl` and Maestro print, without starting any
// of them: `fakeIos` answers the exact commands the driver sends, keeps the simulators it was told to create, and records every command.
import { png } from "./device-png-encode.js";
import { answer, scriptedPort, type RecordedRun } from "./device-command-fake.js";
import type { DeviceCommandResult } from "../../packages/verifier/src/executor/device-process.js";

export const XCRUN = "/usr/bin/xcrun";
export const SHELL = "/bin/sh";
export const MAESTRO_IOS = "/opt/homebrew/bin/maestro";
export const UDID = "0F3A9B1C-7D2E-4A55-8C10-5E6F7A8B9C0D";
export const RUNTIMES = JSON.stringify({ runtimes: [
  { identifier: "com.apple.CoreSimulator.SimRuntime.iOS-17-5", name: "iOS 17.5", version: "17.5", platform: "iOS", isAvailable: true, supportedDeviceTypes: [{ name: "iPhone 15", identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-15" }] },
  { identifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-2", name: "iOS 18.2", version: "18.2", platform: "iOS", isAvailable: true, supportedDeviceTypes: [
    { name: "iPhone SE (3rd generation)", identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-SE-3rd-generation" }, { name: "iPhone 16 Pro", identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro" },
    { name: "iPhone 16", identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16" }, { name: "iPad Pro 11-inch", identifier: "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-11" }] },
  { identifier: "com.apple.CoreSimulator.SimRuntime.iOS-19-0", name: "iOS 19.0", version: "19.0", platform: "iOS", isAvailable: false, supportedDeviceTypes: [{ name: "iPhone 17", identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17" }] },
  { identifier: "com.apple.CoreSimulator.SimRuntime.watchOS-11-0", name: "watchOS 11.0", version: "11.0", platform: "watchOS", isAvailable: true, supportedDeviceTypes: [{ name: "Apple Watch", identifier: "x.watch" }] },
] });
/** The screenshot is 390 x 844 points at 3x. */
export const PIXELS = { width: 1170, height: 2532 };
export const hierarchy = (...children: unknown[]) => JSON.stringify({ attributes: { bounds: "[0,0][390,844]", type: "XCUIElementTypeApplication" }, children });
export const HIERARCHY = hierarchy({ attributes: { text: "Total: 12", bounds: "[10,100][200,140]" } }, { attributes: { password: "true", text: "••••", bounds: "[10,200][380,240]" } });

export type FakeIosScript = {
  build?: DeviceCommandResult;
  runtimes?: DeviceCommandResult;
  create?: DeviceCommandResult;
  bootstatus?: DeviceCommandResult;
  screenshot?: DeviceCommandResult | ((call: number) => DeviceCommandResult);
  /** The PNG the screenshot file holds (default: a grey one of `PIXELS`); a function is asked with the number of the screenshot (1 is the one `prepare` takes), and undefined means no file is written. */
  png?: Uint8Array | undefined | ((call: number) => Uint8Array | undefined);
  install?: DeviceCommandResult;
  maestro?: (flowText: string, args: readonly string[]) => DeviceCommandResult;
  hierarchy?: string | DeviceCommandResult;
  first?: (file: string, args: readonly string[]) => DeviceCommandResult | undefined;
};

export function fakeIos(script: FakeIosScript = {}) {
  const files = new Map<string, string | Uint8Array>();
  const removed: string[] = [];
  const simulators = new Set<string>();
  let defaultPng: Uint8Array | undefined;
  let shots = 0;
  const scripted = scriptedPort((file, args, options) => {
    const early = script.first?.(file, args);
    if (early !== undefined) return early;
    if (file === SHELL) return script.build ?? answer("", 0);
    if (file === MAESTRO_IOS) {
      if (args[2] === "hierarchy") return typeof script.hierarchy === "object" ? script.hierarchy : answer(script.hierarchy ?? HIERARCHY);
      return script.maestro?.(String(files.get(args.at(-1)!) ?? ""), args) ?? answer("Flow completed");
    }
    if (file === XCRUN && args[0] === "simctl") {
      const sub = args[1];
      if (sub === "list") return script.runtimes ?? answer(RUNTIMES);
      if (sub === "create") { const result = script.create ?? answer(`${UDID}\n`); if (result.exitCode === 0) simulators.add(new TextDecoder().decode(result.stdout).trim()); return result; }
      if (sub === "bootstatus") return script.bootstatus ?? answer("Device already booted, nothing to do.\n");
      if (sub === "io") {
        const out = args.at(-1)!;
        shots += 1;
        defaultPng ??= png(PIXELS.width, PIXELS.height, () => [230, 230, 230], { channels: 3 });
        const result = typeof script.screenshot === "function" ? script.screenshot(shots) : script.screenshot ?? answer(`Wrote screenshot to: ${out}\n`);
        // `png: undefined` in the script means the command succeeds but writes no file.
        const wrote = typeof script.png === "function" ? script.png(shots) : "png" in script ? script.png : defaultPng;
        if (result.exitCode === 0 && wrote !== undefined) files.set(out, wrote);
        return result;
      }
      if (sub === "install") return script.install ?? answer("");
      if (sub === "shutdown" || sub === "delete") { if (sub === "delete") simulators.delete(args[2]!); return answer(""); }
    }
    void options;
    return answer("");
  });
  return {
    ...scripted, files, removed, simulators,
    writeFile: (path: string, text: string) => { files.set(path, text); return Promise.resolve(); },
    readFile: (path: string) => { const value = files.get(path); return Promise.resolve(value instanceof Uint8Array ? value : undefined); },
    removeFile: (path: string) => { removed.push(path); files.delete(path); return Promise.resolve(); },
  };
}
export const simctlRuns = (runs: RecordedRun[]) => runs.filter((row) => row.file === XCRUN).map((row) => row.args.slice(1));
export const maestroRuns = (runs: RecordedRun[]) => runs.filter((row) => row.file === MAESTRO_IOS);
