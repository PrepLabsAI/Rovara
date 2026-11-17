import ts from "typescript";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { COMPANY_CHECKED_ROUTES } from "../support/company-route-harness.js";
import { scanCompanySources, loadCompanySources, validateCompanyInventory, forwardingCoverage } from "../support/company-inventory-scan.js";
import { judgeProofHold, markReadyAnyway, proofHoldKey, proofOverrideKey, readProofHold, readProofHoldHistory } from "../../packages/broker/src/core/merge/proof-hold.js";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";
import { mergeWorld } from "../support/merge-world.js";
import { summaryCheckKey, summaryCheckRecordOf } from "../../packages/broker/src/core/merge/summary-check.js";

let cachedSources: ReturnType<typeof loadCompanySources> | undefined;
const companySources = () => cachedSources ??= loadCompanySources(resolve("."));

const source = (text: string, path = "packages/broker/src/aws/broker.ts") => ({ path, text });
const markdown = (count = "1 record kinds: 0 company-scoped, 0 install-wide, 1 needs-company. 1 routes: 0 company-scoped, 0 install-wide, 1 needs-company.") => `${count}\n\n| kind | identity | class | table | checked | methods | reason |\n|---|---|---|---|---|---|---|\n| record | entity:TASK | needs-company | State table | no | - | T1 |\n| route | /v1/dev/tasks | needs-company | State table | no | GET | T2 |\n`;
const basic = () => scanCompanySources([source('const item = { entityType: "TASK" }; const route = "/v1/dev/tasks";')]);

describe("company inventory", () => {
  it("classifies every source identity and recomputes the count", () => {
    const markdown = readFileSync("docs/architecture/company-inventory.md", "utf8");
    const inventory = scanCompanySources(companySources(), {}, forwardingCoverage(markdown));
    validateCompanyInventory(inventory, markdown, COMPANY_CHECKED_ROUTES);
  });
  it("accepts the unchanged classified control", () => expect(() => validateCompanyInventory(basic(), markdown(), [])).not.toThrow());
  it("finds a new entity in a new file (scanner mutant)", () => {
    const scanned = scanCompanySources([source('const a = { entityType: "TASK" }; const path = "/v1/dev/tasks";'), source('const b = { entityType: "NEW_KIND" };', "packages/broker/src/new-kind.ts")]);
    expect(() => validateCompanyInventory(scanned, markdown(), [])).toThrow("Company inventory missing: entity:NEW_KIND");
  });
  it("rejects a count mutation", () => expect(() => validateCompanyInventory(basic(), markdown().replace("1 record kinds", "2 record kinds"), [])).toThrow("Company inventory count differs."));
  it("rejects an unknown class", () => expect(() => validateCompanyInventory(basic(), markdown().replace("| needs-company |", "| invented |"), [])).toThrow("Company inventory invalid row."));
  it("rejects a stale row", () => expect(() => validateCompanyInventory(basic(), markdown().replace("entity:TASK", "entity:OLD"), [])).toThrow("Company inventory stale: entity:OLD"));
  it("rejects an unchecked route advertised as checked", () => expect(() => validateCompanyInventory(basic(), markdown().replace("| no | GET", "| yes | GET"), [])).toThrow("Company inventory unchecked: /v1/dev/tasks"));
  it.each(['const item = { entityType: ;', 'const item = { entityType: externalValue };', 'const item = { pk: externalValue, sk: "META" };'])('refuses an unclassifiable whole input, without echoing source (%s)', (text) => {
    expect(() => scanCompanySources([source('const safe = { entityType: "TASK" };'), source(text + '\n// confidential-canary', 'packages/broker/src/bad.ts')])).toThrow(/^Company inventory unclassifiable\.$/);
  });
  it("reads multiline constants, aliases and key templates with the compiler", () => {
    const scanned = scanCompanySources([source('const TYPE = "TASK"; const alias = TYPE; const row = {\nentityType: alias,\npk: `DEVTASK#${id}`, sk: "META"\n};')]);
    expect(scanned.records).toEqual(["entity:TASK", "pk:DEVTASK"]);
  });
  it("refuses total byte, file, item and work limits", () => {
    for (const limits of [{ files: 1 }, { bytes: 20 }, { items: 1 }, { nodes: 1 }]) {
      expect(() => scanCompanySources([source('const a = { entityType: "ONE" };'), source('const b = { entityType: "TWO" };', "packages/broker/src/two.ts")], limits)).toThrow(/^Company inventory limit exceeded\.$/);
    }
  });
  it("handles a large generated input under the existing test timeout", () => {
    const text = Array.from({ length: 10_000 }, (_, i) => `const item${i} = { entityType: "KIND_${i}" };`).join("\n");
    expect(scanCompanySources([source(text)]).records).toHaveLength(10_000);

  });
});

