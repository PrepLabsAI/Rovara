// The beta gate of #1478 phase 2, shown before any deploy: the model gateway stack made by CODE's CDK app has no resource change against the one Cloud's CDK app made.
// It synthesizes the gateway stack from two built trees (Cloud's, as today's pipeline makes it; Code's, as the phase 2 pipeline will) with the same settings, and compares the two
// templates. Everything but the Outputs must be equal; the Outputs may differ only by dropping DeployedCloudSha and adding DeployedCodeSha. Nothing here calls AWS.
//
//   node scripts/gateway-phase2-template-diff.ts --cloud-tree <built Cloud tree> --code-tree <built Code tree> --context <json file> --cloud-sha <40 hex> --code-sha <40 hex> [--out <dir>]
//
// <context json file>: the cdk context the pipeline passes for one environment (for example {"rovaraModelGateway":"beta","agentxRegion":"us-east-1",...}); both trees get the same
// context. Each tree must have its infra built (`npx tsc -b infra`). Exit 0: equal apart from the outputs. Exit 1: a difference (printed by name). Exit 2: usage or a failed synth.
// Node runs this file directly, so only erasable syntax.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const DROPPED_OUTPUTS: readonly string[] = ["DeployedCloudSha"];
export const ADDED_OUTPUT = "DeployedCodeSha";
const SHA40 = /^[0-9a-f]{40}$/u;
type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);

/** JSON with every object's keys sorted, so the same template compares equal whatever order its keys came in. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
const list = (names: readonly string[]): string => `${names.slice(0, 8).join(", ")}${names.length > 8 ? `, and ${names.length - 8} more` : ""}`;

export interface Comparison { failures: string[]; resources: number; outputsOnlyDifference: boolean }

/** What differs between two templates outside the Outputs, by section and name (empty when equal). */
function sectionDifferences(cloud: Json, code: Json): string[] {
  const failures: string[] = [];
  for (const section of new Set([...Object.keys(cloud), ...Object.keys(code)])) {
    if (section === "Outputs" || same(cloud[section], code[section])) continue;
    const a = cloud[section];
    const b = code[section];
    if (!isObject(a) || !isObject(b)) { failures.push(`section ${section} differs`); continue; }
    const added = Object.keys(b).filter((key) => !(key in a));
    const removed = Object.keys(a).filter((key) => !(key in b));
    const changed = Object.keys(a).filter((key) => key in b && !same(a[key], b[key]));
    if (added.length > 0) failures.push(`${section}: added ${list(added)}`);
    if (removed.length > 0) failures.push(`${section}: removed ${list(removed)}`);
    if (changed.length > 0) failures.push(`${section}: changed ${list(changed)}`);
  }
  return failures;
}

/** The Outputs may differ only by dropping DeployedCloudSha and adding DeployedCodeSha, which must name the Code commit. */
function outputDifferences(cloud: Json, code: Json, codeSha: string): string[] {
  const before = isObject(cloud.Outputs) ? cloud.Outputs : {};
  const after = isObject(code.Outputs) ? code.Outputs : {};
  const failures: string[] = [];
  for (const key of Object.keys(before).filter((name) => !(name in after) && !DROPPED_OUTPUTS.includes(name))) failures.push(`Outputs: ${key} goes`);
  for (const key of Object.keys(after).filter((name) => !(name in before) && name !== ADDED_OUTPUT)) failures.push(`Outputs: ${key} is new`);
  for (const key of Object.keys(before).filter((name) => name in after && !same(before[name], after[name]))) failures.push(`Outputs: ${key} changes`);
  const recorded = isObject(after[ADDED_OUTPUT]) ? after[ADDED_OUTPUT].Value : undefined;
  if (recorded !== codeSha) failures.push(`Outputs: ${ADDED_OUTPUT} is ${String(recorded)}, not the Code commit ${codeSha}`);
  return failures;
}

/** Cloud-made template against Code-made template: no difference outside the Outputs, and the Outputs differ only as the design allows. */
export function compareGatewayTemplates(cloud: unknown, code: unknown, codeSha: string): Comparison {
  if (!isObject(cloud) || !isObject(code)) return { failures: ["a template is not a JSON object"], resources: 0, outputsOnlyDifference: false };
  const sections = sectionDifferences(cloud, code);
  return { failures: [...sections, ...outputDifferences(cloud, code, codeSha)], resources: isObject(code.Resources) ? Object.keys(code.Resources).length : 0, outputsOnlyDifference: sections.length === 0 };
}

