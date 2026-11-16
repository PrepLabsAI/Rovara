// Device testing slice 1: the device-evidence runner over a fake device. Before (the base code) and after (the candidate) for each picked flow, one masked picture per named step, inside one time
// limit and one byte budget, with the pack's JPEG cap, the credential scan, the view-tree mask, and the device always stopped. A step that cannot be shown is "Not run" with a fixed reason.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DEVICE_EVIDENCE_SCREENSHOT_MAX_BYTES, DEVICE_EVIDENCE_TOTAL_MAX_BYTES, DEVICE_EVIDENCE_FRAME_PIXELS_MAX } from "../../packages/contracts/src/device-evidence.js";
import {
  DEVICE_EVIDENCE_STOP_MS, deviceRectsPainted, paintDeviceRects, runDeviceEvidence, type DeviceDriver, type DeviceEvidenceRunInput, type DeviceEvidenceSide, type DeviceFrame,
} from "../../packages/verifier/src/executor/device-evidence.js";
import { createFakeDevice, decodeFakeJpeg, encodeFakeJpeg, fakeFrame, type FakeDeviceScreen, type FakeDeviceScript } from "../../packages/verifier/src/executor/device-evidence-fake.js";

const W = 60;
const H = 100;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const node = (over: Record<string, unknown>) => ({ bounds: { x: 0, y: 0, width: W, height: 10 }, ...over });
const SECURE = { x: 10, y: 20, width: 40, height: 10 };
/** A screen with a visible title and a secure field (always painted); `extra` nodes follow. */
const screenOf = (side: DeviceEvidenceSide, flow: string, step: string, extra: unknown[] = []): FakeDeviceScreen => ({
  tree: { width: W, height: H, nodes: [node({ text: `Screen ${flow} ${step}` }), node({ text: "••••", secure: true, bounds: SECURE }), ...extra] },
  frame: fakeFrame(W, H, side === "before" ? 100 : 150),
});
const flows = [{ id: "checkout", steps: [{ id: "open", label: "Open" }, { id: "submit", label: "Submit" }] }, { id: "settings", steps: [{ id: "open", label: "Open" }] }];
const input = (driver: DeviceDriver, over: Partial<DeviceEvidenceRunInput> = {}): DeviceEvidenceRunInput =>
  ({ platform: "android", isolation: "sandbox", flows, notShown: [], moreNotShown: 0, maskIds: [], driver, encodeJpeg: encodeFakeJpeg, ...over });
const fake = (over: Partial<FakeDeviceScript> = {}) => createFakeDevice({ screen: (side, flow, step) => screenOf(side, flow, step), ...over });
const reasons = (got: { steps: Array<{ status: string; reason?: string }> }) => got.steps.map((row) => (row.status === "shown" ? "shown" : row.reason));
const bytesOf = (size: number, seed = 1) => { const out = new Uint8Array(size); out.set([0xff, 0xd8, 0xff]); out.fill(seed, 3); return out; };