it("resolves imported literals and lexical shadowing without guessing", () => {
  const scanned = scanCompanySources([
    source('export const KIND = "IMPORTED";', "packages/broker/src/kinds.ts"),
    source('import { KIND as TYPE } from "../kinds.js"; const row = { entityType: TYPE }; function f() { const TYPE = "INNER"; return { entityType: TYPE }; }'),
  ]);
  expect(scanned.records).toEqual(["entity:IMPORTED", "entity:INNER"]);
});


it("ratchets reviewed forwarding sites separately from constructors", () => {
  const input = [source('function forward(key) { return { pk: key.pk, sk: key.sk }; }')];
  const coverage = [{ site: "packages/broker/src/aws/broker.ts:1:34:pk", expression: "key.pk", reason: "Generic key transport", constructors: "pk:TASK" }, { site: "packages/broker/src/aws/broker.ts:1:46:sk", expression: "key.sk", reason: "Generic key transport", constructors: "pk:TASK" }];
  const scanned = scanCompanySources(input, {}, coverage);
  expect(scanned.records).toEqual([]);
  expect(scanned.forwarding).toHaveLength(2);
  expect(() => scanCompanySources(input, {}, coverage.slice(1))).toThrow("Company inventory unclassifiable.");
  expect(() => scanCompanySources([source(input[0]!.text.replace("key.pk", "other.pk"))], {}, coverage)).toThrow("Company inventory unclassifiable.");
  expect(() => scanCompanySources([], {}, coverage)).toThrow("Company inventory stale forwarding.");
});

it("counts shorthand aliases and resolves imported builder aliases", () => {
  const scanned = scanCompanySources([
    source('export function key(id) { return `TASK#${id}`; }', "packages/broker/src/keys.ts"),
    source('import { key as alias } from "../keys.js"; const entityType = "TASK"; const pk = alias(id); const row = { entityType, pk, sk: "META" };'),
  ]);
  expect(scanned.records).toEqual(["builder:packages/broker/src/keys.ts:key", "entity:TASK"]);
});

it("refuses a declared but unreadable key constructor and a dynamic entity template", () => {
  for (const text of ['function key() { return externalValue; } const row = { pk: key() };', 'const row = { entityType: `TASK_${externalValue}` };']) {
    expect(() => scanCompanySources([source(text)])).toThrow("Company inventory unclassifiable.");
  }
});

it("resolves namespace constants and computed literal field names", () => {
  const scanned = scanCompanySources([
    source('export const KIND = "NAMESPACE";', "packages/broker/src/kinds.ts"),
    source('import * as kinds from "../kinds.js"; const field = "entityType"; const row = { [field]: kinds.KIND, ["pk"]: `TASK#${id}` };'),
  ]);
  expect(scanned.records).toEqual(["entity:NAMESPACE", "pk:TASK"]);
});

