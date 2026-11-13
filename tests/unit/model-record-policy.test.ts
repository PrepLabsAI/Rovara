// TE-F8: which call to record, by F4's own identity of a changed prompt: attribution per kind (goldens), the "after" side only, an incomplete report, and the decision table.
import { describe, expect, it } from "vitest";
import {
  RECORDING_NOT_RUN_INCOMPLETE, RECORDING_NOT_RUN_UNREADABLE, decideRecording, detectPromptChanges, matchChangedItems, planRecording, readModelRequest, type PromptChangeItem, type RecordingPlan, type StoredRecordings,
} from "@agentx/contracts";
import { fakeModelEgressWorld } from "../../packages/testing/src/ports/model-egress-world.js";
import { OLD_SYSTEM_TEXT, SYSTEM_TEXT, USER_TEXT, changedReport, chatFrame, geminiFrame, messagesFrame } from "./model-record-support.js";

const world = fakeModelEgressWorld();
const ready = (report: unknown): Extract<RecordingPlan, { status: "ready" }> => {
  const plan = planRecording(report);
  if (plan.status !== "ready") throw new Error("not ready");
  return plan;
};
const match = (plan: RecordingPlan, frame: unknown): readonly string[] => {
  const read = readModelRequest(frame);
  if (!read.ok) throw new Error("unreadable");
  return matchChangedItems(plan, read.view);
};
const idOf = (kind: PromptChangeItem["kind"], report = changedReport({ model: "fixture-large", oldModel: "fixture-small" })): string => report.items.find((item) => item.kind === kind)!.id;

describe("planRecording", () => {
  it("plans the prompt and model kinds of a complete report, and only those", () => {
    const report = detectPromptChanges({ files: [{ path: "ai/app.py", before: "client.messages.create(model='fixture-small', temperature=0.1, system='old', messages=[])", after: "client.messages.create(model='fixture-large', temperature=0.9, system='new', messages=[])", wholeFile: true }] }).report;
    const kinds = report.items.map((item) => item.kind).sort();
    expect(kinds).toEqual(expect.arrayContaining(["model_name", "model_setting", "system_prompt"]));
    expect(ready(report).items.map((item) => item.kind).sort()).toEqual(["model_name", "system_prompt"]);
  });

  it("records nothing for an incomplete report, with the fixed words", () => {
    const report = detectPromptChanges({ files: [{ path: "ai/app.py", before: "", after: "x".repeat(2 * 1024 * 1024), wholeFile: true }] }).report;
    expect(report.status).toBe("incomplete");
    expect(planRecording(report)).toEqual({ status: "not_run", reason: "incomplete", sentence: RECORDING_NOT_RUN_INCOMPLETE });
    expect(RECORDING_NOT_RUN_INCOMPLETE).toBe("not run: the prompt changes could not be read fully");
  });

  it("records nothing for partial coverage even when the status says changes", () => {
    const report = changedReport();
    expect(planRecording({ ...report, coverage: "partial", incompleteReasons: ["unreadable_diff"] })).toMatchObject({ status: "not_run", reason: "incomplete" });
  });

  it("records nothing for a report that does not parse (never throws)", () => {
    for (const bad of [undefined, null, 3, "x", {}, { ...changedReport(), extra: 1 }, { ...changedReport(), items: "no" }]) expect(planRecording(bad)).toEqual({ status: "not_run", reason: "unreadable", sentence: RECORDING_NOT_RUN_UNREADABLE });
  });

  it("plans nothing for a report with no changes", () => {
    const plan = ready(detectPromptChanges({ files: [{ path: "a.txt", before: "same", after: "same", wholeFile: true }] }).report);
    expect(plan.items).toEqual([]);
    expect(match(plan, chatFrame(world, { system: SYSTEM_TEXT }))).toEqual([]);
  });
});

