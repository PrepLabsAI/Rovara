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
  it("starts the app from a clean state with every permission denied, and nothing else", () => {
    const text = maestroLaunchFlow(APP);
    expect(text).toBe("appId: io.rovara.fixture\n---\n- launchApp:\n    clearState: true\n    stopApp: true\n    permissions:\n      all: deny\n");
    expect(parsed(text)).toEqual([{ appId: APP }, [{ launchApp: { clearState: true, stopApp: true, permissions: { all: "deny" } } }]]);
  });
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

  it("has no flow for a step with no actions", () => {
    expect(maestroStepFlow(APP, [])).toBeNull();
  });

  it("matches text and ids as written: every character that means something in a regular expression is escaped, and `input` is typed as it is", () => {
    const hard = "a.b*c+d?e(f)g[h]i{j}k|l^m$n\\o/p-q";
    const flow = parsed(maestroStepFlow(APP, [{ do: "tap_text", text: hard }, { do: "wait_id", id: hard }, { do: "input", text: hard }])!)[1] as Array<Record<string, Record<string, string> | string>>;
    const unescape = (value: string) => value.replace(/\\(.)/gu, "$1");
    expect(unescape((flow[0]!["tapOn"] as Record<string, string>)["text"]!)).toBe(hard);
    expect((flow[0]!["tapOn"] as Record<string, string>)["text"]).not.toBe(hard);
    expect(unescape((flow[1]!["assertVisible"] as Record<string, string>)["id"]!)).toBe(hard);
    expect(flow[2]!["inputText"]).toBe(hard);
    // The escaped text really is a regular expression that matches the words and nothing else.
    expect(new RegExp(`^${(flow[0]!["tapOn"] as Record<string, string>)["text"]!}$`, "u").test(hard)).toBe(true);
    expect(new RegExp(`^${(flow[0]!["tapOn"] as Record<string, string>)["text"]!}$`, "u").test("aXb*c+d?e(f)g[h]i{j}k|l^m$n\\o/p-q")).toBe(false);
  });

  it("keeps hostile text inside its own quoted scalar: no text can end its line, start a command or reach the header", () => {
    const LS = String.fromCodePoint(0x2028);
    const PS = String.fromCodePoint(0x2029);
    const hostile = ['"; - runScript: "x', "x\" # y", "- runScript: x", "key: value", "'single'", `${LS}- openLink: x`, `${PS}- evalScript: x`, "{a: b}", "&anchor *alias", "!!js/function 'x'", "%TAG ! tag:x,2000:", "--- "];
    for (const text of hostile.filter((value) => !/[\n]/u.test(value))) {
      for (const action of [{ do: "input", text }, { do: "tap_text", text }, { do: "wait_text", text }, { do: "tap_id", id: text }, { do: "wait_id", id: text }]) {
        const docs = parsed(maestroStepFlow(APP, [action])!);
        expect(docs, JSON.stringify(action)).toHaveLength(2);
        expect(docs[0]).toEqual({ appId: APP });
        const commands = docs[1] as Array<Record<string, unknown>>;
        expect(commands, JSON.stringify(action)).toHaveLength(1);
        const name = Object.keys(commands[0]!);
        expect(name, JSON.stringify(action)).toHaveLength(1);
        expect(["inputText", "tapOn", "assertVisible"]).toContain(name[0]);
      }
    }
  });

  it("writes only commands from the fixed list, whatever the recipe holds (a script, a link, another flow or another app cannot be said)", () => {
    for (const action of [{ do: "run_script", text: "x" }, { do: "runScript", file: "x" }, { do: "open_link", text: "https://x" }, { do: "tap_text", text: "x", extra: 1 }, { do: "scroll", direction: "UP" }, { do: "tap_text" },
      { do: "input", text: "" }, { do: "input", text: "a\nb" }, { do: "input", text: "a\u0085- runFlow: x" }, { do: "tap_id", id: "a\u0000b" }, { do: "input", text: "x".repeat(201) }, {}, null, "scroll", 5]) {
      expect(() => maestroStepFlow(APP, [action]), JSON.stringify(action)).toThrow();
    }
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