it("refuses mutable aliases and assignment-based constructors instead of returning a partial inventory", () => {
  for (const text of [
    'let kind = "OLD"; kind = externalValue; const row = { entityType: kind };',
    'let key = "OLD#id"; key = externalValue; const row = { pk: key };',
    'const row = {}; row.entityType = "NEW";',
    'const row = {}; row["pk"] = "NEW#id";',
  ]) expect(() => scanCompanySources([source(text)])).toThrow("Company inventory unclassifiable.");
});

it("refuses reassigned object-property aliases instead of counting their obsolete initializer", () => {
  expect(() => scanCompanySources([source('const kinds = { name: "OLD" }; kinds.name = externalValue; const row = { entityType: kinds.name };')])).toThrow("Company inventory unclassifiable.");
});

it("ratchets whitespace inside a forwarded field name as a semantic change", () => {
  const input = source('function forward(key) { return { pk: key["a b"] }; }');
  const coverage = [{ site: "packages/broker/src/aws/broker.ts:1:34:pk", expression: 'key["a b"]', reason: "Runtime field forwarding", constructors: "caller record keys" }];
  expect(scanCompanySources([input], {}, coverage).forwarding).toHaveLength(1);
  expect(() => scanCompanySources([source(input.text.replace('a b', 'a  b'))], {}, coverage)).toThrow("Company inventory unclassifiable.");
});

it("uses work rather than elapsed wall time to bound the inventory", () => {
  let elapsed = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => elapsed += 60_000);
  try { expect(basic().records).toEqual(["entity:TASK"]); } finally { clock.mockRestore(); }
});

describe("merge-up 3 proof record classifications", () => {
  async function proofWorld() {
    const world = await mergeWorld();
    const task = { ...await world.task(), orgId: COMPANY_A.orgId };
    const pr = world.prs[0]!;
    const request = { repositoryId: pr.repositoryId, number: pr.number, headSha: pr.head };
    const judge = (companyTask = task, headSha = pr.head) => judgeProofHold({
      store: world.store, timeline: world.timeline,
      proofHold: { mode: () => "hold", facts: async () => ({ absentOnNew: ["changed check"] }) },
    }, companyTask, pr, headSha, world.now.value);
    const press = () => markReadyAnyway({
      store: world.store, audit: world.audit, now: () => world.now.value,
      roles: { read: async () => ({ orgRole: "owner" }) },
      loadTask: async () => task,
    }, { companyId: task.orgId, taskId: task.taskId, repositoryId: pr.repositoryId, number: pr.number, expectedHeadSha: pr.head, actorId: task.ownerId });
    await world.seedTracking({ orgId: task.orgId, draft: true });
    return { world, task, request, judge, press };
  }

  it("keeps proof history separate for the same project in two companies", async () => {
    const { world, task, judge } = await proofWorld();
    expect(await readProofHoldHistory(world.store, task.orgId, task.project)).toEqual({ held: 0, total: 0 });
    expect(await judge()).toMatchObject({ kind: "held" });
    expect(await readProofHoldHistory(world.store, task.orgId, task.project)).toEqual({ held: 1, total: 1 });
    expect(await readProofHoldHistory(world.store, COMPANY_B.orgId, task.project)).toEqual({ held: 0, total: 0 });
    expect(await judge({ ...task, orgId: COMPANY_B.orgId })).toMatchObject({ kind: "held" });
    expect(await readProofHoldHistory(world.store, task.orgId, task.project)).toEqual({ held: 1, total: 1 });
    expect(await readProofHoldHistory(world.store, COMPANY_B.orgId, task.project)).toEqual({ held: 1, total: 1 });
  });

  it("known gap: proof-hold judgement writers replace another company's row at the same task key", async () => {
    const { world, task, request, judge } = await proofWorld();
    expect(await judge()).toMatchObject({ kind: "held" });
    expect((await readProofHold(world.store, task, request))?.record.orgId).toBe(task.orgId);
    const foreignTask = { ...task, orgId: COMPANY_B.orgId };
    expect(await readProofHold(world.store, foreignTask, request)).toBeUndefined();
    expect(await judge(foreignTask)).toMatchObject({ kind: "held" });
    // Equal state keys suppress the foreign judgement write; a new head replaces the row.
    expect(await readProofHold(world.store, foreignTask, request)).toBeUndefined();
    const nextHead = "b".repeat(40);
    expect(await judge(foreignTask, nextHead)).toMatchObject({ kind: "held" });
    expect((await world.store.get(proofHoldKey(task.taskId, request.repositoryId, request.number)))?.["orgId"]).toBe(COMPANY_B.orgId);
    expect(await readProofHold(world.store, task, request)).toBeUndefined();
    expect((await readProofHold(world.store, foreignTask, { ...request, headSha: nextHead }))?.record.orgId).toBe(COMPANY_B.orgId);
  });

  it("known gap: a foreign proof-override row blocks mark-ready at the same task key despite the read fence", async () => {
    const { world, task, request, judge, press } = await proofWorld();
    expect(await judge()).toMatchObject({ kind: "held" });
    const key = proofOverrideKey(task.taskId, request.repositoryId, request.number);
    expect(await press()).toMatchObject({ overridden: true, already: false });
    const own = (await world.store.get(key))!;
    expect((await readProofHold(world.store, task, request))?.override?.orgId).toBe(task.orgId);
    const foreign = { ...own, orgId: COMPANY_B.orgId };
    await world.store.put({ item: foreign });
    expect((await readProofHold(world.store, task, request))?.override).toBeUndefined();
    await expect(press()).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(await world.store.get(key)).toEqual(foreign);
  });
});

