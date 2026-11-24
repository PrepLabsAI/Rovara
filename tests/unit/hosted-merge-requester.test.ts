// A hosted task's workflow owner is the per-task key `taskOwnerKey(developerId, taskId)`, not a person id, and a takeover never changes it (it writes only the task People list). With the default rule
// (self-approval OFF) every hosted merge after another member's approval refused "Link your GitHub account" until the requesters were read the hosted way (aws/hosted-merge-people.ts): the creator while a
// member, plus every current owner of the People list. These tests run the REAL path: the hosted identity over real GitHub link rows (`linkGithubAccount(personId)`), the hosted dependencies and the job services built
// with no people override, the default code settings, and a task whose owner id is the per-task key (as `core/task-flow/start.ts` makes it). The press and merge tracking judge the same cases.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CODE_SETTINGS, MERGE_NOT_READY_MESSAGES as M, change, codeMilestoneKey, type Principal } from "@agentx/contracts";
import { hostedMergeDependencies } from "../../packages/broker/src/aws/hosted-merge-deps.js";
import { createHostedBrokerCoreServices } from "../../packages/broker/src/aws/core-job-services.js";
import { createHostedMergePeople, type HostedTaskPeopleSource } from "../../packages/broker/src/aws/hosted-merge-people.js";
import { createHostedIdentity } from "../../packages/broker/src/core-host/hosted-modules.js";
import { routeHostedMerge } from "../../packages/broker/src/core-host/hosted-merge-routes.js";
import { githubLinkReaderOver, linkGithubAccount } from "../../packages/broker/src/core/people/github-links.js";
import type { MergeTask } from "../../packages/broker/src/core/merge/seams.js";
import { riskOfTask } from "../../packages/broker/src/core/merge/merge.js";
import { fixedCodeSettings } from "../../packages/broker/src/core/merge/defaults.js";
import { recoveryRowKey } from "../../packages/broker/src/core/merge/store.js";
import { pullRequestRecordKey } from "../../packages/broker/src/core/build-step/records.js";
import { taskKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { taskOwnerKey } from "../../packages/broker/src/developer/task-records.js";
import { host, ORG } from "../support/service-host.js";
import { TASK_ID } from "../support/merge-world.js";

const CREATOR = "a".repeat(64), APPROVER = "b".repeat(64), NEW_OWNER = "c".repeat(64), BYSTANDER = "d".repeat(64);
const CREATOR_GITHUB = "424242", NEW_OWNER_GITHUB = "737373";
const TABLE = "state";
const person = (personId: string): Principal => ({ companyId: ORG, personId, displayName: personId, provider: "rovara", roles: ["admin"] });
const at = "2026-11-24T10:00:00.000Z";

/**
 * The task People list as the state table holds it (the rows `developer/task-people.ts` writes), behind a fake document client that answers only reads. `owners` undefined: the task has no list.
 * `listed` are the people on the list (default the owners); the owners hold role `owner`, the rest `commenter`.
 */
function peopleTable(owners: readonly string[] | undefined, listed: readonly string[] = owners ?? []) {
  const entry = (developerId: string) => ({ developerId, name: `Person ${developerId.slice(0, 2)}`, role: owners?.includes(developerId) === true ? "owner" : "commenter", method: "oidc" });
  const item = owners === undefined ? undefined : { pk: `DEVTASK#${TASK_ID}`, sk: "PEOPLE", schemaVersion: 1, revision: 2, orphaned: owners.length === 0, people: listed.map(entry) };
  const documentClient = { send: vi.fn(async (command: unknown) => {
    if (!(command instanceof GetCommand)) throw new Error("only reads");
    const key = command.input.Key as { pk: string; sk: string };
    return { Item: item !== undefined && key.pk === item.pk && key.sk === item.sk ? item : undefined };
  }) };
  return { documentClient, tableName: TABLE };
}
const unreadablePeople = { documentClient: { send: async () => { throw new Error("down"); } }, tableName: TABLE };

type Link = "creator" | "newOwner";
/**
 * The hosted world: the task's creator (a member, or one who left), its stored owner id (always the creator's own key, as production keeps it), the task People list, the members and the GitHub links. The pull request has ONE approval, from the fake host's reviewer
 * `priya`, whose GitHub account is linked to whoever `approvedBy` names (no one: an approval no member stands behind).
 */
async function world(options: { links?: readonly Link[]; approvedBy?: "approver" | "creator" | "newOwner" | "nobody"; people?: HostedTaskPeopleSource; creatorLeft?: boolean; approverLeft?: boolean; selfApproval?: boolean } = {}) {
  const { links = ["creator"], approvedBy = "approver", people = peopleTable([CREATOR]), creatorLeft = false, approverLeft = false, selfApproval = false } = options;
  const settings = selfApproval ? fixedCodeSettings({ ...DEFAULT_CODE_SETTINGS, allowSelfApproval: true }) : undefined;
  const w = await host();
  const model = w.world.prs[0]!.model;
  const priya = model.accounts.get("priya")!.hostUserId;
  const members = [NEW_OWNER, BYSTANDER, ...(approverLeft ? [] : [APPROVER]), ...(creatorLeft ? [] : [CREATOR])];
  await w.h.store.update({ key: taskKey(TASK_ID), ops: [change.set(["developerId"], CREATOR), change.set(["workflow", "ownerId"], taskOwnerKey(CREATOR, TASK_ID))] });
  // Rovara's own record of the pull request and its workspace (the press reads the base branch from it).
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
  const link = (personId: string, githubUserId: string) => linkGithubAccount(w.h.store, { companyId: ORG, githubUserId, login: `login${githubUserId}`, personId, linkedAt: at });
  // A person has ONE linked account. The reviewer's account (priya's) belongs to whoever the case names; the others get an account of their own.
  const accountOf = (who: "creator" | "newOwner" | "approver", own: string | undefined) => (approvedBy === who ? priya : own);
  for (const [who, personId, own] of [["creator", CREATOR, CREATOR_GITHUB], ["newOwner", NEW_OWNER, NEW_OWNER_GITHUB], ["approver", APPROVER, undefined]] as const) {
    const account = accountOf(who, own);
    if (account !== undefined && (who === "approver" ? approvedBy === "approver" : links.includes(who))) await link(personId, account);
  }
  const identity = createHostedIdentity({ membershipOf: async (id) => (members.includes(id) ? { companyId: ORG, role: "member" } : undefined), displayNameOf: async (id) => (members.includes(id) ? id : undefined), githubLinks: githubLinkReaderOver(w.h.store) });
  w.registry.register("identity", "hosted", identity);
  w.registry.register("approvers", "local", w.world.deps.approvers);
  const runtime = { companyId: ORG, flow: w.h.flow, ciReporting: { honest: true, ciMode: async () => "their_ci_fix" as const } } as never;
  const merges = vi.spyOn(model, "merge");
  const shown = { expectedHeads: w.world.prs.map((pr) => ({ repositoryId: pr.repositoryId, number: pr.number, headSha: pr.head })), risk: riskOfTask((await w.world.task()).workflow, []).level };
  await w.world.seedTracking();
  /** A press by `presser` through the hosted route, over the hosted dependencies with the DEFAULT code settings (no settings reader: `fixedCodeSettings(DEFAULT_CODE_SETTINGS)`). */
  const press = async (presser: string = CREATOR) => {
    const path = `/v1/app/tasks/${TASK_ID}/merge`;
    const result = await routeHostedMerge({ path, request: { method: "POST", path, headers: {}, body: JSON.stringify({ requestId: randomUUID(), ...shown }) },
      companyId: ORG, principal: person(presser), role: "admin", flow: w.h.deps, audit: w.h.deps.audit, now: () => w.clock.ms, webApp: true,
      wiring: { projectGrantRole: async () => undefined, afterMerge: async () => undefined,
        merge: (audit) => hostedMergeDependencies({ runtime, registry: w.registry, settings, defaults: DEFAULT_CODE_SETTINGS, now: () => w.clock.ms, policyHook: false, audit, taskPeople: people }) },
    });
    return { status: result.statusCode, body: JSON.parse(result.body) as { status?: string; error?: { message?: string } } };
  };
  /** One merge-tracking pass of the hosted job services (no people override: the hosted rule), then whether the task was announced as approved. */
  const track = async () => {
    const services = createHostedBrokerCoreServices({ companyId: ORG, flow: w.h.flow, registry: w.registry, ciMode: async () => "their_ci_fix" as const, now: () => new Date(w.clock.ms), taskPeople: people, ...(settings === undefined ? {} : { settings }) });
    await w.h.store.put({ item: { ...recoveryRowKey(TASK_ID), entityType: "WORKFLOW_MERGE_RECOVERY", kind: "tracking", taskId: TASK_ID, nextAttemptAt: 0 } });
    expect(await services["merge-tracking"].pass({ budgetMs: 10_000 })).toMatchObject({ attempted: 1, failed: 0 });
    const rows = (await w.h.store.query({ pk: codeMilestoneKey(TASK_ID, "approved", 0).pk, sk: { op: "beginsWith", prefix: "CODE_MILESTONE#approved#" } })).items;
    return rows.length > 0;
  };
  return { ...w, press, track, merges };
}

describe("hosted merge with the default rule (self-approval off): who asked for the task", () => {
  it("the task's owner id is the per-task key, never a person id (the shape that hid the bug)", async () => {
    const w = await world();
    const task = await w.world.task();
    expect(task.workflow.ownerId).toBe(taskOwnerKey(CREATOR, TASK_ID));
    expect(task.workflow.ownerId).not.toBe(CREATOR);
  });

  it("(1) the creator linked the normal way and another linked member approving: the press merges, and tracking announces the approval", async () => {
    const w = await world();
    expect(await w.press()).toMatchObject({ status: 200, body: { status: "MERGED" } });
    expect(w.merges).toHaveBeenCalledTimes(1);
    const t = await world();
    expect(await t.track()).toBe(true);
  });

  it("(2) the creator's own approval alone still refuses as self-only, and tracking does not announce it", async () => {
    const w = await world({ approvedBy: "creator" });
    const refused = await w.press();
    expect(refused.status).toBe(409);
    expect(refused.body.error?.message).toBe(M.needsOtherApproval("the owner"));
    expect(w.merges).not.toHaveBeenCalled();
    expect(await (await world({ approvedBy: "creator" })).track()).toBe(false);
  });

  it("(3) a creator with no linked account still gets the link message, in the press and (no announcement) in tracking", async () => {
    const w = await world({ links: [] });
    const refused = await w.press(APPROVER);
    expect(refused.body.error?.message).toBe(M.linkGithub);
    expect(w.merges).not.toHaveBeenCalled();
    expect(await (await world({ links: [] })).track()).toBe(false);
  });

  // A takeover writes only the People list: the stored owner id stays the creator's key, whoever holds the task now.
  const takeover = () => peopleTable([NEW_OWNER], [CREATOR, NEW_OWNER]);
  const lines = ["creator", "newOwner"] as const;

  it("(takeover 1) the NEW OWNER's own approval refuses as self-only, and a THIRD linked member's approval merges (press and tracking)", async () => {
    const self = await world({ links: lines, approvedBy: "newOwner", people: takeover() });
    expect((await self.press(CREATOR)).body.error?.message).toBe(M.needsOtherApproval("the owner"));
    expect(self.merges).not.toHaveBeenCalled();
    expect(await (await world({ links: lines, approvedBy: "newOwner", people: takeover() })).track()).toBe(false);
    const third = await world({ links: lines, people: takeover() });
    expect(await third.press(CREATOR)).toMatchObject({ status: 200, body: { status: "MERGED" } });
    expect(await (await world({ links: lines, people: takeover() })).track()).toBe(true);
  });

  it("(takeover 2) after a takeover the original creator, still a member, stays a requester: their approval is self-only too", async () => {
    const w = await world({ links: lines, approvedBy: "creator", people: takeover() });
    expect((await w.press(NEW_OWNER)).body.error?.message).toBe(M.needsOtherApproval("the owner"));
    expect(w.merges).not.toHaveBeenCalled();
    expect(await (await world({ links: lines, approvedBy: "creator", people: takeover() })).track()).toBe(false);
  });

  it("(takeover 3) a departed creator and a current owner: the owner is the requester, and another member's approval merges (no dead end)", async () => {
    const own = await world({ links: ["newOwner"], approvedBy: "newOwner", creatorLeft: true, people: takeover() });
    expect((await own.press(CREATOR)).body.error?.message).toBe(M.needsOtherApproval("the owner"));
    expect(await (await world({ links: ["newOwner"], approvedBy: "newOwner", creatorLeft: true, people: takeover() })).track()).toBe(false);
    const other = await world({ links: ["newOwner"], creatorLeft: true, people: takeover() });
    expect(await other.press(NEW_OWNER)).toMatchObject({ status: 200, body: { status: "MERGED" } });
    expect(await (await world({ links: ["newOwner"], creatorLeft: true, people: takeover() })).track()).toBe(true);
  });

  it("(review) a departed creator whose GitHub link row is still there cannot approve: dropping them from the requesters never lets their approval count", async () => {
    const w = await world({ links: ["creator", "newOwner"], approvedBy: "creator", creatorLeft: true, people: takeover() });
    expect((await w.press(NEW_OWNER)).status).toBe(409);
    expect(w.merges).not.toHaveBeenCalled();
    expect(await (await world({ links: ["creator", "newOwner"], approvedBy: "creator", creatorLeft: true, people: takeover() })).track()).toBe(false);
  });

  it("(takeover 4) a departed creator and NO current owner (or no People list): a plain NO OWNER refusal, never the link message and never a guessed requester", async () => {
    for (const people of [peopleTable([], [CREATOR]), peopleTable(undefined)]) {
      const w = await world({ links: [], creatorLeft: true, people });
      const refused = await w.press(APPROVER);
      expect(refused.status).toBe(409);
      expect(refused.body.error?.message).toBe(M.noOwner);
      expect(refused.body.error?.message).not.toBe(M.linkGithub);
      expect(w.merges).not.toHaveBeenCalled();
      expect(await (await world({ links: [], creatorLeft: true, people })).track()).toBe(false);
    }
  });

  it("(takeover 5) the People list unreadable: fails closed (the link message), nothing merges, nothing is announced", async () => {
    const w = await world({ links: lines, people: unreadablePeople });
    expect((await w.press(CREATOR)).body.error?.message).toBe(M.linkGithub);
    expect(w.merges).not.toHaveBeenCalled();
    expect(await (await world({ links: lines, people: unreadablePeople })).track()).toBe(false);
  });

  it("a current owner with no linked account still gets the link message", async () => {
    const w = await world({ links: ["creator"], people: takeover() });
    expect((await w.press(CREATOR)).body.error?.message).toBe(M.linkGithub);
    expect(w.merges).not.toHaveBeenCalled();
  });

  it("an approval no linked member stands behind does not count", async () => {
    const w = await world({ approvedBy: "nobody" });
    expect((await w.press()).status).toBe(409);
    expect(w.merges).not.toHaveBeenCalled();
    expect(await (await world({ approvedBy: "nobody" })).track()).toBe(false);
  });
});

// The owner's decision: an approval counts only from a CURRENT MEMBER of the company, whatever "allow self-approval" says. Self-approval ON only lets a requester's OWN approval count.
describe("hosted merge with self-approval ON: only a current member's approval counts", () => {
  it("a person who LEFT the company but still has GitHub write access and a link row: their approval does not count (the press refuses, tracking does not announce)", async () => {
    const w = await world({ selfApproval: true, approvedBy: "approver", approverLeft: true });
    const refused = await w.press();
    expect(refused.status).toBe(409);
    expect(refused.body.error?.message).toBe(M.needsWriteApproval("app"));
    expect(w.merges).not.toHaveBeenCalled();
    expect(await (await world({ selfApproval: true, approvedBy: "approver", approverLeft: true })).track()).toBe(false);
  });

  it("an approval from a GitHub account no member stands behind does not count either", async () => {
    const w = await world({ selfApproval: true, approvedBy: "nobody" });
    expect((await w.press()).status).toBe(409);
    expect(w.merges).not.toHaveBeenCalled();
    expect(await (await world({ selfApproval: true, approvedBy: "nobody" })).track()).toBe(false);
  });

  it("the requester, a current member, approving their own task counts (self-approval's whole meaning): the press merges and tracking announces", async () => {
    const w = await world({ selfApproval: true, approvedBy: "creator" });
    expect(await w.press()).toMatchObject({ status: 200, body: { status: "MERGED" } });
    expect(w.merges).toHaveBeenCalledTimes(1);
    expect(await (await world({ selfApproval: true, approvedBy: "creator" })).track()).toBe(true);
  });

  it("another current member approving counts too, and with self-approval OFF a departed member still does not (unchanged)", async () => {
    expect(await (await world({ selfApproval: true })).press()).toMatchObject({ status: 200, body: { status: "MERGED" } });
    const off = await world({ approvedBy: "approver", approverLeft: true });
    expect((await off.press()).status).toBe(409);
    expect(off.merges).not.toHaveBeenCalled();
  });
});

describe("createHostedMergePeople: who the requesters are", () => {
  const accountsOf = vi.fn(async (_company: string, personId: string) => (personId === CREATOR ? [{ provider: "github", tenant: "", accountId: "1" }] : personId === NEW_OWNER ? [{ provider: "github", tenant: "", accountId: "2" }] : []));
  const identityOf = (members: readonly string[]) => ({ capabilities: {}, authenticate: async () => ({ ok: false as const, reason: "refused" as const }), getPrincipal: async (_c: string, id: string) => (members.includes(id) ? person(id) : undefined), resolveExternalAccount: async () => undefined, accountsOf }) as never;
  const task: MergeTask = { taskId: TASK_ID, ownerId: taskOwnerKey(CREATOR, TASK_ID), creatorId: CREATOR, ownerName: "x", project: "web", startingRevision: 1, workspaceId: "w" };

  it("is the creator while a member plus every current owner; the stored owner id is never read or rewritten", async () => {
    const identity = identityOf([CREATOR, NEW_OWNER]);
    expect(await createHostedMergePeople(identity, peopleTable([CREATOR])).requestersOf(ORG, task)).toEqual(["1"]);
    expect(await createHostedMergePeople(identity, peopleTable([NEW_OWNER], [CREATOR, NEW_OWNER])).requestersOf(ORG, task)).toEqual(["1", "2"]);
    expect(await createHostedMergePeople(identity, peopleTable(undefined)).requestersOf(ORG, { ...task, ownerId: "anything" })).toEqual(["1"]);
    expect(task.ownerId).toBe(taskOwnerKey(CREATOR, TASK_ID));
  });

  it("drops the creator who left and an owner who left; nobody left is no_owner; a requester with no account is unlinked; an unreadable list is unlinked", async () => {
    expect(await createHostedMergePeople(identityOf([NEW_OWNER]), peopleTable([NEW_OWNER], [CREATOR, NEW_OWNER])).requestersOf(ORG, task)).toEqual(["2"]);
    expect(await createHostedMergePeople(identityOf([CREATOR]), peopleTable([NEW_OWNER], [CREATOR, NEW_OWNER])).requestersOf(ORG, task)).toEqual(["1"]);
    expect(await createHostedMergePeople(identityOf([]), peopleTable([NEW_OWNER])).requestersOf(ORG, task)).toBe("no_owner");
    expect(await createHostedMergePeople(identityOf([CREATOR, BYSTANDER]), peopleTable([BYSTANDER], [CREATOR, BYSTANDER])).requestersOf(ORG, task)).toBe("unlinked");
    expect(await createHostedMergePeople(identityOf([CREATOR]), unreadablePeople).requestersOf(ORG, task)).toBe("unlinked");
  });

  it("(review) a People row naming someone who is not a current member of THIS company is no requester (they cannot approve either)", async () => {
    const OUTSIDER = "e".repeat(64);
    const memberships: Array<{ companyId: string; role: "member" } | undefined> = [{ companyId: "org_other", role: "member" }, undefined];
    for (const membership of memberships) {
      const hosted = createHostedIdentity({
        membershipOf: async (id) => (id === CREATOR ? { companyId: ORG, role: "member" } : id === OUTSIDER ? membership : undefined),
        displayNameOf: async (id) => id,
        githubLinks: { personOf: async () => undefined, accountOf: async (_c: string, id: string) => (id === CREATOR ? "1" : id === OUTSIDER ? "9" : undefined) },
      });
      expect(await createHostedMergePeople(hosted, peopleTable([OUTSIDER], [CREATOR, OUTSIDER])).requestersOf(ORG, task)).toEqual(["1"]);
    }
  });
});

describe("the hosted merge never falls back to a rule that lets anyone approve", () => {
  it("the job services built with neither a People source nor a people override refuse to build (fail closed), and with either they build", async () => {
    const w = await world();
    const base = { companyId: ORG, flow: w.h.flow, registry: w.registry, ciMode: async () => "their_ci_fix" as const, now: () => new Date(w.clock.ms) };
    expect(() => createHostedBrokerCoreServices(base)).toThrow("the core jobs need the task People source for the merge requesters");
    expect(() => createHostedBrokerCoreServices({ ...base, taskPeople: peopleTable([CREATOR]) })).not.toThrow();
  });

  it("the deployed broker and the core root each hand the People source (the state table) to the job services and the press", () => {
    const read = (path: string) => readFileSync(new URL(`../../packages/broker/src/aws/${path}`, import.meta.url), "utf8");
    // aws/broker.ts: the job services (merge tracking) that the deployed handler builds.
    expect(read("broker.ts")).toMatch(/createHostedBrokerCoreServices\(\{ companyId, flow, registry, ciMode: wiring\.ciMode!,\s*settings: [^\n]*, taskPeople: \{ documentClient, tableName: requiredEnvironment\("STATE_TABLE_NAME"\) \},/u);
    // aws/core-engine-root.ts: the press (the hosted merge dependencies).
    expect(read("core-engine-root.ts")).toMatch(/hostedMergeDependencies\(\{[^\n]*, taskPeople \}\)/u);
    expect(read("core-engine-root.ts")).toMatch(/const taskPeople: TaskPeopleDependencies = \{/u);
  });
});
