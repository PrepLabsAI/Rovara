// Generates the table of the AWS services the local AWS emulator engine serves, from the engine's own Smithy models and its fidelity scores.
//
//   node scripts/aws-emulator/gen-service-table.ts --engine-src <emulator source checkout> --scores <scores.json.gz | scores.json> [--out <dir>] [--check]
//
// Writes three files into `--out` (default `packages/contracts/src/generated`):
//   aws-emulator-services.ts           the table, browser-safe (no import), one row per service
//   aws-emulator-services.json         the same table as plain JSON, for a program that is not TypeScript
//   aws-emulator-not-implemented.json  per service, the operations that answer NotImplemented (kept out of browser bundles: nothing imports it)
// `--check` writes nothing and exits 1 when a file differs from what would be written.
//
// The input is pinned: the engine release, its commit, and the sha256 of the scores file. A different scores file, or a scores file of another
// commit, is refused. The output is a pure function of the inputs (sorted, no clock, no path), so a second run is byte-identical.
//
// Node runs this file directly, so only erasable syntax and only Node's own modules.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

export const ENGINE_NAME = "aws-emulator";
export const ENGINE_VERSION = "1.0.322";
export const ENGINE_COMMIT = "7753983c6e495ec3612695b1336bf4936fc7b7fd";
/** sha256 of the scores file as released (gzip) and of the same file unzipped. */
export const SCORES_SHA256_GZ = "eca6d69bfa6e801d224f88dd47907ef1573002161e57d1b092de655db77e08cd";
export const SCORES_SHA256_JSON = "9aaa34569c5701fa33c706784354eff0d418e616058df99e0e1fc0b749def290";
export const SCORES_SCHEMA_VERSION = 1;

const SERVICE_KEY = /^[a-z][a-z0-9-]{1,39}$/u;
const HERE = dirname(fileURLToPath(import.meta.url));

// ---- input shapes

export interface SmithyService {
  type: string;
  version?: string;
  operations?: Array<{ target: string }>;
  resources?: Array<{ target: string }>;
  traits?: Record<string, unknown>;
}
interface SmithyResource {
  type: string;
  operations?: Array<{ target: string }>;
  collectionOperations?: Array<{ target: string }>;
  resources?: Array<{ target: string }>;
  create?: { target: string };
  read?: { target: string };
  update?: { target: string };
  delete?: { target: string };
  list?: { target: string };
  put?: { target: string };
}
export interface SmithyModel { shapes: Record<string, SmithyService | SmithyResource | { type: string }> }

/** What the reader finds for one service of the engine's source tree. */
export interface ServiceSource {
  /** The crate folder name; used only in error messages. */
  dir: string;
  model: SmithyModel;
  /** Operations whose source file carries the "SCAFFOLDED, NOT IMPLEMENTED" marker. */
  scaffoldedOps: string[];
  /** Operations listed as skipped in the service's skipped-stubs file and with no source file: modelled, never wired. */
  unwiredOps: string[];
}

export interface ScoreUnit { unitId: string; kind: "behavioral" | "wire"; outcome: "pass" | "fail" | "skipped"; services: string[] }
export interface ScoresFile { commit: string; schemaVersion: number; scoredAt: string; units: ScoreUnit[] }

export interface Overrides {
  /** alias -> key */
  legacyKeys: Readonly<Record<string, string>>;
  /** key -> boto3 client name */
  boto3Names: Readonly<Record<string, string>>;
}

// ---- output shapes

export interface ServiceRow {
  key: string;
  smithyId: string;
  sdkId: string;
  envKey: string;
  signingName: string | null;
  endpointPrefix: string | null;
  cfnName: string | null;
  protocols: string[];
  targetPrefix: string | null;
  queryVersion: string | null;
  jsPackage: string;
  goPackage: string;
  javaPackage: string;
  boto3Name: string;
  opCount: number;
  notImplementedCount: number;
  unwiredCount: number;
  behavioralScore: number | null;
  behavioralUnits: number;
  /** The behavioral score over the units that name this service alone (the figure comparable to a per-suite score). */
  behavioralOwnScore: number | null;
  behavioralOwnUnits: number;
  wireScore: number | null;
  wireUnits: number;
  legacyKeys: string[];
}

