// Device testing slice 1 (DEC 244): device evidence, the pure half (contracts). The setting (off by default), the recipe, which changed flows are picked, the view-tree mask plan, the caps,
// the fixed words, the evidence-pack check and the pull request's lines. Visual evidence only: a picture, and anything from a fake device, never counts as change proof.
import { describe, expect, it } from "vitest";
import {
  DEVICE_EVIDENCE_CHANGED_FILES_MAX, DEVICE_EVIDENCE_CHECK_ID, DEVICE_EVIDENCE_DEVICE_WORDS, DEVICE_EVIDENCE_FLOWS_MAX, DEVICE_EVIDENCE_FRAME_PIXELS_MAX, DEVICE_EVIDENCE_NOT_PROOF_WORDS,
  DEVICE_EVIDENCE_NOT_RUN_REASONS, DEVICE_EVIDENCE_NOT_RUN_WORDS, DEVICE_EVIDENCE_NOT_SHOWN_MAX, DEVICE_EVIDENCE_SCREENSHOT_MAX_BYTES, DEVICE_EVIDENCE_SETTING, DEVICE_EVIDENCE_STEPS_MAX,
  DEVICE_EVIDENCE_TOTAL_MAX_BYTES, DEVICE_EVIDENCE_TREE_NODES_MAX, DeviceEvidenceRecipeSchema, addDeviceEvidenceToPack, checkedDeviceEvidenceCaptured, deviceEvidenceCheck, deviceEvidenceLines,
  deviceEvidenceOn, pickChangedFlows, planDeviceMask, type DeviceEvidenceOutcome,
} from "../../packages/contracts/src/device-evidence.js";
import { BROWSER_EVIDENCE_TEXT_MASKS, scrubVisibleText } from "../../packages/contracts/src/browser-evidence.js";
import { checkKindInfo } from "../../packages/contracts/src/check-kinds.js";
import { EVIDENCE_ARTIFACT_MAX_BYTES, EvidencePackV2Schema, type ArtifactRef, type EvidencePackV2 } from "../../packages/contracts/src/evidence.js";
import { POLICY_FIELDS, resolvePolicy } from "../../packages/contracts/src/policy.js";
import { POLICY_PRESETS } from "../../packages/contracts/src/presets.js";
import { proofHolds, type TestProof } from "../../packages/contracts/src/test-proof.js";

const sha = (c: string) => c.repeat(64);
const jpeg = (c: string, bytes = 1_000): ArtifactRef => ({ kind: "jpeg", sha256: sha(c), bytes, retentionClass: "evidence-std" });
const flow = (id: string, files: string[], steps = ["open", "submit"]) => ({ id, files, steps: steps.map((step) => ({ id: step, label: `Step ${step}` })) });
const recipe = (extra: Record<string, unknown> = {}) => ({
  platform: "android", buildCommand: "./gradlew assembleDebug", appFile: "app/build/outputs/apk/debug/app-debug.apk",
  flows: [flow("checkout", ["app/src/main/**/checkout/**"]), flow("settings", ["app/src/main/**/settings/**", "app/src/shared/**"])], ...extra,
});

describe("the setting", () => {
  it("is a policy field that is off today, off in every preset, and only an explicit `on` turns it on", () => {
    const field = POLICY_FIELDS.find((row) => row.id === DEVICE_EVIDENCE_SETTING);
    expect(field).toMatchObject({ kind: "ordered_enum", order: ["off", "on"], today: "off", compatibility: true });
    for (const preset of Object.values(POLICY_PRESETS)) expect((preset as Record<string, unknown>)[DEVICE_EVIDENCE_SETTING]).toBe("off");
    expect(deviceEvidenceOn(resolvePolicy({}))).toBe(false);
    expect(deviceEvidenceOn(resolvePolicy({ project: { preset_level: "careful" } }))).toBe(false);
    expect(deviceEvidenceOn(resolvePolicy({ project: { [DEVICE_EVIDENCE_SETTING]: "on" } }))).toBe(true);
    expect(deviceEvidenceOn(resolvePolicy({ project: { [DEVICE_EVIDENCE_SETTING]: "off" } }))).toBe(false);
  });
  it("fails closed on anything but a resolved policy whose value is exactly `on`, and browser evidence's switch is not this one", () => {
    for (const input of [undefined, null, {}, "on", { status: "refused", values: {} }, { status: "disabled", values: { device_evidence: { value: "on", origin: "install_off" } } },
      { status: "resolved", values: { device_evidence: { value: "ON", origin: "changed_here" } } }, { status: "resolved", values: { device_evidence: { value: true, origin: "changed_here" } } },
      { status: "resolved", values: { device_evidence: "on" } }, { status: "resolved", values: Object.create({ device_evidence: { value: "on" } }) as unknown },
      { status: "resolved", values: { browser_evidence: { value: "on", origin: "changed_here" } } }]) {
      expect(deviceEvidenceOn(input), JSON.stringify(input)).toBe(false);
    }
    expect(deviceEvidenceOn(resolvePolicy({ project: { [DEVICE_EVIDENCE_SETTING]: "on" } }, { installOff: true }))).toBe(false);
  });
});

