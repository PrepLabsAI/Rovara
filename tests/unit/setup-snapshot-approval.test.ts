// L4-DR (DEC 254z c): the setup snapshot is saved by the approval of a setup, in the approval's own transaction, on the laptop's path and on the hosted one (both are `createSetupProposalSubject`). It holds paths and
// content ids only; a host that cannot be read never fails or delays an approval; a rejection saves nothing; another company's snapshot is never read.
import { describe, expect, it } from "vitest";
import {
  IMPLICIT_COMPANY_ID, WORKER_INVOCATION_FEATURES, SetupSnapshotSchema, orgProjectCatalogKey, projectMetaKey, projectRevisionKey, type JsonValue, type OrgId, type Principal, type ProjectDefinition, type TransactItem,
} from "@agentx/contracts";
import { SETUP_APPLY_KIND, createSetupProposalSubject, setupApplyDigest, setupApplyKey, type SetupApplyRow } from "../../packages/broker/src/core/setup-agent/apply.js";
import { buildSetupCheck, relayCheck } from "../../packages/broker/src/core/setup-agent/check.js";
import { readSetupSnapshot, setupSnapshotKey } from "../../packages/broker/src/core/setup-agent/snapshot.js";
import { readWorkspace } from "../../packages/broker/src/core/task-flow/stage-machine.js";
import { createAdapterRegistry } from "../../packages/broker/src/ports/adapter-registry.js";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
import { FakeHostModel } from "../../packages/broker/src/plugins/fake/model.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createHarness, definition, newRequestId, type Harness } from "../support/task-flow-harness.js";

const URL_ = "https://examplehost.test/acme/app";
const FILES = { "README.md": "x", "package.json": "{}", "package-lock.json": "lock", "services/api/Dockerfile": "FROM node", ".env.example": "KEY=", "src/index.ts": "export {}" };
const SEEDED_SECRET = ["sk", "live", "0123456789abcdefghijklmnop"].join("_");
const TOKEN_URL_LOCK = `{"resolved":"https://user:${SEEDED_SECRET}@registry.example/pkg.tgz"}`;
const base: ProjectDefinition = {
  ...definition, repositories: [{ ...definition.repositories[0]!, url: URL_, host: { kind: "fake" } }],
  setup: [{ cwd: "repo/demo", executable: "npm", args: ["ci"], timeoutSeconds: 60 }], readiness: [{ cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 60 }],
};
const candidateOf = (extra: Partial<ProjectDefinition> = {}): ProjectDefinition => ({ ...base, revision: 2, ...extra });

async function waiting(options: { files?: Record<string, string>; candidate?: ProjectDefinition; withHost?: boolean; baseCommits?: "none" } = {}) {
  const h = createHarness({ machines: { startingChecks: 0, features: [...WORKER_INVOCATION_FEATURES] } });
  await h.registerProject(base);
  await h.store.put({ item: { ...projectMetaKey(h.deps.companyId, "payments"), entityType: "PROJECT_META" } });
  const candidate = options.candidate ?? candidateOf();
  await h.store.put({ item: { ...projectRevisionKey(h.deps.companyId, "payments", 2), entityType: "PROJECT", candidate: true, definition: JSON.parse(JSON.stringify(candidate)) as JsonValue } });
  const model = new FakeHostModel({ url: URL_, id: "1", fullName: "acme/app", initialFiles: options.files ?? FILES });
  const host = new FakeCodeHost(model);
  const registry = createAdapterRegistry();
  registry.register("code-host", "fake", host);
  if (options.withHost !== false) h.deps.codeHosts = registry;
  // The candidate's own check, run to a pass: the proposal waits for a decision only then.
  const check = buildSetupCheck(h.deps, { project: "payments", revision: 2, startedBy: "local-owner", requestId: newRequestId(), candidate: true });
  expect((await h.store.transact(check.items)).applied).toBe(true);
  await relayCheck(h.deps, check);
  await finish(h, check.workspaceId);
  const digest = setupApplyDigest(candidate.setup, candidate.readiness);
  const baseCommits = options.baseCommits === "none" ? undefined : { demo: model.headOf("main") };
  const row: SetupApplyRow = { entityType: "SETUP_APPLY", orgId: h.deps.companyId, project: "payments", taskId: "", requestId: newRequestId(), by: "local-owner", digest, baseRevision: 1, candidateRevision: 2, state: "checking", check: check.mark, reply: {}, createdAt: "2026-11-09T10:00:00.000Z", ...(baseCommits === undefined ? {} : { baseCommits }) };
  await h.store.put({ item: { ...setupApplyKey(h.deps.companyId, "payments"), ...(JSON.parse(JSON.stringify(row)) as Record<string, JsonValue>) } });
  return { h, model, host, digest };
}

