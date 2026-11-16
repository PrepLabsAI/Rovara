// Device testing slice 4: the contract half of running on a developer machine. The opt-in (exactly the words "not in a sandbox", in the recipe, with the project's switch), the iOS bundle identifier and
// .app folder in the recipe, the new fixed reason, and the pull request's extra line for a run on a developer machine. Everything slice 1 says about the absent case stays byte for byte.
import { describe, expect, it } from "vitest";
import {
  DEVICE_EVIDENCE_APP_ID, DEVICE_EVIDENCE_BUNDLE_ID, DEVICE_EVIDENCE_HOST_WORDS, DEVICE_EVIDENCE_NOT_RUN_REASONS, DEVICE_EVIDENCE_NOT_RUN_WORDS, DEVICE_HOST_RUN_ACK, DEVICE_HOST_RUN_WARNING,
  DeviceEvidenceRecipeSchema, deviceEvidenceLines, deviceHostRunAllowed, type DeviceEvidenceOutcome,
} from "../../packages/contracts/src/device-evidence.js";
import { maestroLaunchFlow, maestroStepFlow } from "../../packages/verifier/src/executor/device-maestro.js";

const ON = { status: "resolved", values: { device_evidence: { value: "on", origin: "changed_here" } } };
const recipe = (over: Record<string, unknown> = {}) => ({
  platform: "ios", buildCommand: "xcodebuild -scheme App", appFile: "build/App.app", appId: "io.rovara.fixture-app", flows: [{ id: "main", files: ["App/**"], steps: [{ id: "open", label: "Open" }] }], ...over,
});
const jpeg = (c: string) => ({ kind: "jpeg" as const, sha256: c.repeat(64), bytes: 1_000, retentionClass: "evidence-std" as const });
const shown = (device: DeviceEvidenceOutcome["device"], isolation: DeviceEvidenceOutcome["isolation"]): DeviceEvidenceOutcome =>
  ({ device, isolation, durationMs: 5, steps: [{ flow: "main", step: "open", status: "shown", before: jpeg("a"), after: jpeg("b") }], notShown: [], moreNotShown: 0, unmasked: 0 });

