// Q2 (web task channel, stacked on S2): the AWS root's administrator stop of a core task's workspace binds the install administrator's project grant to the TASK'S company. A grant row
// (`MEMBER#<person>` / `PROJECT#<name>`) names a project by name only, and companies A and B both have a "payments" project here; the administrator's company is their live membership in
// the sign-in table (`COMPANY_MEMBER#<person>`), the reader every core caller is judged by. Real broker root and core runtime over fake adapters; no network, no AWS.
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { orgProjectCatalogKey, projectRevisionKey, type OrgId, type StoredDocument } from "@agentx/contracts";
import { createBrokerCoreRoot } from "../../packages/broker/src/aws/core-engine-root.js";
import { createBrokerCoreServices } from "../../packages/broker/src/aws/core-job-services.js";
import type { CoreTaskEntry } from "../../packages/broker/src/aws/engine-boundary.js";
import { taskKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { ADMIN_GRANT_MISSING } from "../../packages/broker/src/core/task-flow/stop-request.js";
import { taskKeySigner } from "../../packages/broker/src/core-host/gateway-model-access.js";
import { createFakeWorld } from "../support/core-host-fakes.js";
import { makeKey, signerOf } from "../unit/policy-hook-fixture.js";
import { signedRunPriceResponse } from "../support/signed-run-price-fetch.js";

afterEach(() => { vi.unstubAllGlobals(); });

const adapters = vi.hoisted(() => ({ modules: [] as unknown[] }));
vi.mock("../../packages/broker/src/core-host/code-modules.js", async (original) => ({ ...await original<object>(), codeAdapterModules: () => adapters.modules }));
// Batch b18 (#1041 HW3c): no company rules service on this install (the company-instructions point stays empty, as before #1041); this file is not about company rules.
vi.mock("../../packages/broker/src/core-host/company-instructions-http.js", async (original) => ({ ...await original<object>(), companyInstructionsModules: () => [] }));
const A: OrgId = "org_aaaaaaaaaaaaaaaaaaaa", B: OrgId = "org_bbbbbbbbbbbbbbbbbbbb";
/** Task owners in each company, an install administrator in each company, one revoked from B, and one whose membership read fails. */
const ownerA = "a".repeat(64), ownerB = "b".repeat(64), adminA = "1".repeat(64), adminB = "2".repeat(64), revokedB = "3".repeat(64), unreadable = "4".repeat(64), nobody = "5".repeat(64);
const MODEL = "claude-sonnet-4-6";
const plain = (value: unknown): StoredDocument => JSON.parse(JSON.stringify(value)) as StoredDocument;
const project = { name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.", repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }] };

async function world() {
  const w = createFakeWorld();
  w.clock.now = Date.now();
  vi.stubGlobal("fetch", async (input: string | URL | Request) => signedRunPriceResponse(input, [A, B], [MODEL], w.clock.now) ?? Response.json({}, { status: 404 }));
  adapters.modules = w.modules.filter((module) => ["storage", "queue", "worker-machines", "object-storage", "code-host", "check-runner", "secrets"].includes(module.point));
  const members = new Map<string, { companyId: OrgId; role: string; revokedAt?: string }>([
    [ownerA, { companyId: A, role: "member" }], [ownerB, { companyId: B, role: "member" }], [adminA, { companyId: A, role: "member" }], [adminB, { companyId: B, role: "member" }],
    [revokedB, { companyId: B, role: "admin", revokedAt: new Date(w.clock.now).toISOString() }],
  ]);
  const client = { async send(command: unknown) {
    if (!(command instanceof GetCommand)) throw new Error("only fake point reads");
    const key = command.input.Key as { pk: string; sk: string };
    if (key.pk.startsWith("COMPANY_MEMBER#")) {
      const personId = key.pk.slice("COMPANY_MEMBER#".length);
      if (personId === unreadable) throw new Error("sign-in table throttled: secret-cause");
      const found = members.get(personId);
      return { Item: found === undefined ? undefined : { ...key, entityType: "COMPANY_MEMBERSHIP", personId, ...found, joinedAt: new Date(w.clock.now).toISOString() } };
    }
    // DEC 254zzz80: each person's "payments" grant sits in their own company's partition (`ORG#<company>#MEMBER#<person>`), as a named company keeps its grants.
    const grant = /^ORG#(org_[0-9a-z]{20})#MEMBER#(.+)$/u.exec(key.pk);
    if (grant !== null) return { Item: members.get(grant[2]!)?.companyId === grant[1] ? { ...key, projectName: "payments", role: "developer" } : undefined };
    return { Item: await w.store.get(key) };
  } };
  const root = createBrokerCoreRoot({
    env: { ROVARA_CORE_MODEL_GATEWAY_URL: "https://gateway.example", ROVARA_CORE_AGENT_MODEL: MODEL },
    documentClient: client, stateTableName: "state", signInTableName: "signin", callbackSigningKey: "k".repeat(32), repositoryGrantKey: Buffer.alloc(32, 1),
    repositoryCredential: async () => ({ token: "fake" }), codeModules: () => ({}) as never,
    taskTokens: () => ({ signer: taskKeySigner(signerOf(makeKey("t".repeat(16)))), issuer: "https://api.example/v1/auth" }),
    origin: () => "https://api.example", now: () => new Date(w.clock.now), log: () => undefined,
    ciReporting: { honest: true, ciMode: async () => "sandbox_only" as const },
    services: (companyId, flow, registry, wiring) => createBrokerCoreServices({ companyId, flow, registry, ciMode: wiring.ciMode!, now: () => new Date(w.clock.now) }),
  });
  for (const companyId of [A, B]) {
    await w.store.put({ item: plain({ ...projectRevisionKey(companyId, "payments", 1), definition: project }) });
    await w.store.put({ item: { ...orgProjectCatalogKey(companyId, "payments"), latestRevision: 1 } });
  }
  /** Starts a "payments" task for this person (in their own company) and answers its ids. */
  const start = async (developerId: string) => {
    const answer = await root.coreTasks!.route({ method: "POST", path: "/v1/dev/tasks", headers: {}, body: JSON.stringify({ requestId: randomUUID(), project: "payments", instructions: "Add retry handling" }) }, { developerId, sessionId: "session", name: "Member" });
    expect(answer?.statusCode, answer?.body).toBe(200);
    const { task: { taskId } } = z.object({ task: z.object({ taskId: z.string() }) }).parse(JSON.parse(answer!.body));
    const workspaceId = z.string().parse((await w.store.get(taskKey(taskId)))!["workspaceId"]);
    return { taskId, workspaceId };
  };
  const activeOperation = async (companyId: OrgId, workspaceId: string) => (await w.store.get(workspaceKey(companyId, workspaceId)))?.["activeOperationId"];
  return { w, root, start, activeOperation };
}

it("two companies: A's administrator, whose grant names 'payments', is refused on B's 'payments' task in the missing grant's words, before the project check; B's administrator stops it", async () => {
  const h = await world();
  const b = await h.start(ownerB);
  const running = await h.activeOperation(B, b.workspaceId);
  expect(running).toEqual(expect.any(String));
  const authorize = vi.fn(async () => undefined);
  const stop: NonNullable<CoreTaskEntry["stopWorkspaceForAdmin"]> = (workspaceId, administrator, authorize) => h.root.coreTasks!.stopWorkspaceForAdmin!(workspaceId, administrator, authorize);
  for (const administrator of [adminA, revokedB, unreadable, nobody]) {
    const refused = stop(b.workspaceId, { id: administrator }, authorize);
    await expect(refused, administrator).rejects.toMatchObject({ code: "NOT_FOUND", message: `NOT_FOUND: ${ADMIN_GRANT_MISSING}` });
    await expect(refused).rejects.not.toThrow(/secret-cause|throttled/u);
  }
  expect(authorize).not.toHaveBeenCalled();
  expect(await h.activeOperation(B, b.workspaceId)).toBe(running);
  // The task's own company's administrator: the project check is asked with the stored task's project, and the stop runs.
  expect(await stop(b.workspaceId, { id: adminB }, authorize)).toEqual({ taskId: b.taskId, nothingRunning: false });
  expect(authorize).toHaveBeenCalledWith("payments");
});

