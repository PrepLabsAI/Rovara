// S1 guards around the registry's surfaces (the plan's tests 5, 6, 13, 14 and 15): every registry id has words and a Slack class and no other `rovara_task:` id does; Slack renders and never decides (the plugin imports nothing from
// the task flow or the registry and compares no message); the CoreTaskEntry's methods are the same in all three places a method must be added; every refusal reason has Slack words; and a press that needs a form opens a view at once.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ACTION_WORDS, TASK_ACTION_IDS, TASK_ACTION_NOTES, TASK_ACTION_REFUSAL_REASONS, WorkflowSnapshotSchema, taskActionButtonId, taskActionOfButtonId } from "@agentx/contracts";
import { slackActionClass } from "../../packages/broker/src/aws/slack-action-classes.js";
import { createSlackPressDispatcher } from "../../packages/broker/src/aws/slack-interactivity.js";
import { pressedOf, taskActionPressHandler, type TaskActionPressDeps } from "../../packages/broker/src/aws/slack-task-actions.js";
import { taskActionButtons } from "../../packages/broker/src/core/channel/task-action-cards.js";
import { TASK_ACTION_ENTRIES, stateOffers } from "../../packages/broker/src/core/task-actions/index.js";
import { taskActionRefusalWords, taskFormMetadata, taskActionModal, valuesOfSubmission, taskFormContextOf, TASK_ACTION_FORM } from "../../packages/broker/src/plugins/channel/slack/task-actions.js";
import { blockedReview, code, PARSER, TOKEN, parserId, report, seed, seedPlain, taskOf } from "../support/task-actions-world.js";

const ROOT = join(import.meta.dirname, "../..");
const filesUnder = (directory: string): string[] => readdirSync(join(ROOT, directory)).flatMap((name) => {
  const path = join(directory, name);
  return statSync(join(ROOT, path)).isDirectory() ? filesUnder(path) : path.endsWith(".ts") ? [path] : [];
});

describe("the registry's ids, words and Slack classes", () => {
  it("every id has words and a button id that round-trips, and an id no entry names is no action", () => {
    expect(new Set(TASK_ACTION_ENTRIES.map((entry) => entry.id))).toEqual(new Set(TASK_ACTION_IDS));
    for (const id of TASK_ACTION_IDS) {
      expect(ACTION_WORDS[id].label.length, id).toBeGreaterThan(0);
      expect(taskActionOfButtonId(taskActionButtonId(id))).toBe(id);
      expect(slackActionClass(taskActionButtonId(id)), id).toBe("member");
    }
    expect(slackActionClass("rovara_task:not.an.action")).toBeUndefined();
    expect(slackActionClass("rovara_task:")).toBeUndefined();
    expect(taskActionOfButtonId("agentx_workflow_stop")).toBeUndefined();
    // The form is the member class too; every other id keeps the table's own class.
    expect(slackActionClass(TASK_ACTION_FORM)).toBe("member");
    expect(slackActionClass("agentx_admin_change_confirm")).toBe("admin");
  });

  it("every declared exclusion names an id and says why", () => {
    for (const [id, why] of Object.entries(TASK_ACTION_NOTES)) { expect(TASK_ACTION_IDS).toContain(id); expect(String(why).length).toBeGreaterThan(10); }
    for (const entry of TASK_ACTION_ENTRIES.filter((candidate) => candidate.who === "held")) expect(TASK_ACTION_NOTES[entry.id], entry.id).toBeDefined();
  });

  it("a registry entry with a high or irreversible risk always describes a confirm (a renderer cannot be the only dialog)", async () => {
    const world = await seed({ workflow: blockedReview({}, [report("CRITIC", "FINDINGS", [PARSER]), report("SECURITY", "PASS", [])]) });
    const task = await taskOf(world.h);
    for (const entry of TASK_ACTION_ENTRIES.filter((candidate) => candidate.who !== "held")) {
      for (const risk of [entry.risk(task, {}), entry.risk(task, { [parserId]: "ACCEPT" })]) {
        if (risk === "high" || risk === "irreversible") expect(typeof entry.describe, `${entry.id} (${risk})`).toBe("function");
      }
    }
  });

  it("each non-held action is offered by the state its own test seeds (the same-set matrix over the states of one task)", async () => {
    const seen = new Set<string>();
    const add = async (world: Awaited<ReturnType<typeof seed>>, caps: Parameters<typeof stateOffers>[0] = {}) => { for (const offer of await stateOffers(caps, await taskOf(world.h))) seen.add(offer.id); };
    await add(await seed({ workflow: blockedReview({}, [report("CRITIC", "FAILED", []), report("SECURITY", "PASS", [])]) }));
    await add(await seed({ workflow: blockedReview({}, [report("CRITIC", "FINDINGS", [PARSER]), report("SECURITY", "FINDINGS", [TOKEN])]) }));
    await add(await seed({ workflow: WorkflowSnapshotSchema.parse({ ...blockedReview(), stage: "IMPLEMENT", state: "RUNNING", blockReason: undefined }) }), { people: true });
    await add(await seedPlain());
    await add(await seed({ workflow: WorkflowSnapshotSchema.parse({ ...blockedReview({}, [report("CRITIC", "PASS", []), report("SECURITY", "PASS", [])]), stage: "WAIT_FOR_MERGE", state: "WAITING", blockReason: undefined, pullRequests: [{ repositoryId: "demo", number: 7, url: "https://example.com/pull/7", required: true, state: "OPEN", candidateDigest: code.digest, headSha: "b".repeat(40) }] }) }), { merge: true });
    await add(await seed({ workflow: WorkflowSnapshotSchema.parse({ ...blockedReview(), stage: "IMPLEMENT", state: "BLOCKED", blockReason: "the step stopped" }) }));
    // Offered elsewhere, each with its own test: the plan decision (a host's card facts), the PR feedback choices (the hosted feedback world), the questions (Understand), taking over (a person's own eligibility), the held two.
    const elsewhere = new Set(["plan.approve", "plan.request-changes", "plan.reject", "feedback.fix", "feedback.dismiss", "feedback.answer", "feedback.retry-review", "pull-request.keep", "task.answer", "people.take-ownership", "people.add", "people.set-role"]);
    expect(TASK_ACTION_IDS.filter((id) => !elsewhere.has(id) && !seen.has(id))).toEqual([]);
  });
});