it("pins L4 legacy pagination as a known gap and preserves company-scoped target constructors", () => {
  const markdown = readFileSync("docs/architecture/company-inventory.md", "utf8");
  const rows = forwardingCoverage(markdown).filter(row => row.site.startsWith("packages/broker/src/aws/core-project-backfill.ts:"));
  expect(rows.map(row => row.expression)).toEqual(["projectKey(name, 1).pk", "cursor.after"]);
  expect(rows.every(row => row.reason.startsWith("Known gap:") && row.constructors === "projectKey (legacy PROJECT)")).toBe(true);
  const text = readFileSync("packages/broker/src/aws/core-project-backfill.ts", "utf8");
  expect(text).toContain("projectRevisionKey(company, definition.name, definition.revision)");
  expect(text).toContain("orgProjectCatalogKey(company, definition.name)");
});

it("TE-B4: the Rovara Check record is company-scoped: the same task key in two companies is two rows, and a foreign row is refused", () => {
  const a = summaryCheckKey(COMPANY_A.orgId, "task-1", "app", 7);
  const b = summaryCheckKey(COMPANY_B.orgId, "task-1", "app", 7);
  expect(a.pk).not.toBe(b.pk);
  expect(a.sk).toBe(b.sk);
  const row = { ...a, entityType: "ROVARA_CHECK", orgId: COMPANY_A.orgId, taskId: "task-1", repositoryId: "app", number: 7, headSha: "a".repeat(40), firstSeenAtMs: 1 };
  expect(summaryCheckRecordOf(row, COMPANY_A.orgId, "task-1")).toBeDefined();
  expect(summaryCheckRecordOf(row, COMPANY_B.orgId, "task-1")).toBeUndefined();
});

it("classifies the M4a settings owner and both full-access company-checked methods", () => {
  const markdown = readFileSync("docs/architecture/company-inventory.md", "utf8");
  expect(markdown).toContain("| record | entity:PROJECT_SETTINGS | company-scoped |");
  expect(markdown).toContain("| route | /v1/dev/projects/{id}/settings | company-scoped | State table | yes | GET, PUT |");
  expect(COMPANY_CHECKED_ROUTES).toContain("GET /v1/dev/projects/{id}/settings");
  expect(COMPANY_CHECKED_ROUTES).toContain("PUT /v1/dev/projects/{id}/settings");
});

