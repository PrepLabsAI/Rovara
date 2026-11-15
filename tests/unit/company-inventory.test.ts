import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { COMPANY_CHECKED_ROUTES } from "../support/company-route-harness.js";
import { scanCompanySources, loadCompanySources, validateCompanyInventory, forwardingCoverage } from "../support/company-inventory-scan.js";

const source = (text: string, path = "packages/broker/src/aws/broker.ts") => ({ path, text });
const markdown = (count = "1 record kinds: 0 company-scoped, 0 install-wide, 1 needs-company. 1 routes: 0 company-scoped, 0 install-wide, 1 needs-company.") => `${count}\n\n| kind | identity | class | table | checked | methods | reason |\n|---|---|---|---|---|---|---|\n| record | entity:TASK | needs-company | State table | no | - | T1 |\n| route | /v1/dev/tasks | needs-company | State table | no | GET | T2 |\n`;
const basic = () => scanCompanySources([source('const item = { entityType: "TASK" }; const route = "/v1/dev/tasks";')]);

describe("company inventory", () => {
  it("classifies every source identity and recomputes the count", () => {
    const markdown = readFileSync("docs/architecture/company-inventory.md", "utf8");
    const inventory = scanCompanySources(loadCompanySources(resolve(".")), {}, forwardingCoverage(markdown));
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