describe("a card's buttons", () => {
  const offer = (id: string, risk: "routine" | "irreversible" = "routine", needsDialog = false) => ({ id, label: id, risk, needsDialog, binding: { revision: 3, digest: "a".repeat(64) } }) as never;
  it("keeps to the declared count with the page link always in, marks an irreversible move danger, and hints a dialog only as layout", () => {
    const buttons = taskActionButtons([offer("task.close", "irreversible", true), offer("task.stop"), offer("people.view"), offer("people.take-ownership")], { taskId: "8b579b4b-eaa7-4bf2-87bf-6da86b97c9e6", taskUrl: "https://app.example/t", limit: 3 });
    expect(buttons.map((button) => button.type === "link" ? "link" : button.actionId)).toEqual(["rovara_task:task.close", "rovara_task:task.stop", "link"]);
    expect(buttons[0]).toMatchObject({ style: "danger" });
    expect(JSON.parse((buttons[0] as { value: string }).value)).toEqual({ t: "8b579b4b-eaa7-4bf2-87bf-6da86b97c9e6", r: 3, d: "a".repeat(64), n: 1 });
    expect(taskActionButtons([offer("people.take-ownership")], { taskId: "8b579b4b-eaa7-4bf2-87bf-6da86b97c9e6", limit: 5 })).toEqual([]);
  });
});

