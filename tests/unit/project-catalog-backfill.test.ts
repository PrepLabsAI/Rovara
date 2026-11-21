import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { IMPLICIT_COMPANY_ID, canonicalJson, orgProjectCatalogKey, orgSettingsKey, projectRevisionKey } from "@agentx/contracts";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { backfillCorePage } from "../../packages/broker/src/aws/core-project-backfill.js";
import { catalogBackfill } from "../../packages/broker/src/aws/project-catalog-backfill.js";
const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb";
const at = "2026-11-16T12:00:00.000Z";
const I = IMPLICIT_COMPANY_ID;
// Only the implicit company is marked (a named company's own partition is authoritative without a flag), so the mark tests run as the implicit company with unattributed (D1) sources.
function world(company = A) {
  const db = new FakeDynamoDb(), send = vi.spyOn(db, "send");
  const deps = { tableName: "state", signInTableName: "signin", documentClient: { send: (command: unknown) => db.send(command as never) }, now: () => Date.parse(at) };
  const seed = (name: string, companyId?: string, revision = 1) => {
    db.set({ pk: `PROJECT#${name}`, sk: `REV#${String(revision).padStart(12, "0")}`, entityType: "PROJECT", ...(companyId === undefined ? {} : { companyId }), registeredAt: at,
      definition: { name, revision, repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions: "Delegate work." } });
    db.set({ pk: "PROJECT_CATALOG", sk: `PROJECT#${name}`, entityType: "PROJECT_CATALOG", name, latestRevision: revision });
  };
  const run = (action: string, fields = {}) => catalogBackfill(deps, { action, companyId: company, runId: "run-a", ...fields });
  const apply = (companyId = company, projectNames = ["web"], fields = {}) => backfillCorePage(deps, { companyId, projectNames, runId: "run-a", dryRun: false, ...fields });
  return { db, deps, seed, run, apply, send };
}
it("discover attributes missing company to the implicit company, reports conflicts and writes nothing", async () => {
  const w = world(); w.seed("web", A); w.seed("foreign", B); w.seed("old");
  w.db.set({ ...orgProjectCatalogKey(A, "web"), entityType: "PROJECT_CATALOG", companyId: B, name: "web", latestRevision: 1 });
  const result = await w.run("discover");
  expect(result.companies).toEqual(expect.arrayContaining([
    { companyId: A, indexed: [], missing: [], conflicts: ["web"] },
    { companyId: B, indexed: [], missing: ["foreign"], conflicts: [] },
    { companyId: IMPLICIT_COMPANY_ID, indexed: [], missing: ["old"], conflicts: [] },
  ]));
  expect(result.mappings).toContainEqual({ companyId: B, projectNames: ["foreign"] });
  expect(w.send.mock.calls.every(([c]) => ["GetCommand", "QueryCommand"].includes(c.constructor.name))).toBe(true);
});
it("preview and L4 apply are read-only by default, tagged, fenced and idempotent", async () => {
  const w = world(); w.seed("web", A);
  expect(await w.apply(A, ["web"], { dryRun: true })).toMatchObject({ written: 1 });
  expect(w.send.mock.calls.every(([c]) => c.constructor.name !== "TransactWriteCommand")).toBe(true);
  expect(await w.apply()).toMatchObject({ written: 1, failed: 0 });
  expect(w.db.get(orgProjectCatalogKey(A, "web").pk, "PROJECT#web")?.backfillRunId).toBe("run-a");
  expect(w.db.get(projectRevisionKey(A, "web", 1).pk, "REV#000000000001")?.backfillRunId).toBe("run-a");
  expect(await w.apply()).toMatchObject({ written: 0, skippedExisting: 1 });
  expect(w.db.get(orgProjectCatalogKey(B, "web").pk, "PROJECT#web")).toBeUndefined();
});
it("verify/mark writes only after exact comparison, explicit mark and apply", async () => {
  const w = world(I); w.seed("web"); const key = orgSettingsKey(I, "PROJECT_CATALOG_INDEX");
  expect(await w.run("verify", { mark: true, dryRun: false })).toMatchObject({ ok: false, missing: ["web"] });
  expect(w.db.get(key.pk, key.sk)).toBeUndefined();
  await w.apply();
  for (const fields of [{}, { mark: true }, { dryRun: false }]) {
    expect(await w.run("verify", fields)).toMatchObject({ ok: true, written: 0 });
    expect(w.db.get(key.pk, key.sk)).toBeUndefined();
  }
  expect(await w.run("verify", { mark: true, dryRun: false })).toMatchObject({ ok: true, written: 1 });
  expect(w.db.get(key.pk, key.sk)).toMatchObject({ verifiedAt: at, count: 1, runId: "run-a" });
  expect(await w.run("undo-run", { dryRun: false })).toMatchObject({ ok: false });
  expect(await w.run("unmark", { runId: "wrong", dryRun: false })).toMatchObject({ ok: false });
  expect(await w.run("unmark", { dryRun: false })).toMatchObject({ ok: true, written: 1 });
  expect(w.db.get(key.pk, key.sk)).toBeUndefined();
  expect(await w.run("undo-run", { dryRun: false })).toMatchObject({ ok: false });
});
it("undo preview and apply reserve one retirement per project inside the 100-item transaction boundary", async () => {
  for (const count of [33, 34]) {
    const w = world();
    for (let i = 0; i < count; i++) {
      const name = `p${String(i).padStart(3, "0")}`; w.seed(name, A); await w.apply(A, [name]);
    }
    // Each project needs two content deletes and a retained META write, plus the one flag check.
    w.send.mockClear();
    expect(await w.run("undo-run")).toMatchObject({ ok: count === 33, ...(count === 33 ? { deleteCount: count * 2 } : { error: "unavailable" }), written: 0 });
    expect(w.send.mock.calls.every(([c]) => c.constructor.name !== "TransactWriteCommand")).toBe(true);
    expect(await w.run("undo-run", { dryRun: false })).toMatchObject({ ok: count === 33, ...(count === 33 ? { deleteCount: count * 2 } : { error: "unavailable" }) });
  }
});

