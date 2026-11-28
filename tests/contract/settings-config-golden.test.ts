// F1 lane L1b: `agentx config`'s keys and docs/day-two.md's table are generated from the settings rows and equal what they were before, exactly.
// tests/contract/golden/config-keys.golden.json is taken from the hand-written CONFIG_KEYS at the base commit: for each key its description, target, where text, default, flags and the
// result of a fixed battery of inputs (accepted: the stored value; refused: the exact message and which inputs got it). `config set` without a TTY applies the value, so validation must
// not loosen: an input refused before is refused after with the same words, and an accepted input stores the same value. config-keys-docs-table.golden.md is the docs table as it was.
// Never update the golden files in this lane.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHATGPT_DEFAULT_PREFERRED_MODEL, CODE_SETTING_ROWS, configDocsTable, configKeySpecsFromRows } from "@agentx/contracts";
import { MAX_BUDGET_USD } from "../../packages/cli/src/deploy/answer-schemas.js";
import { CONFIG_KEYS, whereText } from "../../packages/cli/src/config/keys.js";

interface GoldenKey {
  key: string; description: string; target: unknown; where: string; defaultValue: string | null;
  flags: { e2eAgentModel: true | null; fallbackModel: true | null; corePairedWith: string | null; gatewayOffered: true | null; model: string | null; hasShown: boolean };
  shownSamples: Record<string, string> | null;
  results: { accepts: Record<string, string>; refuses: Record<string, string[]> };
}
/** #1614: the keys deleted since the golden was taken (company mode is the only mode, so its three switches are gone). Everything else must still match exactly. */
const DELETED_KEYS = ["company.signIn", "company.selfServe", "slack.companyWorkspaces"];
const golden = (JSON.parse(readFileSync("tests/contract/golden/config-keys.golden.json", "utf8")) as GoldenKey[]).filter((entry) => !DELETED_KEYS.includes(entry.key));
const BATTERY = [...new Set(golden.flatMap((entry) => [...Object.keys(entry.results.accepts), ...Object.values(entry.results.refuses).flat()]))];

function grouped(parse: (value: string) => string, inputs: readonly string[]): GoldenKey["results"] {
  const accepts: Record<string, string> = {};
  const refuses: Record<string, string[]> = {};
  for (const input of inputs) {
    try { accepts[input] = parse(input); } catch (error) { (refuses[(error as Error).message] ??= []).push(input); }
  }
  return { accepts, refuses };
}

describe("CONFIG_KEYS is generated from the rows and equals the old list (F1 L1b)", () => {
  it("has the same keys in the same order", () => {
    expect(CONFIG_KEYS.map((entry) => entry.key)).toEqual(golden.map((entry) => entry.key));
    expect(CONFIG_KEYS).toHaveLength(29 - DELETED_KEYS.length);
  });

  it("lists each key with the same description, target, where text, default and flags (config list is unchanged)", () => {
    for (const [index, entry] of CONFIG_KEYS.entries()) {
      const before = golden[index]!;
      expect({ key: entry.key, description: entry.description, target: entry.target, where: whereText(entry.target, "staging"), defaultValue: entry.defaultValue ?? null }, entry.key)
        .toEqual({ key: before.key, description: before.description, target: before.target, where: before.where, defaultValue: before.defaultValue });
      expect({ e2eAgentModel: entry.e2eAgentModel ?? null, fallbackModel: entry.fallbackModel ?? null, corePairedWith: entry.corePairedWith ?? null, gatewayOffered: entry.gatewayOffered ?? null, model: entry.model ?? null, hasShown: entry.shown !== undefined }, entry.key).toEqual(before.flags);
      expect(entry.shown === undefined ? null : Object.fromEntries(Object.keys(before.shownSamples ?? {}).map((stored) => [stored, entry.shown!(stored)])), entry.key).toEqual(before.shownSamples);
    }
  });

  it("accepts and refuses the same inputs with the same stored value and the same words (validation does not loosen)", () => {
    expect(BATTERY.length).toBeGreaterThan(50);
    for (const [index, entry] of CONFIG_KEYS.entries()) {
      const before = golden[index]!;
      const now = grouped((value) => entry.parse(value), BATTERY);
      expect(now.accepts, `${entry.key} accepted`).toEqual(before.results.accepts);
      const sortedInputs = (refuses: Record<string, string[]>) => Object.fromEntries(Object.entries(refuses).map(([message, inputs]) => [message, [...inputs].sort()]));
      expect(sortedInputs(now.refuses), `${entry.key} refused`).toEqual(sortedInputs(before.results.refuses));
    }
  });

  it("keeps the constants the rows spell out equal to the constants the code names", () => {
    expect(configKeySpecsFromRows(CODE_SETTING_ROWS).find((spec) => spec.key === "budget.monthlyUsd")?.validator).toEqual({ kind: "wholeNumber", min: 0, max: MAX_BUDGET_USD });
    expect(configKeySpecsFromRows(CODE_SETTING_ROWS).find((spec) => spec.key === "models.chatgpt.preferredModel")?.defaultValue).toBe(CHATGPT_DEFAULT_PREFERRED_MODEL);
  });
});

describe("docs/day-two.md's config table is generated from the rows (F1 L1b)", () => {
  const goldenTable = readFileSync("tests/contract/golden/config-keys-docs-table.golden.md", "utf8").trimEnd().split("\n").filter((line) => !DELETED_KEYS.some((key) => line.startsWith(`| \`${key}\``)));

  it("generates exactly the table the guide had before", () => {
    expect(configDocsTable(CODE_SETTING_ROWS)).toEqual(goldenTable);
  });

  it("is the table the guide holds now, byte for byte (the doc is unchanged by this lane; regenerate with scripts/generate-config-docs.ts)", () => {
    const lines = readFileSync("docs/day-two.md", "utf8").split("\n");
    const start = lines.findIndex((line) => line.startsWith("| Key | Where it lives | Default | Notes |"));
    expect(start).toBeGreaterThan(0);
    let end = start;
    while (lines[end]?.startsWith("|") === true) end += 1;
    expect(lines.slice(start, end)).toEqual(configDocsTable(CODE_SETTING_ROWS));
  });

  it("has one row of the table for each config key (the guide's order is its own, not config list's)", () => {
    expect(configDocsTable(CODE_SETTING_ROWS).slice(2).map((line) => /^\| `([^`]+)`/u.exec(line)![1]).sort()).toEqual(CONFIG_KEYS.map((entry) => entry.key).sort());
  });
});