describe("runDeviceEvidence", () => {
  it("runs every flow on the base code, then on the candidate, one picture per step, and stops the device each time", async () => {
    const { driver, calls } = fake();
    const got = await runDeviceEvidence(input(driver));
    const ops = calls.map((c) => `${c.op}:${c.side}${c.flow === undefined ? "" : `/${c.flow}`}${c.step === undefined ? "" : `/${c.step}`}`);
    const side = (s: string) => [`prepare:${s}`, `startFlow:${s}/checkout`, `performStep:${s}/checkout/open`, `readTree:${s}`, `screenshot:${s}`, `readTree:${s}`, `performStep:${s}/checkout/submit`, `readTree:${s}`, `screenshot:${s}`, `readTree:${s}`,
      `startFlow:${s}/settings`, `performStep:${s}/settings/open`, `readTree:${s}`, `screenshot:${s}`, `readTree:${s}`, `stop:${s}`];
    expect(ops).toEqual([...side("before"), ...side("after")]);
    expect(got.device).toBe("fake");
    expect(got.isolation).toBe("sandbox");
    expect(got.notRun).toBeUndefined();
    expect(got.unmasked).toBe(0);
    expect(got.steps.map((row) => `${row.flow}/${row.step}:${row.status}`)).toEqual(["checkout/open:shown", "checkout/submit:shown", "settings/open:shown"]);
    const first = got.steps[0]!;
    if (first.status !== "shown") throw new Error("shown");
    expect(first.before.sha256).toBe(sha(first.before.bytes));
    expect(first.before.sha256).not.toBe(first.after.sha256);
  });

  it("paints the secure field black in the encoded picture and leaves every other pixel as the device drew it; the device's own pixels are never touched", async () => {
    const original = screenOf("before", "checkout", "open").frame;
    const keep = Uint8Array.from(original.rgba);
    const { driver } = fake({ screen: (side) => ({ ...screenOf(side, "x", "y"), frame: side === "before" ? original : fakeFrame(W, H, 150) }) });
    const got = await runDeviceEvidence(input(driver, { flows: [flows[0]!] }));
    const shot = got.steps[0]!;
    if (shot.status !== "shown") throw new Error("shown");
    const decoded = decodeFakeJpeg(shot.before.bytes);
    const pixel = (x: number, y: number) => Array.from(decoded.rgba.slice((y * decoded.width + x) * 4, (y * decoded.width + x) * 4 + 4));
    expect(pixel(10, 20)).toEqual([0, 0, 0, 255]);
    expect(pixel(49, 29)).toEqual([0, 0, 0, 255]);
    expect(pixel(9, 20)).toEqual([100, 100, 100, 255]);
    expect(pixel(50, 29)).toEqual([100, 100, 100, 255]);
    expect(pixel(10, 30)).toEqual([100, 100, 100, 255]);
    expect(Array.from(original.rgba)).toEqual(Array.from(keep));
  });

  it("paints text a shared mask matches, an element the recipe names, and a web view", async () => {
    const extra = [node({ text: "ada@example.com", bounds: { x: 0, y: 40, width: 20, height: 5 } }), node({ id: "com.app:id/iban", text: "ordinary", bounds: { x: 0, y: 50, width: 20, height: 5 } }),
      node({ webView: true, bounds: { x: 0, y: 60, width: 20, height: 5 } }), node({ text: "plain words", bounds: { x: 0, y: 70, width: 20, height: 5 } })];
    const { driver } = fake({ screen: (side, flow, step) => screenOf(side, flow, step, extra) });
    const got = await runDeviceEvidence(input(driver, { flows: [flows[1]!], maskIds: ["com.app:id/iban"] }));
    const shot = got.steps[0]!;
    if (shot.status !== "shown") throw new Error("shown");
    const decoded = decodeFakeJpeg(shot.after.bytes);
    const at = (y: number) => decoded.rgba[(y * decoded.width + 5) * 4]!;
    expect([at(42), at(52), at(62)]).toEqual([0, 0, 0]);
    expect(at(72)).toBe(150);
  });

  it("an iOS run in a sandbox is refused before the device is touched; on a developer machine it runs", async () => {
    const { driver, calls } = fake();
    const got = await runDeviceEvidence(input(driver, { platform: "ios", isolation: "sandbox" }));
    expect(got).toMatchObject({ steps: [], notRun: "needs_macos", device: "fake" });
    expect(calls).toEqual([]);
    const laptop = await runDeviceEvidence(input(fake().driver, { platform: "ios", isolation: "developer_machine" }));
    expect(reasons(laptop)).toEqual(["shown", "shown", "shown"]);
  });

  it("refuses input it was not built for", async () => {
    const { driver } = fake();
    const real = (kind: DeviceDriver["kind"]): DeviceDriver => ({ ...driver, kind });
    const bad: Array<Partial<DeviceEvidenceRunInput>> = [
      { isolation: "imported" as never }, { platform: "windows" as never }, { flows: [] }, { flows: [flows[0]!, flows[0]!] }, { flows: Array.from({ length: 6 }, (_, i) => ({ id: `f${i}`, steps: [{ id: "s", label: "S" }] })) },
      { flows: [{ id: "a", steps: [] }] }, { flows: [{ id: "a", steps: Array.from({ length: 7 }, (_, i) => ({ id: `s${i}`, label: "S" })) }] }, { flows: [{ id: "A B", steps: [{ id: "s", label: "S" }] }] },
      { flows: [{ id: "a", steps: [{ id: "s", label: "S" }, { id: "s", label: "S" }] }] },
      { notShown: [{ flow: "A B", reason: "over_flow_cap" }] }, { notShown: [{ flow: "a", reason: "because" as never }] }, { moreNotShown: -1 }, { moreNotShown: 1.5 },
      { maskIds: Array.from({ length: 21 }, (_, i) => `id${i}`) }, { driver: real("phone" as never) },
      // An iOS simulator cannot be driven for an Android app and the other way round; an iOS simulator is never in a sandbox.
      { driver: real("ios_simulator"), platform: "android", isolation: "developer_machine" }, { driver: real("android_emulator"), platform: "ios", isolation: "developer_machine" },
      { driver: real("ios_simulator"), platform: "ios", isolation: "sandbox" }, { encodeJpeg: undefined as never },
    ];
    for (const over of bad) await expect(runDeviceEvidence(input(driver, over)), JSON.stringify(over).slice(0, 100)).rejects.toThrow("device evidence input is not valid");
  });

  describe("masking", () => {
    it("withholds a screen whose tree and picture disagree: it reads again once, and a tree that changes every time is withheld", async () => {
      let reads = 0;
      const flip = fake({ screen: (side, flow, step) => { const s = screenOf(side, flow, step); reads += 1; return { ...s, tree: { ...(s.tree as object), nodes: [node({ text: `tick ${reads}` })] } }; } });
      const got = await runDeviceEvidence(input(flip.driver, { flows: [flows[1]!] }));
      expect(reasons(got)).toEqual(["masked_content"]);
      // Two attempts per side: tree, picture, tree twice over.
      expect(flip.calls.filter((c) => c.op === "readTree" && c.side === "before")).toHaveLength(4);
    });
    it("a tree that settles on the second try is used", async () => {
      let reads = 0;
      const second = fake({ screen: (side, flow, step) => { const s = screenOf(side, flow, step); reads += 1; return reads <= 1 ? { ...s, tree: { ...(s.tree as object), nodes: [node({ text: "moving" })] } } : s; } });
      const got = await runDeviceEvidence(input(second.driver, { flows: [flows[1]!] }));
      expect(reasons(got)).toEqual(["shown"]);
    });
    it("withholds a secret across two elements (a label and its value), and a match it cannot paint", async () => {
      const split = fake({ screen: (side, flow, step) => screenOf(side, flow, step, [node({ text: "API key:" }), node({ text: "abcd1234" })]) });
      expect(reasons(await runDeviceEvidence(input(split.driver, { flows: [flows[1]!] })))).toEqual(["masked_content"]);
      const unpaintable = fake({ screen: (side, flow, step) => screenOf(side, flow, step, [{ text: "ada@example.com" }]) });
      expect(reasons(await runDeviceEvidence(input(unpaintable.driver, { flows: [flows[1]!] })))).toEqual(["masked_content"]);
    });
    it("withholds a screen with no readable tree (this screen cannot be checked), a tree of another size, and a garbage tree", async () => {
      for (const tree of [null, { width: W + 1, height: H, nodes: [node({ text: "x" })] }, { nope: 1 }, "tree"]) {
        const dark = fake({ screen: (side) => ({ tree, frame: fakeFrame(W, H, side === "before" ? 100 : 150) }) });
        expect(reasons(await runDeviceEvidence(input(dark.driver, { flows: [flows[1]!] }))), JSON.stringify(tree)).toEqual(["unreadable_screen"]);
      }
    });
    it("fixture-data-only shows a screen with no tree unmasked and counts it; it never waives a match it cannot paint, and only `true` counts", async () => {
      const dark = fake({ screen: (side) => ({ tree: null, frame: fakeFrame(W, H, side === "before" ? 100 : 150) }) });
      const got = await runDeviceEvidence(input(dark.driver, { flows: [flows[1]!], fixtureDataOnly: true }));
      expect(reasons(got)).toEqual(["shown"]);
      expect(got.unmasked).toBe(1);
      expect(reasons(await runDeviceEvidence(input(dark.driver, { flows: [flows[1]!], fixtureDataOnly: "true" as never })))).toEqual(["unreadable_screen"]);
      const unpaintable = fake({ screen: (side, flow, step) => screenOf(side, flow, step, [{ text: "ada@example.com" }]) });
      expect(reasons(await runDeviceEvidence(input(unpaintable.driver, { flows: [flows[1]!], fixtureDataOnly: true })))).toEqual(["masked_content"]);
    });
    it("checks the paint: the check fails on a frame that was not painted, and covers every pixel of every rectangle", () => {
      const frame: DeviceFrame = fakeFrame(10, 10, 200);
      const rects = [{ x: 2, y: 2, width: 3, height: 3 }, { x: 8, y: 8, width: 5, height: 5 }];
      expect(deviceRectsPainted(frame, rects)).toBe(false);
      const painted = paintDeviceRects(frame, rects);
      expect(deviceRectsPainted(painted, rects)).toBe(true);
      expect(frame.rgba[(2 * 10 + 2) * 4]).toBe(200);
      // One pixel left unpainted is enough to fail the check.
      painted.rgba[(4 * 10 + 4) * 4 + 1] = 1;
      expect(deviceRectsPainted(painted, rects)).toBe(false);
      // Painting stays inside the frame and leaves everything else alone.
      expect(Array.from(paintDeviceRects(frame, [{ x: 9, y: 9, width: 50, height: 50 }]).rgba.slice(-8))).toEqual([200, 200, 200, 255, 0, 0, 0, 255]);
    });
  });

  describe("caps and failures", () => {
    it("drops a picture over the pack's cap, one that is not a JPEG, and one that carries a credential", async () => {
      const encoders: Array<[string, (frame: DeviceFrame) => Uint8Array, string]> = [
        ["over", () => bytesOf(DEVICE_EVIDENCE_SCREENSHOT_MAX_BYTES + 1), "over_size_cap"], ["at cap", () => bytesOf(DEVICE_EVIDENCE_SCREENSHOT_MAX_BYTES), "shown"],
        ["png", () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), "capture_failed"], ["empty", () => new Uint8Array(0), "capture_failed"],
        ["throws", () => { throw new Error("encoder broke at /home/ada"); }, "capture_failed"], ["not bytes", () => "bytes" as never, "capture_failed"],
        ["secret", () => { const out = bytesOf(100); out.set(new TextEncoder().encode("SECRET-VALUE"), 10); return out; }, "masked_content"],
      ];
      for (const [name, encodeJpeg, expected] of encoders) {
        const got = await runDeviceEvidence(input(fake().driver, { flows: [flows[1]!], encodeJpeg, redactor: { contains: (bytes) => Buffer.from(bytes).includes("SECRET-VALUE") } }));
        expect(reasons(got), name).toEqual([expected]);
        expect(JSON.stringify(got), name).not.toMatch(/home\/ada|SECRET/u);
      }
      const redactorThrows = await runDeviceEvidence(input(fake().driver, { flows: [flows[1]!], redactor: { contains: () => { throw new Error("no"); } } }));
      expect(reasons(redactorThrows)).toEqual(["masked_content"]);
    });
    it("refuses a frame that is not what it says: wrong size for its pixels, no pixels, over the pixel cap", async () => {
      const frames: unknown[] = [{ width: W, height: H, rgba: new Uint8Array(10) }, { width: 0, height: 0, rgba: new Uint8Array(0) }, { width: 1.5, height: 2, rgba: new Uint8Array(12) }, null, "frame",
        { width: W, height: H, rgba: "pixels" }, { width: DEVICE_EVIDENCE_FRAME_PIXELS_MAX + 1, height: 1, rgba: new Uint8Array(4) }];
      for (const frame of frames) {
        const odd = fake({ screen: (side, flow, step) => ({ ...screenOf(side, flow, step), frame: frame as DeviceFrame }) });
        expect(reasons(await runDeviceEvidence(input(odd.driver, { flows: [flows[1]!] }))), JSON.stringify(frame)?.slice(0, 40)).toEqual(["capture_failed"]);
      }
    });
    it("keeps the whole run inside one byte budget: the step that would pass it is Not run, and a caller can lower the budget but never raise it", async () => {
      const big = (seed: number) => (frame: DeviceFrame) => bytesOf(DEVICE_EVIDENCE_SCREENSHOT_MAX_BYTES, frame.rgba[0]! + seed);
      const many = Array.from({ length: 5 }, (_, i) => ({ id: `f${i}`, steps: [{ id: "s", label: "S" }, { id: "t", label: "T" }] }));
      const got = await runDeviceEvidence(input(fake().driver, { flows: many, encodeJpeg: big(0) }));
      const shown = got.steps.filter((row) => row.status === "shown");
      // 8 MiB is 16 pictures of the cap: 8 steps fit (before and after), the rest are Not run.
      expect(shown.length * 2 * DEVICE_EVIDENCE_SCREENSHOT_MAX_BYTES).toBeLessThanOrEqual(DEVICE_EVIDENCE_TOTAL_MAX_BYTES);
      expect(shown).toHaveLength(8);
      expect(got.steps.at(-1)).toEqual({ flow: "f4", step: "t", status: "not_run", reason: "over_size_cap" });
      const small = await runDeviceEvidence(input(fake().driver, { flows: [flows[0]!], encodeJpeg: big(0), limits: { totalBytes: 3 * DEVICE_EVIDENCE_SCREENSHOT_MAX_BYTES } }));
      expect(reasons(small)).toEqual(["shown", "over_size_cap"]);
      const raised = await runDeviceEvidence(input(fake().driver, { flows: many, encodeJpeg: big(0), limits: { totalBytes: 1_000 * DEVICE_EVIDENCE_TOTAL_MAX_BYTES } }));
      expect(raised.steps.filter((row) => row.status === "shown")).toHaveLength(8);
    });
    it("a step that fails stops its flow (later steps are Not run), another flow still runs, and the failed step's picture is never half-kept", async () => {
      const { driver } = fake({ performStep: (side, flow, step) => (side === "after" && flow === "checkout" && step === "open" ? "step_failed" : "ok") });
      const got = await runDeviceEvidence(input(driver));
      expect(reasons(got)).toEqual(["step_failed", "step_failed", "shown"]);
      const startFails = fake({ startFlow: (side, flow) => (flow === "checkout" ? "step_failed" : "ok") });
      expect(reasons(await runDeviceEvidence(input(startFails.driver)))).toEqual(["step_failed", "step_failed", "shown"]);
      // The flow's later steps are still performed when only an earlier picture was withheld, so they start from where the app is.
      const withheldFirst = fake({ screen: (side, flow, step) => screenOf(side, flow, step, step === "open" ? [{ text: "ada@example.com" }] : []) });
      const second = await runDeviceEvidence(input(withheldFirst.driver, { flows: [flows[0]!] }));
      expect(reasons(second)).toEqual(["masked_content", "shown"]);
      expect(withheldFirst.calls.filter((c) => c.op === "performStep" && c.side === "after").map((c) => c.step)).toEqual(["open", "submit"]);
    });
    it("an app or device that does not come up is Not run for the whole run, nothing is captured, the device is still stopped, and the reason is fixed words", async () => {
      for (const [answer, expected] of [["app_did_not_build", "app_did_not_build"], ["device_did_not_start", "device_did_not_start"], ["needs_macos", "needs_macos"], ["time_limit", "time_limit"],
        ["weird", "device_did_not_start"], ["constructor", "device_did_not_start"], [42, "device_did_not_start"]] as const) {
        const { driver, calls } = fake({ prepare: (side) => (side === "before" ? (answer as never) : "ready") });
        const got = await runDeviceEvidence(input(driver));
        expect(got.notRun, String(answer)).toBe(expected);
        expect(got.steps).toEqual([]);
        expect(calls.filter((c) => c.op !== "prepare" && c.op !== "stop")).toEqual([]);
        expect(calls.filter((c) => c.op === "stop").map((c) => c.side)).toEqual(["before"]);
      }
      const throws = fake({ prepare: () => { throw new Error("spawn ENOENT /home/ada/secret"); } });
      const got = await runDeviceEvidence(input(throws.driver));
      expect(got.notRun).toBe("device_did_not_start");
      expect(JSON.stringify(got)).not.toContain("secret");
      // The candidate not coming up is the same: no step is shown from half a pair.
      const afterFails = fake({ prepare: (side) => (side === "after" ? "app_did_not_build" : "ready") });
      expect(await runDeviceEvidence(input(afterFails.driver))).toMatchObject({ steps: [], notRun: "app_did_not_build" });
    });
    it("stops at the run's time limit: later steps are Not run (time limit) and never opened; each call gets at most what is left", async () => {
      let clock = 0;
      const { driver, calls } = fake({ performStep: () => { clock += 40_000; return "ok"; } });
      const got = await runDeviceEvidence(input(driver, { now: () => clock, limits: { runMs: 100_000, stepMs: 15_000 } }));
      expect(got.steps.every((row) => row.status === "not_run" && row.reason === "time_limit")).toBe(true);
      for (const call of calls.filter((c) => c.timeoutMs !== undefined)) expect(call.timeoutMs).toBeLessThanOrEqual(100_000);
      expect(calls.filter((c) => c.op === "stop")).toHaveLength(calls.filter((c) => c.op === "prepare").length);
      expect(calls.filter((c) => c.op === "performStep").length).toBeLessThanOrEqual(3);
    });
    it("a caller can lower the built-in limits but never raise them", async () => {
      const { driver, calls } = fake();
      await runDeviceEvidence(input(driver, { limits: { runMs: 10_000_000, stepMs: 10_000_000 } }));
      for (const call of calls.filter((c) => c.op === "readTree" || c.op === "performStep")) expect(call.timeoutMs).toBeLessThanOrEqual(30_000);
      for (const call of calls.filter((c) => c.op === "prepare")) expect(call.timeoutMs).toBeLessThanOrEqual(600_000);
    });
    it("a driver that throws or answers nonsense is a fixed reason, with no echo of its error, and the device is still stopped", async () => {
      const boom = () => { throw new Error("adb: device 'emulator-5554' at https://user:pw@host/ failed"); };
      const cases: Array<[Partial<FakeDeviceScript>, string]> = [[{ performStep: boom }, "step_failed"], [{ startFlow: boom }, "step_failed"], [{ performStep: (() => "perhaps") as never }, "step_failed"]];
      for (const [over, expected] of cases) {
        const { driver, calls } = fake(over);
        const got = await runDeviceEvidence(input(driver, { flows: [flows[1]!] }));
        expect(reasons(got)).toEqual([expected]);
        expect(JSON.stringify(got)).not.toMatch(/pw@|emulator-5554/u);
        expect(calls.filter((c) => c.op === "stop").map((c) => c.side)).toEqual(["before"]);
      }
      for (const op of ["readTree", "screenshot"] as const) {
        const { driver, calls } = fake();
        const throwing: DeviceDriver = { ...driver, async [op]() { throw new Error("adb: lost at /home/ada"); } };
        const got = await runDeviceEvidence(input(throwing, { flows: [flows[1]!] }));
        expect(reasons(got), op).toEqual(["capture_failed"]);
        expect(JSON.stringify(got)).not.toContain("ada");
        expect(calls.some((c) => c.op === "stop")).toBe(true);
      }
    });
    it("a device that never answers cannot hold the run: the step is Not run (time limit) at the step's time, and the device is still stopped, within a bound", async () => {
      const calls: string[] = [];
      const never = <T>() => new Promise<T>(() => undefined);
      const driver: DeviceDriver = {
        kind: "fake", async prepare(side) { calls.push(`prepare:${side}`); return "ready"; }, async startFlow() { return "ok"; }, async performStep() { return "ok"; },
        async readTree() { return never(); }, async screenshot() { return never(); }, stop(side) { calls.push(`stop:${side}`); return never(); },
      };
      const started = Date.now();
      const got = await runDeviceEvidence(input(driver, { flows: [flows[1]!], limits: { stepMs: 50, runMs: 5_000 } }));
      expect(reasons(got)).toEqual(["time_limit"]);
      expect(calls).toEqual(["prepare:before", "stop:before"]);
      expect(Date.now() - started).toBeLessThan(DEVICE_EVIDENCE_STOP_MS + 3_000);
    }, 20_000);
    it("a prepare that answers after the run gave up is stopped as soon as it settles", async () => {
      const stops: string[] = [];
      let release: (answer: "ready") => void = () => undefined;
      const driver: DeviceDriver = {
        ...fake().driver, prepare: () => new Promise((resolve) => { release = resolve; }), async stop(side) { stops.push(side); },
      };
      const got = await runDeviceEvidence(input(driver, { flows: [flows[1]!], limits: { runMs: 30 } }));
      expect(got.notRun).toBe("time_limit");
      expect(stops).toEqual(["before"]);
      release("ready");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(stops).toEqual(["before", "before"]);
    });
  });

  describe("painting is bounded and checked", () => {
    it("a screen of hundreds of full-screen rectangles is withheld at once, and one full-screen paint on a phone-sized frame is quick", async () => {
      const W2 = 1080;
      const H2 = 2400;
      const full = { x: 0, y: 0, width: W2, height: H2 };
      const many = fake({ screen: () => ({ tree: { width: W2, height: H2, nodes: [node({ text: "Hello", bounds: { x: 0, y: 0, width: 10, height: 10 } }), ...Array.from({ length: 400 }, () => node({ secure: true, bounds: full }))] }, frame: fakeFrame(W2, H2, 100) }) });
      const started = Date.now();
      expect(reasons(await runDeviceEvidence(input(many.driver, { flows: [flows[1]!], limits: { runMs: 1_000, stepMs: 500 } })))).toEqual(["masked_content"]);
      expect(Date.now() - started).toBeLessThan(2_000);
      const one = fake({ screen: () => ({ tree: { width: W2, height: H2, nodes: [node({ text: "Hello", bounds: { x: 0, y: 0, width: 10, height: 10 } }), node({ secure: true, bounds: full })] }, frame: fakeFrame(W2, H2, 100) }) });
      const t0 = Date.now();
      expect(reasons(await runDeviceEvidence(input(one.driver, { flows: [flows[1]!], encodeJpeg: () => bytesOf(1_000) })))).toEqual(["shown"]);
      expect(Date.now() - t0).toBeLessThan(5_000);
    });
    it("a painter that did not paint, painted a frame of another size, or threw is never encoded", async () => {
      const lazy = (frame: DeviceFrame) => ({ ...frame, rgba: Uint8Array.from(frame.rgba) });
      const small = () => fakeFrame(10, 10);
      const throws = () => { throw new Error("boom at /home/ada"); };
      for (const [paint, expected] of [[lazy, "masked_content"], [small, "masked_content"], [throws, "capture_failed"], [() => null as never, "masked_content"]] as const) {
        let encoded = 0;
        const got = await runDeviceEvidence(input(fake().driver, { flows: [flows[1]!], paint, encodeJpeg: (frame) => { encoded += 1; return encodeFakeJpeg(frame); } }));
        expect(reasons(got)).toEqual([expected]);
        expect(encoded).toBe(0);
        expect(JSON.stringify(got)).not.toContain("ada");
      }
    });
    it("the time is read again after painting: a step whose paint ran past the limit is Not run (time limit)", async () => {
      let clock = 0;
      const slow = (frame: DeviceFrame, rects: Parameters<typeof paintDeviceRects>[1]) => { clock += 1_000_000; return paintDeviceRects(frame, rects); };
      let encoded = 0;
      const got = await runDeviceEvidence(input(fake().driver, { flows: [flows[1]!], paint: slow, now: () => clock, limits: { runMs: 500_000 }, encodeJpeg: (frame) => { encoded += 1; return encodeFakeJpeg(frame); } }));
      expect(reasons(got)).toEqual(["time_limit"]);
      expect(encoded).toBe(0);
    });
    it("counts a screen shown under the fixture-data choice even when part of it was painted", async () => {
      const web = fake({ screen: (side) => ({ tree: { width: W, height: H, nodes: [node({ webView: true })] }, frame: fakeFrame(W, H, side === "before" ? 100 : 150) }) });
      const got = await runDeviceEvidence(input(web.driver, { flows: [flows[1]!], fixtureDataOnly: true }));
      expect(reasons(got)).toEqual(["shown"]);
      expect(got.unmasked).toBe(1);
      expect(reasons(await runDeviceEvidence(input(web.driver, { flows: [flows[1]!] })))).toEqual(["unreadable_screen"]);
    });
    it("a prepare that fails after the run gave up is stopped too", async () => {
      const stops: string[] = [];
      let fail: (reason: unknown) => void = () => undefined;
      const driver: DeviceDriver = { ...fake().driver, prepare: () => new Promise((_, reject) => { fail = reject; }), async stop(side) { stops.push(side); } };
      await runDeviceEvidence(input(driver, { flows: [flows[1]!], limits: { runMs: 30 } }));
      fail(new Error("late"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(stops).toEqual(["before", "before"]);
    });
  });

  describe("a fake device is never a real run", () => {
    it("says it is fake in its kind, and no driver input can make a fake into a real device", async () => {
      expect(fake().driver.kind).toBe("fake");
      const got = await runDeviceEvidence(input(fake().driver));
      expect(got.device).toBe("fake");
    });
  });
});
