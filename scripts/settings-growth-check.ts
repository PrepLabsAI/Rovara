// E1-0, check 2 (arch rules 1 and 2): the stack parameters and the settings may not GROW. A ratchet that names every row.
//
// Counted, each by NAME, so that the one that grew is the one the failure names:
//   stackParameters    `new CfnParameter(` (CDK core, not an SSM parameter) in infra/: one entry per declaring file and parameter id, with how many times it is declared there;
//   brokerSettings     the keys of BROKER_SETTINGS (packages/contracts/src/broker-environment.ts): the settings packed into the broker's one variable;
//   configKeys         the keys of CONFIG_KEYS (packages/cli/src/config/keys.ts): what `agentx config set` accepts;
//   operatorParameters OPERATOR_PARAMETERS (packages/cli/src/deploy/parameters.ts), as "<part>:<parameter>": the parameters an upgrade keeps.
// scripts/settings-growth-baseline.json holds today's names. A name (or a count) that is not in the baseline fails: a new setting needs a named customer who asked and a reason
// a good default will not do (rule 2), and no new default-off switch (rule 1); the change that adds one adds its row to the baseline in the same diff, so the reviewer sees the
// name and the decision line. A name in the baseline that is gone passes; `shrink` drops it and never adds one.
//
// F1 (the settings table): F1's scripts/settings-lints.ts counts `new CfnParameter(` per FILE (and CDK context reads and broker `process.env`) in a shrink-only baseline, and its rows
// DERIVE BROKER_SETTINGS, CONFIG_KEYS and OPERATOR_PARAMETERS. This check reads those three from the code, so it keeps working unchanged once F1 lands; the per-file CfnParameter
// count is then the same fact F1 holds, here per parameter id, and either may be dropped.
//
// Usage, from the repository root:  tsx scripts/settings-growth-check.ts check | shrink
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BROKER_SETTINGS } from "../packages/contracts/src/broker-environment.js";
import { CONFIG_KEYS } from "../packages/cli/src/config/keys.js";
import { OPERATOR_PARAMETERS } from "../packages/cli/src/deploy/parameters.js";

export interface SettingsCounts {
  /** "<file>::<parameter id>" to the number of declarations. */
  stackParameters: Record<string, number>;
  brokerSettings: string[];
  configKeys: string[];
  operatorParameters: string[];
}
export type CountName = keyof SettingsCounts;

