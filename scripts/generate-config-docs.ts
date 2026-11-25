// F1 lane L1b: docs/day-two.md's table of `agentx config` keys is generated from Code's settings rows (packages/contracts/src/settings/install-rows.ts), so a new key is one row and the
// guide cannot drift from the code. tests/contract/settings-config-golden.test.ts holds the guide equal to the generated table.
//
// Usage, from the repository root:  node scripts/generate-config-docs.ts check | write
import { readFileSync, writeFileSync } from "node:fs";
import { CODE_SETTING_ROWS, configDocsTable } from "@agentx/contracts";

const DOC = "docs/day-two.md";
const HEADER = "| Key | Where it lives | Default | Notes |";

/** The guide with its config table replaced by `table`; the table is the run of `|` lines that starts at the header. */
export function withTable(guide: string, table: readonly string[]): string {
  const lines = guide.split("\n");
  const start = lines.findIndex((line) => line.startsWith(HEADER));
  if (start < 0) throw new Error(`${DOC} has no config table (a line starting with ${HEADER})`);
  let end = start;
  while (lines[end]?.startsWith("|") === true) end += 1;
  return [...lines.slice(0, start), ...table, ...lines.slice(end)].join("\n");
}

function main(): void {
  const mode = process.argv[2];
  const current = readFileSync(DOC, "utf8");
  const next = withTable(current, configDocsTable(CODE_SETTING_ROWS));
  if (mode === "write") {
    writeFileSync(DOC, next);
    process.stdout.write(next === current ? `${DOC} is already generated\n` : `${DOC} rewritten\n`);
    return;
  }
  if (next !== current) {
    process.stderr.write(`${DOC}'s config table is out of date; run: node scripts/generate-config-docs.ts write\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${DOC}'s config table is generated\n`);
}

if (process.argv[1]?.endsWith("generate-config-docs.ts")) main();
