// F1 lane L0: the lints that keep new settings in the rows, each with a SHRINK-ONLY baseline.
//
// A setting added outside the settings table (packages/contracts/src/settings) is invisible to the table, to `agentx config`, to the docs and to the kept-on-upgrade list. Three places
// let one in today, so each is counted per file and held at today's count:
//   cfnParameter   `new CfnParameter(` in infra/: an install parameter declared by hand, with no row;
//   tryGetContext  a CDK `tryGetContext` call in infra/ and scripts/: a context flag read by hand (the hidden flags until R8 deletes them; the stack selectors in app.ts);
//   processEnv     `process.env` in packages/broker/src: a direct environment read (unpacked settings land in `env`; about 360 today, no broker rewrite in L0 or L1a).
// A file may not go above its baseline count and a file with no baseline may not appear: the failure says "add a row" (or read the value through the table). A LOWER count passes, and
// `shrink` rewrites the baseline down to it (it refuses to raise any count, the way complexity:update only lowers its baseline). The baseline is scripts/settings-lints-baseline.json.
//
// The tombstone lint: a retired setting's key may appear only in the tombstone list, a store adapter's tolerant-read code and the stored-document tests (SETTING_TOMBSTONES is empty
// until the first removal lane, so it finds nothing today).
//
// Usage, from the repository root:  node scripts/settings-lints.ts check | shrink
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

export type Counts = Record<string, number>;
export interface LintScan { cfnParameter: Counts; tryGetContext: Counts; processEnv: Counts }
export type LintName = keyof LintScan;

export const BASELINE_PATH = "scripts/settings-lints-baseline.json";
export const LINT_NAMES: readonly LintName[] = ["cfnParameter", "tryGetContext", "processEnv"];

const RULES: Record<LintName, { pattern: RegExp; roots: readonly string[]; advice: string }> = {
  cfnParameter: { pattern: /\bnew (?:\w+\.)?CfnParameter\(/gu, roots: ["infra"], advice: "declare the parameter as an install row (packages/contracts/src/settings/install-rows.ts) instead of a new CfnParameter" },
  tryGetContext: { pattern: /\btryGetContext\(/gu, roots: ["infra", "scripts"], advice: "make the flag a parameter row instead of reading CDK context (only the stack selectors in infra/lib/app.ts are context)" },
  processEnv: { pattern: /\bprocess\.env\b/gu, roots: ["packages/broker/src"], advice: "add a row for the setting and read it through the table (an install setting arrives packed in AGENTX_SETTINGS)" },
};

const SKIPPED = new Set(["node_modules", "dist", "cdk.out", ".release-synth", ".git"]);

function sourceFiles(root: string, directory: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(join(root, directory))) {
    if (SKIPPED.has(name)) continue;
    const path = join(directory, name);
    if (statSync(join(root, path)).isDirectory()) found.push(...sourceFiles(root, path));
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts") && !name.endsWith(".test.ts")) found.push(path);
  }
  return found;
}

export function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(new RegExp(pattern.source, pattern.flags))].length;
}

export function scanRepository(root: string): LintScan {
  const scan: LintScan = { cfnParameter: {}, tryGetContext: {}, processEnv: {} };
  for (const name of LINT_NAMES) {
    for (const directory of RULES[name].roots) {
      for (const file of sourceFiles(root, directory)) {
        const count = countMatches(readFileSync(join(root, file), "utf8"), RULES[name].pattern);
        if (count > 0) scan[name][file] = count;
      }
    }
  }
  return scan;
}

/**
 * Baseline counts that ROSE after the lane's base (e2344f187), because other trains added hand-declared parameters or reads that are not environment-stack install settings (so they have
 * no install row): the baseline is otherwise shrink-only, and `shrink` refuses to raise it. Each entry names the lint, the file, the count the baseline now holds, the commit that added it
 * and why it has no row. tests/contract/settings-lints.test.ts holds every entry to the baseline (a stale entry fails), so an entry goes when its file's count reaches zero.
 */