it("classifies the M4a S3 compliance route as a company-scoped, full-access, read-only admin route", () => {
  const markdown = readFileSync("docs/architecture/company-inventory.md", "utf8");
  expect(markdown).toContain("| route | /v1/dev/company/settings-compliance | company-scoped | State table | yes | GET |");
  expect(COMPANY_CHECKED_ROUTES).toContain("GET /v1/dev/company/settings-compliance");
});

it("pins S3 migration text and every catalog constructor caller, including all writers", () => {
  const inventory = readFileSync("docs/architecture/company-inventory.md", "utf8");
  for (const text of ["PROJECT_CATALOG_INDEX", "canonical company-bound cursor v2", "no shared fallback and no flag", "the partition key proves the company", "unflagged it keeps the legacy v1/shared paging", "verify --mark refuses a named company", "project_catalog.index_drift", "Future move contract"]) expect(inventory).toContain(text);
  // Counts pin every constructor call, not just files. Adding a writer (including to a current reader) requires review here.
  const expected: Record<string, number[]> = {
    "packages/broker/src/aws/broker.ts": [5, 0], // registration + repair dual-write corePlan in the legacy transaction; other calls read/check
    "packages/broker/src/aws/core-project-backfill.ts": [0, 1], // fenced L4 planner, appended atomically by registration/repair
    "packages/broker/src/aws/company-project-names.ts": [0, 3], // L2-1: own-company name check reads + one ConditionCheck in the registration transaction; no catalog write
    "packages/broker/src/aws/developer-tasks.ts": [1, 0], // legacy task ConditionCheck
    "packages/broker/src/aws/project-catalog-backfill.ts": [0, 3], // operator reads + fenced mark/undo
    "packages/broker/src/aws/project-settings.ts": [1, 2], // v1 read and v2 existence/start-key reads
    "packages/broker/src/core-host/lessons.ts": [0, 1],
    "packages/broker/src/core/e2e/local-authority.ts": [0, 1],
    "packages/broker/src/core/setup-agent/apply.ts": [0, 2], // core-only approval: condition + fenced latestRevision update
    "packages/broker/src/core/task-flow/project-source.ts": [0, 1],
    "packages/broker/src/local/app/lessons-repos.ts": [0, 1],
    "packages/broker/src/local/app/lessons.ts": [0, 1],
    "packages/broker/src/local/app/projects.ts": [0, 2], // local-only company writer + read (no AWS legacy transaction)
  };
  const found: Record<string, number[]> = {};
  for (const input of companySources().filter(s => s.path.startsWith("packages/broker/src/"))) {
    const file = ts.createSourceFile(input.path, input.text, ts.ScriptTarget.Latest, true);
    const aliases = new Map([["projectCatalogKey", 0], ["orgProjectCatalogKey", 1]]);
    for (const statement of file.statements) if (ts.isImportDeclaration(statement) && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) {
      for (const imported of statement.importClause.namedBindings.elements) {
        const kind = aliases.get(imported.propertyName?.text ?? imported.name.text);
        if (kind !== undefined) aliases.set(imported.name.text, kind);
      }
    }
    const counts = [0, 0];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const name = ts.isIdentifier(node.expression) ? node.expression.text : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : undefined;
        const kind = name === undefined ? undefined : aliases.get(name);
        if (kind !== undefined) counts[kind] = counts[kind]! + 1;
      }
      ts.forEachChild(node, visit);
    };
    visit(file); if (counts.some(n => n > 0)) found[input.path] = counts;
  }
  expect(found).toEqual(expected);
  const broker = readFileSync("packages/broker/src/aws/broker.ts", "utf8");
  expect(broker.match(/\.\.\.corePlan\.writes/g)).toHaveLength(2); // registration and catalog repair
  expect(readFileSync("packages/broker/src/core/setup-agent/apply.ts", "utf8")).toContain('condition: when.eq("latestRevision", row.baseRevision)');
});