export const BASELINE_PATH = "scripts/settings-growth-baseline.json";
type NameList = Exclude<CountName, "stackParameters">;
const NAME_LISTS: readonly NameList[] = ["brokerSettings", "configKeys", "operatorParameters"];
const ADVICE: Record<CountName, string> = {
  stackParameters: "a new stack parameter needs a named customer who asked and a reason a good default will not do (rule 2); add it to scripts/settings-growth-baseline.json with the decision line",
  brokerSettings: "a new broker setting needs a named customer and a reason (rule 2); add it to scripts/settings-growth-baseline.json with the decision line",
  configKeys: "a new `agentx config` key needs a named customer and a reason (rule 2); add it to scripts/settings-growth-baseline.json with the decision line",
  operatorParameters: "a new kept-on-upgrade parameter needs a named customer and a reason (rule 2); add it to scripts/settings-growth-baseline.json with the decision line",
};
const SKIPPED = new Set(["node_modules", "dist", "cdk.out", ".release-synth", ".git"]);
/** `new CfnParameter(` or `new cdk.CfnParameter(`, and the second argument (the parameter's id); an SSM `CfnParameter` is a resource, not a stack parameter. */
const DECLARATION = /\bnew (?!(?:ssm|aws_ssm|awsSsm)\.)(?:\w+\.)?CfnParameter\(\s*[^,()]+,\s*("[^"]*"|`[^`]*`|'[^']*'|[A-Za-z_$][\w$.]*)/gu;

function sourceFiles(root: string, directory: string): string[] {
  const found: string[] = [];
  let names: string[];
  try {
    names = readdirSync(join(root, directory));
  } catch {
    return found;
  }
  for (const name of names) {
    if (SKIPPED.has(name)) continue;
    const path = `${directory}/${name}`;
    if (statSync(join(root, path)).isDirectory()) found.push(...sourceFiles(root, path));
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts") && !name.endsWith(".test.ts")) found.push(path);
  }
  return found.sort();
}

/** The stack parameters one source text declares, by id, with how many times. */
export function stackParametersIn(text: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const match of text.matchAll(DECLARATION)) {
    const id = (match[1] ?? "").replace(/^["'`]|["'`]$/gu, "");
    counts[id] = (counts[id] ?? 0) + 1;
  }
  return counts;
}

export function scanStackParameters(root: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of sourceFiles(root, "infra")) {
    for (const [id, count] of Object.entries(stackParametersIn(readFileSync(join(root, file), "utf8")))) counts[`${file}::${id}`] = count;
  }
  return counts;
}

const sortedNames = (names: Iterable<string>): string[] => [...new Set(names)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** Today's counts, read from the repository (the infra sources) and from the code (the three settings tables). */
export function currentCounts(root: string): SettingsCounts {
  return {
    stackParameters: scanStackParameters(root),
    brokerSettings: sortedNames(Object.keys(BROKER_SETTINGS)),
    configKeys: sortedNames(CONFIG_KEYS.map((key) => key.key)),
    operatorParameters: sortedNames(Object.entries(OPERATOR_PARAMETERS).flatMap(([part, names]) => names.map((name) => `${part}:${name}`))),
  };
}

export interface Comparison { raised: string[]; lowered: string[] }

function compareStackParameters(now: SettingsCounts, baseline: SettingsCounts): Comparison {
  const raised: string[] = [];
  const lowered: string[] = [];
  for (const name of new Set([...Object.keys(now.stackParameters), ...Object.keys(baseline.stackParameters)])) {
    const count = now.stackParameters[name] ?? 0;
    const before = baseline.stackParameters[name] ?? 0;
    if (count > before) raised.push(`stackParameters: ${name} is declared ${count} time(s) (baseline ${before}): ${ADVICE.stackParameters}`);
    else if (count < before) lowered.push(`stackParameters: ${name} is down`);
  }
  return { raised, lowered };
}

function compareNames(list: NameList, now: SettingsCounts, baseline: SettingsCounts): Comparison {
  return {
    raised: now[list].filter((name) => !baseline[list].includes(name)).map((name) => `${list}: ${name} is new: ${ADVICE[list]}`),
    lowered: baseline[list].filter((name) => !now[list].includes(name)).map((name) => `${list}: ${name} is gone`),
  };
}

/** `raised`: a name (or a stack parameter count) above the baseline, as a sentence. `lowered`: a name the baseline holds that is gone or down. */
export function compareToBaseline(now: SettingsCounts, baseline: SettingsCounts): Comparison {
  const parts = [compareStackParameters(now, baseline), ...NAME_LISTS.map((list) => compareNames(list, now, baseline))];
  return { raised: parts.flatMap((part) => part.raised), lowered: parts.flatMap((part) => part.lowered) };
}

/** The baseline with every name that is gone (or down) taken out; nothing is ever added or raised. */
export function shrunkBaseline(now: SettingsCounts, baseline: SettingsCounts): SettingsCounts {
  const stackParameters: Record<string, number> = {};
  for (const [name, before] of Object.entries(baseline.stackParameters)) {
    const kept = Math.min(now.stackParameters[name] ?? 0, before);
    if (kept > 0) stackParameters[name] = kept;
  }
  return {
    stackParameters,
    brokerSettings: baseline.brokerSettings.filter((name) => now.brokerSettings.includes(name)),
    configKeys: baseline.configKeys.filter((name) => now.configKeys.includes(name)),
    operatorParameters: baseline.operatorParameters.filter((name) => now.operatorParameters.includes(name)),
  };
}

export function readBaseline(root: string): SettingsCounts {
  return JSON.parse(readFileSync(join(root, BASELINE_PATH), "utf8")) as SettingsCounts;
}

export function formatBaseline(counts: SettingsCounts): string {
  const stackParameters = Object.fromEntries(Object.entries(counts.stackParameters).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return `${JSON.stringify({ ...counts, stackParameters }, null, 2)}\n`;
}

function main(): void {
  const mode = process.argv[2];
  const root = process.cwd();
  const now = currentCounts(root);
  const baseline = readBaseline(root);
  const { raised, lowered } = compareToBaseline(now, baseline);
  if (mode === "shrink") {
    if (raised.length > 0) throw new Error(`a setting count went up; fix it, the baseline never grows by itself:\n${raised.join("\n")}`);
    writeFileSync(join(root, BASELINE_PATH), formatBaseline(shrunkBaseline(now, baseline)));
    process.stdout.write(`${lowered.length} entries dropped from ${BASELINE_PATH}\n`);
    return;
  }
  if (raised.length > 0) {
    process.stderr.write(`${raised.join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`settings growth check passes${lowered.length > 0 ? `; ${lowered.length} entries are gone, run: tsx scripts/settings-growth-check.ts shrink` : ""}\n`);
}

if (process.argv[1]?.endsWith("settings-growth-check.ts")) main();