describe("matchChangedItems (attribution goldens)", () => {
  const report = changedReport({ model: "fixture-large", oldModel: "fixture-small" });
  const plan = ready(report);
  const system = idOf("system_prompt", report);
  const model = idOf("model_name", report);

  it("matches a request carrying the changed system prompt, in the OpenAI, Anthropic and Gemini shapes", () => {
    expect(match(plan, chatFrame(world, { system: SYSTEM_TEXT, model: "fixture-small" }))).toEqual([system]);
    expect(match(plan, messagesFrame(world, { system: SYSTEM_TEXT, model: "fixture-small" }))).toEqual([system]);
    expect(match(plan, geminiFrame(world, { system: SYSTEM_TEXT }))).toEqual([system]);
  });

  it("is not thrown by whitespace, line wraps and invisible format characters in the request", () => {
    const messy = `  Answer in one short\n sentence   about​ trains.  `;
    expect(match(plan, chatFrame(world, { system: messy, model: "fixture-small" }))).toEqual([system]);
  });

  it("matches the model name by the AFTER value only", () => {
    expect(match(plan, chatFrame(world, { user: "nothing changed here", model: "fixture-large" }))).toEqual([model]);
    expect(match(plan, chatFrame(world, { user: "nothing changed here", model: "fixture-small" }))).toEqual([]);
  });

  it("matches on the AFTER side of a prompt, never the BEFORE side", () => {
    expect(match(plan, chatFrame(world, { system: OLD_SYSTEM_TEXT, model: "fixture-small" }))).toEqual([]);
  });

  it("matches no call that carries none of the changed prompts (the unchanged user text, another system text)", () => {
    expect(match(plan, chatFrame(world, { system: "A different system prompt.", user: USER_TEXT, model: "fixture-small" }))).toEqual([]);
  });

  it("a system_prompt item matches system segments only, not a user message with the same text", () => {
    expect(match(plan, chatFrame(world, { user: SYSTEM_TEXT, model: "fixture-small" }))).toEqual([]);
  });

  it("a prompt_text item matches a user message with the same text", () => {
    const text = detectPromptChanges({ files: [{ path: "ai/app.py", before: "client.chat.completions.create(messages=[{'role': 'user', 'content': 'old words'}])", after: "client.chat.completions.create(messages=[{'role': 'user', 'content': 'new words here'}])", wholeFile: true }] }).report;
    const id = text.items.find((item) => item.kind === "prompt_text")!.id;
    expect(match(ready(text), chatFrame(world, { user: "new words here" }))).toEqual([id]);
    expect(match(ready(text), chatFrame(world, { user: "old words" }))).toEqual([]);
  });

  it("a prompt_file item matches a request carrying the file's text", () => {
    const file = detectPromptChanges({ files: [{ path: "prompts/system.txt", before: "old file text", after: "You are a careful assistant.", wholeFile: true }] }).report;
    const id = file.items.find((item) => item.kind === "prompt_file")!.id;
    expect(match(ready(file), chatFrame(world, { system: "You are a careful assistant." }))).toEqual([id]);
  });

  it("a templated prompt (a hole in the text) matches nothing: it is listed as not recorded later", () => {
    const templated = detectPromptChanges({ files: [{ path: "ai/app.py", before: "client.messages.create(system=f'old {x}')", after: "client.messages.create(system=f'hello {name}')", wholeFile: true }] }).report;
    expect(match(ready(templated), messagesFrame(world, { system: "hello Ada" }))).toEqual([]);
  });
});

describe("decideRecording", () => {
  const none: StoredRecordings = { keys: new Set(), itemIds: new Set() };
  const matched = ["item-a"];
  it("scripted for a call that matches nothing, in either mode", () => {
    expect(decideRecording({ matched: [], key: "k", stored: none, mode: "record" }).action).toBe("scripted");
    expect(decideRecording({ matched: [], key: "k", stored: none, mode: "replay_only" }).action).toBe("scripted");
  });
  it("record for the first call of an item, replay for a stored key, scripted for a second key of a recorded item", () => {
    expect(decideRecording({ matched, key: "k1", stored: none, mode: "record" }).action).toBe("record");
    expect(decideRecording({ matched, key: "k1", stored: { keys: new Set(["k1"]), itemIds: new Set(matched) }, mode: "record" }).action).toBe("replay");
    expect(decideRecording({ matched, key: "k2", stored: { keys: new Set(["k1"]), itemIds: new Set(matched) }, mode: "record" }).action).toBe("scripted");
  });
  it("never records in a replay-only round: a miss, or a replay", () => {
    expect(decideRecording({ matched, key: "k1", stored: none, mode: "replay_only" }).action).toBe("miss");
    expect(decideRecording({ matched, key: "k1", stored: { keys: new Set(["k1"]), itemIds: new Set(matched) }, mode: "replay_only" }).action).toBe("replay");
  });
  it("records a call that matches one recorded and one new item", () => {
    expect(decideRecording({ matched: ["a", "b"], key: "k2", stored: { keys: new Set(["k1"]), itemIds: new Set(["a"]) }, mode: "record" }).action).toBe("record");
  });
});