describe("Slack renders and never decides", () => {
  const plugin = filesUnder("packages/broker/src/plugins/channel/slack");
  const hosted = ["packages/broker/src/aws/slack-task-actions.ts", "packages/broker/src/aws/slack-core-task-action.ts"];
  const registry = filesUnder("packages/broker/src/core/task-actions");

  it("imports nothing from the task flow or the registry, anywhere in the Slack plugin", () => {
    for (const file of plugin) expect(readFileSync(join(ROOT, file), "utf8"), file).not.toMatch(/from "[^"]*\/core\/(task-flow|task-actions)\//u);
  });

  it("compares no error message or sentence, in the plugin, the press handler and the registry (a refusal is a code and a reason)", () => {
    for (const file of [...plugin, ...hosted, ...registry]) {
      const text = readFileSync(join(ROOT, file), "utf8");
      expect(text, file).not.toMatch(/\.message(?:\s*===|\s*!==|\.includes\(|\.startsWith\(|\.match\(|\.indexOf\()/u);
    }
  });

  it("decides no right in the press handler: no role, no stage and no engine name appears in its code", () => {
    const text = readFileSync(join(ROOT, "packages/broker/src/aws/slack-task-actions.ts"), "utf8").split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
    for (const forbidden of [/companyRole/u, /ownerActing/u, /stage ===/u, /\.workflow\b/u, /workflowSendBackOffered/u]) expect(text).not.toMatch(forbidden);
  });
});

describe("the CoreTaskEntry's methods are the same in all three places", () => {
  it("names every method of the interface in `coreTaskEntryFrom` and in the root's wrapper (one dropped silently once)", () => {
    const boundary = readFileSync(join(ROOT, "packages/broker/src/aws/engine-boundary.ts"), "utf8");
    const root = readFileSync(join(ROOT, "packages/broker/src/aws/core-engine-root.ts"), "utf8");
    const iface = /export interface CoreTaskEntry \{([\s\S]*?)\n\}\n/u.exec(boundary)![1]!;
    const methods = [...iface.matchAll(/^ {2}(\w+)\??\(/gmu)].map((match) => match[1]!);
    expect(methods).toEqual(expect.arrayContaining(["route", "taskActions", "taskAction", "chatDecision", "recordThread", "threadInput", "taskMoney", "taskReadable", "stopWorkspaceForAdmin"]));
    const factory = /export function coreTaskEntryFrom\([\s\S]*?\n\}\n/u.exec(boundary)![0];
    const wrapper = /coreTasks = \{\n\s*route: accessRetryRoute[\s\S]*?\n {4}\};/u.exec(root)![0];
    for (const method of methods) {
      // (The administrator's workspace cancel is composed by the root itself, not by `coreTaskEntryFrom`.)
      if (method !== "stopWorkspaceForAdmin") expect(factory, `coreTaskEntryFrom must give ${method}`).toMatch(new RegExp(`\\b${method}\\b`, "u"));
      // The registry's two methods are passed on by one helper the wrapper spreads, which must itself name both.
      const named = method === "taskActions" || method === "taskAction" ? `${wrapper}\n${/export function taskActionMethodsOf[\s\S]*?\n\}\n/u.exec(boundary)![0]}` : wrapper;
      expect(named, `the root's wrapper must pass ${method}`).toMatch(new RegExp(`\\b${method}\\b`, "u"));
      if (method === "taskActions" || method === "taskAction") expect(wrapper).toContain("...taskActionMethodsOf(entry)");
    }
  });
});

describe("Slack's words", () => {
  it("has its own words for every refusal reason, never two reasons with the same words, and no id in them", () => {
    const words = TASK_ACTION_REFUSAL_REASONS.map((reason) => taskActionRefusalWords(reason));
    expect(new Set(words).size).toBe(words.length);
    for (const text of words) { expect(text.length).toBeGreaterThan(10); expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/u); }
    expect(taskActionRefusalWords("unavailable", "maybe")).toContain("may already have been done");
    expect(taskActionRefusalWords("stale", "none")).not.toContain("may already");
  });
});

describe("the form's own round trip", () => {
  it("reads back what the blocks it made carry, the context survives Slack's private metadata, and an oversized card text is shrunk first", () => {
    const context = { a: "work.send-back" as const, t: "8b579b4b-eaa7-4bf2-87bf-6da86b97c9e6", r: 6, s: "T0BSHLLUGBD", h: "C0123456789", ts: "1695500000.000777", u: "U0OWNER0001", w: "T0BSHLLUGBD", m: "1695500001.000002", x: "x".repeat(5_000) };
    const view = taskActionModal({ label: "Send back to coding", spec: { fields: [
      { kind: "text", id: "instructions", label: "What should coding do?", required: false, max: 1_000, multiline: true, initial: "Fix the review findings." },
      { kind: "pick-many", id: "checks", label: "Checks", min: 0, max: 2, options: [{ value: "a", label: "A", selected: true }, { value: "b", label: "B" }] },
    ] }, context });
    expect(String(view["private_metadata"]).length).toBeLessThanOrEqual(2_800);
    expect(taskFormContextOf(view)).toMatchObject({ a: "work.send-back", t: context.t, r: 6, u: "U0OWNER0001" });
    const blocks = view["blocks"] as Array<Record<string, unknown>>;
    expect(blocks.map((block) => block["block_id"])).toEqual(["f:instructions", "f:checks"]);
    expect(valuesOfSubmission({ state: { values: { "f:instructions": { v: { type: "plain_text_input", value: "Go." } }, "f:checks": { v: { type: "multi_static_select", selected_options: [{ value: "b" }] } }, "i:abc:c": { v: { type: "static_select", selected_option: { value: "ACCEPT" } } }, "i:abc:n": { v: { type: "plain_text_input", value: "Why." } }, other: { v: { value: "ignored" } } } } })).toEqual({ instructions: "Go.", checks: ["b"], abc: "ACCEPT", "abc#note": "Why." });
    expect(taskFormContextOf({ private_metadata: "not json" })).toBeUndefined();
    expect(taskFormContextOf({ private_metadata: JSON.stringify({ ...context, a: "not.an.action", x: undefined }) })).toBeUndefined();
    expect(taskFormMetadata({ ...context, x: undefined }).length).toBeLessThan(400);
  });
});

describe("a press that needs a form opens a view at once, before the core is asked (Slack's trigger lives seconds)", () => {
  it("opens the loading view first, then asks the core to describe, then replaces the view; a slow core never costs the trigger", async () => {
    const order: string[] = [];
    const deps: TaskActionPressDeps = {
      ask: vi.fn(async () => { order.push("ask"); return { mode: "describe" as const, description: { status: "ok" as const, label: "Close task", spec: { fields: [] }, binding: { revision: 1 } } }; }),
      isCoreTask: async () => true,
      openView: async () => { order.push("open"); return "V1"; }, updateView: async () => { order.push("update"); },
      respondEphemeral: async () => undefined, update: async () => undefined,
    };
    const handler = taskActionPressHandler(deps);
    await handler.handle({
      actionId: "rovara_task:task.close", value: JSON.stringify({ t: "8b579b4b-eaa7-4bf2-87bf-6da86b97c9e6", r: 1, n: 1 }), userId: "U0OWNER0001", userTeamId: "T0BSHLLUGBD", workspaceTeamId: "T0BSHLLUGBD", enterpriseId: "", userEnterpriseId: "",
      requestStartedAt: Date.now(), thread: { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000777" }, messageTs: "1695500001.000002", messageText: "", responseUrl: "https://hooks.slack.test/x", triggerId: "T1",
    });
    expect(order).toEqual(["open", "ask", "update"]);
    expect(pressedOf({ actionId: "agentx_workflow_stop", value: JSON.stringify({ taskId: "8b579b4b-eaa7-4bf2-87bf-6da86b97c9e6" }) })).toMatchObject({ id: "task.stop", revision: 0, dialog: false });
    expect(pressedOf({ actionId: "rovara_task:task.close", value: "{\"t\":1}" })).toBeUndefined();
    expect(pressedOf({ actionId: "rovara_task:nope", value: "{}" })).toBeUndefined();
  });
});

describe("an older Stop card whose task's engine cannot be read", () => {
  it("says it could not be done, with the stable reason's words, and never hands the press to the older path that would say the person is not the owner", async () => {
    const said: string[] = [];
    const older = vi.fn(async () => undefined);
    const deps: TaskActionPressDeps = {
      ask: vi.fn(), isCoreTask: async () => { throw new Error("the state table did not answer"); }, openView: async () => undefined, updateView: async () => undefined,
      respondEphemeral: async (_url, text) => { said.push(text); }, update: async () => undefined,
    };
    const dispatch = createSlackPressDispatcher({ handlers: [], workflow: { handleAction: older, handleSubmission: async () => undefined }, taskActions: taskActionPressHandler(deps), respondEphemeral: async (_url, text) => { said.push(text); } });
    await dispatch({
      actionId: "agentx_workflow_stop", value: JSON.stringify({ taskId: "8b579b4b-eaa7-4bf2-87bf-6da86b97c9e6" }), userId: "U0OWNER0001", userTeamId: "T0BSHLLUGBD", workspaceTeamId: "T0BSHLLUGBD", enterpriseId: "", userEnterpriseId: "",
      requestStartedAt: Date.now(), thread: { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000777" }, messageTs: "1695500001.000002", messageText: "", responseUrl: "https://hooks.slack.test/x", triggerId: "T1",
    });
    expect(older).not.toHaveBeenCalled();
    expect(said).toEqual([taskActionRefusalWords("unavailable")]);
    expect(deps.ask).not.toHaveBeenCalled();
  });
});