describe("the recipe", () => {
  it("accepts a platform, a build command, an app file, flows with named steps and the files that map to them; refuses odd input", () => {
    expect(DeviceEvidenceRecipeSchema.safeParse(recipe()).success).toBe(true);
    expect(DeviceEvidenceRecipeSchema.safeParse(recipe({ platform: "ios", maskIds: ["com.app:id/iban"], fixtureDataOnly: true })).success).toBe(true);
    for (const bad of [
      recipe({ extra: 1 }), recipe({ platform: "windows" }), recipe({ buildCommand: "" }), recipe({ buildCommand: "make\nrm -rf /" }), recipe({ appFile: "/abs/app.apk" }), recipe({ appFile: "../app.apk" }),
      recipe({ appFile: "a/../../b.apk" }), recipe({ appFile: "a\\b.apk" }), recipe({ flows: [] }), recipe({ flows: [flow("a", [])] }), recipe({ flows: [flow("a", ["x"], [])] }),
      recipe({ flows: [flow("A B", ["x"])] }), recipe({ flows: [flow("a", ["x"], ["s1", "s1"])] }), recipe({ flows: [flow("a", ["x"]), flow("a", ["y"])] }),
      recipe({ flows: [flow("a", ["x"], Array.from({ length: DEVICE_EVIDENCE_STEPS_MAX + 1 }, (_, i) => `s${i}`))] }),
      recipe({ flows: Array.from({ length: 51 }, (_, i) => flow(`f${i}`, ["x"])) }), recipe({ maskIds: Array.from({ length: 21 }, (_, i) => `id${i}`) }), recipe({ fixtureDataOnly: "yes" }),
    ]) expect(DeviceEvidenceRecipeSchema.safeParse(bad).success, JSON.stringify(bad).slice(0, 120)).toBe(false);
    expect(DeviceEvidenceRecipeSchema.safeParse(recipe({ flows: [flow("a", ["x"], Array.from({ length: DEVICE_EVIDENCE_STEPS_MAX }, (_, i) => `s${i}`))] })).success).toBe(true);
  });
});

