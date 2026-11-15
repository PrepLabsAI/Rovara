// The host-neutral service layer composed by a host that is not the local app: fake adapters only, no `local/app` code. One merge is tracked and recorded, one session sweep runs and one notice is delivered, and the
// host's own rules (who a person is on the code host, the words of a notice) are the ones it passed in.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { approvalProofKey, change, companyScoped, when, type Approvers } from "@agentx/contracts";
import { approvalProofMarkerKey, type DecisionGatePolicy, type DecisionSubject } from "../../packages/broker/src/core/decisions/approval-gate.js";
import { createDocumentEvidenceBlobStore } from "../../packages/broker/src/core/proof/evidence-blob-store.js";
import { createNoopAuditSink } from "../../packages/broker/src/ports/policy-defaults.js";
import { createHarness } from "../support/task-flow-harness.js";
import * as broker from "../../packages/broker/src/index.js";
import { createAdapterRegistry } from "../../packages/broker/src/ports/adapter-registry.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { writeNotifyPrefs } from "../../packages/broker/src/core/notify/index.js";
import { recoveryRowKey } from "../../packages/broker/src/core/merge/store.js";
import { createDecisionService, createNoticeService } from "../../packages/broker/src/services/index.js";
import { TASK_ID } from "../support/merge-world.js";
import { CONVERSATION, FOOTER, ORG, OWNER, OWNER_ID, SESSION, host } from "../support/service-host.js";

describe("the service layer, composed with fake adapters and no local-app code", () => {
  it("is exported from the package's public entry", () => {
    for (const name of ["createMergeTrackingService", "createSessionService", "createNoticeService", "createDecisionService", "createCallbackService", "createMilestoneService"]) {
      expect(typeof (broker as unknown as Record<string, unknown>)[name], name).toBe("function");
    }
  });

  it("tracks one merge: the pull request merged on the code host is recorded in the workflow with its milestone, and the tracking row ends", async () => {
    const w = await host();
    const pr = w.world.prs[0]!;
    expect(pr.model.merge(String(pr.number), { revision: pr.head, method: "squash" }).outcome).toBe("merged");
    expect(await w.tracking.sweep()).toEqual({ attempted: 1 });
    const task = (await w.world.store.get(taskKey(TASK_ID)))!;
    expect(task["workflow"]).toMatchObject({ stage: "MERGED", state: "COMPLETE", outcome: "MERGED", pullRequests: [expect.objectContaining({ number: pr.number, state: "MERGED" })] });
    // The milestone is a row of the task, written once, in the merge's own commit.
    const rows = (await w.world.store.query({ pk: `DEVTASK#${TASK_ID}` })).items.filter((item) => String(item.sk).startsWith("CODE_MILESTONE#"));
    expect(rows.filter((row) => row["kind"] === "merged")).toHaveLength(1);
    expect(await w.world.store.get(recoveryRowKey(TASK_ID))).toBeUndefined();
    // A second sweep has nothing to read.
    expect(await w.tracking.sweep()).toEqual({ attempted: 0 });
  });

  it("reads who a person is through the seam the host passed, not a sole owner", async () => {
    const w = await host();
    expect(w.tracking.deps.people).toBe(w.people);
    // The pull request is open and approved: the pass asks the host's seam who asked for the task.
    await w.tracking.sweep();
    expect(w.requested).toContain("requestersOf");
  });

  it("runs one session sweep and delivers one notice through the host's own words", async () => {
    const w = await host();
    await writeNotifyPrefs({ store: w.h.store, now: () => new Date(w.clock.ms) }, ORG, OWNER_ID, { targets: [{ channel: "examplechat", conversation: CONVERSATION }], muted: false });
    // The summary written at creation has no status-model words: its first refresh is not announced.
    await w.sessions.refresh(ORG, SESSION);
    w.clock.ms += 1_000;
    w.state.facts = { ...w.state.facts, workflow: { stage: "PLAN_REVIEW", state: "WAITING" }, step: "Waiting for approval" };
    expect(await w.sessions.sweep()).toMatchObject({ visited: 1, updated: 1, failed: 0 });
    w.clock.ms += 6 * 60_000;
    expect(await w.notices.deliver()).toMatchObject({ people: 1, sent: 1 });
    expect(w.chat.delivered).toHaveLength(1);
    const text = (w.chat.delivered[0]!.data as { text: string }).text;
    expect(text).toContain("Add retry");
    expect(text).toContain(`https://host.example.test/sessions/${SESSION}`);
    expect(text).toContain(FOOTER);
  });

  it("queues and delivers nothing when no chat or email adapter can tell anyone", async () => {
    const w = await host();
    const none = createNoticeService({ store: w.h.store, registry: createAdapterRegistry() });
    expect(none.canNotify()).toBe(false);
    expect(await none.deliver()).toBeUndefined();
  });
});