describe("the opt-in", () => {
  it("is exactly the words the evidence carries, and the warning is plain words that say what it means", () => {
    expect(DEVICE_HOST_RUN_ACK).toBe("not in a sandbox");
    expect(DEVICE_HOST_RUN_WARNING).toContain("not in a sandbox");
    expect(DEVICE_HOST_RUN_WARNING).toMatch(/files/u);
    expect(DEVICE_HOST_RUN_WARNING).toMatch(/network/u);
    expect(DEVICE_HOST_RUN_WARNING).not.toMatch(/[—–]/u);
  });
  it("is allowed only with the project's switch on AND the recipe's own words, and then gives the checked recipe back", () => {
    const got = deviceHostRunAllowed({ policy: ON, recipe: recipe({ outsideSandbox: DEVICE_HOST_RUN_ACK }) });
    expect(got).toMatchObject({ allowed: true, recipe: { platform: "ios", outsideSandbox: "not in a sandbox" } });
  });
  it("is refused as 'not switched on' when the switch is off or not exactly on, or the recipe has no opt-in or any other words", () => {
    const off = [undefined, null, {}, "on", { status: "refused", values: {} }, { status: "resolved", values: { device_evidence: { value: "off" } } }, { status: "resolved", values: { device_evidence: { value: "ON" } } }, { status: "disabled", values: { device_evidence: { value: "on" } } }];
    for (const policy of off) expect(deviceHostRunAllowed({ policy, recipe: recipe({ outsideSandbox: DEVICE_HOST_RUN_ACK }) }), JSON.stringify(policy)).toEqual({ allowed: false, reason: "host_run_not_allowed" });
    for (const outsideSandbox of [undefined, null, true, 1, "yes", "Not in a sandbox", " not in a sandbox", "not in a sandbox.", ["not in a sandbox"], { value: "not in a sandbox" }]) {
      expect(deviceHostRunAllowed({ policy: ON, recipe: recipe({ outsideSandbox }) }), JSON.stringify(outsideSandbox)).toEqual({ allowed: false, reason: "host_run_not_allowed" });
    }
  });
  it("does not count an opt-in the recipe only inherits (a polluted prototype), and a recipe or policy that throws when read is not an opt-in", () => {
    const inherited = Object.assign(Object.create({ outsideSandbox: DEVICE_HOST_RUN_ACK }) as object, recipe());
    expect(Object.hasOwn(inherited, "outsideSandbox")).toBe(false);
    expect(deviceHostRunAllowed({ policy: ON, recipe: inherited })).toEqual({ allowed: false, reason: "host_run_not_allowed" });
    const polluted = Object.prototype as Record<string, unknown>;
    polluted["outsideSandbox"] = DEVICE_HOST_RUN_ACK;
    try { expect(deviceHostRunAllowed({ policy: ON, recipe: recipe() }).allowed).toBe(false); } finally { delete polluted["outsideSandbox"]; }
    const throwing = { ...recipe(), get flows(): never { throw new Error("boom"); } };
    expect(() => deviceHostRunAllowed({ policy: ON, recipe: throwing })).not.toThrow();
    expect(deviceHostRunAllowed({ policy: ON, recipe: throwing }).allowed).toBe(false);
    const proxy = new Proxy({}, { get() { throw new Error("boom"); }, ownKeys() { throw new Error("boom"); } });
    expect(deviceHostRunAllowed({ policy: ON, recipe: proxy }).allowed).toBe(false);
    expect(deviceHostRunAllowed({ policy: proxy, recipe: recipe({ outsideSandbox: DEVICE_HOST_RUN_ACK }) }).allowed).toBe(false);
  });
  it("is 'no recipe' for a recipe that is not valid, whatever the switch says, and never throws", () => {
    for (const bad of [undefined, null, 5, "x", [], {}, recipe({ flows: [] }), recipe({ platform: "windows" }), recipe({ extra: 1 })]) {
      expect(deviceHostRunAllowed({ policy: ON, recipe: bad }), JSON.stringify(bad)).toEqual({ allowed: false, reason: "no_recipe" });
    }
    expect(() => deviceHostRunAllowed({} as never)).not.toThrow();
    expect(deviceHostRunAllowed({ policy: ON, recipe: Object.create({ platform: "ios" }) as unknown })).toEqual({ allowed: false, reason: "no_recipe" });
  });
});

describe("the recipe", () => {
  it("takes an iOS bundle identifier (a hyphen is allowed in it), and an Android application id still takes no hyphen", () => {
    expect(DeviceEvidenceRecipeSchema.safeParse(recipe()).success).toBe(true);
    expect(DeviceEvidenceRecipeSchema.safeParse(recipe({ appId: "com.my-company.app-2" })).success).toBe(true);
    expect(DeviceEvidenceRecipeSchema.safeParse(recipe({ platform: "android", appFile: "app.apk", appId: "io.rovara.fixture" })).success).toBe(true);
    expect(DeviceEvidenceRecipeSchema.safeParse(recipe({ platform: "android", appFile: "app.apk", appId: "io.rovara.fixture-app" })).success).toBe(false);
    expect(DEVICE_EVIDENCE_APP_ID.test("io.rovara.fixture-app")).toBe(false);
    expect(DEVICE_EVIDENCE_BUNDLE_ID.test("io.rovara.fixture-app")).toBe(true);
  });
  it("refuses a bundle identifier with something else in it", () => {
    for (const over of [{ appId: "app" }, { appId: "io.x y" }, { appId: "io.x\n---" }, { appId: "io.x;rm" }, { appId: "io.x\"y" }, { appId: "-io.x" }]) {
      expect(DeviceEvidenceRecipeSchema.safeParse(recipe(over)).success, JSON.stringify(over)).toBe(false);
    }
  });
  it("leaves an Android recipe from slice 2 exactly as it was (no opt-in needed to be valid)", () => {
    const old = { platform: "android", buildCommand: "./gradlew assembleDebug", appFile: "app/build/outputs/apk/debug/app-debug.apk", appId: "io.rovara.fixture", flows: [{ id: "a", files: ["**"], steps: [{ id: "s", label: "S" }] }] };
    const parsed = DeviceEvidenceRecipeSchema.safeParse(old);
    expect(parsed.success).toBe(true);
    expect(parsed.success && "outsideSandbox" in parsed.data).toBe(false);
  });
});

