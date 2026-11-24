// S1 (the plan's tests 1 to 4, 8, 9, 10, 17, 18): a press from Slack on a real hosted core task, through the REAL interactivity dispatcher (the registry's press handler, the broker's own `core-task-action` event, the core's registry), on a task
// seeded at the stage each move is offered. What a person sees (the card line, the private words, the form) and what the move left in the store are asserted, never internals.
import { beforeAll, describe, expect, it } from "vitest";
import { WorkflowSnapshotSchema } from "@agentx/contracts";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import type { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { loadSlackBroker } from "../support/slack-broker.js";
import { PARSER, TOKEN, code, parserId, report, tokenId } from "../support/task-actions-world.js";
import { SLACK_PEOPLE, buttonValueOf, coreSlackWorld, hostedPressDispatcher, offersFor, operationsOfMode, seedWorkflow, slackPress, type CoreSlackWorld } from "../support/core-slack-world.js";

beforeAll(async () => { await loadSlackBroker(); });

const OWNER = SLACK_PEOPLE.owner;
type Dispatcher = ReturnType<typeof hostedPressDispatcher>;

async function setup(make: Parameters<typeof seedWorkflow>[1], options: Parameters<typeof coreSlackWorld>[0] = {}) {
  const world = await coreSlackWorld(options);
  world.shareThread();
  await seedWorkflow(world, make);
  const dispatcher = hostedPressDispatcher(world);
  return { world, dispatcher };
}
const reviewBlocked = (reviews: unknown[]) => (base: Record<string, unknown>) => ({ ...base, reviews });
const findingsBoth = reviewBlocked([report("CRITIC", "FINDINGS", [PARSER]), report("SECURITY", "FINDINGS", [TOKEN])]);
const findingsCode = reviewBlocked([report("CRITIC", "FINDINGS", [PARSER]), report("SECURITY", "PASS", [])]);
const reviewFailed = reviewBlocked([report("CRITIC", "FAILED", []), report("SECURITY", "PASS", [])]);

/** The card's button for an action, for a person, as the thread card would carry it; pressed through the real dispatcher. */
async function pressButton(world: CoreSlackWorld, dispatcher: Dispatcher, user: string, id: string, overrides: Partial<Parameters<typeof slackPress>[0]> = {}) {
  const offer = (await offersFor(world, OWNER)).find((entry) => entry.id === id);
  expect(offer, `the task offers ${id}`).toBeDefined();
  await dispatcher.press(slackPress({ actionId: `rovara_task:${id}`, value: buttonValueOf(world.task.taskId, offer!), userId: user, ...overrides }));
  return offer!;
}
const workflowOf = async (world: CoreSlackWorld) => WorkflowSnapshotSchema.parse((await world.world.store.get(taskKey(world.task.taskId)))!["workflow"]);
const lastView = (dispatcher: Dispatcher) => dispatcher.views.filter((view) => view.method === "views.update").at(-1)!.body as { view: { blocks: Array<Record<string, unknown>>; callback_id?: string; private_metadata?: string; submit?: { text: string } } };
const textsOf = (blocks: Array<Record<string, unknown>>): string => JSON.stringify(blocks);
const operations = operationsOfMode;

describe("a button that needs no form: the press is the move", () => {
  it("retries the reviews for the owner in one press (no dialog), and the card gets one line", async () => {
    const { world, dispatcher } = await setup(reviewFailed);
    await pressButton(world, dispatcher, OWNER, "task.review");
    // One press: no form, no dialog, the move is made.
    expect(dispatcher.views.filter((view) => view.method.startsWith("views."))).toEqual([]);
    expect(await operations(world, "REVIEW")).toHaveLength(1);
    expect(dispatcher.updates.at(-1)!.text).toContain("Done in Slack");
  });

  it("answers a press with a stale revision privately and writes nothing", async () => {
    const { world, dispatcher } = await setup(reviewFailed);
    const before = JSON.stringify((await world.world.store.get(taskKey(world.task.taskId)))!["workflow"]);
    await dispatcher.press(slackPress({ actionId: "rovara_task:task.review", value: JSON.stringify({ t: world.task.taskId, r: 2, d: code.digest }), userId: OWNER }));
    expect(dispatcher.said).toEqual(["This card is out of date. Use the latest message in this thread."]);
    expect(dispatcher.updates).toEqual([]);
    expect(JSON.stringify((await world.world.store.get(taskKey(world.task.taskId)))!["workflow"])).toBe(before);
  });
});

describe("a refusal on a public card is shown only to the presser", () => {
  it("tells an unlinked Slack account to link, a colleague who is no owner who may act, and another workspace's guest nothing at all; nothing is written", async () => {
    const { world, dispatcher } = await setup(findingsCode);
    const offer = (await offersFor(world, OWNER)).find((entry) => entry.id === "work.send-back")!;
    const value = buttonValueOf(world.task.taskId, offer);
    const before = JSON.stringify((await world.world.store.get(taskKey(world.task.taskId)))!["workflow"]);
    // (A form button: the refusal is shown in the form's place, to the presser only.)
    await dispatcher.press(slackPress({ actionId: "rovara_task:work.send-back", value, userId: "U0NOBODY001" }));
    expect(textsOf(lastView(dispatcher).view.blocks)).toContain("not available to you");
    // A button that needs no form, from an account nobody linked: private words, nothing in the channel.
    await dispatcher.press(slackPress({ actionId: "rovara_task:task.stop", value: JSON.stringify({ t: world.task.taskId, r: 0 }), userId: "U0NOBODY001" }));
    expect(dispatcher.said.at(-1)).toBe("That task is not available to you here.");
    // A colleague presses a form button: the core describes it for HER first, so the form is replaced by a refusal that holds no finding text.
    await dispatcher.press(slackPress({ actionId: "rovara_task:findings.resolve", value: buttonValueOf(world.task.taskId, (await offersFor(world, OWNER)).find((entry) => entry.id === "findings.resolve")!), userId: SLACK_PEOPLE.colleague }));
    const shown = textsOf(lastView(dispatcher).view.blocks);
    expect(shown).not.toContain("parser");
    expect(shown).not.toContain("drops the last line");
    // A guest of a shared channel: the presser's own workspace is not the thread's.
    await dispatcher.press(slackPress({ actionId: "rovara_task:work.send-back", value, userId: SLACK_PEOPLE.foreign, userTeamId: "T0ELSEWHERE" }));
    expect(dispatcher.said.at(-1)).toBe("That task is not available to you here.");
    expect(dispatcher.updates).toEqual([]);
    expect(JSON.stringify((await world.world.store.get(taskKey(world.task.taskId)))!["workflow"])).toBe(before);
  });
});

describe("send back opens a form and the submit is the move", () => {
  it("opens a loading view at once, replaces it with the form, and a double submit is one effect", async () => {
    const { world, dispatcher } = await setup(findingsCode);
    await pressButton(world, dispatcher, OWNER, "work.send-back");
    expect(dispatcher.views.map((view) => view.method)).toEqual(["views.open", "views.update"]);
    const form = lastView(dispatcher).view;
    const payload = { type: "view_submission", user: { id: OWNER, team_id: "T0BSHLLUGBD" }, view: { id: "V9", callback_id: form.callback_id, private_metadata: form.private_metadata, state: { values: { "f:instructions": { v: { type: "plain_text_input", value: "Keep the footer line." } } } } } };
    expect(await dispatcher.submit(payload)).toEqual({ response_action: "clear" });
    expect(await dispatcher.submit(payload)).toBeDefined();
    // One send back was taken, once: the double submit is the same request.
    expect((await workflowOf(world)).decisions.filter((decision) => decision.source === "SEND_BACK")).toHaveLength(1);
    expect((await workflowOf(world)).stage).toBe("IMPLEMENT");
  });
});

describe("findings: the confirm comes before an accept is written, and a security accept is the web's", () => {
  const submitValues = (form: ReturnType<typeof lastView>["view"], values: Record<string, Record<string, unknown>>, id = "V2") => ({
    type: "view_submission", user: { id: OWNER, team_id: "T0BSHLLUGBD" }, view: { id, callback_id: form.callback_id, private_metadata: form.private_metadata, state: { values } },
  });
  const choice = (value: string) => ({ v: { type: "static_select", selected_option: { value } } });
  const note = (value: string) => ({ v: { type: "plain_text_input", value } });

  it("shows the findings as inert text, asks to confirm an accept with its reason, and writes only after the confirm's submit", async () => {
    const { world, dispatcher } = await setup(findingsCode);
    await pressButton(world, dispatcher, OWNER, "findings.resolve");
    const form = lastView(dispatcher).view;
    expect(textsOf(form.blocks)).toContain("drops the last line");
    const accept = { [`i:${parserId}:c`]: choice("ACCEPT"), [`i:${parserId}:n`]: note("A footer we drop on purpose.") };
    // The first submit does not accept: the form comes back with the confirm above the fields and what was typed.
    const confirm = await dispatcher.submit(submitValues(form, accept)) as { response_action: string; view: { blocks: Array<Record<string, unknown>>; private_metadata: string; submit: { text: string } } };
    expect(confirm.response_action).toBe("update");
    expect(textsOf(confirm.view.blocks)).toContain("will no longer block");
    expect(confirm.view.submit.text).toBe("Accept and continue");
    expect((await workflowOf(world)).acceptedFindings ?? []).toHaveLength(0);
    // The second submit carries the digest of what the confirm showed.
    expect(await dispatcher.submit(submitValues({ ...form, private_metadata: confirm.view.private_metadata }, accept, "V3"))).toEqual({ response_action: "clear" });
    expect((await workflowOf(world)).acceptedFindings).toHaveLength(1);
    expect(world.world.audit.some((event) => event.details?.["via"] === "slack")).toBe(true);
  });

  it("refuses to accept a SECURITY finding from Slack (the web's), shows it in the form, writes nothing, and Fix on it works", async () => {
    const { world, dispatcher } = await setup(findingsBoth);
    await pressButton(world, dispatcher, OWNER, "findings.resolve");
    const form = lastView(dispatcher).view;
    const securityAccept = { [`i:${parserId}:c`]: choice("FIX"), [`i:${tokenId}:c`]: choice("ACCEPT"), [`i:${tokenId}:n`]: note("Test token only.") };
    const confirm = await dispatcher.submit(submitValues(form, securityAccept)) as { view: { private_metadata: string } };
    const refused = await dispatcher.submit(submitValues({ ...form, private_metadata: confirm.view.private_metadata }, securityAccept, "V4")) as { view: { blocks: Array<Record<string, unknown>> } };
    expect(textsOf(refused.view.blocks)).toContain("Rovara task page");
    expect((await workflowOf(world)).acceptedFindings ?? []).toHaveLength(0);
    expect((await workflowOf(world)).decisions.filter((decision) => decision.source === "FINDINGS")).toHaveLength(0);
    const fixAll = { [`i:${parserId}:c`]: choice("FIX"), [`i:${tokenId}:c`]: choice("FIX") };
    expect(await dispatcher.submit(submitValues(form, fixAll, "V5"))).toEqual({ response_action: "clear" });
    expect((await workflowOf(world)).decisions.filter((decision) => decision.source === "FINDINGS")).toHaveLength(1);
  });

  it("refuses a submit that carries a confirm digest of a different state (a form left open over a change), before any write", async () => {
    const { world, dispatcher } = await setup(findingsCode);
    await pressButton(world, dispatcher, OWNER, "findings.resolve");
    const form = lastView(dispatcher).view;
    const accept = { [`i:${parserId}:c`]: choice("ACCEPT"), [`i:${parserId}:n`]: note("First reason.") };
    const confirm = await dispatcher.submit(submitValues(form, accept)) as { view: { private_metadata: string } };
    // The person changed the reason after the confirm showed: the digest no longer matches what would be written, so the form shows the new confirm instead.
    const changed = { ...accept, [`i:${parserId}:n`]: note("A different reason.") };
    const again = await dispatcher.submit(submitValues({ ...form, private_metadata: confirm.view.private_metadata }, changed, "V6")) as { response_action: string };
    expect(again.response_action).toBe("update");
    expect((await workflowOf(world)).acceptedFindings ?? []).toHaveLength(0);
  });
});

describe("close: irreversible, so the confirm is shown and the discard is the person's choice", () => {
  it("opens the confirm with the fixed lines, writes nothing on a cancel, and closes on the submit that carries its digest", async () => {
    const { world, dispatcher } = await setup(findingsCode);
    await pressButton(world, dispatcher, OWNER, "task.close");
    const form = lastView(dispatcher).view;
    expect(textsOf(form.blocks)).toContain("The open pull request stays on GitHub");
    expect(form.submit?.text).toBe("Close task");
    expect((await world.world.store.get(taskKey(world.task.taskId)))!["closedAt"]).toBeUndefined();
    const closed = await dispatcher.submit({ type: "view_submission", user: { id: OWNER, team_id: "T0BSHLLUGBD" }, view: { id: "V7", callback_id: form.callback_id, private_metadata: form.private_metadata, state: { values: {} } } });
    expect(closed).toEqual({ response_action: "clear" });
    expect((await world.world.store.get(taskKey(world.task.taskId)))!["closedAt"]).toBeDefined();
  });

  it("refuses a close that carries no digest, whatever the renderer did (the core's own half of the confirm)", async () => {
    const { world, dispatcher } = await setup(findingsCode);
    const offer = (await offersFor(world, OWNER)).find((entry) => entry.id === "task.close")!;
    // A renderer bug: a plain button that skips the dialog (its value says no form is needed).
    await dispatcher.press(slackPress({ actionId: "rovara_task:task.close", value: JSON.stringify({ t: world.task.taskId, r: offer.binding.revision }), userId: OWNER, triggerId: "" }));
    expect(dispatcher.said.at(-1)).toContain("needs a value or a confirmation");
    expect((await world.world.store.get(taskKey(world.task.taskId)))!["closedAt"]).toBeUndefined();
  });
});

describe("money", () => {
  it("refuses a send back past the round cap with `over_limit` and writes nothing", async () => {
    const { world, dispatcher } = await setup(findingsCode, { roundCap: async () => ({ limitUsd: 1, spentUsd: 5 }) });
    await pressButton(world, dispatcher, OWNER, "work.send-back");
    const form = lastView(dispatcher).view;
    const answered = await dispatcher.submit({ type: "view_submission", user: { id: OWNER, team_id: "T0BSHLLUGBD" }, view: { id: "V8", callback_id: form.callback_id, private_metadata: form.private_metadata, state: { values: {} } } }) as { view: { blocks: Array<Record<string, unknown>> } };
    expect(textsOf(answered.view.blocks)).toContain("used its run limit");
    expect((await workflowOf(world)).decisions.filter((decision) => decision.source === "SEND_BACK")).toHaveLength(0);
    expect((await workflowOf(world)).stage).toBe("REVIEW");
  });
});

describe("the link fence", () => {
  it("refuses a move after the Slack account was unlinked, and nothing is written", async () => {
    const { world, dispatcher } = await setup(reviewFailed);
    const offer = (await offersFor(world, OWNER)).find((entry) => entry.id === "task.review")!;
    await world.unlink(OWNER);
    await dispatcher.press(slackPress({ actionId: "rovara_task:task.review", value: JSON.stringify({ t: world.task.taskId, r: offer.binding.revision, d: offer.binding.digest }), userId: OWNER, triggerId: "" }));
    expect(dispatcher.said.at(-1)).toBe("Link your Slack account to Rovara first, then press the button again.");
    expect(await operations(world, "REVIEW")).toHaveLength(0);
  });
});

/** Every row of the core's store, whole: what "nothing was written" is compared against. */
async function snapshotOf(world: CoreSlackWorld): Promise<string> {
  const rows: unknown[] = [];
  let cursor: string | undefined;
  do {
    const page = await (world.world.store as MemoryDocumentStore).scanPage({ limit: 500, ...(cursor === undefined ? {} : { cursor }) });
    rows.push(...page.items);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return JSON.stringify(rows.map((row) => JSON.stringify(row)).sort());
}

describe("every move refuses those who may not make it, and writes nothing (the plan's table over the entries)", () => {
  const without = async (world: CoreSlackWorld) => {
    const stored = (await world.world.store.get(taskKey(world.task.taskId)))!;
    const { workflow: _gone, ...plain } = stored as Record<string, unknown>;
    void _gone;
    await world.world.store.put({ item: plain as never });
  };
  const cases: Array<{ id: string; seed: (world: CoreSlackWorld) => Promise<void>; form: boolean }> = [
    { id: "task.review", seed: (world) => seedWorkflow(world, (base) => reviewFailed(base)), form: false },
    { id: "work.send-back", seed: (world) => seedWorkflow(world, (base) => findingsCode(base)), form: true },
    { id: "findings.resolve", seed: (world) => seedWorkflow(world, (base) => findingsCode(base)), form: true },
    { id: "task.close", seed: (world) => seedWorkflow(world, (base) => findingsCode(base)), form: true },
    { id: "step.retry", seed: (world) => seedWorkflow(world, (base) => ({ ...base, stage: "IMPLEMENT", state: "BLOCKED", blockReason: "the step stopped" })), form: false },
    { id: "task.stop", seed: async () => undefined, form: false },
    { id: "task.continue", seed: without, form: true },
    { id: "pull-request.open", seed: without, form: true },
  ];

  it.each(cases)("$id: an unlinked account, a colleague with no part and another company's administrator get a private refusal and nothing is written", async ({ id, seed, form }) => {
    const world = await coreSlackWorld();
    world.shareThread();
    await seed(world);
    const dispatcher = hostedPressDispatcher(world);
    const offer = (await offersFor(world, OWNER)).find((entry) => entry.id === id);
    expect(offer, `the task offers ${id} to its owner`).toBeDefined();
    const value = buttonValueOf(world.task.taskId, offer!);
    const before = await snapshotOf(world);
    for (const who of ["U0NOBODY001", SLACK_PEOPLE.colleague, SLACK_PEOPLE.foreign]) {
      const spoken = dispatcher.said.length;
      const opened = dispatcher.views.length;
      await dispatcher.press(slackPress({ actionId: `rovara_task:${id}`, value, userId: who }));
      const refused = form ? dispatcher.views.length > opened : dispatcher.said.length > spoken;
      expect(refused, `${who} is refused ${id} privately`).toBe(true);
      expect(await snapshotOf(world), `${who} wrote nothing for ${id}`).toBe(before);
    }
    expect(dispatcher.updates).toEqual([]);
  });
});