/** The gateway stack's template as one tree's CDK app makes it for a context. */
export function synthGateway(tree: string, context: Json, outDir: string): unknown {
  mkdirSync(outDir, { recursive: true });
  const run = spawnSync(process.execPath, ["infra/dist/bin/agentx.js"], { cwd: tree, encoding: "utf8", env: { ...process.env, CDK_OUTDIR: outDir, CDK_CONTEXT_JSON: JSON.stringify(context), AWS_ACCESS_KEY_ID: "", AWS_SECRET_ACCESS_KEY: "", AWS_SESSION_TOKEN: "" } });
  if (run.status !== 0) throw new Error(`the CDK app in ${tree} failed (exit ${run.status}): ${(run.stderr || run.stdout).split("\n").filter((line) => line !== "").slice(-3).join(" / ")}`);
  const file = readdirSync(outDir).find((name) => name === "RovaraModelGateway.template.json");
  if (file === undefined) throw new Error(`the CDK app in ${tree} made no RovaraModelGateway template`);
  return JSON.parse(readFileSync(join(outDir, file), "utf8")) as unknown;
}

/** `--name value` pairs; undefined on a malformed command line. */
function parseOptions(argv: string[]): Map<string, string> | undefined {
  const opts = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    const value = argv[i + 1];
    if (name === undefined || !name.startsWith("--") || value === undefined || opts.has(name)) return undefined;
    opts.set(name, value);
  }
  return opts;
}

function report(result: Comparison, context: Json, cloud: unknown, code: unknown): void {
  const keys = (template: unknown): string[] => Object.keys(isObject(template) && isObject(template.Outputs) ? template.Outputs : {}).sort();
  console.log(`gateway templates (${String(context.rovaraModelGateway)}): ${result.resources} resources in the Code-made template; sections other than Outputs ${result.outputsOnlyDifference ? "EQUAL" : "DIFFER"}`);
  console.log(`outputs: Cloud-made [${keys(cloud).join(", ")}]`);
  console.log(`outputs: Code-made  [${keys(code).join(", ")}]`);
  for (const failure of result.failures) console.log(`DIFFERENCE: ${failure}`);
  console.log(result.failures.length === 0 ? "RESULT: no resource change; only DeployedCloudSha is replaced by DeployedCodeSha" : "RESULT: the Code-made gateway differs from the Cloud-made one");
}

function main(argv: string[]): number {
  const opts = parseOptions(argv);
  if (opts === undefined) { console.error("usage: gateway-phase2-template-diff.ts --cloud-tree <dir> --code-tree <dir> --context <json file> --cloud-sha <sha> --code-sha <sha> [--out <dir>]"); return 2; }
  const need = (name: string): string => { const value = opts.get(name); if (value === undefined) throw new Error(`${name} is required`); return value; };
  try {
    const context = JSON.parse(readFileSync(need("--context"), "utf8")) as Json;
    const cloudSha = need("--cloud-sha");
    const codeSha = need("--code-sha");
    if (!SHA40.test(cloudSha) || !SHA40.test(codeSha)) throw new Error("--cloud-sha and --code-sha must be 40-hex commits");
    const out = opts.get("--out") ?? mkdtempSync(join(tmpdir(), "gateway-template-diff-"));
    const cloud = synthGateway(resolve(need("--cloud-tree")), { ...context, rovaraCloudSha: cloudSha }, join(out, "cloud"));
    const code = synthGateway(resolve(need("--code-tree")), { ...context, rovaraCodeSha: codeSha }, join(out, "code"));
    writeFileSync(join(out, "cloud.template.json"), `${JSON.stringify(cloud, null, 2)}\n`);
    writeFileSync(join(out, "code.template.json"), `${JSON.stringify(code, null, 2)}\n`);
    const result = compareGatewayTemplates(cloud, code, codeSha);
    report(result, context, cloud, code);
    return result.failures.length === 0 ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