describe("the new reason", () => {
  it("is a fixed word, listed with the others, and says nothing of the project's own words", () => {
    expect(DEVICE_EVIDENCE_NOT_RUN_REASONS).toContain("host_run_not_allowed");
    expect(DEVICE_EVIDENCE_NOT_RUN_WORDS.host_run_not_allowed).toBe("running on this machine is not switched on for this project");
  });
});

describe("the pull request's lines for a run on a developer machine", () => {
  it("add one line that says the network was this machine's, for a real device that ran", () => {
    const android = deviceEvidenceLines(shown("android_emulator", "developer_machine"), {});
    expect(android.at(-1)).toBe(`- ${DEVICE_EVIDENCE_HOST_WORDS.android_emulator}`);
    expect(android[0]).toBe("Device evidence: Ran on an Android emulator on a developer machine, not in a sandbox. Visual evidence only: it does not count as change proof.");
    const ios = deviceEvidenceLines(shown("ios_simulator", "developer_machine"), {});
    expect(ios.at(-1)).toBe(`- ${DEVICE_EVIDENCE_HOST_WORDS.ios_simulator}`);
    expect(ios.filter((line) => line.includes("outside a sandbox"))).toHaveLength(1);
  });
  it("add nothing for a run in the sandbox, a fake device, or a run that did not happen (byte for byte what slice 1 wrote)", () => {
    expect(deviceEvidenceLines(shown("android_emulator", "sandbox"), {}).join("\n")).not.toMatch(/Network not restricted|outside a sandbox/u);
    expect(deviceEvidenceLines(shown("fake", "developer_machine"), {}).join("\n")).not.toMatch(/Network not restricted|outside a sandbox/u);
    const none: DeviceEvidenceOutcome = { device: "ios_simulator", isolation: "developer_machine", durationMs: 0, steps: [], notShown: [], moreNotShown: 0, unmasked: 0, notRun: "host_run_not_allowed" };
    expect(deviceEvidenceLines(none, {})).toEqual(["Device evidence: Ran on an iOS simulator on a developer machine, not in a sandbox. Visual evidence only: it does not count as change proof.", "- Not run: running on this machine is not switched on for this project"]);
  });
});

describe("Maestro flows for iOS", () => {
  it("quote the bundle identifier (all digits and dots would read as a number) and keep the same launch from a clean state with every permission denied", () => {
    expect(maestroLaunchFlow("io.rovara.fixture-app", "ios")).toBe('appId: "io.rovara.fixture-app"\n---\n- launchApp:\n    clearState: true\n    stopApp: true\n    permissions:\n      all: deny\n');
    expect(maestroLaunchFlow("1.2", "ios")).toMatch(/^appId: "1\.2"\n/u);
    expect(maestroStepFlow("io.x.y", [{ do: "tap_text", text: "Go" }], "ios")).toBe('appId: "io.x.y"\n---\n- tapOn:\n    text: "Go"\n');
    expect(maestroStepFlow("io.x.y", [], "ios")).toBeNull();
  });
  it("leave Android's flows exactly as they were (unquoted, no hyphen)", () => {
    expect(maestroLaunchFlow("io.rovara.fixture")).toMatch(/^appId: io\.rovara\.fixture\n---\n/u);
    expect(() => maestroLaunchFlow("io.rovara.fixture-app")).toThrow("the application id is not valid");
    expect(() => maestroLaunchFlow("io.rovara.fixture-app", "android")).toThrow("the application id is not valid");
  });
  it("refuse an identifier that is not valid for the platform, and an action that is not one of the eight", () => {
    for (const bad of ["app", "io.x\n---\n- runScript: x", "io.x y", "", "io.x\"", 5 as unknown as string]) expect(() => maestroLaunchFlow(bad, "ios"), String(bad)).toThrow("the application id is not valid");
    expect(() => maestroStepFlow("io.x.y", [{ do: "runScript", script: "x" }], "ios")).toThrow();
    expect(() => maestroStepFlow("io.x.y", [{ do: "input", text: "${x}" }], "ios")).toThrow();
  });
});