it("verify refuses extra, foreign and missing core history; undo deletes only the run's rows", async () => {
  const w = world(); w.seed("web", A); w.seed("foreign", B); await w.apply();
  await w.apply(B, ["foreign"], { runId: "run-b" });
  w.seed("web", A, 2);
  expect(await w.run("verify")).toMatchObject({ ok: false, conflicts: ["web"] });
  expect(await w.run("undo-run")).toMatchObject({ ok: true, written: 0 });
  expect(await w.run("undo-run", { dryRun: false })).toMatchObject({ ok: true, written: 2 });
  expect(w.db.get(orgProjectCatalogKey(A, "web").pk, "PROJECT#web")).toBeUndefined();
  expect(w.db.get(projectRevisionKey(A, "web", 1).pk, "REV#000000000001")).toBeUndefined();
  expect(w.db.get(orgProjectCatalogKey(B, "foreign").pk, "PROJECT#foreign")?.backfillRunId).toBe("run-b");
  expect(w.db.get("PROJECT#web", "REV#000000000001")).toBeDefined();
});
it("discover continuation is table-bound, bounded and never silently drops a corrupt row", async () => {
  const w = world(); for (let i = 0; i < 101; i++) w.seed(`p${String(i).padStart(3, "0")}`, A);
  const first = await w.run("discover"); expect(first.continuation).toBeTypeOf("string");
  expect(first.mappings?.[0]?.projectNames).toHaveLength(100);
  expect(await catalogBackfill({ ...w.deps, tableName: "different" }, { action: "discover", continuation: first.continuation })).toMatchObject({ ok: false });
  expect((await w.run("discover", { continuation: first.continuation })).mappings?.[0]?.projectNames).toHaveLength(1);
  w.db.set({ pk: "PROJECT_CATALOG", sk: "PROJECT#BAD NAME" });
  expect(await w.run("discover")).toMatchObject({ ok: false, error: "unavailable" });
});