describe("decision service approval policy", () => {
  it.each<{ label: string; policy?: DecisionGatePolicy; method: string; spent: boolean }>([
    { label: "omitted policy spends a non-local credential once", method: "browser-session", spent: true },
    { label: "omitted policy keeps the local session reusable", method: "local-session", spent: false },
    { label: "supplied policy keeps its named method reusable", policy: { reusableMethods: ["browser-session"] }, method: "browser-session", spent: false },
    { label: "supplied policy replaces the default reusable methods", policy: { reusableMethods: ["browser-session"] }, method: "local-session", spent: true },
  ])("$label", async ({ policy, method, spent }) => {
    const h = createHarness();
    const token = ["test", "session", randomUUID()].join("-");
    const digest = "a".repeat(64);
    const key = (id: string) => ({ pk: companyScoped(ORG, `POLICY_SUBJECT#${id}`), sk: "STATE" });
    // A host-owned subject and issuer; the service, gate and transactional store are real.
    const subject: DecisionSubject = {
      kind: "policy-test",
      async load(companyId, id) {
        if (companyId !== ORG) return undefined;
        const row = await h.store.get(key(id));
        if (row === undefined) return undefined;
        return { key: key(id), guard: when.eq(["waiting"], true), waiting: row["waiting"] === true, state: null,
          request: { kind: "policy-test", subject: { type: "task", id }, revision: 1, artifactDigest: digest, risk: "low" } };
      },
      apply: () => ({ ops: [change.set(["waiting"], false)] }),
    };
    const approvers: Approvers = {
      requirement: async () => ({ methods: ["browser-session", "local-session"], minApprovers: 1, selfApprovalAllowed: true }),
      verify: async (request, proof) => proof.token === token && proof.method === method && proof.requestId === request.requestId
        ? { approved: true, approver: OWNER, method: proof.method, proofId: proof.proofId }
        : { approved: false, reason: "invalid" },
    };
    const service = createDecisionService({
      flow: h.deps, blobs: createDocumentEvidenceBlobStore(h.store, { companyId: ORG }), store: h.store,
      approvers, audit: createNoopAuditSink(), companyId: ORG, subjects: [subject],
      ...(policy === undefined ? {} : { policy }),
    });
    const decide = (subjectId: string) => service.gate.decide({
      companyId: ORG, kind: subject.kind, subjectId, requestId: randomUUID(), outcome: "approve",
      seen: { revision: 1, artifactDigest: digest }, credentials: [{ method, token }],
    });
    for (const id of ["first", "second"]) await h.store.put({ item: { ...key(id), waiting: true } });
    expect((await decide("first")).status).toBe("decided");
    expect((await h.store.get(key("first")))?.["waiting"]).toBe(false);
    const marker = await h.store.get(approvalProofMarkerKey(ORG, approvalProofKey({ method, token, requestId: "*" })));
    if (spent) expect(marker?.["entityType"]).toBe("APPROVAL_PROOF_SPENT");
    else expect(marker).toBeUndefined();
    const second = await decide("second");
    if (spent) expect(second).toMatchObject({ status: "refused", reason: "proof_already_used" });
    else expect(second.status).toBe("decided");
    expect((await h.store.get(key("second")))?.["waiting"]).toBe(spent);
  });
});
