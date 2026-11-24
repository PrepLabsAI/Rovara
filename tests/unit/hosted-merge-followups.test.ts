// REVIEW-1: exercise the hosted compositions, so replacing the creator with the
// presser or dropping core-job-services' repositoryEdges wiring breaks behavior.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CODE_SETTINGS, change, codeMilestoneKey, type OrgId, type Principal } from "@agentx/contracts";
import { hostedMergeDependencies } from "../../packages/broker/src/aws/hosted-merge-deps.js";
import { createHostedBrokerCoreServices } from "../../packages/broker/src/aws/core-job-services.js";
import { routeHostedMerge } from "../../packages/broker/src/core-host/hosted-merge-routes.js";
import { hostedEvidenceBlobs } from "../../packages/broker/src/core-host/hosted-evidence.js";
import { pullRequestRecordKey } from "../../packages/broker/src/core/build-step/records.js";
import { riskOfTask } from "../../packages/broker/src/core/merge/merge.js";
import { fixedCodeSettings } from "../../packages/broker/src/core/merge/defaults.js";
import { recoveryRowKey } from "../../packages/broker/src/core/merge/store.js";
import { repositoryEdgesKey } from "../../packages/broker/src/core/proof/evidence-keep.js";
import { taskKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { createPolicyHookClient } from "../../packages/broker/src/core/policy-hook/client.js";
import { withPolicyHookApprovers } from "../../packages/broker/src/core/policy-hook/approvers.js";
import { host, ORG } from "../support/service-host.js";
import { TASK_ID } from "../support/merge-world.js";
import { fakeService, ISSUER, makeKey, settingsFor, signerOf } from "./policy-hook-fixture.js";

const CREATOR = "task-creator", PRESSER = "different-presser";
const B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const person = (personId: string): Principal => ({ companyId: ORG, personId, displayName: personId, provider: "rovara", roles: ["admin"] });
const settings = fixedCodeSettings({ ...DEFAULT_CODE_SETTINGS, allowSelfApproval: true });
const install = makeKey("hosted-install"), hookKey = makeKey("hosted-rules");
const allow = { allow: true, minApprovers: 1, secondPerson: false, selfApproval: true };
const meta = { contentType: "application/json", metadata: {}, retention: "evidence-std" } as const;

async function hostedWorld(repositories = ["app"]) {
  const w = await host({ repositories });
  const home = { ownerKey: "owner-1", workspaceId: "ws-1", taskId: TASK_ID };
  await w.h.store.update({ key: taskKey(TASK_ID), ops: [change.set(["ownerKey"], home.ownerKey), change.set(["developerId"], CREATOR)] });
  const workspace = workspaceKey(ORG, home.workspaceId);
  await w.h.store.put({ item: { ...workspace, entityType: "WORKSPACE", id: home.workspaceId, companyId: ORG, ownerKey: home.ownerKey } });
  for (const pr of w.world.prs) await w.h.store.put({ item: {
    ...pullRequestRecordKey(workspace, pr.repositoryId, pr.number), entityType: "PULL_REQUEST", workspaceId: home.workspaceId,
    repository: pr.repositoryId, repositoryUrl: `https://github.com/acme/${pr.repositoryId}`, number: pr.number, url: pr.model.crUrl(String(pr.number)),
    state: "open", headBranch: "rovara/test", baseBranch: "main", expectedHeadCommit: pr.head, title: "Change", body: "",
    createdByOperationId: "11111111-1111-4111-8111-111111111111", updatedAt: new Date(w.clock.ms).toISOString(),
  } });
  const merges = w.world.prs.map((pr) => vi.spyOn(pr.model, "merge"));
  return { ...w, home, merges };
}

async function hookedRoute(mode: "allow" | "deny" | "no-answer" | "unaskable" | "malformed" | "second-person" | "raised" = "allow") {
  const w = await hostedWorld();
  await w.world.seedTracking();
  const service = fakeService({ key: hookKey, now: () => w.clock.ms, answer: () => {
    if (mode === "no-answer") return new Error("offline");
    if (mode === "malformed") return { ...allow, allow: "yes" };
    return { ...allow, allow: mode !== "deny", secondPerson: mode === "second-person", minApprovers: mode === "raised" ? 2 : 1 };
  } });
  const client = createPolicyHookClient({ settings: settingsFor(hookKey), install: { issuer: ISSUER, signer: signerOf(install) }, fetch: service.fetch, now: () => w.clock.ms, audit: w.h.deps.audit });
  w.registry.register("approvers", "rules", withPolicyHookApprovers(w.world.deps.approvers, mode === "unaskable" ? { ...client, prepare: async () => undefined } : client, { now: () => w.clock.ms }));
  const identities: Array<[string, string]> = [];
  const priyaAccount = w.world.prs[0]!.model.accounts.get("priya")!.hostUserId;
  const identity = { getPrincipal: vi.fn(async (companyId: string, id: string) => {
    identities.push([companyId, id]);
    return companyId === ORG && id === CREATOR ? person(CREATOR) : undefined;
  }),
  // Self-approval is ON here, and an approval counts only from a linked CURRENT member whatever that setting says: the reviewer's account belongs to the creator (a member).
  resolveExternalAccount: async (companyId: string, account: { accountId: string }) => (companyId === ORG && account.accountId === priyaAccount ? person(CREATOR) : undefined),
  accountsOf: async (companyId: string, id: string) => companyId === ORG && [CREATOR, PRESSER].includes(id)
    ? [{ provider: "github", tenant: "", accountId: priyaAccount }] : [],
  };
  w.registry.register("identity", "test", identity as never);
  const runtime = { companyId: ORG, flow: w.h.flow, ciReporting: { honest: true, ciMode: async () => "their_ci_fix" as const } } as never;
  const shown = { expectedHeads: w.world.prs.map((pr) => ({ repositoryId: pr.repositoryId, number: pr.number, headSha: pr.head })), risk: riskOfTask((await w.world.task()).workflow, []).level };
  const call = async (presser = PRESSER, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) => {
    const path = `/v1/app/tasks/${TASK_ID}/merge`;
    const result = await routeHostedMerge({ path, request: { method: "POST", path, headers, body: JSON.stringify({ requestId: randomUUID(), ...shown, ...body }) },
      companyId: ORG, principal: person(presser), role: "admin", flow: w.h.deps, audit: w.h.deps.audit, now: () => w.clock.ms, webApp: true,
      wiring: { projectGrantRole: async () => undefined, afterMerge: async () => undefined,
        merge: (audit) => hostedMergeDependencies({ runtime, registry: w.registry, settings, defaults: DEFAULT_CODE_SETTINGS, now: () => w.clock.ms, policyHook: true, audit, taskPeople: { documentClient: { send: async () => ({}) }, tableName: "state" } }) },
    });
    return { status: result.statusCode, body: JSON.parse(result.body) as Record<string, unknown> };
  };
  return { ...w, service, identity, identities, call };
}

describe("hosted route: task creator is the policy requester", () => {

  for (const field of ["requestedBy", "creatorId", "presser"] as const) it(`refuses a body-supplied ${field} before asking rules or merging`, async () => {
    const w = await hookedRoute();
    expect((await w.call(PRESSER, { [field]: person(PRESSER) })).status).toBe(400);
    expect(w.service.asked).toEqual([]);
    expect(w.merges[0]).not.toHaveBeenCalled();
  });

  for (const missing of ["creator", "identity"] as const) it(`refuses a missing ${missing} with zero merges`, async () => {
    const w = await hookedRoute();
    if (missing === "creator") await w.h.store.update({ key: taskKey(TASK_ID), ops: [change.remove(["developerId"])] });
    else w.identity.getPrincipal.mockResolvedValue(undefined);
    expect(await w.call()).toMatchObject({ status: 403, body: { error: { message: "someone other than the requester must merge" } } });
    expect(w.service.asked).toEqual([]);
    expect(w.merges[0]).not.toHaveBeenCalled();
  });

  for (const mode of ["deny", "no-answer", "unaskable", "malformed", "raised"] as const) it(`enforces ${mode} through the hosted route with zero merges`, async () => {
    const w = await hookedRoute(mode);
    expect((await w.call()).status).toBe(403);
    expect(w.merges[0]).not.toHaveBeenCalled();
    if (mode !== "unaskable") expect(w.service.asked[0]?.q).toMatchObject({ by: CREATOR, per: PRESSER });
  });

  it("a second-person rule refuses the creator's press and permits another person's press", async () => {
    const w = await hookedRoute("second-person");
    expect(await w.call(CREATOR)).toMatchObject({ status: 403, body: { error: { message: "someone other than the requester must merge" } } });
    expect(w.merges[0]).not.toHaveBeenCalled();
    expect((await w.call(PRESSER)).body).toMatchObject({ status: "MERGED" });
    expect(w.service.asked.map((q) => [q.q["by"], q.q["per"]])).toEqual([[CREATOR, CREATOR], [CREATOR, PRESSER]]);
    expect(w.merges[0]).toHaveBeenCalledTimes(1);
  });
});

async function hostedOrderWorld() {
  const w = await hostedWorld(["app", "docs", "payments-lib"]);
  for (const pr of w.world.prs) pr.model.getChangeRequest(String(pr.number)).draft = true;
  const prOf = (id: string) => w.world.prs.find((pr) => pr.repositoryId === id)!;
  const docs = prOf("docs");
  docs.model.setChecks(docs.head, [{ name: "unit", state: "pending", required: false, url: "" }]);
  const finishChecks = () => docs.model.setChecks(docs.head, [{ name: "unit", state: "completed", conclusion: "success", required: false, url: "", runId: "11" }]);
  const mergeByHand = (id: string) => {
    const pr = prOf(id);
    pr.model.getChangeRequest(String(pr.number)).draft = false;
    expect(pr.model.merge(String(pr.number), { revision: pr.head, method: "squash" }).outcome).toBe("merged");
  };
  const digest = (await w.world.task()).workflow.candidate!.digest;
  const key = repositoryEdgesKey(w.home, digest);
  const bytes = (candidateDigest = digest) => Buffer.from(JSON.stringify({ schemaVersion: 1, candidateDigest,
    edges: ["app", "docs"].map((consumer) => ({ consumer, provider: "payments-lib", language: "node", source: "both" })),
  }));
  const services = createHostedBrokerCoreServices({ companyId: ORG, flow: w.h.flow, registry: w.registry, settings, people: w.people,
    ciMode: async () => "their_ci_fix" as const, now: () => new Date(w.clock.ms) });
  const pass = async () => {
    await w.h.store.put({ item: { ...recoveryRowKey(TASK_ID), entityType: "WORKFLOW_MERGE_RECOVERY", kind: "tracking", taskId: TASK_ID, nextAttemptAt: 0 } });
    expect(await services["merge-tracking"].pass({ budgetMs: 10_000 })).toMatchObject({ attempted: 1, failed: 0 });
  };
  const warnings = async () => (await w.h.store.query({ pk: codeMilestoneKey(TASK_ID, "stuck", 0).pk, sk: { op: "beginsWith", prefix: "CODE_MILESTONE#stuck#" } })).items;
  const draft = (id: string) => prOf(id).model.getChangeRequest(String(prOf(id).number)).draft;
  const blobs = hostedEvidenceBlobs({ blobs: w.registry.require("object-storage"), store: w.h.store, companyId: ORG });
  return { ...w, key, bytes, digest, blobs, pass, warnings, draft, mergeByHand, finishChecks };
}

describe("hosted jobs: persisted repository edges drive warning and hold", () => {
  it("warns for a consumer merged first, holds the other consumer, and releases it after the provider merges", async () => {
    const w = await hostedOrderWorld();
    await w.blobs.put(w.key, w.bytes(), meta);
    w.mergeByHand("app");
    await w.pass();
    expect((await w.warnings()).map((row) => row["text"])).toEqual(["app merged before payments-lib, which it depends on. Rovara keeps docs as a draft until payments-lib merges. Merge payments-lib next, or ask for a revert of app."]);
    expect((await w.world.task()).workflow.pullRequests!.find((pr) => pr.repositoryId === "app")?.state).toBe("MERGED");
    // Draft readiness runs before merge observation. Complete docs' checks after
    // that observation, so only the dependency order now holds its draft.
    w.finishChecks();
    await w.pass();
    expect(w.draft("docs")).toBe(true);
    expect(w.draft("payments-lib")).toBe(false);
    w.mergeByHand("payments-lib");
    // One pass observes the provider; the next uses the recorded merge order.
    await w.pass();
    await w.pass();
    expect(w.draft("docs")).toBe(false);
    expect(await w.warnings()).toHaveLength(1);
    expect(w.merges.map((merge) => merge.mock.calls.length)).toEqual([1, 0, 1]);
  });

  for (const facts of ["missing", "stale-key", "stale-body", "unreadable", "other-company"] as const) it(`${facts} facts do not invent an order warning or hold`, async () => {
    const w = await hostedOrderWorld();
    const otherDigest = "f".repeat(64);
    if (facts === "stale-key") await w.blobs.put(repositoryEdgesKey(w.home, otherDigest), w.bytes(otherDigest), meta);
    if (facts === "stale-body") await w.blobs.put(w.key, w.bytes(otherDigest), meta);
    if (facts === "unreadable") await w.blobs.put(w.key, Buffer.from("not json"), meta);
    if (facts === "other-company") {
      const foreignHome = { ...w.home, ownerKey: "other-owner" };
      await w.h.store.put({ item: { ...workspaceKey(B, foreignHome.workspaceId), entityType: "WORKSPACE", id: foreignHome.workspaceId, companyId: B, ownerKey: foreignHome.ownerKey } });
      await w.h.store.update({ key: taskKey(TASK_ID), ops: [change.set(["ownerKey"], foreignHome.ownerKey)] });
      await hostedEvidenceBlobs({ blobs: w.registry.require("object-storage"), store: w.h.store, companyId: B }).put(repositoryEdgesKey(foreignHome, w.digest), w.bytes(), meta);
    }
    w.mergeByHand("app");
    await w.pass();
    w.finishChecks();
    await w.pass();
    expect(await w.warnings()).toEqual([]);
    expect(w.draft("docs")).toBe(false);
    expect(w.draft("payments-lib")).toBe(false);
    // Tracking observes merges; it never performs one itself.
    expect(w.merges.map((merge) => merge.mock.calls.length)).toEqual([1, 0, 0]);
  });
});