async function finish(h: Harness, workspaceId: string): Promise<void> {
  for (let round = 0; round < 8; round += 1) {
    await h.flow.dispatchOnce({ maxMessages: 10 });
    const workspace = await readWorkspace(h.deps, workspaceId);
    const job = workspace?.machine === undefined ? undefined : h.machines.delivered(workspace.machine.machineId).find((entry) => entry.kind === "prepare" && entry.workspaceId === workspaceId);
    if (job !== undefined) { await h.flow.recordResult({ workspaceId, operationId: job.operationId, fence: job.fence ?? workspace!.fence, status: "SUCCEEDED" }); return; }
    h.clock.advance(70);
  }
  throw new Error("never delivered");
}

const owner = (companyId: OrgId = IMPLICIT_COMPANY_ID): Principal => localOwnerPrincipal({ companyId });
const attempt = (digest: string, outcome: "approve" | "reject") => ({ companyId: IMPLICIT_COMPANY_ID, kind: SETUP_APPLY_KIND, subjectId: "payments", requestId: newRequestId(), outcome, seen: { revision: 2, artifactDigest: digest }, credentials: [] });

async function approve(w: Awaited<ReturnType<typeof waiting>>, approval?: Parameters<typeof createSetupProposalSubject>[0]["approval"]) {
  const subject = createSetupProposalSubject({ flow: w.h.deps, ...(approval === undefined ? {} : { approval }) });
  const loaded = await subject.load(w.h.deps.companyId, "payments");
  expect(loaded?.waiting).toBe(true);
  return subject.apply(loaded!, attempt(w.digest, "approve"), [owner()], "2026-11-09T10:05:00.000Z");
}
const snapshotPut = (extra: readonly TransactItem[] | undefined, w: { h: Harness }): TransactItem | undefined =>
  extra?.find((item) => item.kind === "put" && item.item.pk === setupSnapshotKey(w.h.deps.companyId, "payments").pk && item.item.sk === "SNAPSHOT");