export interface RaisedSinceBase { lint: LintName; file: string; count: number; commit: string; reason: string }
export const RAISED_SINCE_BASE: readonly RaisedSinceBase[] = [
  { lint: "cfnParameter", file: "infra/lib/api-address.ts", count: 1, commit: "f0c56803d (train 41, ADDRESS-STACK)", reason: "ApiId: the one parameter of the separate, long-lived address stack (certificate, custom domain, API mapping), changed only by the pipeline's flip change set; not an environment stack, never an operator or install-answer setting" },
  { lint: "tryGetContext", file: "infra/lib/api-address.ts", count: 1, commit: "f0c56803d (train 41, ADDRESS-STACK)", reason: "agentxApiAddress: the context key that selects whether the address stack exists in the app, a stack selector like the ones in app.ts, not a setting of an install" },
  { lint: "cfnParameter", file: "infra/lib/public-api-url.ts", count: 1, commit: "515e9d67c (train 46, CODE-PUBLIC-URL)", reason: "PublicApiUrl: it HAS rows (install.control-plane.PublicApiUrl and install.foundation.PublicApiUrl, which derive its kept-on-upgrade entries and its packed broker setting `pu`); this is the one helper that declares the parameter on both stacks, which the lint counts until the templates are generated from the rows" },
  { lint: "cfnParameter", file: "infra/lib/canary-session.ts", count: 4, commit: "4af3b1828 (CANARY-SESSION, arch ruling 2026-11-25)", reason: "CanarySessionPlacementEnvironment, CanarySessionPerson, CanarySessionCompany and CanarySessionStepRoleName: they HAVE rows (install.control-plane.<name>, declaredIn legacy, which the synth test pins); they stay CloudFormation parameters because the production lock is a template condition, which can only test a whole parameter (arch ruling bbff6b7dd), so the lint counts the four declarations until the templates are generated from the rows" },
  { lint: "cfnParameter", file: "infra/lib/port-guard-step.ts", count: 1, commit: "745c0a21e (train 39, L14 PORT-GUARD NAMES FROM SSM)", reason: "PortGuardNamesParameterName: a parameter of the release pipeline stack (the SSM name of the port guard's private list), not an environment install stack" },
  { lint: "cfnParameter", file: "infra/lib/release-pipeline.ts", count: 3, commit: "396f07448 (train 52 part 1, PIPELINE L1; baseline was 2, #1578 removed the six Cloud parameters leaving 3)", reason: "GitHubConnectionArn, BetaAccountId, PortGuardNamesKeyArn: parameters of the Code-only release pipeline stack, which F1 L0 leaves out of the install rows (the environment release pipeline's parameters are listed as not rows yet)" },
  { lint: "processEnv", file: "packages/broker/src/aws/canary-session.ts", count: 2, commit: "4af3b1828 (CANARY-SESSION, arch ruling 2026-11-25)", reason: "the canary session function's own handler reads its environment once (the fixed names the template writes on that one function: the environment gate, the person, the company, the issuer, the table and key names), plus the comment saying it never reads process.env anywhere else: wiring of one beta-only function, not packed install settings" },
  { lint: "processEnv", file: "packages/broker/src/aws/instance-state-change-lambda.ts", count: 3, commit: "95e35ac05 (train 68, WORKER-DELIVERY-IDENTITY)", reason: "AWS_REGION (twice, the region Lambda gives every function) and STATE_TABLE_NAME (the session state table the template wires on the instance state-change function): a platform variable and a resource name, not packed install settings" },
  { lint: "processEnv", file: "packages/broker/src/aws/machine-check-aws.ts", count: 3, commit: "95e35ac05 (train 68, WORKER-DELIVERY-IDENTITY)", reason: "AWS_REGION (twice) and AGENTX_METRICS_NAMESPACE (the metrics namespace the template sets on the function, default of withMetric): a platform variable and a derived name, not packed install settings" },
  { lint: "processEnv", file: "packages/broker/src/aws/slack-interactivity.ts", count: 14, commit: "2cf91c0c6 (train 32, S1 CUT 1)", reason: "STATE_TABLE_NAME (the task action registry's state table in the interactivity handler's own wiring): a resource name the template sets on the function (infra/lib/channel-adapters.ts and siblings), not an install setting, so it never arrives packed in AGENTX_SETTINGS; the same variable is already read at line 908 of this file" },
  { lint: "cfnParameter", file: "infra/lib/self-hosted-gateway.ts", count: 1, commit: "fb802c38f (issue #1554, self-hosted Model Gateway stack)", reason: "SelfHostedModelGatewayStack parameter helper: every parameter declared on agentx-<env>-gateway HAS an install row in packages/contracts/src/settings/install-rows.ts (pinned by settings-install-synth.test.ts); the lint counts the one helper until templates are generated from rows" },
];

