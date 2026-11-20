import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { repinInventory, runInventoryRepin } from "../../scripts/inventory-repin.js";
import { forwardingCoverage, scanCompanySources, validateCompanyInventory } from "../support/company-inventory-scan.js";

const path = "packages/broker/src/aws/broker.ts";
const site = (line = 1, field = "pk") => `${path}:${line}:34:${field}`;
const row = (location = site(), expression = "key.pk", reason = "Generic key transport.") =>
  `| forwarding | ${location} | ${expression} | ${reason} | pk:TASK |`;
const src = (expression = "key.pk", line = 1, field = "pk") => `${"\n".repeat(line - 1)}function forward(key) { return { ${field}: ${expression} }; }\n`;
const sources = (text = src()) => [{ path, text }];
const fixture = (forwarding = row()) => [
  "1 record kinds: 0 company-scoped, 0 install-wide, 1 needs-company. 1 routes: 0 company-scoped, 0 install-wide, 1 needs-company.",
  "", "Summary: preserve this later line too.",
  "| kind | identity | class | table | checked | methods | reason |",
  "|---|---|---|---|---|---|---|",
  "| record | entity:TASK | needs-company | State table | no | - | T1 |",
  forwarding,
  "| route | /v1/dev/tasks | needs-company | State table | no | GET | T2 |",
  "", "Counts and trailing prose stay byte-identical.", "",
].join("\n");

describe("inventory repin", () => {
  it("re-pins only the site cell, preserving every other line and cell; the checker accepts it", () => {
    const markdown = fixture();
    const input = sources(src("key.pk", 2) + 'const item = { entityType: "TASK" }; const route = "/v1/dev/tasks";');
    const result = repinInventory(markdown, input);
    expect(result).toBe(markdown.replace(site(), site(2)));
    markdown.split("\n").forEach((line, index) => {
      if (!line.startsWith("| forwarding |")) expect(result.split("\n")[index]).toBe(line);
    });
    const inventory = scanCompanySources(input, {}, forwardingCoverage(result));
    expect(inventory.forwarding).toEqual([site(2)]);
    expect(() => validateCompanyInventory(inventory, result, [])).not.toThrow();
  });

  it.each([
    ["pk", "key.pk", "pk", "key.pk"],
    ["sk", "key.sk", "sk", "key.sk"],
    ["entityType", "key.entityType", "entityType", "key.entityType"],
    ["computed", "[key]", "[key]", "value"],
    ["computed", "[documents.ttlAttribute]", "[documents.ttlAttribute]", "value"],
  ])("re-pins a moved %s row (%s)", (field, expression, property, value) => {
    const markdown = row(site(1, field), expression);
    const input = sources(src(value, 2, property));
    const result = repinInventory(markdown, input);
    expect(result).toBe(row(site(2, field), expression));
    expect(scanCompanySources(input, {}, forwardingCoverage(result)).forwarding).toEqual([site(2, field)]);
  });

  it.each([
    ["pk", "key.pk", "pk", "key.pk"],
    ["computed", "[key]", "[key]", "value"],
  ])("the tool itself refuses a MOVED ambiguous %s row", (field, expression, property, value) => {
    // Neither current site has the old position: this must reach the tool's candidates guard.
    const markdown = row(site(1, field), expression);
    expect(() => repinInventory(markdown, sources(src(value, 2, property) + src(value, 1, property))))
      .toThrow(`Inventory repin refused row ${site(1, field)} (${expression}): ambiguous matching sites`);
  });

  it("claims exact matches before stale rows in either document order", () => {
    const stale = row(site(1));
    const exact = row(site(3));
    const input = sources(src("key.pk", 2) + src());
    for (const rows of [[stale, exact], [exact, stale]]) {
      const result = repinInventory(rows.join("\n"), input);
      expect(result).toBe(rows.map((line) => line === stale ? row(site(2)) : exact).join("\n"));
      expect(forwardingCoverage(result).map((entry) => entry.site).sort()).toEqual([site(2), site(3)]);
    }
  });

  it("refuses two stale rows in the same expression/reason group in either order", () => {
    const first = row(site(8)); const second = row(site(9));
    const input = sources(src("key.pk", 2) + src());
    for (const rows of [[first, second], [second, first]]) {
      expect(() => repinInventory(rows.join("\n"), input)).toThrow("ambiguous unclaimed rows (2)");
    }
  });

  it.each([
    ["edited expression", src("key.other"), `row ${site()} (key.pk): no matching current site`],
    ["changed field", src("key.pk", 1, "sk"), `row ${site()} (key.pk): no matching current site`],
    ["new site", src() + src("key.sk", 1, "sk"), `uncovered current site ${site(2, "sk")}`],
    ["removed site", "const value = 1;\n", `row ${site()} (key.pk): no matching current site`],
  ])("refuses %s naming the offending row/site", (_name, text, message) => {
    expect(() => repinInventory(row(), sources(text))).toThrow(`Inventory repin refused ${message}`);
  });

  it("refuses duplicate rows claiming the same exact site", () => {
    expect(() => repinInventory([row(), row()].join("\n"), sources()))
      .toThrow(`Inventory repin refused row ${site()}: ambiguous duplicate row/site ${site()}`);
  });

  it("preserves unusual site-cell padding while replacing exactly that cell", () => {
    const markdown = row().replace(` ${site()} |`, `   ${site()}\t|`);
    expect(repinInventory(markdown, sources(src("key.pk", 2)))).toBe(markdown.replace(site(), site(2)));
  });

  it.each([
    `${row(site(2))} extra |`,
    row(site(2)).replace(` ${site(2)} |`, ` ${site(2)} trailing |`),
    row(site(2)).slice(0, -1),
  ])("names the offending malformed second row (%s)", (badRow) => {
    expect(() => repinInventory([row(), badRow].join("\n"), sources(src() + src())))
      .toThrow(`Inventory repin refused malformed row: ${badRow}`);
  });

  it("uses scanner resolution and scope when enumerating sites", () => {
    const text = 'const field = "pk"; function forward(key) { return { [field]: key.pk }; }';
    const location = `${path}:1:${text.indexOf("[field]") + 1}:pk`;
    const markdown = row(location);
    const input = [{ path, text }, { path: "outside/records.ts", text: src() }];
    expect(repinInventory(markdown, input)).toBe(markdown);
  });

  it("leaves a no-op run byte-identical", () => {
    const markdown = fixture();
    expect(repinInventory(markdown, sources())).toBe(markdown);
  });
  it("real repository no-op does not write", () => {
    const before = readFileSync("docs/architecture/company-inventory.md", "utf8");
    runInventoryRepin(process.cwd());
    expect(readFileSync("docs/architecture/company-inventory.md", "utf8")).toBe(before);
  });
});
