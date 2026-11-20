import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { enumerateCompanyForwardingSites, loadCompanySources } from "../tests/support/company-inventory-scan.js";
import type { InventorySource } from "../tests/support/company-inventory-scan.js";

function replaceSiteCell(line: string, expected: string, replacement: string): string {
  const parts = line.split("|");
  const cell = parts[2];
  if (parts.length !== 7 || cell?.trim() !== expected) throw new Error(`Inventory repin refused mismatched site cell in row: ${line}`);
  const start = cell.indexOf(expected);
  parts[2] = cell.slice(0, start) + replacement + cell.slice(start + expected.length);
  return parts.join("|");
}

function decodeCell(value: string): string {
  return value.replaceAll("&#10;", "\n").replaceAll("&#124;", "|").replaceAll("&amp;", "&");
}

export function repinInventory(markdown: string, sources: readonly InventorySource[]): string {
  const discovered = enumerateCompanyForwardingSites(sources).map((entry) => {
    const match = /^(.*):\d+:\d+:([^:]+)$/.exec(entry.site)!;
    return { ...entry, path: match[1]!, field: match[2]! };
  });
  const lines = markdown.split("\n");
  const rows = lines.flatMap((line, index) => {
    if (!line.startsWith("| forwarding |")) return [];
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    const [, site, expression, reason, constructors] = cells;
    const match = /^(.*):(\d+):(\d+):([^:]+)$/.exec(site ?? "");
    if (cells.length !== 5 || !line.endsWith("|") || !match || !["pk", "sk", "entityType", "computed"].includes(match[4]!) || !expression || !reason || !constructors) throw new Error(`Inventory repin refused malformed row: ${line}`);
    return [{ index, line, site: site!, path: match[1]!, field: match[4]!, expression: decodeCell(expression), reason }];
  });
  const claimed = new Set<string>();
  const resolved = new Set<number>();
  const claim = (row: typeof rows[number], site: string): void => {
    if (claimed.has(site)) throw new Error(`Inventory repin refused row ${row.site}: ambiguous duplicate row/site ${site}`);
    claimed.add(site);
    resolved.add(row.index);
    lines[row.index] = replaceSiteCell(row.line, row.site, site);
  };
  // Claim every exact match before resolving any stale location, regardless of row order.
  for (const row of rows) {
    const exact = discovered.filter((entry) => entry.site === row.site && entry.expression === row.expression);
    if (exact.length === 1) claim(row, exact[0]!.site);
  }
  const stale = rows.filter((row) => !resolved.has(row.index));
  for (const row of stale) {
    const group = stale.filter((other) => other.path === row.path && other.field === row.field && other.expression === row.expression && other.reason === row.reason);
    const candidates = discovered.filter((entry) => entry.path === row.path && entry.field === row.field && entry.expression === row.expression && !claimed.has(entry.site));
    if (group.length !== 1) throw new Error(`Inventory repin refused row ${row.site}: ambiguous unclaimed rows (${group.length})`);
    if (candidates.length !== 1) throw new Error(`Inventory repin refused row ${row.site} (${row.expression}): ${candidates.length === 0 ? "no matching current site" : "ambiguous matching sites"}`);
    claim(row, candidates[0]!.site);
  }
  const added = discovered.find((entry) => !claimed.has(entry.site));
  if (added) throw new Error(`Inventory repin refused uncovered current site ${added.site} (${added.expression})`);
  return lines.join("\n");
}

export function runInventoryRepin(root = process.cwd()): void {
  const inventoryPath = join(root, "docs/architecture/company-inventory.md");
  const original = readFileSync(inventoryPath, "utf8");
  const sources = loadCompanySources(resolve(root));
  const updated = repinInventory(original, sources);
  if (updated !== original) writeFileSync(inventoryPath, updated);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(dirname(new URL(import.meta.url).pathname), "inventory-repin.ts")) {
  try { runInventoryRepin(); }
  catch (error) { console.error(error instanceof Error ? error.message : "Inventory repin refused."); process.exitCode = 1; }
}