describe("which changed flows are picked", () => {
  it("picks the recipe flows whose globs match a changed file, in recipe order, each once, with their steps", () => {
    expect(pickChangedFlows({ changedFiles: ["app/src/shared/x.kt", "app/src/main/kotlin/checkout/Pay.kt", "README.md"], recipe: recipe() })).toEqual({
      status: "picked", notShown: [], moreNotShown: 0,
      flows: [{ id: "checkout", steps: [{ id: "open", label: "Step open" }, { id: "submit", label: "Step submit" }] }, { id: "settings", steps: [{ id: "open", label: "Step open" }, { id: "submit", label: "Step submit" }] }],
    });
    const only = pickChangedFlows({ changedFiles: ["app/src/main/java/settings/A.kt"], recipe: recipe() });
    expect(only.status === "picked" && only.flows.map((row) => row.id)).toEqual(["settings"]);
  });
  it("says Not run when nothing changed maps to a flow, when there is no recipe, and refuses input that is not a file list", () => {
    expect(pickChangedFlows({ changedFiles: ["README.md"], recipe: recipe() })).toEqual({ status: "not_run", reason: "no_changed_flow" });
    expect(pickChangedFlows({ changedFiles: [], recipe: recipe() })).toEqual({ status: "not_run", reason: "no_changed_flow" });
    expect(pickChangedFlows({ changedFiles: ["a"], recipe: undefined })).toEqual({ status: "not_run", reason: "no_recipe" });
    expect(pickChangedFlows({ changedFiles: ["a"], recipe: { ...recipe(), platform: "palm" } })).toEqual({ status: "not_run", reason: "no_recipe" });
    for (const changedFiles of [undefined, "a", [1], ["a", null]]) expect(pickChangedFlows({ changedFiles, recipe: recipe() })).toEqual({ status: "not_run", reason: "changes_unreadable" });
  });
  it("refuses the whole pick above the changed-file cap instead of picking from part of the list", () => {
    const many = Array.from({ length: DEVICE_EVIDENCE_CHANGED_FILES_MAX + 1 }, (_, i) => `app/src/main/x/checkout/f${i}.kt`);
    expect(pickChangedFlows({ changedFiles: many, recipe: recipe() })).toEqual({ status: "not_run", reason: "too_many_changed_files" });
    expect(pickChangedFlows({ changedFiles: many.slice(0, DEVICE_EVIDENCE_CHANGED_FILES_MAX), recipe: recipe() }).status).toBe("picked");
  });
  it("takes at most five flows and lists the rest as not shown, with a bounded list and a count", () => {
    const flows = Array.from({ length: 40 }, (_, i) => flow(`f${i}`, [`src/f${i}/**`]));
    const got = pickChangedFlows({ changedFiles: flows.map((_, i) => `src/f${i}/x.kt`), recipe: recipe({ flows }) });
    expect(got.status).toBe("picked");
    if (got.status !== "picked") return;
    expect(got.flows.map((row) => row.id)).toEqual(["f0", "f1", "f2", "f3", "f4"]);
    expect(got.flows).toHaveLength(DEVICE_EVIDENCE_FLOWS_MAX);
    expect(got.notShown).toHaveLength(DEVICE_EVIDENCE_NOT_SHOWN_MAX);
    expect(got.notShown[0]).toEqual({ flow: "f5", reason: "over_flow_cap" });
    expect(got.notShown.length + got.moreNotShown).toBe(35);
  });
  it("finishes a customer-sized input within a bounded time", () => {
    const flows = Array.from({ length: 50 }, (_, i) => flow(`f${i}`, Array.from({ length: 20 }, (_, j) => `src/**/m${i}-${j}/**/*.kt`)));
    const changedFiles = Array.from({ length: DEVICE_EVIDENCE_CHANGED_FILES_MAX }, (_, i) => `src/${"deep/".repeat(20)}file-${i}.kt`);
    const started = performance.now();
    expect(pickChangedFlows({ changedFiles, recipe: recipe({ flows }) }).status).toBe("not_run");
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});

// A screen is a flat list of nodes in reading order, with the size of the frame it was read from.
const node = (over: Record<string, unknown>) => ({ bounds: { x: 10, y: 10, width: 200, height: 40 }, ...over });
const screen = (nodes: unknown[], size = { width: 360, height: 640 }) => ({ ...size, nodes });
const frame = { width: 360, height: 640 };
const plan = (tree: unknown, extra: Record<string, unknown> = {}) => planDeviceMask(tree, { frame, ...extra });
const email = "ada.lovelace@example.com";

describe("the view-tree mask plan", () => {
  it("paints over every node that is secure, a web view, named by the recipe, or whose text matches a shared mask; and nothing else", () => {
    const got = plan(screen([
      node({ text: "Welcome", bounds: { x: 0, y: 0, width: 100, height: 20 } }),
      node({ text: "••••••••", secure: true, bounds: { x: 1, y: 30, width: 100, height: 20 } }),
      node({ webView: true, bounds: { x: 2, y: 60, width: 100, height: 20 } }),
      node({ id: "com.app:id/iban", text: "ordinary", bounds: { x: 3, y: 90, width: 100, height: 20 } }),
      node({ text: `Signed in as ${email}`, bounds: { x: 4, y: 120, width: 100, height: 20 } }),
      node({ description: "Card 4111 1111 1111 1111", bounds: { x: 5, y: 150, width: 100, height: 20 } }),
      node({ hint: "Phone (415) 555-0123", bounds: { x: 6, y: 180, width: 100, height: 20 } }),
      node({ text: "Total: 3 items on 2026-11-15 for $1,299.00", bounds: { x: 7, y: 210, width: 100, height: 20 } }),
    ]), { maskIds: ["com.app:id/iban"] });
    expect(got).toEqual({ status: "paint", rects: [
      { x: 1, y: 30, width: 100, height: 20 }, { x: 2, y: 60, width: 100, height: 20 }, { x: 3, y: 90, width: 100, height: 20 },
      { x: 4, y: 120, width: 100, height: 20 }, { x: 5, y: 150, width: 100, height: 20 }, { x: 6, y: 180, width: 100, height: 20 },
    ] });
  });
  it("uses the browser-evidence text masks themselves (the list is shared, not copied)", () => {
    // Every shared mask's own match is painted: build one sample per mask from the shared sources' behaviour on a known sample.
    const samples = ["bob@example.org", "4111 1111 1111 1111", "+44 20 7946 0958", "123-45-6789", "password: Hunter2x", "0123456789abcdef".repeat(3)];
    for (const text of samples) {
      expect(scrubVisibleText(text), text).not.toBe(text);
      expect(plan(screen([node({ text })])), text).toEqual({ status: "paint", rects: [{ x: 10, y: 10, width: 200, height: 40 }] });
    }
    expect(BROWSER_EVIDENCE_TEXT_MASKS.length).toBeGreaterThan(10);
  });
  it("clips a node to the screen, skips one that is wholly off the screen, and withholds a match it cannot paint", () => {
    const secret = { secure: true };
    expect(plan(screen([node({ ...secret, bounds: { x: 300, y: 600, width: 200, height: 200 } }), node({ text: "hi", bounds: { x: 0, y: 0, width: 5, height: 5 } })]))).toEqual({ status: "paint", rects: [{ x: 300, y: 600, width: 60, height: 40 }] });
    expect(plan(screen([node({ ...secret, bounds: { x: -50, y: -10, width: 100, height: 30 } }), node({ text: "hi" })]))).toEqual({ status: "paint", rects: [{ x: 0, y: 0, width: 50, height: 20 }] });
    // Wholly off the screen: it is not in the picture, so there is nothing to paint (the other node keeps the screen readable).
    expect(plan(screen([node({ ...secret, bounds: { x: 400, y: 10, width: 50, height: 50 } }), node({ text: "hi" })]))).toEqual({ status: "paint", rects: [] });
    const noBounds = { text: email };
    for (const bad of [noBounds, node({ text: email, bounds: { x: 10, y: 10, width: 0, height: 10 } }), node({ text: email, bounds: { x: 10, y: 10, width: 10, height: 0 } })]) {
      expect(plan(screen([node({ text: "ok" }), bad])), JSON.stringify(bad)).toEqual({ status: "withheld", reason: "masked_content" });
    }
  });
  it("withholds a secret that only shows across two nodes (a label and its value)", () => {
    const got = plan(screen([node({ text: "API key:", bounds: { x: 0, y: 0, width: 80, height: 20 } }), node({ text: "abcd1234", bounds: { x: 0, y: 30, width: 80, height: 20 } })]));
    expect(got).toEqual({ status: "withheld", reason: "masked_content" });
    // A hint shows while a field is empty, so a value there counts as text on the screen.
    expect(plan(screen([node({ text: "API key:" }), node({ hint: "abcd1234" })]))).toEqual({ status: "withheld", reason: "masked_content" });
    // A sign-in screen's label beside its (painted) secure field and a two-word button is not one.
    expect(plan(screen([node({ text: "Password:" }), node({ text: "••••", secure: true }), node({ text: "Sign in" })]))).toMatchObject({ status: "paint" });
  });
  it("withholds a screen it cannot read: no tree, no nodes, no text at all, a malformed tree, a tree of another size, or too many nodes", () => {
    const bad: unknown[] = [undefined, null, {}, screen([]), screen([node({}), { }]), screen([node({ text: "x" })], { width: 361, height: 640 }), screen([node({ text: "x" })], { width: 360, height: 641 }),
      { ...screen([node({ text: "x" })]), extra: 1 }, screen([{ text: "x", extra: 1 }]), screen([node({ text: 5 })]), screen([node({ text: "x", bounds: { x: 1.5, y: 0, width: 1, height: 1 } })]),
      screen(Array.from({ length: DEVICE_EVIDENCE_TREE_NODES_MAX + 1 }, () => node({ text: "x" }))), screen([node({ text: "x".repeat(10_001) })]),
      screen(Array.from({ length: 100 }, () => node({ text: "x".repeat(9_000) })))];
    for (const tree of bad) expect(plan(tree), JSON.stringify(tree)?.slice(0, 80)).toEqual({ status: "withheld", reason: "unreadable_screen" });
    expect(plan(screen(Array.from({ length: DEVICE_EVIDENCE_TREE_NODES_MAX }, (_, i) => node({ text: `n${i}` }))))).toMatchObject({ status: "paint" });
  });
  it("text of only spaces or hidden characters is no text: that screen cannot be read either", () => {
    for (const text of [" ", "\u200b", " \u00a0\t\n", "\u202e"]) {
      expect(plan(screen([node({ text })])), JSON.stringify(text)).toEqual({ status: "withheld", reason: "unreadable_screen" });
      expect(plan(screen([node({ description: text }), node({ hint: text })]))).toEqual({ status: "withheld", reason: "unreadable_screen" });
    }
    expect(plan(screen([node({ text: " a " })]))).toMatchObject({ status: "paint" });
  });
  it("a canvas, game or map surface is always painted, whatever text its screen has", () => {
    expect(plan(screen([node({ text: "Play" }), node({ surface: true, bounds: { x: 0, y: 20, width: 360, height: 300 } })]))).toEqual({ status: "paint", rects: [{ x: 0, y: 20, width: 360, height: 300 }] });
    expect(plan(screen([node({ text: "Play" }), node({ surface: "yes" })]))).toEqual({ status: "withheld", reason: "unreadable_screen" });
  });
  it("a value before its label (a hint shown above a value) and an accessibility label as the visible one read as a label and value too", () => {
    expect(plan(screen([node({ text: "abcd1234", hint: "token:" })]))).toEqual({ status: "withheld", reason: "masked_content" });
    expect(plan(screen([node({ description: "Password:" }), node({ text: "hunter22" })]))).toEqual({ status: "withheld", reason: "masked_content" });
    expect(plan(screen([node({ description: "Close" }), node({ text: "Welcome back" })]))).toMatchObject({ status: "paint" });
  });
  it("the painted area is bounded: rectangles that cover the frame more than four times over withhold the screen, and four times is allowed", () => {
    const full = { x: 0, y: 0, width: 360, height: 640 };
    const stack = (n: number) => screen([node({ text: "hi" }), ...Array.from({ length: n }, () => node({ secure: true, bounds: full }))]);
    expect(plan(stack(4))).toMatchObject({ status: "paint" });
    expect(plan(stack(5))).toEqual({ status: "withheld", reason: "masked_content" });
    expect(plan(stack(DEVICE_EVIDENCE_TREE_NODES_MAX - 1))).toEqual({ status: "withheld", reason: "masked_content" });
  });
  it("the maskIds option can only add: a bad one is ignored and the defaults stay", () => {
    expect(plan(screen([node({ id: "a", secure: true }), node({ id: "b", text: "x" })]), { maskIds: 3 })).toMatchObject({ status: "paint", rects: [{ x: 10 }] });
    expect(plan(screen([node({ id: "b", text: "x" })]), { maskIds: [3, "b"] })).toMatchObject({ status: "paint", rects: [{ x: 10 }] });
  });
  it("with fixture data only switched on, a screen with no readable text is shown unmasked, but a screen with a match it cannot paint is still withheld", () => {
    expect(plan(null, { fixtureDataOnly: true })).toEqual({ status: "unmasked" });
    expect(plan(screen([node({})]), { fixtureDataOnly: true })).toEqual({ status: "unmasked" });
    // Some of it painted, the rest shown under the waiver: counted as unmasked.
    expect(plan(screen([node({ secure: true })]), { fixtureDataOnly: true })).toEqual({ status: "paint", rects: [{ x: 10, y: 10, width: 200, height: 40 }], unmasked: true });
    expect(plan(screen([node({ webView: true })]), { fixtureDataOnly: true })).toMatchObject({ status: "paint", unmasked: true });
    expect(plan(screen([node({ text: "hi" })]), { fixtureDataOnly: true })).not.toHaveProperty("unmasked");
    expect(plan({ nope: 1 }, { fixtureDataOnly: true })).toEqual({ status: "withheld", reason: "unreadable_screen" });
    expect(plan(screen([node({ text: "ok" }), { text: email }]), { fixtureDataOnly: true })).toEqual({ status: "withheld", reason: "masked_content" });
    expect(plan(null, { fixtureDataOnly: "true" })).toEqual({ status: "withheld", reason: "unreadable_screen" });
    expect(plan(null)).toEqual({ status: "withheld", reason: "unreadable_screen" });
  });
  it("finishes a customer-sized tree within a bounded time", () => {
    const nodes = Array.from({ length: DEVICE_EVIDENCE_TREE_NODES_MAX }, (_, i) => node({ text: `${"a.".repeat(10)}${i}`, description: "x ".repeat(3), bounds: { x: 0, y: i % 600, width: 10, height: 10 } }));
    const started = performance.now();
    expect(plan(screen(nodes)).status).toBe("paint");
    expect(performance.now() - started).toBeLessThan(5_000);
  });
  it("a screen with more visible text than the masks scan (200,000 characters) is withheld whole, never half checked", () => {
    const nodes = Array.from({ length: 50 }, () => node({ text: "word ".repeat(900) }));
    expect(plan(screen(nodes))).toEqual({ status: "withheld", reason: "masked_content" });
    expect(plan(screen(nodes.slice(0, 40)))).toMatchObject({ status: "paint" });
  });
});

describe("caps", () => {
  it("reuses the pack's JPEG cap, and bounds a run", () => {
    expect(DEVICE_EVIDENCE_SCREENSHOT_MAX_BYTES).toBe(EVIDENCE_ARTIFACT_MAX_BYTES.jpeg);
    expect(DEVICE_EVIDENCE_SCREENSHOT_MAX_BYTES).toBe(512 * 1_024);
    expect(DEVICE_EVIDENCE_TOTAL_MAX_BYTES).toBe(8 * 1_048_576);
    expect([DEVICE_EVIDENCE_FLOWS_MAX, DEVICE_EVIDENCE_STEPS_MAX, DEVICE_EVIDENCE_FRAME_PIXELS_MAX]).toEqual([5, 6, 8_000_000]);
    // 5 flows x 6 steps x 2 sides stays inside the pack's own pair cap.
    expect(DEVICE_EVIDENCE_FLOWS_MAX * DEVICE_EVIDENCE_STEPS_MAX).toBeLessThanOrEqual(50);
  });
});

const shown: DeviceEvidenceOutcome = {
  device: "fake", isolation: "sandbox", durationMs: 4_200, unmasked: 0, notShown: [{ flow: "profile", reason: "over_flow_cap" }], moreNotShown: 0,
  steps: [
    { flow: "checkout", step: "open", status: "shown", before: jpeg("a"), after: jpeg("b") },
    { flow: "checkout", step: "submit", status: "not_run", reason: "step_failed" },
    { flow: "settings", step: "open", status: "not_run", reason: "masked_content" },
  ],
};
const basePack = (): EvidencePackV2 => ({
  schemaVersion: 2, candidate: { digest: sha("c"), repositories: [] }, producer: { edition: "code", isolation: "sandbox" }, level: { reached: "sandbox_only", required: [] }, result: "verified",
  checks: [{ id: "unit", kind: "test", label: "Unit tests", before: "failed", after: "passed", class: "fixed", durationMs: 10 }], notTested: [],
});

describe("the evidence-pack check", () => {
  it("is a `visual` check, run by Rovara, labelled as a fake device, with one before/after pair per shown step and a not-tested row for each other step", () => {
    const { check, notTested } = deviceEvidenceCheck(shown);
    expect(check).toEqual({ id: DEVICE_EVIDENCE_CHECK_ID, kind: "visual", label: "Device evidence: fake device, not a real run", stage: "sandbox", runBy: "rovara", before: "passed", after: "passed",
      class: "not_rerun", durationMs: 4_200, pairs: [{ id: "checkout/open", before: jpeg("a"), after: jpeg("b") }] });
    expect(notTested).toEqual([
      { what: "Device evidence: checkout/submit", reason: "Not run: the step did not complete" },
      { what: "Device evidence: settings/open", reason: "Not run: withheld, it may show a secret or personal data" },
      { what: "Device evidence: profile", reason: "Not shown: more changed flows than the cap" },
    ]);
    expect(EvidencePackV2Schema.safeParse(addDeviceEvidenceToPack(basePack(), shown)).success).toBe(true);
    expect(deviceEvidenceCheck({ ...shown, isolation: "developer_machine" }).check.stage).toBeUndefined();
  });
  it("says what the device was in the label, for every kind", () => {
    expect(deviceEvidenceCheck({ ...shown, device: "android_emulator" }).check.label).toBe("Device evidence: Android emulator");
    expect(deviceEvidenceCheck({ ...shown, device: "ios_simulator", isolation: "developer_machine" }).check.label).toBe("Device evidence: iOS simulator");
  });
  it("a run that showed nothing is `not_run` with no pairs, and a whole-run reason becomes one not-tested row", () => {
    const { check, notTested } = deviceEvidenceCheck({ device: "fake", isolation: "sandbox", durationMs: 0, steps: [], notShown: [], moreNotShown: 0, unmasked: 0, notRun: "app_did_not_build" });
    expect(check).toMatchObject({ kind: "visual", before: "not_run", after: "not_run", class: "not_rerun" });
    expect(check.pairs).toBeUndefined();
    expect(notTested).toEqual([{ what: "Device evidence", reason: "Not run: the app did not build" }]);
  });
  it("NEVER counts toward the proof: the kind is visual, the registry says so, the hold rule ignores it, and a fake device cannot be anything else", () => {
    for (const device of ["fake", "android_emulator"] as const) expect(deviceEvidenceCheck({ ...shown, device }).check.kind).toBe("visual");
    expect(checkKindInfo("visual")?.countsTowardProof).toBe(false);
    const proof: TestProof = { schemaVersion: 1, candidateDigest: sha("d"), status: "checked", note: "completed", changedTests: { added: 1, changed: 0, deleted: 0 }, durationMs: 10,
      items: [{ checkId: DEVICE_EVIDENCE_CHECK_ID, label: "Device evidence", granularity: "check", verdict: "proves_change", reason: "assertion_failed_on_old" }] };
    // Positive control: the same entry under a kind that counts is a proven change.
    expect(proofHolds({ facts: { proof, checkKinds: { [DEVICE_EVIDENCE_CHECK_ID]: "e2e" } }, mode: "hold" }).provenCount).toBe(1);
    expect(proofHolds({ facts: { proof, checkKinds: { [DEVICE_EVIDENCE_CHECK_ID]: deviceEvidenceCheck(shown).check.kind } }, mode: "hold" }).provenCount).toBe(0);
  });
  it("refuses an outcome it does not understand rather than writing a guess", () => {
    for (const bad of [{ ...shown, isolation: "imported" }, { ...shown, device: "phone" }, { ...shown, steps: [{ flow: "a", step: "b", status: "maybe" }] },
      { ...shown, steps: [{ flow: "a", step: "b", status: "not_run", reason: "because" }] }, { ...shown, steps: [shown.steps[0], shown.steps[0]] },
      { ...shown, steps: Array.from({ length: 31 }, (_, i) => ({ flow: `f${i}`, step: "s", status: "not_run", reason: "step_failed" })) },
      { ...shown, steps: [{ flow: "a", step: "b", status: "shown", before: jpeg("a", EVIDENCE_ARTIFACT_MAX_BYTES.jpeg + 1), after: jpeg("b") }] },
      { ...shown, steps: [{ flow: "a", step: "b", status: "shown", before: { ...jpeg("a"), kind: "png" }, after: jpeg("b") }] },
      // An iOS simulator is not run in a sandbox, ever; and a whole-run reason has no steps.
      { ...shown, device: "ios_simulator", isolation: "sandbox" }, { ...shown, notRun: "app_did_not_build" }, { ...shown, unmasked: -1 }, { ...shown, unmasked: 5 }]) {
      expect(() => deviceEvidenceCheck(bad as never), JSON.stringify(bad).slice(0, 100)).toThrow("device evidence outcome is not valid");
    }
  });
});

describe("the pull request's lines", () => {
  it("use the plan's words for where it ran and for never-proof, and say fake device in plain words", () => {
    expect(DEVICE_EVIDENCE_NOT_PROOF_WORDS).toBe("Visual evidence only: it does not count as change proof.");
    expect(DEVICE_EVIDENCE_DEVICE_WORDS).toEqual({
      fake: { sandbox: "Ran on a fake device (a test stand-in, not a real run)", developer_machine: "Ran on a fake device (a test stand-in, not a real run)" },
      android_emulator: { sandbox: "Ran on an Android emulator in Rovara's sandbox", developer_machine: "Ran on an Android emulator on a developer machine, not in a sandbox" },
      ios_simulator: { developer_machine: "Ran on an iOS simulator on a developer machine, not in a sandbox" },
    });
    expect(deviceEvidenceLines(shown, {})[0]).toBe("Device evidence: Ran on a fake device (a test stand-in, not a real run). Visual evidence only: it does not count as change proof.");
  });
  it("list each step, carry the never-proof words on every picture line, and never carry an image or a public link", () => {
    const lines = deviceEvidenceLines(shown, { taskLink: "https://rovara.example/tasks/t-1" });
    expect(lines).toEqual([
      "Device evidence: Ran on a fake device (a test stand-in, not a real run). Visual evidence only: it does not count as change proof.",
      "- `checkout/open`: before and after screenshots (view behind sign-in: https://rovara.example/tasks/t-1). Fake device, not a real run. Visual evidence only: it does not count as change proof.",
      "- `checkout/submit`: Not run: the step did not complete",
      "- `settings/open`: Not run: withheld, it may show a secret or personal data",
      "- `profile`: Not shown: more changed flows than the cap",
    ]);
    expect(lines.join("\n")).not.toMatch(/!\[|<img|\.jpe?g|sha256|X-Amz|Signature=/iu);
    for (const line of lines.filter((row) => row.includes("screenshots"))) expect(line).toContain(DEVICE_EVIDENCE_NOT_PROOF_WORDS);
  });
  it("say where a real run happened, fall back to the task page words with no or a bad link, and say how many screens were shown unmasked", () => {
    const real = deviceEvidenceLines({ ...shown, device: "android_emulator", unmasked: 1 }, {});
    expect(real[0]).toBe(`Device evidence: Ran on an Android emulator in Rovara's sandbox. ${DEVICE_EVIDENCE_NOT_PROOF_WORDS}`);
    expect(real[1]).toBe(`- \`checkout/open\`: before and after screenshots (on the task page, behind sign-in). ${DEVICE_EVIDENCE_NOT_PROOF_WORDS}`);
    expect(real).toContain("- 1 screen shown unmasked: fixture data only");
    const two: DeviceEvidenceOutcome = { ...shown, device: "android_emulator", unmasked: 2, steps: [shown.steps[0]!, { flow: "checkout", step: "submit", status: "shown", before: jpeg("c"), after: jpeg("d") }] };
    expect(deviceEvidenceLines(two, {})).toContain("- 2 screens shown unmasked: fixture data only");
    for (const taskLink of ["javascript:alert(1)", "http://rovara.example/t", "https://x.example/a b", `https://x.example/${"a".repeat(400)}`]) {
      expect(deviceEvidenceLines(shown, { taskLink })[1], taskLink).toContain("(on the task page, behind sign-in)");
    }
  });
  it("a run that did not happen says Not run with its fixed reason, and the words never echo input", () => {
    expect(deviceEvidenceLines({ device: "ios_simulator", isolation: "developer_machine", durationMs: 0, steps: [], notShown: [], moreNotShown: 0, unmasked: 0, notRun: "needs_macos" }, {})).toEqual([
      `Device evidence: Ran on an iOS simulator on a developer machine, not in a sandbox. ${DEVICE_EVIDENCE_NOT_PROOF_WORDS}`,
      "- Not run: needs macOS (your CI is not connected)",
    ]);
    for (const words of Object.values(DEVICE_EVIDENCE_NOT_RUN_WORDS)) expect(words).toMatch(/^[a-z][A-Za-z ,:()-]+$/u);
    expect(Object.keys(DEVICE_EVIDENCE_NOT_RUN_WORDS).sort()).toEqual([...DEVICE_EVIDENCE_NOT_RUN_REASONS].sort());
    expect(() => deviceEvidenceLines({ ...shown, steps: [{ flow: "a`<x>", step: "b", status: "not_run", reason: "step_failed" }] } as never, {})).toThrow("device evidence outcome is not valid");
  });
  it("count the flows beyond the not-shown list", () => {
    expect(deviceEvidenceLines({ ...shown, steps: [], notShown: [], moreNotShown: 7 }, {}).at(-1)).toBe("- 7 more changed flows not shown: more changed flows than the cap");
  });
});

describe("the runner's result, checked whole before anything is stored", () => {
  const bytes = (size: number) => { const out = new Uint8Array(size); out.set([0xff, 0xd8, 0xff]); return out; };
  const shot = (c: string, size = 500) => ({ sha256: sha(c), bytes: bytes(size) });
  const captured = (steps: unknown[]) => ({ device: "fake", isolation: "sandbox", durationMs: 1, unmasked: 0, notShown: [], moreNotShown: 0, steps });
  const row = (flow: string, c: string, size?: number) => ({ flow, step: "open", status: "shown", before: shot(c, size), after: shot("f", size) });
  it("accepts a run inside the caps and refuses one outside them", () => {
    expect(() => checkedDeviceEvidenceCaptured(captured([row("a", "a")]))).not.toThrow();
    const big = DEVICE_EVIDENCE_SCREENSHOT_MAX_BYTES;
    // 8 MiB / 512 KiB = 16 pictures: 8 shown steps fit, a ninth does not.
    const steps = (n: number) => Array.from({ length: n }, (_, i) => ({ flow: `f${i % 5}`, step: `s${Math.floor(i / 5)}`, status: "shown", before: shot("a", big), after: shot("b", big) }));
    expect(() => checkedDeviceEvidenceCaptured(captured(steps(8)))).not.toThrow();
    expect(() => checkedDeviceEvidenceCaptured(captured(steps(9)))).toThrow("device evidence outcome is not valid");
    expect(() => checkedDeviceEvidenceCaptured(captured([{ ...row("a", "a"), before: shot("a", big + 1) }]))).toThrow("device evidence outcome is not valid");
    expect(() => checkedDeviceEvidenceCaptured(captured([{ ...row("a", "a"), before: { sha256: "x", bytes: bytes(5) } }]))).toThrow("device evidence outcome is not valid");
    expect(() => checkedDeviceEvidenceCaptured({ ...captured([]), device: "phone" })).toThrow("device evidence outcome is not valid");
  });
});

describe("absent = today's behaviour, byte for byte", () => {
  it("with no device evidence the pack is the same object, the same bytes, and the PR gets no line", () => {
    const pack = basePack();
    const before = JSON.stringify(pack);
    expect(addDeviceEvidenceToPack(pack, undefined)).toBe(pack);
    expect(JSON.stringify(addDeviceEvidenceToPack(pack, undefined))).toBe(before);
    expect(deviceEvidenceLines(undefined, {})).toEqual([]);
  });
  it("adding it never touches the other checks or rows", () => {
    const pack = basePack();
    const before = JSON.stringify(pack);
    const added = addDeviceEvidenceToPack(pack, shown);
    expect(JSON.stringify(pack)).toBe(before);
    expect(added.checks.slice(0, 1)).toEqual(pack.checks);
    expect(added.checks).toHaveLength(2);
    expect(added.result).toBe(pack.result);
    expect(added.level).toEqual(pack.level);
  });
  it("refuses to add it twice, or to a pack whose producer says another place than the outcome", () => {
    expect(() => addDeviceEvidenceToPack(addDeviceEvidenceToPack(basePack(), shown), shown)).toThrow("device evidence outcome is not valid");
    expect(() => addDeviceEvidenceToPack({ ...basePack(), producer: { edition: "code", isolation: "developer_machine" } }, shown)).toThrow("device evidence outcome is not valid");
  });
});
