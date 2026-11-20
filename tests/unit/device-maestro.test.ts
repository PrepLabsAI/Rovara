// Device testing slice 2: the Maestro flow content. A step's actions (eight fixed ones) become the YAML of one flow; nothing the recipe says can become another Maestro command, and the flow
// starts the app from a clean state with every permission denied.
import { parseAllDocuments } from "yaml";
import { describe, expect, it } from "vitest";
import { maestroLaunchFlow, maestroStepFlow } from "../../packages/verifier/src/executor/device-maestro.js";
import { DEVICE_EVIDENCE_ACTIONS_MAX, DeviceEvidenceRecipeSchema, pickChangedFlows } from "../../packages/contracts/src/device-evidence.js";

const APP = "io.rovara.fixture";
/** The two YAML documents of a Maestro flow: the header (appId) and the list of commands. */
const parsed = (text: string) => parseAllDocuments(text).map((doc) => { expect(doc.errors).toEqual([]); return doc.toJS() as unknown; });

describe("maestroLaunchFlow", () => {
  it("refuses an application id that is not a dotted name (it is the one thing written unquoted)", () => {
    for (const bad of ["", "app", "io.rovara.\nrunScript: x", "io.rovara.fixture\n---\n- runFlow: x", "io rovara", "io..rovara", "1io.rovara", "io.rovara.fixture ", "a".repeat(300)]) expect(() => maestroLaunchFlow(bad), bad).toThrow("the application id is not valid");
  });
});

describe("maestroStepFlow", () => {
  it("writes each of the eight actions as one Maestro command", () => {
    const text = maestroStepFlow(APP, [
      { do: "tap_text", text: "Continue" }, { do: "tap_id", id: "io.rovara.fixture:id/next" }, { do: "input", text: "hello world" }, { do: "wait_text", text: "Step two" }, { do: "wait_id", id: "title" },
      { do: "scroll" }, { do: "back" }, { do: "hide_keyboard" },
    ]);
    expect(parsed(text!)).toEqual([{ appId: APP }, [
      { tapOn: { text: "Continue" } }, { tapOn: { id: "io\\.rovara\\.fixture:id/next" } }, { inputText: "hello world" }, { assertVisible: { text: "Step two" } }, { assertVisible: { id: "title" } },
      "scroll", "back", "hideKeyboard",
    ]]);
  });

  it("writes the three Unicode line breaks as escapes, never raw (a YAML 1.1 reader ends a line at them)", () => {
    const breaks = ["\u0085", "\u2028", "\u2029"].map((char) => `a${char}b`);
    const text = maestroStepFlow(APP, [{ do: "input", text: breaks[1]! }, { do: "input", text: breaks[2]! }])!;
    expect(text).not.toMatch(/[\u2028\u2029\u0085]/u);
    expect(text).toContain("a\\u2028b");
    expect(text).toContain("a\\u2029b");
  });

  it("the recipe accepts at most ten actions a step, only the eight, and a recipe without actions or an app id reads as it always did", () => {
    const flow = (actions?: unknown[]) => ({ id: "go", files: ["app/**"], steps: [{ id: "open", label: "Open", ...(actions === undefined ? {} : { actions }) }] });
    const recipe = (extra: Record<string, unknown> = {}, actions?: unknown[]) => ({ platform: "android", buildCommand: "./gradlew assembleDebug", appFile: "app/build/app.apk", flows: [flow(actions)], ...extra });
    expect(DeviceEvidenceRecipeSchema.safeParse(recipe()).success).toBe(true);
    expect(DeviceEvidenceRecipeSchema.parse(recipe())).toEqual(recipe());
    expect(DeviceEvidenceRecipeSchema.safeParse(recipe({ appId: APP }, Array.from({ length: DEVICE_EVIDENCE_ACTIONS_MAX }, () => ({ do: "back" })))).success).toBe(true);
    expect(DeviceEvidenceRecipeSchema.safeParse(recipe({}, Array.from({ length: DEVICE_EVIDENCE_ACTIONS_MAX + 1 }, () => ({ do: "back" })))).success).toBe(false);
    expect(DeviceEvidenceRecipeSchema.safeParse(recipe({}, [{ do: "run_script", text: "x" }])).success).toBe(false);
    expect(DeviceEvidenceRecipeSchema.safeParse(recipe({ appId: "not an id" })).success).toBe(false);
    expect(DeviceEvidenceRecipeSchema.safeParse(recipe({ appId: "io.rovara.fixture\nx" })).success).toBe(false);
  });

  it("a picked flow carries its steps' actions, and a flow without any is picked exactly as before", () => {
    const withActions = { platform: "android", buildCommand: "b", appFile: "a.apk", appId: APP, flows: [{ id: "go", files: ["app/**"], steps: [{ id: "open", label: "Open", actions: [{ do: "tap_text", text: "Go" }] }, { id: "end", label: "End" }] }] };
    expect(pickChangedFlows({ changedFiles: ["app/x.kt"], recipe: withActions })).toMatchObject({ status: "picked", flows: [{ id: "go", steps: [{ id: "open", label: "Open", actions: [{ do: "tap_text", text: "Go" }] }, { id: "end", label: "End" }] }] });
    const plain = pickChangedFlows({ changedFiles: ["app/x.kt"], recipe: { ...withActions, appId: undefined, flows: [{ id: "go", files: ["app/**"], steps: [{ id: "open", label: "Open" }] }] } });
    expect(plain).toEqual({ status: "picked", flows: [{ id: "go", steps: [{ id: "open", label: "Open" }] }], notShown: [], moreNotShown: 0 });
    expect(Object.keys((plain as { flows: Array<{ steps: object[] }> }).flows[0]!.steps[0]!)).toEqual(["id", "label"]);
  });
});
