// FIX-0518 review fixes (Opus review of #552): a setup host request cannot bring a model host back, the opt-out line does not change a verdict, evidence reads the state the machine was created with.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { setupDecisionSubjects } from "../../packages/broker/src/local/app/setup-agent.js";
import { SETUP_HOST_KIND, createSetupHostSubject, hostAskSubjectId, listHostAsks, refusedCountsOf, requestHostAsk, SETUP_HOST_REFUSALS, SETUP_HOST_REFUSAL_WORDS } from "../../packages/broker/src/core/setup-agent/host-ask.js";
import { refuseSetupHost } from "../../packages/broker/src/core/setup-agent/host-refusal.js";
import { handleSetupAgentCallback } from "../../packages/broker/src/core/setup-agent/callback.js";
import { taskPointerKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { SETUP_AGENT_WORKFLOW_MODE } from "../../packages/broker/src/core/setup-agent/agent.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { SubjectRefusal } from "../../packages/broker/src/core/decisions/approval-gate.js";
import { laptopSandboxDenyList } from "../../packages/broker/src/local/isolation/sandbox-model-deny.js";

const orgId = IMPLICIT_COMPANY_ID;
const DENY = laptopSandboxDenyList();
const taskRow = (taskId: string) => ({ pk: `DEVTASK#${taskId}`, sk: "META", entityType: "DEVELOPER_TASK", purpose: "setup_agent", companyId: orgId, project: "payments", developerId: "local-owner", provider: "local-owner", workspaceId: randomUUID() });
const MODEL_HOSTS = ["api.openai.com", "API.OpenAI.com", "chatgpt.com", "auth.openai.com", "api.anthropic.com", "openrouter.ai", "eu.api.openai.com", "ab.chatgpt.com", "x.openai.azure.com", "a.b.c.openai.azure.com", "us-central1-aiplatform.googleapis.com"];

describe("the setup agent cannot ask for a model host back (M1)", () => {
  it("refuseSetupHost refuses anything the sandbox deny list covers, with its own kind, and is unchanged when no list is given", () => {
    for (const host of MODEL_HOSTS) {
      expect(refuseSetupHost(host, undefined, DENY), host).toBe("model_host");
      expect(refuseSetupHost(`${host}.`, undefined, DENY), `${host}.`).toBe("model_host");
    }
    for (const host of ["github.com", "registry.npmjs.org", "oauth2.googleapis.com", "api.openai.com.evil.dev", "notopenai.com"]) expect(refuseSetupHost(host, undefined, DENY), host).toBeUndefined();
    expect(refuseSetupHost("api.openai.com")).toBeUndefined();
    expect(refuseSetupHost("api.openai.com", undefined, [])).toBeUndefined();
    expect(SETUP_HOST_REFUSALS).toContain("model_host");
    expect(SETUP_HOST_REFUSAL_WORDS.model_host).toBe("A model host: the test sandbox is not allowed to reach it.");
  });

  it("a request for a denied host is refused as a model host, counted, never `already_allowed` (L3) and never a card; with no deny it is as before", async () => {
    const store = new MemoryDocumentStore();
    const table = { store, now: () => Date.parse("2026-11-13T12:00:00Z") };
    const taskId = randomUUID();
    await store.put({ item: taskRow(taskId) });
    const input = (host: string, extra: Record<string, unknown> = {}) => ({ orgId, project: "payments", host, taskId, projectDomains: ["api.openai.com", "*.openai.com", "chatgpt.com"], ...extra });
    for (const host of ["api.openai.com", "eu.api.openai.com", "chatgpt.com"]) {
      expect(await requestHostAsk(table, input(host, { sandboxDenied: DENY })), host).toMatchObject({ outcome: "refused", reason: "model_host" });
    }
    expect(await refusedCountsOf(table, orgId, "payments", taskId)).toEqual({ model_host: 3 });
    expect(await listHostAsks(table, orgId, "payments", ["open", "approved", "refused"])).toEqual([]);
    // The owner allowed model hosts for this project (no deny list): the old answer.
    expect(await requestHostAsk(table, input("api.openai.com", { sandboxDenied: [] }))).toEqual({ outcome: "already_allowed" });
    expect(await requestHostAsk(table, input("api.openai.com"))).toEqual({ outcome: "already_allowed" });
  });

  it("the worker's callback hands the project's deny list to the ask: a denied host comes back refused/model_host, an allowed project's does not", async () => {
    const store = new MemoryDocumentStore();
    const taskId = randomUUID();
    const workspaceId = randomUUID();
    await store.put({ item: { ...taskRow(taskId), workspaceId } });
    await store.put({ item: { ...taskPointerKey(workspaceId), taskId } });
    const operation = { kind: "task", workflowMode: SETUP_AGENT_WORKFLOW_MODE, status: "RUNNING", workspaceId, companyId: orgId };
    const deps = (list?: (project: string) => readonly string[]) => ({ store, companyId: orgId, now: () => Date.parse("2026-11-13T12:00:00Z"), installDomains: () => ["api.openai.com", "*.openai.com"], ...(list === undefined ? {} : { sandboxDenied: list }) });
    const ask = (host: string, list?: (project: string) => readonly string[]) => handleSetupAgentCallback(deps(list), operation, { kind: "host", host });
    const seen: string[] = [];
    expect(await ask("api.openai.com", (project) => { seen.push(project); return DENY; })).toEqual({ outcome: "refused", reason: "model_host" });
    expect(seen).toEqual(["payments"]);
    expect(await ask("eu.api.openai.com", () => DENY)).toEqual({ outcome: "refused", reason: "model_host" });
    // The owner allowed model hosts for the project (the list is empty), or the install passes no list: today's answer.
    expect(await ask("api.openai.com", () => [])).toEqual({ outcome: "already_allowed" });
    expect(await ask("api.openai.com")).toEqual({ outcome: "already_allowed" });
  });

  it("the owner's approval re-checks the deny list: a model host asked while allowed cannot be approved after the deny is on, and can while it is off (also through the app's own subjects)", async () => {
    const store = new MemoryDocumentStore();
    const table = { store, now: () => Date.parse("2026-11-13T12:00:00Z") };
    const taskId = randomUUID();
    await store.put({ item: taskRow(taskId) });
    // `generativelanguage.googleapis.com` is a catalog host that is not on the default list, so it becomes a card while the project's sandbox is allowed model hosts.
    const host = "generativelanguage.googleapis.com";
    expect(await requestHostAsk(table, { orgId, project: "payments", host, taskId, projectDomains: [], sandboxDenied: [] })).toMatchObject({ outcome: "created" });
    const subjectId = hostAskSubjectId(orgId, "payments", host);
    const attempt = { companyId: orgId, kind: SETUP_HOST_KIND, subjectId, requestId: "r1", outcome: "approve", seen: { revision: 1, artifactDigest: "x" } } as never;
    const decideWith = async (subject: ReturnType<typeof createSetupHostSubject>) => { const loaded = await subject.load(orgId, subjectId); if (loaded === undefined) throw new Error("no open ask"); return subject.apply(loaded, attempt, [localOwnerPrincipal()], "2026-11-13T12:00:00Z"); };
    const direct = (sandboxDenied?: (project: string) => readonly string[]) => createSetupHostSubject({ store, ...(sandboxDenied === undefined ? {} : { sandboxDenied }) });
    const viaApp = (sandboxDenied?: (project: string) => readonly string[]) => setupDecisionSubjects({ store } as never, sandboxDenied).find((subject) => subject.kind === SETUP_HOST_KIND)!;
    for (const make of [direct, viaApp]) {
      await expect(decideWith(make(() => DENY))).rejects.toBeInstanceOf(SubjectRefusal);
      await expect(decideWith(make(() => DENY))).rejects.toThrow(SETUP_HOST_REFUSAL_WORDS.model_host);
      expect(await decideWith(make(() => []))).toMatchObject({ result: { host, state: "approved" } });
      expect(await decideWith(make())).toMatchObject({ result: { host, state: "approved" } });
    }
  });
});