it("D1 attribution is enforced on L4 catalog runs and older mixed-company history is a discover conflict", async () => {
  const w = world(); w.seed("web");
  expect(await w.apply()).toMatchObject({ written: 0, skippedConflict: 1 });
  expect(await w.apply(IMPLICIT_COMPANY_ID)).toMatchObject({ written: 1, failed: 0 });
  w.seed("web", A, 2);
  expect((await w.run("discover")).companies).toContainEqual({ companyId: A, indexed: [], missing: [], conflicts: ["web"] });
});
it("mark supports its full atomic maximum and refuses the next row without writes", async () => {
  for (const count of [99, 100]) {
    const w = world(I);
    for (let i = 0; i < count; i++) { const name = `p${String(i).padStart(3, "0")}`; w.seed(name); await w.apply(I, [name]); }
    w.send.mockClear();
    expect(await w.run("verify", { mark: true })).toMatchObject({ ok: count === 99, ...(count === 100 ? { error: "unavailable" } : {}) });
    expect(w.send.mock.calls.every(([c]) => c.constructor.name !== "TransactWriteCommand")).toBe(true);
    w.send.mockClear();
    expect(await w.run("verify", { mark: true, dryRun: false })).toMatchObject({ ok: count === 99, written: count === 99 ? 1 : 0 });
    if (count === 100) expect(w.send.mock.calls.every(([c]) => c.constructor.name !== "TransactWriteCommand")).toBe(true);
  }
});
it("catalog snapshot races cannot mark or undo, and logger/SDK causes never leave the operator boundary", async () => {
  const w = world(I); w.seed("web"); await w.apply();
  w.db.injectFault({ command: "TransactWriteCommand", match: () => {
    w.db.set({ ...orgProjectCatalogKey(I, "web"), entityType: "PROJECT_CATALOG", companyId: B, name: "web", latestRevision: 1 }); return false;
  }, error: { name: "unused" } });
  expect(await w.run("verify", { mark: true, dryRun: false })).toEqual({ ok: false, written: 0, error: "unavailable" });
  expect(w.db.get(orgSettingsKey(I, "PROJECT_CATALOG_INDEX").pk, "PROJECT_CATALOG_INDEX")).toBeUndefined();
  const other = world(); other.seed("web", A); await other.apply();
  other.db.injectFault({ command: "TransactWriteCommand", match: () => {
    other.db.set({ ...orgSettingsKey(A, "PROJECT_CATALOG_INDEX"), verifiedAt: at, count: 1, runId: "run-a" }); return false;
  }, error: { name: "unused" } });
  expect(await other.run("undo-run", { dryRun: false })).toEqual({ ok: false, written: 0, error: "unavailable" });
  expect(other.db.get(orgProjectCatalogKey(A, "web").pk, "PROJECT#web")).toBeDefined();
});
it("total time and byte limits refuse with no partial discovery or writes", async () => {
  const w = world(); w.seed("web", A); let clock = 0;
  expect(await catalogBackfill({ ...w.deps, now: () => clock += 6000 }, { action: "discover" })).toEqual({ ok: false, written: 0, error: "unavailable" });
  expect(await catalogBackfill({ ...w.deps, documentClient: { send: async () => ({ Items: [{ data: "x".repeat(2_000_001) }] }) } }, { action: "discover" })).toEqual({ ok: false, written: 0, error: "unavailable" });
  for (const request of [null, {}, { action: "verify", companyId: A }, { action: "unmark", companyId: B, runId: "private/canary" }, { action: "discover", mark: true }]) {
    expect(await catalogBackfill(w.deps, request)).toEqual({ ok: false, written: 0, error: "invalid_input" });
  }
});

it("untagged L4 continuations retain their existing digest; tagged runs bind the run id", async () => {
  const w = world(); w.seed("web", A); w.seed("web", A, 2);
  const mapping = { companyId: A, projectNames: ["web"], bindings: [], people: [], grants: [] };
  const old = await backfillCorePage(w.deps, { ...mapping, limit: 1 });
  const cursor = JSON.parse(Buffer.from(old.continuation!, "base64url").toString("utf8")) as { digest: string };
  expect(cursor.digest).toBe(createHash("sha256").update(canonicalJson({ mapping, dryRun: true, tableName: "state", signInTableName: "signin" })).digest("hex"));
  const tagged = await backfillCorePage(w.deps, { ...mapping, limit: 1, runId: "run-a" });
  expect(await backfillCorePage(w.deps, { ...mapping, runId: "run-b", continuation: tagged.continuation })).toMatchObject({ refused: "invalid_input" });
});

