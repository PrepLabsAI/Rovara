// Device testing slice 1 (DEC 244): a fake device. A scripted stand-in for the Android emulator and the iOS simulator, so the whole device-evidence path (flows, view-tree masking, painting,
// caps, words, the pack check) runs and is tested without a device. A FAKE DEVICE IS NEVER A REAL RUN: its kind is `fake`, every label made from it says so, and its check is `visual` like
// every device picture, so it never counts toward the change proof (contracts/device-evidence.ts). It touches no process, no file, no network and no Docker.
import type { DeviceDriver, DeviceEvidencePrepareAnswer, DeviceEvidenceSide, DeviceEvidenceStepAnswer, DeviceFrame } from "./device-evidence.js";

/** One scripted screen: its view tree (what a driver would read) and its pixels. `tree` may be anything, so a test can script a tree that is not valid. */
export type FakeDeviceScreen = { tree: unknown; frame: DeviceFrame };
export type FakeDeviceScript = {
  /** The screen after a step on a side. */
  screen(side: DeviceEvidenceSide, flow: string, step: string): FakeDeviceScreen;
  /** Answers other than the happy ones (all default to success). */
  prepare?(side: DeviceEvidenceSide): DeviceEvidencePrepareAnswer | Promise<DeviceEvidencePrepareAnswer>;
  startFlow?(side: DeviceEvidenceSide, flow: string): DeviceEvidenceStepAnswer | Promise<DeviceEvidenceStepAnswer>;
  performStep?(side: DeviceEvidenceSide, flow: string, step: string): DeviceEvidenceStepAnswer | Promise<DeviceEvidenceStepAnswer>;
};
export type FakeDeviceCall = { op: "prepare" | "startFlow" | "performStep" | "readTree" | "screenshot" | "stop"; side: DeviceEvidenceSide; flow?: string; step?: string; timeoutMs?: number };

/** The fake driver and the log of everything the runner asked of it. */
export function createFakeDevice(script: FakeDeviceScript): { driver: DeviceDriver; calls: FakeDeviceCall[] } {
  const calls: FakeDeviceCall[] = [];
  const at: { flow?: string; step?: string } = {};
  const current = (side: DeviceEvidenceSide) => script.screen(side, at.flow ?? "", at.step ?? "");
  const driver: DeviceDriver = {
    kind: "fake",
    async prepare(side, options) { calls.push({ op: "prepare", side, timeoutMs: options.timeoutMs }); return (await script.prepare?.(side)) ?? "ready"; },
    async startFlow(side, flow, options) { calls.push({ op: "startFlow", side, flow, timeoutMs: options.timeoutMs }); at.flow = flow; delete at.step; return (await script.startFlow?.(side, flow)) ?? "ok"; },
    async performStep(side, flow, step, options) { calls.push({ op: "performStep", side, flow, step, timeoutMs: options.timeoutMs }); at.flow = flow; at.step = step; return (await script.performStep?.(side, flow, step)) ?? "ok"; },
    async readTree(side, options) { calls.push({ op: "readTree", side, timeoutMs: options.timeoutMs }); return current(side).tree; },
    async screenshot(side, options) { calls.push({ op: "screenshot", side, timeoutMs: options.timeoutMs }); return current(side).frame; },
    async stop(side) { calls.push({ op: "stop", side }); },
  };
  return { driver, calls };
}

/** A plain frame: every pixel one colour. */
export function fakeFrame(width: number, height: number, shade = 200): DeviceFrame {
  const rgba = new Uint8Array(width * height * 4);
  for (let at = 0; at < rgba.length; at += 4) rgba.set([shade, shade, shade, 255], at);
  return { width, height, rgba };
}

/** The fake encoder: the JPEG start marker, the size, then the pixels as they are. Not a real JPEG; `decodeFakeJpeg` reads it back so a test can see exactly what was painted. */
export function encodeFakeJpeg(frame: DeviceFrame): Uint8Array {
  const out = new Uint8Array(12 + frame.rgba.byteLength);
  out.set([0xff, 0xd8, 0xff, 0xe0]);
  const view = new DataView(out.buffer);
  view.setUint32(4, frame.width);
  view.setUint32(8, frame.height);
  out.set(frame.rgba, 12);
  return out;
}
export function decodeFakeJpeg(bytes: Uint8Array): DeviceFrame {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(4), height: view.getUint32(8), rgba: bytes.slice(12) };
}
