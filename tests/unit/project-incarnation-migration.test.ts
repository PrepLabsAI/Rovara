import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { canonicalJson, orgProjectCatalogKey, projectMetaKey, projectRevisionKey } from "@agentx/contracts";
import { backfillCorePage } from "../../packages/broker/src/aws/core-project-backfill.js";
import { parseCoreBackfillArguments } from "../../packages/broker/src/aws/core-backfill-runner.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
const companyId = "org_aaaaaaaaaaaaaaaaaaaa", project = "web";
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
function world() {
  const db = new FakeDynamoDb(), key = projectMetaKey(companyId, project);
  const definition = { name: project, revision: 1, repositories: [{ name: "demo", url: "https://github.com/example/native.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions: "Delegate work." };
  const revision = { ...projectRevisionKey(companyId, project, 1), entityType: "PROJECT", definition };
  const catalog = { ...orgProjectCatalogKey(companyId, project), entityType: "PROJECT_CATALOG", latestRevision: 1 };
  const meta = { ...key, entityType: "PROJECT_META", status: "archived", lifecycleRevision: 7, setupCheck: { status: "passed" } };
  for (const row of [revision, catalog, meta]) db.set(row);
  const input = { mode: "migrate-incarnations", companyId, projectNames: [project], runId: "pre-rollout", inventory: [{ project, revision: 1, revisionDigest: digest(revision), catalogDigest: digest(catalog), metaDigest: digest(meta) }] };
  return { db, key, input, meta, deps: { documentClient: db, tableName: "state", signInTableName: "signin" } };
}
it("migrates only inventoried canonical rows, dry-run first, preserving lifecycle and setup; replay writes nothing", async () => {
  const h = world(), before = [...h.db.items];
  // A foreign legacy namesake must never select or block canonical migration.
  h.db.set({ pk: "PROJECT#web", sk: "REV#000000000001", entityType: "PROJECT", companyId: "org_bbbbbbbbbbbbbbbbbbbb" });
  expect(await backfillCorePage(h.deps, h.input)).toMatchObject({ written: 1, failed: 0, skippedConflict: 0 });
  for (const [k, v] of before) expect(h.db.items.get(k)).toEqual(v);
  expect(await backfillCorePage(h.deps, { ...h.input, dryRun: false })).toMatchObject({ written: 1, failed: 0, skippedConflict: 0 });
  expect(h.db.get(h.key.pk, h.key.sk)).toMatchObject({ ...h.meta, companyId, project, incarnationRevision: 1 });
  const applied = [...h.db.items];
  expect(await backfillCorePage(h.deps, { ...h.input, dryRun: false })).toMatchObject({ written: 0, skippedExisting: 1 });
  expect([...h.db.items]).toEqual(applied);
});
it("missing inventory and legacy-import fallback are refused before I/O", async () => {
  const h = world();
  for (const changes of [{ inventory: undefined }, { runId: undefined }, { inventory: [] }, { mode: undefined }, { bindings: [{ installationId: 42, accountLogin: "example" }] }]) {
    expect(await backfillCorePage({ ...h.deps, documentClient: { send: () => { throw new Error("unexpected I/O"); } } }, { ...h.input, ...changes })).toMatchObject({ refused: "invalid_input", written: 0 });
  }
});
it.each(["changed-inventory", "missing-meta", "missing-after-init", "corrupt", "deleted", "foreign"])("refuses %s without repair or content changes", async kind => {
  const h = world();
  if (kind === "missing-after-init") {
    await backfillCorePage(h.deps, { ...h.input, dryRun: false });
    await h.db.send(new (await import("@aws-sdk/lib-dynamodb")).DeleteCommand({ TableName: "state", Key: h.key }));
  } else if (kind === "missing-meta") {
    await h.db.send(new (await import("@aws-sdk/lib-dynamodb")).DeleteCommand({ TableName: "state", Key: h.key }));
  } else if (kind === "changed-inventory") h.db.set({ ...h.meta, lifecycleRevision: 8 });
  else h.db.set({ ...h.meta, companyId: kind === "foreign" ? "org_bbbbbbbbbbbbbbbb" : companyId, project, incarnationRevision: kind === "corrupt" ? 0 : 3, status: kind === "deleted" ? "deleted" : "active" });
  const before = [...h.db.items];
  expect(await backfillCorePage(h.deps, { ...h.input, dryRun: false })).toMatchObject({ written: 0, skippedConflict: 1 });
  expect([...h.db.items]).toEqual(before);
});
it("migration transaction fences catalogue, revision, and absent incarnation fields on META", async () => {
  for (const target of ["meta", "catalog", "revision"]) {
    const h = world();
    const deps = { ...h.deps, documentClient: { async send(command: unknown) {
      if ((command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand") {
        const key = target === "meta" ? h.key : target === "catalog" ? orgProjectCatalogKey(companyId, project) : projectRevisionKey(companyId, project, 1);
        h.db.set({ ...h.db.get(key.pk, key.sk)!, ...(target === "meta" ? { incarnationRevision: 9 } : target === "catalog" ? { latestRevision: 2 } : { companyId: "org_bbbbbbbbbbbbbbbbbbbb" }) });
      }
      return h.db.send(command as never);
    } } };
    expect(await backfillCorePage(deps, { ...h.input, dryRun: false })).toMatchObject({ written: 0, failed: 1 });
    expect(h.db.get(h.key.pk, h.key.sk)?.incarnationRevision).not.toBe(1);
  }
});
it("CLI migration is explicit and exclusive; no HTTP or customer entrypoint imports its runner", () => {
  const base = ["--state-table", "State", "--signin-table", "SignIn", "--input", "mapping.json"];
  expect(parseCoreBackfillArguments([...base, "--migrate-incarnations"])).toMatchObject({ mode: "migrate-incarnations", dryRun: true });
  for (const flags of [["--people-check"], ["--discover"], ["--verify"], ["--migrate-incarnations"]]) expect(() => parseCoreBackfillArguments([...base, "--migrate-incarnations", ...flags])).toThrow();
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);
  for (const file of walk("packages/broker/src").filter(file => file.endsWith(".ts") && !file.endsWith("core-backfill-runner.ts"))) {
    expect(readFileSync(file, "utf8"), file).not.toMatch(/(?:from|import\()\s*["'][^"']*core-backfill-runner/);
    if (!file.endsWith("core-project-backfill.ts") && !file.endsWith("project-catalog-backfill.ts")) expect(readFileSync(file, "utf8"), file).not.toMatch(/\bbackfillCorePage\s*\(/);
  }
});