it("discover reports foreign attribution on a core history copy before any apply", async () => {
  const w = world(); w.seed("web", A);
  const source = w.db.get("PROJECT#web", "REV#000000000001")!;
  w.db.set({ ...source, ...projectRevisionKey(A, "web", 1), companyId: B });
  expect((await w.run("discover")).companies).toContainEqual({ companyId: A, indexed: [], missing: [], conflicts: ["web"] });
  expect(w.send.mock.calls.every(([c]) => c.constructor.name !== "TransactWriteCommand")).toBe(true);
});

// Switch-over layout (staging 2026-11-17): no shared catalog or shared revisions; the company's own partition holds every project, without a companyId attribute.
function companyLayout(w: ReturnType<typeof world>, companyId: string, name: string, revisions = 1, extra: Record<string, unknown> = {}) {
  for (let revision = 1; revision <= revisions; revision++) {
    w.db.set({ ...projectRevisionKey(companyId, name, revision), entityType: "PROJECT", registeredAt: at, registeredBy: "person", runtimeBinding: {}, definition: { name, revision } });
  }
  w.db.set({ ...orgProjectCatalogKey(companyId, name), entityType: "PROJECT_CATALOG", firstRegisteredAt: at, name, latestRevision: revisions, ...extra });
}
it("switch-over layout: verify of a named company passes with partition-only rows (reported as extra) and writes nothing; mark of a named company is refused", async () => {
  const w = world(); companyLayout(w, A, "web", 2); companyLayout(w, A, "api"); companyLayout(w, B, "foreign");
  expect(await w.run("verify")).toEqual({ ok: true, written: 0, missing: [], extra: ["api", "web"], conflicts: [] });
  expect(await w.run("verify", { mark: true })).toEqual({ ok: false, written: 0, error: "invalid_input" });
  expect(await w.run("verify", { mark: true, dryRun: false })).toEqual({ ok: false, written: 0, error: "invalid_input" });
  expect(w.send.mock.calls.every(([c]) => ["GetCommand", "QueryCommand"].includes(c.constructor.name))).toBe(true);
  expect(w.db.get(orgSettingsKey(A, "PROJECT_CATALOG_INDEX").pk, "PROJECT_CATALOG_INDEX")).toBeUndefined();
  // Undo of a run that wrote nothing keeps every row the company already had.
  expect(await w.run("undo-run", { dryRun: false })).toEqual({ ok: true, written: 0, deleteCount: 0 });
  expect(w.db.get(orgProjectCatalogKey(A, "web").pk, "PROJECT#web")).toBeDefined();
});
it("switch-over layout: a row naming another company, a missing selected revision, or a wrong definition is a verify conflict and blocks undo", async () => {
  const cases: Array<[string, (w: ReturnType<typeof world>) => void]> = [
    ["catalog companyId", (w) => companyLayout(w, A, "web", 1, { companyId: B })],
    ["catalog orgId", (w) => companyLayout(w, A, "web", 1, { orgId: B })],
    ["revision companyId", (w) => { companyLayout(w, A, "web"); w.db.set({ ...w.db.get(projectRevisionKey(A, "web", 1).pk, "REV#000000000001")!, companyId: B }); }],
    ["missing revision", (w) => { companyLayout(w, A, "web"); w.db.delete(projectRevisionKey(A, "web", 1).pk, "REV#000000000001"); }],
    ["wrong definition", (w) => { companyLayout(w, A, "web"); w.db.set({ ...projectRevisionKey(A, "web", 1), entityType: "PROJECT", definition: { name: "other", revision: 1 } }); }],
  ];
  for (const [label, plant] of cases) {
    const w = world(); companyLayout(w, A, "ok"); plant(w);
    expect(await w.run("verify"), label).toMatchObject({ ok: false, conflicts: ["web"] });
  }
  for (const [label, plant] of cases.slice(0, 3)) {
    const w = world(); plant(w);
    expect(await w.run("undo-run"), label).toEqual({ ok: false, written: 0, error: "conflict" });
  }
});