describe("the approval saves the setup snapshot", () => {
  it("saves, in the approval's own transaction, the watched files by path and content id at the head, and the websites the candidate allows", async () => {
    const w = await waiting({ candidate: candidateOf({ network: { allowedDomains: ["api.stripe.com", "registry.npmjs.org"] } }) });
    const applied = await approve(w);
    const put = snapshotPut(applied.extra, w);
    expect(put).toBeDefined();
    const saved = SetupSnapshotSchema.parse((put as unknown as { item: { snapshot: unknown } }).item.snapshot);
    expect(saved.setupRevision).toBe(2);
    expect(saved.takenAt).toBe("2026-11-09T10:05:00.000Z");
    expect(saved.hosts).toEqual(["api.stripe.com", "registry.npmjs.org"]);
    expect(saved.repositories).toHaveLength(1);
    expect(saved.repositories[0]).toMatchObject({ name: "demo", commit: w.model.headOf("main") });
    expect(saved.repositories[0]!.files.map((file) => file.path)).toEqual([".env.example", "package-lock.json", "package.json", "services/api/Dockerfile"]);
    // The approval itself is what it always was: the project moves to the candidate, and nothing else about it changed.
    expect(applied.ops.map((op) => (op as { path?: unknown }).path).flat()).toContain("state");
    expect(applied.extra?.some((item) => item.kind === "update" && item.key.pk === orgProjectCatalogKey(w.h.deps.companyId, "payments").pk)).toBe(true);
  });

  it("is written by the same transaction as the decision: stored only when the approval commits", async () => {
    const w = await waiting();
    const applied = await approve(w);
    expect(await readSetupSnapshot(w.h.store, w.h.deps.companyId, "payments")).toBeUndefined();
    expect((await w.h.store.transact([...(applied.extra ?? [])])).applied).toBe(true);
    expect(SetupSnapshotSchema.safeParse(await readSetupSnapshot(w.h.store, w.h.deps.companyId, "payments")).success).toBe(true);
  });

  it("holds no file content and no secret: a seeded secret inside a watched file never reaches the row", async () => {
    const w = await waiting({ files: { ...FILES, "package-lock.json": TOKEN_URL_LOCK, ".env.example": `STRIPE=${SEEDED_SECRET}` } });
    const applied = await approve(w);
    const text = JSON.stringify(snapshotPut(applied.extra, w));
    expect(text).not.toContain(SEEDED_SECRET);
    expect(text).not.toContain("registry.example");
    expect(text).not.toContain("STRIPE");
  });

  it("the hosted rule saves it the same way (the snapshot does not depend on who approves)", async () => {
    const w = await waiting();
    const applied = await approve(w, { riskFromDiff: true, mayDecide: async () => true, refusal: () => "no" });
    expect(snapshotPut(applied.extra, w)).toBeDefined();
  });

  it("an install with no code host, or a host that cannot list setup files, or a host that fails, still approves, and saves none", async () => {
    const noHost = await waiting({ withHost: false });
    expect(snapshotPut((await approve(noHost)).extra, noHost)).toBeUndefined();
    const cannotList = await waiting();
    delete (cannotList.host as { setupFileVersions?: unknown }).setupFileVersions;
    Object.defineProperty(cannotList.host, "setupFileVersions", { value: undefined });
    const approved = await approve(cannotList);
    expect(snapshotPut(approved.extra, cannotList)).toBeUndefined();
    expect(approved.ops.length).toBeGreaterThan(0);
    const failing = await waiting();
    failing.host.setupFileVersions = async () => { throw new Error("host is down"); };
    const failed = await approve(failing);
    expect(snapshotPut(failed.extra, failing)).toBeUndefined();
    expect(failed.extra?.some((item) => item.kind === "update")).toBe(true);
  });

  it("is of the code the check prepared, not of whatever landed before the approval", async () => {
    const w = await waiting();
    const prepared = w.model.headOf("main");
    w.model.commit("main", { "package-lock.json": "changed after the check", "docker-compose.yml": "services: {}" });
    const saved = SetupSnapshotSchema.parse((snapshotPut((await approve(w)).extra, w) as unknown as { item: { snapshot: unknown } }).item.snapshot);
    expect(saved.repositories[0]!.commit).toBe(prepared);
    expect(saved.repositories[0]!.files.map((file) => file.path)).not.toContain("docker-compose.yml");
  });

  it("saves none when the check's commits were not noted (the first re-check saves the baseline instead)", async () => {
    const w = await waiting({ baseCommits: "none" });
    const applied = await approve(w);
    expect(snapshotPut(applied.extra, w)).toBeUndefined();
    expect(applied.extra?.some((item) => item.kind === "update")).toBe(true);
  });

  it("a store fault while reading the candidate saves no snapshot and does not fail the approval", async () => {
    const w = await waiting();
    const subject = createSetupProposalSubject({ flow: w.h.deps });
    const loaded = await subject.load(w.h.deps.companyId, "payments");
    const real = w.h.deps.store;
    w.h.deps.store = { ...real, get: async (key: { pk: string; sk: string }) => { if (key.sk.startsWith("REVISION") || key.sk.includes("REV")) throw new Error("store fault"); return real.get(key); } };
    const applied = await subject.apply(loaded!, attempt(w.digest, "approve"), [owner()], "2026-11-09T10:05:00.000Z");
    w.h.deps.store = real;
    expect(snapshotPut(applied.extra, w)).toBeUndefined();
    expect(applied.extra?.some((item) => item.kind === "update")).toBe(true);
  });

  it("a listing the host cut short saves none: a partial baseline would report changes that did not happen", async () => {
    const w = await waiting();
    w.model.incompleteTrees.add(w.model.headOf("main"));
    expect(snapshotPut((await approve(w)).extra, w)).toBeUndefined();
  });

  it("a project of two repositories saves both, and saves neither when one listing was cut (a partial baseline is never kept)", async () => {
    const URL2 = "https://examplehost.test/acme/web";
    const two = candidateOf({ repositories: [base.repositories[0]!, { name: "web", url: URL2, path: "repo/web", defaultBranch: "main", credentialRef: "host-app", host: { kind: "fake2" } }] });
    const attach = (w: Awaited<ReturnType<typeof waiting>>) => {
      const model2 = new FakeHostModel({ url: URL2, id: "2", fullName: "acme/web", initialFiles: { "package.json": "{}", "yarn.lock": "lock" } });
      const registry = createAdapterRegistry();
      registry.register("code-host", "fake", w.host);
      registry.register("code-host", "fake2", Object.defineProperties(new FakeCodeHost(model2), { kind: { value: "fake2" } }));
      w.h.deps.codeHosts = registry;
      return model2;
    };
    const whole = await waiting({ candidate: two });
    const model2Whole = attach(whole);
    await whole.h.store.update({ key: setupApplyKey(whole.h.deps.companyId, "payments"), ops: [{ op: "set", path: ["baseCommits"], value: { demo: whole.model.headOf("main"), web: model2Whole.headOf("main") } as JsonValue }] });
    const saved = SetupSnapshotSchema.parse((snapshotPut((await approve(whole)).extra, whole) as unknown as { item: { snapshot: unknown } }).item.snapshot);
    expect(saved.repositories.map((repository) => repository.name).sort()).toEqual(["demo", "web"]);
    expect(saved.repositories.find((repository) => repository.name === "web")!.files.map((file) => file.path)).toEqual(["package.json", "yarn.lock"]);
    const cut = await waiting({ candidate: two });
    const model2 = attach(cut);
    await cut.h.store.update({ key: setupApplyKey(cut.h.deps.companyId, "payments"), ops: [{ op: "set", path: ["baseCommits"], value: { demo: cut.model.headOf("main"), web: model2.headOf("main") } as JsonValue }] });
    model2.incompleteTrees.add(model2.headOf("main"));
    expect(snapshotPut((await approve(cut)).extra, cut)).toBeUndefined();
  });

  it("a rejection saves nothing", async () => {
    const w = await waiting();
    const subject = createSetupProposalSubject({ flow: w.h.deps });
    const loaded = await subject.load(w.h.deps.companyId, "payments");
    const rejected = await subject.apply(loaded!, attempt(w.digest, "reject"), [owner()], "2026-11-09T10:05:00.000Z");
    expect(snapshotPut(rejected.extra, w)).toBeUndefined();
  });

  it("another company's snapshot is never read: a row copied under another company's key reads as none", async () => {
    const w = await waiting();
    const applied = await approve(w);
    await w.h.store.transact([...(applied.extra ?? [])]);
    const other: OrgId = "org_cccccccccccccccccccc";
    const mine = await w.h.store.get(setupSnapshotKey(w.h.deps.companyId, "payments"));
    await w.h.store.put({ item: { ...mine!, ...setupSnapshotKey(other, "payments") } });
    expect(await readSetupSnapshot(w.h.store, other, "payments")).toBeUndefined();
    expect(await readSetupSnapshot(w.h.store, w.h.deps.companyId, "billing")).toBeUndefined();
  });
});
