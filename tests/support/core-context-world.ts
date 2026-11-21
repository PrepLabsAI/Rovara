import { signingWorld } from "./model-gateway.js";
import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { teamRecordPk, type DocumentStore, type OrgId, type StoredDocument } from "@agentx/contracts";
import { createBrokerCoreRoot, type BrokerCoreRoot } from "../../packages/broker/src/aws/core-engine-root.js";
import { CallbackCapabilities } from "../../packages/broker/src/callbacks.js";
import { createTeamRecord } from "../../packages/broker/src/team-record/record.js";
import { engineStampKey } from "../../packages/broker/src/core-host/engine-stamp.js";
import { taskKey, taskPointerKey, workspaceKey, operationKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { createFakeWorld, FAKE_COMPANY, type FakeWorld } from "../support/core-host-fakes.js";
import type * as TeamRecordModule from "../../packages/broker/src/core-host/team-record.js";

// Substitute only the deployment adapters; the root, registry, runtime, authority and record search are real.
const adapters = vi.hoisted(() => ({ modules: [] as unknown[], searchReply: undefined as unknown[] | undefined, searchFails: false }));
vi.mock("../../packages/broker/src/core-host/code-modules.js", () => ({ codeAdapterModules: () => adapters.modules }));
vi.mock("../../packages/broker/src/core-host/hosted-modules.js", async (original) => ({ ...await original<object>(), hostedSecurityModules: () => [] }));
vi.mock("../../packages/broker/src/core-host/team-record.js", async (original) => {
  const module = await original<typeof TeamRecordModule>();
  return { ...module, attachCoreTeamRecord: (...args: Parameters<typeof module.attachCoreTeamRecord>) => {
    const real = module.attachCoreTeamRecord(...args);
    return { ...real, search: { search: async (...input: Parameters<typeof real.search.search>) => {
      if (adapters.searchFails) throw new Error("private-canary");
      return adapters.searchReply ?? real.search.search(...input);
    } } };
  } };
});
export const A = FAKE_COMPANY as OrgId;
export const B = "org_corehost00000000000b" as OrgId;
const secret = Buffer.alloc(32, 7);
export const caps = new CallbackCapabilities(secret);
const path = "/v1/internal/context-tools";


interface CoreContextRun {
  companyId: OrgId;
  workspaceId: string;
  operationId: string;
  taskId: string;
  headers: { "x-agentx-callback-capability": string };
  request(arguments_?: unknown): { method: string; path: string; headers: { "x-agentx-callback-capability": string }; body: string };
  record: ReturnType<typeof createTeamRecord>;
  put(item: Record<string, unknown>): ReturnType<DocumentStore["put"]>;
}
interface CoreContextWorld {
  world: Omit<FakeWorld, "clock"> & { clock: { now: number } };
  root: BrokerCoreRoot;
  reads: string[];
  members: Map<string, OrgId>;
  revokeProject(): void;
  a: CoreContextRun;
  b: CoreContextRun;
}

export async function coreContextWorld(options: { teamOff?: boolean; teamCompany?: OrgId; models?: boolean; backend?: { store: DocumentStore; clock: { now: number }; signingKey: Buffer; companyId: OrgId; developerId: string } } = {}): Promise<CoreContextWorld> {
  const fake = createFakeWorld();
  const world = { ...fake, store: options.backend?.store ?? fake.store, clock: options.backend?.clock ?? fake.clock };
  const modules = world.modules.map(module => module.point === "storage" ? { ...module, create: () => world.store } : module);
  adapters.modules = options.models ? modules.filter(module => module.point !== "model-keys") : modules;
  if (options.models && options.backend === undefined) world.clock.now = Date.now();
  const signingKey = options.backend?.signingKey ?? secret;
  const capabilities = new CallbackCapabilities(signingKey);
  const reads: string[] = [];
  const members = new Map([ ["owner-a", A], ["owner-b", B] ]);
  if (options.backend !== undefined) members.set(options.backend.developerId, options.backend.companyId);
  let projectAllowed = true;
  const client = { async send(command: unknown) {
    if (!(command instanceof GetCommand)) throw new Error("unexpected write");
    const { TableName, Key } = command.input;
    reads.push(`${TableName}:${String(Key?.pk)}`);
    if (TableName === "signin") {
      const personId = String(Key?.pk).replace("COMPANY_MEMBER#", "");
      const companyId = members.get(personId);
      return { Item: companyId === undefined ? undefined : { ...Key, entityType: "COMPANY_MEMBERSHIP", personId, companyId, role: "member", joinedAt: "2026-11-01T00:00:00.000Z" } };
    }
    // DEC 254zzz80: a person's grant sits in their own company's partition (`ORG#<company>#MEMBER#<person>`), as a named company keeps its grants.
    const legacyGrant = /^MEMBER#(.+)$/u.exec(String(Key?.pk));
    if (legacyGrant !== null) return { Item: projectAllowed && options.backend !== undefined && members.get(legacyGrant[1]!) === options.backend.companyId ? { ...Key, projectName: "payments", role: "developer" } : undefined };
    const grant = /^ORG#(org_[0-9a-z]{20})#MEMBER#(.+)$/u.exec(String(Key?.pk));
    if (grant !== null) return { Item: projectAllowed && members.get(grant[2]!) === grant[1] ? { ...Key, projectName: "payments", role: "developer" } : undefined };
    return { Item: await world.store.get(Key as { pk: string; sk: string }) };
  } };
  const signer = options.models ? signingWorld().signer : undefined;
  const root = createBrokerCoreRoot({
    env: { ...(options.models ? { ROVARA_CORE_MODEL_GATEWAY_URL: "https://gateway.example", ROVARA_CORE_AGENT_MODEL: "claude-sonnet-4-6", ROVARA_DESIGN_REVIEW: "1" } : {}), ...(!options.teamOff ? { ROVARA_CORE_LESSONS: options.teamCompany === undefined ? "on" : `on:${options.teamCompany}` } : {}) },
    ...(options.models ? {
      taskTokens: () => ({ signer: signer!, issuer: "https://api.example/v1/auth" }),
      offeredModels: { offered: async (companyId: string) => ({ version: 1, models: [{ model: "claude-sonnet-4-6" }], reviewerAccess: { companyId, companyLimitUsd: 5, models: [{ model: "claude-sonnet-4-6", provider: "anthropic" }] } }) },
    } : {}),
    documentClient: client, stateTableName: "state", signInTableName: "signin", callbackSigningKey: signingKey.toString(), repositoryGrantKey: secret,
    codeModules: () => ({}) as never, repositoryCredential: async () => { throw new Error("unused"); }, origin: () => "https://api.example", log: () => undefined,
    now: () => new Date(world.clock.now), ciReporting: { honest: true, ciMode: async () => "sandbox_only" as const },
    services: () => Object.fromEntries(["merge-tracking", "session-sweep", "notify-deliver", "admission-hold-sweep"].map((name) => [name, { pass: async () => ({}) }])),
    lessonsPeople: () => ({ approvers: async () => ({ complete: true, membershipVersion: 1, ownerIds: [], eligibleIds: [], lastEligibleLossAtMs: null }), onProjectRoster: async () => true, linkedAccounts: async () => [], displayName: async () => "Member", isErased: async () => false }),
  });
  const runs = [];
  const sameSource = "same-record-source";
  for (const [companyId, developerId, marker] of [[A, "owner-a", "only-alpha"], [B, "owner-b", "only-bravo"]] as const) {
    const workspaceId = randomUUID(), operationId = randomUUID(), taskId = randomUUID();
    const put = async (item: Record<string, unknown>) => world.store.put({ item: JSON.parse(JSON.stringify(item)) as StoredDocument });
    await put({ pk: `WORKSPACE#${workspaceId}`, sk: "META", entityType: "WORKSPACE_COMPANY_POINTER", workspaceId, companyId });
    await put({ ...workspaceKey(companyId, workspaceId), entityType: "WORKSPACE", id: workspaceId, companyId, orgId: companyId, projectName: "payments", activeOperationId: operationId, fence: 1, status: "READY" });
    await put({ ...taskPointerKey(companyId, workspaceId), taskId });
    await put({ ...taskKey(taskId), taskId, companyId, developerId, project: "payments", workspaceId });
    await put({ ...operationKey(companyId, workspaceId, operationId), id: operationId, workspaceId, companyId, fence: 1, status: "RUNNING", workflowMode: "PLAN" });
    await put({ ...engineStampKey(taskId), coreEngine: { engine: "core", areas: { flow: "core", build: "core", merge: "core" }, flags: "on", stampedAt: new Date(world.clock.now).toISOString() } });
    const record = createTeamRecord({ store: world.store, companyId, now: () => world.clock.now });
    await record.put({ project: "payments", taskId, authorId: developerId, kind: "decision", text: `shared query ${marker}`, sourceRef: sameSource, occurredAt: new Date(world.clock.now).toISOString() });
    // Identical raw record ids across companies, even though the writer normally hashes the company into them.
    const row = (await world.store.query({ pk: teamRecordPk(companyId, "payments"), sk: { op: "beginsWith", prefix: "TREC#" } })).items[0]!;
    await put({ ...row, id: "same-raw-record-id" });
    const token = capabilities.issue({ workspaceId, operationId, fence: 1, actions: ["context-tools", "design-review-packet", "model-access"], expiresInSeconds: 60 });
    const headers = { "x-agentx-callback-capability": token };
    const request = (arguments_: unknown = { query: "shared query" }) => ({ method: "POST", path: `${path}/call`, headers, body: JSON.stringify({ requestId: randomUUID(), tool: "search_team_knowledge", arguments: arguments_ }) });
    runs.push({ companyId, workspaceId, operationId, taskId, headers, request, record, put });
  }
  return { world, root, reads, members, revokeProject: () => { projectAllowed = false; }, a: runs[0]!, b: runs[1]! };
}

