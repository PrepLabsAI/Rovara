// S1, the merge from Slack on the REAL hosted merge: a person presses `rovara_task:task.merge` through the task action registry (`createTaskActionRoutes`, so the real `mergeHostFor`, the real standing and confirm digest), and the registry reaches the
// SAME merge rule the web press does: `hostedMergeDependencies` with the DEFAULT code settings (self-approval off), the hosted merge people (`createHostedMergePeople`: the requesters are the creator while a member and the People list's owners), the
// real GitHub link rows, the hosted identity, the merge core's gates, the lock and the audit. A hosted task's stored owner id is the per-task key (`taskOwnerKey`), no person: it is the shape that made every hosted merge after another member's approval
// refuse "Link your GitHub account" until the requesters were read the hosted way (train 27c). Fakes are only at the edges: the code host (the fake GitHub in the merge world) and the chat seam (which company a Slack workspace is, which person an account is).
//   (a) a second person's approval: the task is ready, the person confirms, and the pull request is merged exactly once, with the press audited BEFORE the merge;
//   (b) the presser's own approval alone: refused with the plain words (the task is not ready), nothing is merged, nothing is written, no audit row.
// The test fails with the hosted people line reverted (hosted-merge-deps.ts reading the identity port's own `createIdentityMergePeople`): (a) is then refused, the way the default rule answered before the fix.
import { randomUUID } from "node:crypto";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CODE_SETTINGS, MERGE_NOT_READY_MESSAGES as M, change, type ActionDescription, type ActionResult, type ActorRef, type AuditEvent, type AuditSink, type ConversationRef, type Principal } from "@agentx/contracts";
import type { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { hostedMergeDependencies } from "../../packages/broker/src/aws/hosted-merge-deps.js";
import { createHostedIdentity } from "../../packages/broker/src/core-host/hosted-modules.js";
import { MERGE_PRESSED_AUDIT, MERGE_RESULT_AUDIT, routeHostedMerge } from "../../packages/broker/src/core-host/hosted-merge-routes.js";
import { createTaskActionRoutes } from "../../packages/broker/src/core-host/task-action-routes.js";
import { githubLinkReaderOver, linkGithubAccount } from "../../packages/broker/src/core/people/github-links.js";
import { taskActionRefusalWords } from "../../packages/broker/src/plugins/channel/slack/task-actions.js";
import { pullRequestRecordKey } from "../../packages/broker/src/core/build-step/records.js";
import { taskKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { taskOwnerKey } from "../../packages/broker/src/developer/task-records.js";
import { host, ORG } from "../support/service-host.js";
import { TASK_ID } from "../support/merge-world.js";

const CREATOR = "a".repeat(64), APPROVER = "b".repeat(64);
const CREATOR_GITHUB = "424242";
const TEAM = "T0TEAM0001";
type Who = "creator" | "approver";
const PERSON: Record<Who, string> = { creator: CREATOR, approver: APPROVER };
const SLACK_USER: Record<Who, string> = { creator: "U0CREATOR1", approver: "U0APPROVER" };
const at = "2026-11-24T10:00:00.000Z";
const CONVERSATION: ConversationRef = { channel: "slack", tenant: TEAM, space: "C0CHANNEL1", thread: "1700000000.000100" };
const actorOf = (who: Who): ActorRef => ({ channel: "slack", tenant: TEAM, userId: SLACK_USER[who] });
const person = (personId: string): Principal => ({ companyId: ORG, personId, displayName: personId, provider: "rovara", roles: [] });

/**
 * The hosted world: the task's creator (a member, the task's owner for the registry's rule), its stored owner id (the creator's per-task key, as production keeps it), a task People list with the creator as the one owner, the members and their GitHub links.
 * The pull request has ONE approval, from the fake host's reviewer `priya`, whose GitHub account is linked to the person `approvedBy` names.
 */
async function world(approvedBy: "approver" | "creator") {
  const w = await host();
  const model = w.world.prs[0]!.model;
  const priya = model.accounts.get("priya")!.hostUserId;
  const members = [CREATOR, APPROVER];
  await w.h.store.update({ key: taskKey(TASK_ID), ops: [change.set(["developerId"], CREATOR), change.set(["workflow", "ownerId"], taskOwnerKey(CREATOR, TASK_ID))] });
  // Rovara's own record of the pull request and its workspace (the merge reads the base branch from it).
  const home = { ownerKey: "owner-1", workspaceId: "ws-1" };
  await w.h.store.update({ key: taskKey(TASK_ID), ops: [change.set(["ownerKey"], home.ownerKey)] });
  const workspace = workspaceKey(ORG, home.workspaceId);
  await w.h.store.put({ item: { ...workspace, entityType: "WORKSPACE", id: home.workspaceId, companyId: ORG, ownerKey: home.ownerKey } });
  for (const pr of w.world.prs) await w.h.store.put({ item: {
    ...pullRequestRecordKey(workspace, pr.repositoryId, pr.number), entityType: "PULL_REQUEST", workspaceId: home.workspaceId,
    repository: pr.repositoryId, repositoryUrl: `https://github.com/acme/${pr.repositoryId}`, number: pr.number, url: pr.model.crUrl(String(pr.number)),
    state: "open", headBranch: "rovara/test", baseBranch: "main", expectedHeadCommit: pr.head, title: "Change", body: "",
    createdByOperationId: "11111111-1111-4111-8111-111111111111", updatedAt: new Date(w.clock.ms).toISOString(),
  } });
  // A person has ONE linked account: the reviewer's (priya's) belongs to whoever approved; the creator has an account of their own otherwise.
  const link = (personId: string, githubUserId: string) => linkGithubAccount(w.h.store, { companyId: ORG, githubUserId, login: `login${githubUserId}`, personId, linkedAt: at });
  await link(CREATOR, approvedBy === "creator" ? priya : CREATOR_GITHUB);
  if (approvedBy === "approver") await link(APPROVER, priya);
  const identity = createHostedIdentity({ membershipOf: async (id) => (members.includes(id) ? { companyId: ORG, role: "member" } : undefined), displayNameOf: async (id) => (members.includes(id) ? id : undefined), githubLinks: githubLinkReaderOver(w.h.store) });
  w.registry.register("identity", "hosted", identity);
  w.registry.register("approvers", "local", w.world.deps.approvers);
  // The task People list as the state table holds it (the creator is the one owner), behind a client that answers only reads.
  const peopleItem = { pk: `DEVTASK#${TASK_ID}`, sk: "PEOPLE", schemaVersion: 1, revision: 1, orphaned: false, people: [{ developerId: CREATOR, name: "Creator", role: "owner", method: "oidc" }] };
  const taskPeople = { tableName: "state", documentClient: { send: vi.fn(async (command: unknown) => {
    if (!(command instanceof GetCommand)) throw new Error("only reads");
    const key = command.input.Key as { pk: string; sk: string };
    return { Item: key.pk === peopleItem.pk && key.sk === peopleItem.sk ? peopleItem : undefined };
  }) } };
  // The runtime the registry works on: the harness flow, with the owner rule a hosted install gives (the person a task runs for), and an honest CI mode.
  const deps = { ...w.h.deps, access: { ...w.h.deps.access, ownerActing: async (principal: Principal, task: { developerId: string; ownerKey: string }) => (principal.personId === task.developerId ? { actorId: task.ownerKey } : undefined) } };
  const runtime = { companyId: ORG, flow: { ...w.h.flow, deps }, ciReporting: { honest: true, ciMode: async () => "their_ci_fix" as const } } as never;
  // Order of events: the press is audited BEFORE GitHub is asked to merge.
  const order: string[] = [];
  const realMerge = model.merge.bind(model);
  const merges = vi.spyOn(model, "merge").mockImplementation((...args: Parameters<typeof model.merge>) => { order.push("github.merge"); return realMerge(...args); });
  const audit = deps.audit;
  const record = audit.record.bind(audit);
  (audit as { record: AuditSink["record"] }).record = async (event: AuditEvent) => { order.push(`audit:${event.action}`); await record(event); };
  await w.world.seedTracking();
  const merge = { projectGrantRole: async () => undefined, afterMerge: async () => undefined,
    merge: (sink: AuditSink) => hostedMergeDependencies({ runtime, registry: w.registry, settings: undefined, defaults: DEFAULT_CODE_SETTINGS, now: () => w.clock.ms, policyHook: false, audit: sink, taskPeople }) };
  const wiring = { origin: () => "https://api.example", taskActions: { roundCap: async () => undefined }, merge } as never;
  // The chat seam as the hosted install has it: a Slack workspace is the company's, a Slack account is the person it was linked to.
  const personOfUser = new Map<string, string>([[SLACK_USER.creator, CREATOR], [SLACK_USER.approver, APPROVER]]);
  const threads = {
    companyOf: async ({ channel, tenant }: { channel: string; tenant: string }) => (channel === "slack" && tenant === TEAM ? ORG : undefined),
    adapterFor: (_companyId: string, channel: string) => (channel === "slack" ? ({ capabilities: { threads: true, buttons: 10, edits: false, maxTextLength: 3_000, proactive: true, taskActions: true }, projects: [], stepUp: [], deliver: async () => undefined } as never) : undefined),
    personOf: async (_companyId: string, actor: ActorRef) => { const found = personOfUser.get(actor.userId); return found === undefined ? undefined : { personId: found, via: "signin" as const }; },
  };
  const routes = createTaskActionRoutes({
    companyOf: async (caller) => (members.includes(caller.principal.personId) ? { companyId: ORG, role: "member" as const } : undefined),
    mount: async () => ({ runtime, wiring }), now: () => w.clock.ms,
    chat: { threads, proofKey: Buffer.alloc(32, 3), gateFor: () => { throw new Error("this world decides no plan"); } },
  });
  const caller = (personId: string) => ({ principal: person(personId) });
  /** What the card offered the person (the merge button's binding), as the Slack card carries it. */
  const offer = async (who: Who) => (await routes.taskActions(caller(PERSON[who]), TASK_ID))?.find((entry) => entry.id === "task.merge");
  /** A press of the merge button by a Slack person: describe (the confirm), then perform with its digest and a request key per click. */
  const describe = async (who: Who): Promise<ActionDescription> => {
    const binding = (await offer(who))!.binding;
    const answer = await routes.taskAction(caller(PERSON[who]), { mode: "describe", actionId: "task.merge", taskId: TASK_ID, binding, conversation: CONVERSATION, actor: actorOf(who) });
    if (answer.mode !== "describe") throw new Error("expected a description");
    return answer.description;
  };
  const perform = async (who: Who, confirmDigest?: string, requestKey: string = randomUUID()): Promise<ActionResult> => {
    const binding = (await offer(who))!.binding;
    const answer = await routes.taskAction(caller(PERSON[who]), { mode: "perform", actionId: "task.merge", taskId: TASK_ID, binding, confirmDigest, requestKey, conversation: CONVERSATION, actor: actorOf(who) });
    if (answer.mode !== "perform") throw new Error("expected a result");
    return answer.result;
  };
  /** The same merge as the web page asks it (GET: whether it would merge now, and why not), over the same dependencies. */
  const webView = async (who: Who) => {
    const path = `/v1/app/tasks/${TASK_ID}/merge`;
    const result = await routeHostedMerge({ path, request: { method: "GET", path, headers: {} }, companyId: ORG, principal: person(PERSON[who]), role: "member", flow: deps, audit: deps.audit, now: () => w.clock.ms, webApp: true,
      wiring: { projectGrantRole: async () => undefined, afterMerge: async () => undefined, merge: (sink) => merge.merge(sink) } });
    return JSON.parse(result.body) as { mayMerge?: boolean; ready?: boolean; message?: string };
  };
  /** Every row of the store, whole: what "nothing was written" is compared against. */
  const snapshot = async (): Promise<string> => {
    const rows: unknown[] = [];
    let cursor: string | undefined;
    do {
      const page = await (w.h.store as MemoryDocumentStore).scanPage({ limit: 500, ...(cursor === undefined ? {} : { cursor }) });
      rows.push(...page.items);
      cursor = page.cursor;
    } while (cursor !== undefined);
    return JSON.stringify(rows.map((row) => JSON.stringify(row)).sort());
  };
  return { ...w, merges, order, offer, describe, perform, webView, snapshot };
}

const okDescription = (description: ActionDescription) => { expect(description.status).toBe("ok"); return description as Extract<ActionDescription, { status: "ok" }>; };
const refusedResult = (result: ActionResult) => { expect(result.status).toBe("refused"); return result as Extract<ActionResult, { status: "refused" }>; };

describe("the merge pressed from Slack, on the real hosted merge with the default rules (self-approval off)", () => {
  it("the stored owner id is the per-task key, never a person id (the shape the default rule used to refuse)", async () => {
    const w = await world("approver");
    expect((await w.world.task()).workflow.ownerId).toBe(taskOwnerKey(CREATOR, TASK_ID));
    expect((await w.world.task()).workflow.ownerId).not.toBe(CREATOR);
  });

  it("(a) another member's approval: the task is ready, the owner confirms in Slack, and the pull request is merged exactly once, the press audited before the merge", async () => {
    const w = await world("approver");
    // The web's own read of the same merge says it would merge now (the hosted people rule over the real link rows).
    expect(await w.webView("creator")).toMatchObject({ mayMerge: true, ready: true });
    // The card offers the button; the confirm is shown to the presser and names what merges; a press that skips the confirm is refused before any write.
    expect(await w.offer("creator")).toMatchObject({ id: "task.merge", risk: "irreversible", needsDialog: true });
    const described = okDescription(await w.describe("creator"));
    expect(described.confirm).toMatchObject({ danger: true, button: "Merge" });
    expect(described.confirmDigest).toMatch(/^[0-9a-f]{64}$/u);
    const before = await w.snapshot();
    expect(refusedResult(await w.perform("creator"))).toMatchObject({ reason: "needs_input", writes: "none" });
    expect(w.merges).not.toHaveBeenCalled();
    expect(await w.snapshot()).toBe(before);
    // The press with the confirm's digest merges, once.
    const key = randomUUID();
    expect(await w.perform("creator", described.confirmDigest, key)).toMatchObject({ status: "done" });
    expect(w.merges).toHaveBeenCalledTimes(1);
    // The press is audited BEFORE GitHub is asked; the result is audited after, both through the Slack surface.
    expect(w.order.indexOf(`audit:${MERGE_PRESSED_AUDIT}`)).toBeGreaterThanOrEqual(0);
    expect(w.order.indexOf(`audit:${MERGE_PRESSED_AUDIT}`)).toBeLessThan(w.order.indexOf("github.merge"));
    expect(w.order.indexOf("github.merge")).toBeLessThan(w.order.indexOf(`audit:${MERGE_RESULT_AUDIT}`));
    const pressed = w.h.audit.filter((event) => event.action === MERGE_PRESSED_AUDIT);
    expect(pressed).toHaveLength(1);
    expect(pressed[0]).toMatchObject({ actor: { type: "person", id: CREATOR }, details: { via: "slack", basis: "task-owner" } });
    expect(w.h.audit.find((event) => event.action === MERGE_RESULT_AUDIT)).toMatchObject({ details: { outcome: "merged", via: "slack" } });
    // The same click again (same request key) never merges a second time.
    await w.perform("creator", described.confirmDigest, key);
    expect(w.merges).toHaveBeenCalledTimes(1);
  });

  it("(b) the presser's own approval alone: refused with the plain words, nothing is merged, nothing is written, no press is audited", async () => {
    const w = await world("creator");
    // Why: the default rule reads the owner (the creator) as the requester, and the only approval is theirs (the web's read gives the merge core's words).
    expect(await w.webView("creator")).toMatchObject({ mayMerge: true, ready: false, message: M.needsOtherApproval("the owner") });
    // The button is still on the card (a state offer), and pressing it is refused as "not available now", before anything is written.
    expect(await w.offer("creator")).toMatchObject({ id: "task.merge" });
    const before = await w.snapshot();
    expect(await w.describe("creator")).toEqual({ status: "refused", code: "TASK_ACTION_NOT_OFFERED", reason: "not_offered" });
    // Not even a press that carries some digest gets further: the readiness is read again at the press.
    const pressed = refusedResult(await w.perform("creator", "0".repeat(64)));
    expect(pressed).toMatchObject({ code: "TASK_ACTION_NOT_OFFERED", reason: "not_offered", writes: "none" });
    expect(taskActionRefusalWords(pressed.reason, pressed.writes)).toBe("That is not available now: the task has moved on.");
    expect(w.merges).not.toHaveBeenCalled();
    expect(w.h.audit.filter((event) => event.action === MERGE_PRESSED_AUDIT || event.action === MERGE_RESULT_AUDIT)).toEqual([]);
    expect(w.order).toEqual([]);
    expect(await w.snapshot()).toBe(before);
  });
});