export interface BaselineComparison { raised: string[]; lowered: string[] }

/** Per file: a count above the baseline (or a file with none) is raised; a count below it (or a file now at zero) is lowered. */
export function compareToBaseline(scan: LintScan, baseline: LintScan): BaselineComparison {
  const raised: string[] = [];
  const lowered: string[] = [];
  for (const name of LINT_NAMES) {
    for (const file of new Set([...Object.keys(scan[name]), ...Object.keys(baseline[name])])) {
      const now = scan[name][file] ?? 0;
      const before = baseline[name][file] ?? 0;
      if (now > before) raised.push(`${name}: ${file} has ${now} (baseline ${before}): ${RULES[name].advice}`);
      else if (now < before) lowered.push(`${name}: ${file} is down to ${now} (baseline ${before})`);
    }
  }
  return { raised, lowered };
}

/** The baseline with every lowered count taken down; a raised count is never written. */
export function shrunkBaseline(scan: LintScan, baseline: LintScan): LintScan {
  const result: LintScan = { cfnParameter: {}, tryGetContext: {}, processEnv: {} };
  for (const name of LINT_NAMES) {
    for (const [file, before] of Object.entries(baseline[name])) {
      const now = Math.min(scan[name][file] ?? 0, before);
      if (now > 0) result[name][file] = now;
    }
  }
  return result;
}

export function readBaseline(root: string): LintScan {
  return JSON.parse(readFileSync(join(root, BASELINE_PATH), "utf8")) as LintScan;
}

export function formatBaseline(scan: LintScan): string {
  const sorted = (counts: Counts) => Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return `${JSON.stringify({ cfnParameter: sorted(scan.cfnParameter), tryGetContext: sorted(scan.tryGetContext), processEnv: sorted(scan.processEnv) }, null, 2)}\n`;
}

/** Where a retired key may still be named: the tombstone list, a store adapter's tolerant read, and the stored-document tests. */
export function tombstoneKeyMayAppearIn(file: string): boolean {
  return file.endsWith("settings/tombstones.ts") || /tolerant/u.test(file) || (/(^|\/)tests\//u.test(file) && /stored/u.test(file));
}

/** One sentence per place a tombstoned key (or its stored name) is used outside the places it may be. `files` maps a path to its text. */
export function tombstoneProblems(tombstones: ReadonlyArray<{ key: string; storedAs: string }>, files: ReadonlyMap<string, string>): string[] {
  const problems: string[] = [];
  for (const [file, text] of files) {
    if (tombstoneKeyMayAppearIn(file)) continue;
    for (const tombstone of tombstones) {
      if (text.includes(tombstone.key) || text.includes(tombstone.storedAs)) problems.push(`${file} names the retired setting ${tombstone.key}; only tombstones.ts, a tolerant read and the stored-document tests may`);
    }
  }
  return problems;
}

function main(): void {
  const mode = process.argv[2];
  const root = process.cwd();
  const scan = scanRepository(root);
  const baseline = readBaseline(root);
  const { raised, lowered } = compareToBaseline(scan, baseline);
  if (mode === "shrink") {
    if (raised.length > 0) throw new Error(`a count went up; fix it, the baseline never rises:\n${raised.join("\n")}`);
    writeFileSync(join(root, BASELINE_PATH), formatBaseline(shrunkBaseline(scan, baseline)));
    process.stdout.write(`${lowered.length} counts lowered in ${relative(root, join(root, BASELINE_PATH))}\n`);
    return;
  }
  if (raised.length > 0) {
    process.stderr.write(`${raised.join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`settings lints pass${lowered.length > 0 ? `; ${lowered.length} counts are below the baseline, run: node scripts/settings-lints.ts shrink` : ""}\n`);
}

if (process.argv[1]?.endsWith("settings-lints.ts")) main();