export interface TableOutput {
  rows: ServiceRow[];
  /** key -> { notImplemented, unwired } (only services that have any). */
  notImplemented: Record<string, { notImplemented: string[]; unwired: string[] }>;
  /** Signing name -> keys, for every signing name more than one service uses. */
  sharedSigningNames: Record<string, string[]>;
  scoresSha256: string;
}

// ---- build

const sorted = (values: Iterable<string>): string[] => [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const fail = (message: string): never => { throw new Error(`gen-service-table: ${message}`); };

/** The id of the one service shape of a model, and the shape. */
export function serviceShapeOf(model: SmithyModel, dir: string): { id: string; service: SmithyService } {
  const found = Object.entries(model.shapes).filter(([, shape]) => shape.type === "service");
  if (found.length !== 1) return fail(`${dir}: expected one service shape, found ${String(found.length)}`);
  const [id, shape] = found[0]!;
  return { id, service: shape };
}

/** The names of every operation the service binds: its own, and those of its resources (recursively). */
export function boundOperations(model: SmithyModel, service: SmithyService): string[] {
  const names = new Set<string>();
  const seen = new Set<string>();
  const nameOf = (target: string): string => target.slice(target.indexOf("#") + 1);
  const walk = (resource: SmithyResource) => {
    for (const operation of [...(resource.operations ?? []), ...(resource.collectionOperations ?? [])]) names.add(nameOf(operation.target));
    for (const lifecycle of [resource.create, resource.read, resource.update, resource.delete, resource.list, resource.put]) if (lifecycle !== undefined) names.add(nameOf(lifecycle.target));
    for (const child of resource.resources ?? []) {
      if (seen.has(child.target)) continue;
      seen.add(child.target);
      walk(model.shapes[child.target] as SmithyResource);
    }
  };
  for (const operation of service.operations ?? []) names.add(nameOf(operation.target));
  walk({ resources: service.resources ?? [] } as SmithyResource);
  return sorted(names);
}

/** Passed over passed-plus-failed, to four places; skipped units count in neither. */
function scoreOf(pass: number, failed: number): number | null {
  return pass + failed === 0 ? null : Math.round((pass / (pass + failed)) * 10_000) / 10_000;
}

interface Tally { behavioral: { pass: number; fail: number }; behavioralOwn: { pass: number; fail: number }; wire: { pass: number; fail: number } }

export function tallyScores(scores: ScoresFile): Map<string, Tally> {
  const tallies = new Map<string, Tally>();
  for (const unit of scores.units) {
    if (unit.outcome === "skipped") continue;
    for (const smithyId of new Set(unit.services)) {
      const tally = tallies.get(smithyId) ?? { behavioral: { pass: 0, fail: 0 }, behavioralOwn: { pass: 0, fail: 0 }, wire: { pass: 0, fail: 0 } };
      tally[unit.kind][unit.outcome] += 1;
      if (unit.kind === "behavioral" && new Set(unit.services).size === 1) tally.behavioralOwn[unit.outcome] += 1;
      tallies.set(smithyId, tally);
    }
  }
  return tallies;
}

export function buildTable(sources: readonly ServiceSource[], scores: ScoresFile, scoresSha256: string, overrides: Overrides): TableOutput {
  const tallies = tallyScores(scores);
  const rows: ServiceRow[] = [];
  const unsorted: TableOutput["notImplemented"] = {};
  for (const source of sources) {
    const { id: smithyId, service } = serviceShapeOf(source.model, source.dir);
    const traits = service.traits ?? {};
    const info = traits["aws.api#service"] as { sdkId?: string; endpointPrefix?: string; cloudFormationName?: string } | undefined;
    if (info?.sdkId === undefined) return fail(`${source.dir}: no aws.api#service sdkId`);
    const sdkId = info.sdkId;
    if (!/^[A-Za-z0-9 ]+$/u.test(sdkId)) return fail(`${source.dir}: unexpected characters in sdkId`);
    const envKey = sdkId.toUpperCase().replace(/ /gu, "_");
    const key = envKey.toLowerCase().replace(/_/gu, "-");
    if (!SERVICE_KEY.test(key)) return fail(`${source.dir}: key ${key} is not a plannable service id`);
    const signing = traits["aws.auth#sigv4"] as { name?: string } | undefined;
    const protocols = sorted(Object.keys(traits).filter((trait) => trait.startsWith("aws.protocols#") || trait.startsWith("smithy.protocols#")).map((trait) => trait.slice(trait.indexOf("#") + 1)));
    const operations = new Set(boundOperations(source.model, service));
    for (const name of [...source.scaffoldedOps, ...source.unwiredOps]) if (!operations.has(name)) return fail(`${source.dir}: ${name} is not an operation of the model`);
    const tally = tallies.get(smithyId);
    const flat = sdkId.toLowerCase().replace(/ /gu, "");
    rows.push({
      key,
      smithyId,
      sdkId,
      envKey,
      signingName: signing?.name ?? null,
      endpointPrefix: info.endpointPrefix ?? null,
      cfnName: info.cloudFormationName ?? null,
      protocols,
      targetPrefix: protocols.includes("awsJson1_0") || protocols.includes("awsJson1_1") ? smithyId.slice(smithyId.indexOf("#") + 1) : null,
      queryVersion: (protocols.includes("awsQuery") || protocols.includes("ec2Query")) && service.version !== undefined ? service.version : null,
      jsPackage: `@aws-sdk/client-${key}`,
      goPackage: `github.com/aws/aws-sdk-go-v2/service/${flat}`,
      javaPackage: `software.amazon.awssdk.services.${flat}`,
      boto3Name: overrides.boto3Names[key] ?? key,
      opCount: operations.size,
      notImplementedCount: new Set(source.scaffoldedOps).size,
      unwiredCount: new Set(source.unwiredOps).size,
      behavioralScore: tally === undefined ? null : scoreOf(tally.behavioral.pass, tally.behavioral.fail),
      behavioralUnits: tally === undefined ? 0 : tally.behavioral.pass + tally.behavioral.fail,
      behavioralOwnScore: tally === undefined ? null : scoreOf(tally.behavioralOwn.pass, tally.behavioralOwn.fail),
      behavioralOwnUnits: tally === undefined ? 0 : tally.behavioralOwn.pass + tally.behavioralOwn.fail,
      wireScore: tally === undefined ? null : scoreOf(tally.wire.pass, tally.wire.fail),
      wireUnits: tally === undefined ? 0 : tally.wire.pass + tally.wire.fail,
      legacyKeys: sorted(Object.entries(overrides.legacyKeys).filter(([, target]) => target === key).map(([alias]) => alias)),
    });
    if (source.scaffoldedOps.length > 0 || source.unwiredOps.length > 0) unsorted[key] = { notImplemented: sorted(new Set(source.scaffoldedOps)), unwired: sorted(new Set(source.unwiredOps)) };
  }
  rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const notImplemented: TableOutput["notImplemented"] = {};
  for (const key of sorted(Object.keys(unsorted))) notImplemented[key] = unsorted[key]!;

  const unique = (what: string, values: string[]) => { if (new Set(values).size !== values.length) fail(`${what} is not unique`); };
  unique("key", rows.map((row) => row.key));
  unique("envKey", rows.map((row) => row.envKey));
  unique("smithyId", rows.map((row) => row.smithyId));
  const keys = new Set(rows.map((row) => row.key));
  for (const [alias, target] of Object.entries(overrides.legacyKeys)) {
    if (!keys.has(target)) fail(`legacy key ${alias} points at ${target}, which is not a key`);
    if (keys.has(alias)) fail(`legacy key ${alias} is a key of the table already`);
    if (!SERVICE_KEY.test(alias)) fail(`legacy key ${alias} is not a service id`);
  }
  for (const key of Object.keys(overrides.boto3Names)) if (!keys.has(key)) fail(`boto3 override for ${key}, which is not a key`);
  const known = new Set(rows.map((row) => row.smithyId));
  const stray = sorted(new Set(scores.units.flatMap((unit) => unit.services)).values()).filter((id) => !known.has(id));
  if (stray.length > 0) fail(`the scores name ${String(stray.length)} service(s) that are not in the engine: ${stray.slice(0, 5).join(", ")}`);

  const bySigning = new Map<string, string[]>();
  for (const row of rows) if (row.signingName !== null) bySigning.set(row.signingName, [...(bySigning.get(row.signingName) ?? []), row.key]);
  const sharedSigningNames: Record<string, string[]> = {};
  for (const name of sorted(bySigning.keys())) if (bySigning.get(name)!.length > 1) sharedSigningNames[name] = bySigning.get(name)!;
  return { rows, notImplemented, sharedSigningNames, scoresSha256 };
}

// ---- render

const HEADER_FORMULA = [
  "Scores: behavioralScore = passed / (passed + failed) over the behavioral units of the release's scores whose `services` list names this",
  "service; wireScore is the same over the wire units. A unit that names several services counts for each of them. Skipped units count in",
  "neither the score nor the unit count. behavioralUnits and wireUnits are passed + failed. A score is null when there are no such units.",
  "behavioralOwnScore is the behavioral score over only the units that name this service alone (behavioralOwnUnits of them): a cross-service",
  "scenario that fails on another service's gap lowers behavioralScore of every service it names, and not this one.",
  "Scores are fractions between 0 and 1, rounded to four places.",
];

function metaLines(output: TableOutput): string[] {
  return [
    `Engine: ${ENGINE_NAME}@${ENGINE_VERSION}`,
    `Engine commit: ${ENGINE_COMMIT}`,
    `Scores sha256: ${output.scoresSha256}`,
    `Services: ${String(output.rows.length)}`,
  ];
}

export function renderTypeScript(output: TableOutput): string {
  const rows = output.rows.map((row) => `  ${JSON.stringify(row)},`).join("\n");
  const shared = Object.entries(output.sharedSigningNames).map(([name, keys]) => `  ${JSON.stringify(name)}: ${JSON.stringify(keys)},`).join("\n");
  return `// GENERATED by scripts/aws-emulator/gen-service-table.ts. Do not edit; change the generator or its inputs and run it again.
//
// ${metaLines(output).join("\n// ")}
//
// One row per AWS service the engine serves, read from the engine's Smithy models. Columns that the models do not carry are null.
//   key            the SDK's endpoint-variable name, lower-case, with "_" as "-": the one id a plan uses (legacyKeys are older spellings, read on input, never written)
//   envKey         the suffix of AWS_ENDPOINT_URL_<envKey>
//   signingName    the SigV4 signing name; many services share one (see AWS_EMULATOR_SHARED_SIGNING_NAMES); null when the model has no SigV4 trait
//   protocols      the protocol traits of the model, sorted; targetPrefix is the X-Amz-Target prefix of an awsJson service; queryVersion the Version of an awsQuery/ec2Query service
//   jsPackage, goPackage, javaPackage, boto3Name   derived from the SDK id (boto3Name has a checked-in list of exceptions)
//   opCount        operations the model binds; notImplementedCount operations that answer NotImplemented; unwiredCount operations the model has and the engine does not route
// ${HEADER_FORMULA.join("\n// ")}
//
// Browser-safe: no import.

export const AWS_EMULATOR_ENGINE_NAME = ${JSON.stringify(ENGINE_NAME)};
export const AWS_EMULATOR_ENGINE_VERSION = ${JSON.stringify(ENGINE_VERSION)};
export const AWS_EMULATOR_ENGINE = ${JSON.stringify(`${ENGINE_NAME}@${ENGINE_VERSION}`)};
export const AWS_EMULATOR_ENGINE_COMMIT = ${JSON.stringify(ENGINE_COMMIT)};
export const AWS_EMULATOR_SCORES_SHA256 = ${JSON.stringify(output.scoresSha256)};

export interface AwsEmulatorServiceRow {
  readonly key: string;
  readonly smithyId: string;
  readonly sdkId: string;
  readonly envKey: string;
  readonly signingName: string | null;
  readonly endpointPrefix: string | null;
  readonly cfnName: string | null;
  readonly protocols: readonly string[];
  readonly targetPrefix: string | null;
  readonly queryVersion: string | null;
  readonly jsPackage: string;
  readonly goPackage: string;
  readonly javaPackage: string;
  readonly boto3Name: string;
  readonly opCount: number;
  readonly notImplementedCount: number;
  readonly unwiredCount: number;
  readonly behavioralScore: number | null;
  readonly behavioralUnits: number;
  readonly behavioralOwnScore: number | null;
  readonly behavioralOwnUnits: number;
  readonly wireScore: number | null;
  readonly wireUnits: number;
  readonly legacyKeys: readonly string[];
}

export const AWS_EMULATOR_SERVICES: readonly AwsEmulatorServiceRow[] = [
${rows}
];

/** Signing names that more than one service uses: a request signed for one of these cannot be told apart by its credential scope alone. */
export const AWS_EMULATOR_SHARED_SIGNING_NAMES: Readonly<Record<string, readonly string[]>> = {
${shared}
};
`;
}

export function renderTableJson(output: TableOutput): string {
  const head = JSON.stringify({ engine: `${ENGINE_NAME}@${ENGINE_VERSION}`, engineCommit: ENGINE_COMMIT, scoresSha256: output.scoresSha256, schemaVersion: 1 });
  const rows = output.rows.map((row) => `    ${JSON.stringify(row)}`).join(",\n");
  return `${head.slice(0, -1)},\n  "services": [\n${rows}\n  ],\n  "sharedSigningNames": ${JSON.stringify(output.sharedSigningNames)}\n}\n`;
}

export function renderNotImplementedJson(output: TableOutput): string {
  const services = Object.entries(output.notImplemented).map(([key, value]) => `    ${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(",\n");
  return `{\n  "engine": ${JSON.stringify(`${ENGINE_NAME}@${ENGINE_VERSION}`)},\n  "engineCommit": ${JSON.stringify(ENGINE_COMMIT)},\n  "schemaVersion": 1,\n  "services": {\n${services}\n  }\n}\n`;
}

export const OUTPUT_FILES = { typescript: "aws-emulator-services.ts", table: "aws-emulator-services.json", notImplemented: "aws-emulator-not-implemented.json" } as const;

export function renderAll(output: TableOutput): Record<(typeof OUTPUT_FILES)[keyof typeof OUTPUT_FILES], string> {
  return {
    [OUTPUT_FILES.typescript]: renderTypeScript(output),
    [OUTPUT_FILES.table]: renderTableJson(output),
    [OUTPUT_FILES.notImplemented]: renderNotImplementedJson(output),
  };
}

// ---- read

/** Reads the engine's source tree: each `services/service-*` folder with a model. */
export function readServiceSources(engineSrc: string): ServiceSource[] {
  const servicesDir = join(engineSrc, "services");
  const sources: ServiceSource[] = [];
  for (const dir of readdirSync(servicesDir).filter((name) => name.startsWith("service-")).sort()) {
    const modelDir = join(servicesDir, dir, "smithy-model");
    if (!existsSync(modelDir)) continue;
    // The folder may also hold a "local-reported" profile file: not the service's model.
    const models = readdirSync(modelDir).filter((name) => name.endsWith(".json") && !name.startsWith("local-reported"));
    if (models.length !== 1) fail(`${dir}: expected one model file, found ${String(models.length)}`);
    const model = JSON.parse(readFileSync(join(modelDir, models[0]!), "utf8")) as SmithyModel;
    const opsDir = join(servicesDir, dir, "src", "ops");
    const withFile = new Set<string>();
    const scaffoldedOps: string[] = [];
    if (existsSync(opsDir)) {
      for (const file of readdirSync(opsDir).filter((name) => name.endsWith(".rs") && name !== "mod.rs")) {
        const text = readFileSync(join(opsDir, file), "utf8");
        const operation = /^\/\/! @op (\w+)/mu.exec(text)?.[1];
        if (operation === undefined) { fail(`${dir}/${file}: no @op line`); continue; }
        withFile.add(operation);
        if (/^\/\/! SCAFFOLDED, NOT IMPLEMENTED:/mu.test(text)) scaffoldedOps.push(operation);
      }
    }
    const skippedFile = join(opsDir, "SKIPPED_STUBS.md");
    const skipped = existsSync(skippedFile) ? [...readFileSync(skippedFile, "utf8").matchAll(/^\/\/ SKIPPED: (\w+)/gmu)].map((match) => match[1]!) : [];
    sources.push({ dir, model, scaffoldedOps, unwiredOps: skipped.filter((name) => !withFile.has(name)) });
  }
  return sources;
}

/** Reads the scores file (gzip or plain JSON) and refuses one that is not the pinned release. */
export function readScores(path: string): { scores: ScoresFile; sha256: string } {
  const bytes = readFileSync(path);
  const gzip = path.endsWith(".gz");
  const actual = sha256(bytes);
  if (actual !== (gzip ? SCORES_SHA256_GZ : SCORES_SHA256_JSON)) return fail(`the scores file is not the pinned release (sha256 ${actual})`);
  const scores = JSON.parse((gzip ? gunzipSync(bytes) : bytes).toString("utf8")) as ScoresFile;
  if (scores.commit !== ENGINE_COMMIT) return fail("the scores are of another engine commit");
  if (scores.schemaVersion !== SCORES_SCHEMA_VERSION) return fail("the scores have an unknown schema version");
  return { scores, sha256: SCORES_SHA256_JSON };
}

export function readOverrides(directory: string = HERE): Overrides {
  const legacy = JSON.parse(readFileSync(join(directory, "legacy-keys.json"), "utf8")) as { aliases: Record<string, string> };
  const boto3 = JSON.parse(readFileSync(join(directory, "boto3-names.json"), "utf8")) as { names: Record<string, string> };
  return { legacyKeys: legacy.aliases, boto3Names: boto3.names };
}

function checkEngineCheckout(engineSrc: string): void {
  let head: string | undefined;
  try {
    head = execFileSync("git", ["-C", engineSrc, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    head = undefined;
  }
  if (head !== undefined && head !== ENGINE_COMMIT) fail(`the engine checkout is at ${head}, not the pinned commit`);
}

// ---- command line

function main(argv: string[]): number {
  const args = new Map<string, string>();
  let check = false;
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]!;
    if (name === "--check") { check = true; continue; }
    const value = argv[index + 1];
    if (!["--engine-src", "--scores", "--out"].includes(name) || value === undefined || args.has(name)) throw new Error("usage: node scripts/aws-emulator/gen-service-table.ts --engine-src DIR --scores FILE [--out DIR] [--check]");
    args.set(name, value);
    index += 1;
  }
  const engineSrc = args.get("--engine-src");
  const scoresPath = args.get("--scores");
  if (engineSrc === undefined || scoresPath === undefined) throw new Error("usage: node scripts/aws-emulator/gen-service-table.ts --engine-src DIR --scores FILE [--out DIR] [--check]");
  const out = resolve(args.get("--out") ?? join(HERE, "..", "..", "packages", "contracts", "src", "generated"));
  checkEngineCheckout(resolve(engineSrc));
  const { scores, sha256: scoresSha256 } = readScores(resolve(scoresPath));
  const output = buildTable(readServiceSources(resolve(engineSrc)), scores, scoresSha256, readOverrides());
  const files = renderAll(output);
  let differs = false;
  mkdirSync(out, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    const path = join(out, name);
    if (check) {
      if (!existsSync(path) || readFileSync(path, "utf8") !== text) { differs = true; process.stderr.write(`differs: ${name}\n`); }
    } else writeFileSync(path, text);
  }
  process.stdout.write(`${check ? (differs ? "out of date" : "up to date") : "written"}: ${String(output.rows.length)} services, ${String(output.rows.filter((row) => row.behavioralScore !== null).length)} with a behavioral score\n`);
  return differs ? 1 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
