// Node detector: package.json scripts (test, lint, typecheck, build), the package manager's install command, and lockfiles.
import { awsClientCandidate, callArguments, candidate, gcpClientFamily, hardcodedEndpoint, isOwnedElsewhere, mergeCandidates, normalizeAwsService, scanDrivers, type DriverRule } from "./dependency-candidates.js";
import type { ProjectCommand } from "@agentx/contracts";
import { readsDatabaseSetting } from "./env-config.js";
import { detectNodeMajor, OFFERED_NODE, type NodeChoice } from "./node-version.js";
import { type DependencyCandidate, type Detection, type Detector, type DetectorContext, type Located, findLine } from "./types.js";

const LOCKS: ReadonlyArray<{ file: string; setup: [string, string[]] }> = [
  { file: "package-lock.json", setup: ["npm", ["ci"]] },
  { file: "pnpm-lock.yaml", setup: ["pnpm", ["install", "--frozen-lockfile"]] },
  { file: "yarn.lock", setup: ["yarn", ["install", "--frozen-lockfile"]] },
];
const SCRIPTS: ReadonlyArray<{ names: readonly string[]; id: string; label: string; kind: "test" | "lint" | "typecheck" | "build"; timeout: number }> = [
  { names: ["test", "test:unit"], id: "unit", label: "Tests", kind: "test", timeout: 1_800 },
  { names: ["lint"], id: "lint", label: "Lint", kind: "lint", timeout: 600 },
  { names: ["typecheck", "type-check", "tsc"], id: "typecheck", label: "Type check", kind: "typecheck", timeout: 900 },
  { names: ["build"], id: "build", label: "Build", kind: "build", timeout: 900 },
];

const detectNodeBuild: Detector = async ({ repo, cwd }) => {
  if (!repo.paths.includes("package.json")) return {};
  const text = await repo.read("package.json");
  if (text === undefined) return {};
  let scripts: Record<string, unknown> = {};
  let manifest: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text) as { scripts?: unknown };
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) manifest = parsed;
    if (parsed.scripts !== null && typeof parsed.scripts === "object" && !Array.isArray(parsed.scripts)) scripts = parsed.scripts as Record<string, unknown>;
  } catch {
    return { notes: ["package.json could not be read as JSON."] };
  }
  const found: Partial<Detection> = { setupCommands: [], checks: [], fullSuiteOn: [], notes: [] };
  const lock = LOCKS.find((candidate) => repo.paths.includes(candidate.file));
  if (lock !== undefined) {
    found.setupCommands!.push({ value: { cwd, executable: lock.setup[0], args: lock.setup[1], timeoutSeconds: 900 }, source: { path: lock.file, line: 1 } });
    found.fullSuiteOn!.push({ value: lock.file, source: "detector:node" });
  } else {
    found.setupCommands!.push({ value: { cwd, executable: "npm", args: ["install"], timeoutSeconds: 900 }, source: { path: "package.json", line: 1 } });
  }
  found.fullSuiteOn!.push({ value: "package.json", source: "detector:node" });
  const manager = lock?.setup[0] === "pnpm" ? "pnpm" : lock?.setup[0] === "yarn" ? "yarn" : "npm";
  for (const entry of SCRIPTS) {
    const name = entry.names.find((candidate) => typeof scripts[candidate] === "string" && (scripts[candidate]).trim() !== "");
    if (name === undefined) continue;
    const line = findLine(text, new RegExp(`"${name.replace(/[:]/gu, "\\:")}"\\s{0,40}:`, "u")) ?? 1;
    found.checks!.push({ value: { id: entry.id, label: entry.label, kind: entry.kind, command: { cwd, executable: manager, args: manager === "npm" ? ["run", name] : [name], timeoutSeconds: entry.timeout } }, source: { path: "package.json", line } });
  }
  // A script that fills the database (`seed`, `db:seed`, `seed:test`): not a check and never setup. The draft offers it as the database dependency's seed when a database is found (TS-UX-1).
  const seedName = Object.keys(scripts).find((name) => /^(?:db[:-])?seed(?:[:-]test)?$|^test[:-]seed$/u.test(name) && typeof scripts[name] === "string" && scripts[name].trim() !== "");
  if (seedName !== undefined) {
    const line = findLine(text, new RegExp(`"${seedName.replace(/[:]/gu, "\\:")}"\\s{0,40}:`, "u")) ?? 1;
    found.seedCommands = [{ value: { cwd, executable: manager, args: manager === "npm" ? ["run", seedName] : [seedName], timeoutSeconds: 900 }, source: { path: "package.json", line } }];
  }
  // The seed the database tools themselves know of (TS-UX-1 item 8), when no script names one: Prisma's `prisma.seed` config, a knex `seeds/` folder, sequelize's `seeders/` folder.
  if (found.seedCommands === undefined) {
    const tool = toolSeedCommand(manifest, repo.paths, text, cwd);
    if (tool !== undefined) found.seedCommands = [tool];
  }
  const databaseScripts = await databaseScriptsOf(scripts, repo);
  if (databaseScripts.length > 0) found.databaseScripts = databaseScripts;
  if (found.checks!.some((check) => check.value.kind === "test")) found.notes!.push("The test script writes no report file Rovara knows of; counts come from the exit code unless the maintainer sets a report path.");
  return found;
};

/** Programs that run one source file given as their first word that is not an option: the file is what the script does. */
const FILE_RUNNERS = new Set(["node", "tsx", "ts-node", "bun", "python", "python3"]);
const DATABASE_SCRIPTS_MAX = 16;

/**
 * TS-UX-1 item 7: the scripts whose program file reads a database setting. A script body is read as words; the first must be a file runner (`node`, `tsx`, `ts-node`, `bun`, `python`), and its first word that is not an
 * option must be a file in the repository, which is read (bounded by the reader) for a database setting. Anything else (a shell line, a runner of a tool, a file outside the list) is no evidence. Nothing is run.
 */
async function databaseScriptsOf(scripts: Record<string, unknown>, repo: DetectorContext["repo"]): Promise<Array<Located<string>>> {
  const out: Array<Located<string>> = [];
  for (const [name, body] of Object.entries(scripts).slice(0, 200)) {
    if (typeof body !== "string" || out.length >= DATABASE_SCRIPTS_MAX || /[|;&<>`$]/u.test(body)) continue;
    const words = body.trim().split(/\s+/u);
    if (!FILE_RUNNERS.has(words[0] ?? "")) continue;
    const file = words.slice(1).find((word) => !word.startsWith("-"))?.replace(/^\.\//u, "");
    if (file === undefined || !repo.paths.includes(file)) continue;
    const text = await repo.read(file);
    const reference = text === undefined ? undefined : readsDatabaseSetting(file, text);
    if (reference !== undefined) out.push({ value: name, source: { path: file, line: reference.line } });
  }
  return out;
}

/** Whether package.json lists a package among its dependencies of any kind. */
function lists(manifest: Record<string, unknown>, name: string): boolean {
  return ["dependencies", "devDependencies", "optionalDependencies"].some((key) => { const table = manifest[key]; return table !== null && typeof table === "object" && !Array.isArray(table) && Object.hasOwn(table, name); });
}

/**
 * The seed command a database tool runs, from its own config, cited at the line that names it: `npx prisma db seed` when package.json has `prisma.seed`, `npx knex seed:run` when knex is a dependency and a `seeds/`
 * folder holds a script, `npx sequelize-cli db:seed:all` when sequelize-cli is one and a `seeders/` folder holds a script. Undefined otherwise. Nothing is run.
 */
export function toolSeedCommand(manifest: Record<string, unknown>, paths: readonly string[], text: string, cwd: string): Located<ProjectCommand> | undefined {
  const prisma = manifest["prisma"];
  if (prisma !== null && typeof prisma === "object" && !Array.isArray(prisma) && typeof (prisma as Record<string, unknown>)["seed"] === "string") {
    return { value: { cwd, executable: "npx", args: ["prisma", "db", "seed"], timeoutSeconds: 900 }, source: { path: "package.json", line: findLine(text, /"prisma"\s{0,40}:/u) ?? 1 } };
  }
  const script = (folder: string) => paths.find((path) => new RegExp(`^(?:[^/]+/){0,2}${folder}/[^/]+\\.(?:[cm]?js|ts)$`, "u").test(path));
  const knex = lists(manifest, "knex") ? script("seeds") : undefined;
  if (knex !== undefined) return { value: { cwd, executable: "npx", args: ["knex", "seed:run"], timeoutSeconds: 900 }, source: { path: knex, line: 1 } };
  const sequelize = lists(manifest, "sequelize-cli") ? script("seeders") : undefined;
  if (sequelize !== undefined) return { value: { cwd, executable: "npx", args: ["sequelize-cli", "db:seed:all"], timeoutSeconds: 900 }, source: { path: sequelize, line: 1 } };
  return undefined;
}

// ---- dependencies (test services D4 manifests, D5 code)

const NODE_PACKAGES: Readonly<Record<string, string>> = {
  pg: "postgres", "pg-promise": "postgres", "pg-pool": "postgres", postgres: "postgres", slonik: "postgres",
  mysql: "mysql", mysql2: "mysql", mariadb: "mariadb",
  mongodb: "mongodb", mongoose: "mongodb",
  redis: "redis", ioredis: "redis", "@redis/client": "redis",
  kafkajs: "kafka", "node-rdkafka": "kafka", "@confluentinc/kafka-javascript": "kafka",
  amqplib: "rabbitmq", "amqp-connection-manager": "rabbitmq",
  "@elastic/elasticsearch": "elasticsearch", "@opensearch-project/opensearch": "opensearch",
  memcached: "memcached", memjs: "memcached", nodemailer: "smtp",
};
/** `@google-cloud/<name>`: a Google Cloud client library of the GCP pack (`@google-cloud/pubsub`, `@google-cloud/storage`, ...), or undefined. */
const nodeGoogleFamily = (name: string): string | undefined => {
  const short = /^@google-cloud\/([a-z0-9-]+)$/u.exec(name)?.[1];
  return short === undefined ? undefined : gcpClientFamily(short);
};
const AWS_SDK_V3 = /^@aws-sdk\/(?:client|lib|util)-([a-z0-9-]+)$/u;
const AWS_SDK_EXTRA: Readonly<Record<string, string>> = { "@aws-sdk/lib-storage": "s3", "@aws-sdk/s3-request-presigner": "s3", "@aws-sdk/s3-presigned-post": "s3" };

/** The service an `@aws-sdk/*` package belongs to (`client-s3`, `lib-dynamodb`, `util-dynamodb`), or undefined. */
function awsPackageService(name: string): string | undefined {
  const raw = AWS_SDK_EXTRA[name] ?? AWS_SDK_V3.exec(name)?.[1];
  if (raw === undefined) return undefined;
  const id = normalizeAwsService(raw, "js");
  return id === undefined || ["crypto", "types", "retry", "utils"].includes(id) || isOwnedElsewhere(`aws:${id}`) ? undefined : id;
}

/** Candidates for the drivers and AWS SDK clients package.json lists (dependencies of every kind). Strength `mentioned`. */
export async function nodeManifestCandidates(repo: DetectorContext["repo"]): Promise<DependencyCandidate[]> {
  const found: DependencyCandidate[] = [];
  for (const path of repo.paths.filter((candidatePath) => candidatePath === "package.json" || /^(?:packages|apps|services)\/[^/]+\/package\.json$/u.test(candidatePath)).slice(0, 20)) {
    const text = await repo.read(path);
    if (text === undefined) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { continue; }
    for (const key of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      const table = (parsed as Record<string, unknown> | null)?.[key];
      if (table === null || typeof table !== "object" || Array.isArray(table)) continue;
      for (const name of Object.keys(table).slice(0, 500)) {
        const family = Object.hasOwn(NODE_PACKAGES, name) ? NODE_PACKAGES[name] : nodeGoogleFamily(name);
        const service = awsPackageService(name);
        const resolved = family ?? (service === undefined ? undefined : `aws:${service}`);
        if (resolved !== undefined) found.push(candidate(resolved, "mentioned", { path, line: findLine(text, new RegExp(`"${name.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&")}"\\s{0,40}:`, "u")) ?? 1 }, { seenBy: ["driver"] }));
      }
    }
  }
  return mergeCandidates(found);
}

const NODE_IMPORT = (names: string): RegExp => new RegExp(`(?:from\\s{1,40}|require\\(\\s{0,120}|import\\(\\s{0,120})["'](?:${names})["']`, "u");
export const NODE_DRIVERS: readonly DriverRule[] = [
  { family: "postgres", uses: NODE_IMPORT("pg|pg-promise|pg-pool|postgres|slonik"), call: /\bnew\s{1,40}(?:Pool|Client)\s{0,120}\(|\bpgp\s{0,120}\(|\bpostgres\s{0,120}\(|\bcreatePool\s{0,120}\(/u },
  { family: "mysql", uses: NODE_IMPORT("mysql2?(?:/promise)?"), call: /\bcreate(?:Connection|Pool|PoolCluster)\s{0,120}\(/u },
  { family: "mariadb", uses: NODE_IMPORT("mariadb"), call: /\bcreate(?:Connection|Pool)\s{0,120}\(/u },
  { family: "redis", uses: NODE_IMPORT("redis|ioredis|@redis/client"), call: /\bcreateClient\s{0,120}\(|\bnew\s{1,40}(?:Redis|IORedis|Cluster)\s{0,120}\(/u },
  { family: "mongodb", uses: NODE_IMPORT("mongodb|mongoose"), call: /\bnew\s{1,40}MongoClient\s{0,120}\(|\bmongoose\.(?:connect|createConnection)\s{0,120}\(/u },
  { family: "kafka", uses: NODE_IMPORT("kafkajs|node-rdkafka|@confluentinc/kafka-javascript"), call: /\bnew\s{1,40}Kafka\s{0,120}\(/u },
  { family: "rabbitmq", uses: NODE_IMPORT("amqplib|amqp-connection-manager"), call: /\bamqp(?:lib)?\.connect\s{0,120}\(|\bconnect\s{0,120}\(/u },
  { family: "elasticsearch", uses: NODE_IMPORT("@elastic/elasticsearch"), call: /\bnew\s{1,40}Client\s{0,120}\(/u },
  { family: "opensearch", uses: NODE_IMPORT("@opensearch-project/opensearch"), call: /\bnew\s{1,40}Client\s{0,120}\(/u },
  { family: "memcached", uses: NODE_IMPORT("memcached|memjs"), call: /\bnew\s{1,40}Memcached\s{0,120}\(|\bMemcached\.create\s{0,120}\(|\bClient\.create\s{0,120}\(/u },
  // The GCP pack (L4-E8): each client class, built with a string `apiEndpoint` / `servicePath`, is flagged as a hard-coded endpoint.
  { family: "pubsub", uses: NODE_IMPORT("@google-cloud/pubsub"), call: /\bnew\s{1,40}PubSub\s{0,120}\(/u },
  { family: "firestore", uses: NODE_IMPORT("@google-cloud/firestore"), call: /\bnew\s{1,40}Firestore\s{0,120}\(/u },
  { family: "datastore", uses: NODE_IMPORT("@google-cloud/datastore"), call: /\bnew\s{1,40}Datastore\s{0,120}\(/u },
  { family: "bigtable", uses: NODE_IMPORT("@google-cloud/bigtable"), call: /\bnew\s{1,40}Bigtable\s{0,120}\(/u },
  { family: "spanner", uses: NODE_IMPORT("@google-cloud/spanner"), call: /\bnew\s{1,40}Spanner\s{0,120}\(/u },
  { family: "gcs", uses: NODE_IMPORT("@google-cloud/storage"), call: /\bnew\s{1,40}Storage\s{0,120}\(/u },
  { family: "bigquery", uses: NODE_IMPORT("@google-cloud/bigquery"), call: /\bnew\s{1,40}BigQuery\s{0,120}\(/u },
];

/** AWS SDK clients (v3 imports, v2 `new AWS.S3(...)`) and drivers a JavaScript or TypeScript file uses (test services D5). An `endpoint` written as a string is flagged. */
export function nodeCodeCandidates(path: string, text: string): DependencyCandidate[] {
  const found = scanDrivers(path, text, NODE_DRIVERS);
  const clients = [...text.matchAll(/\bnew\s{1,40}([A-Za-z0-9]+)Client\s{0,120}\(/gu)].map((match) => ({ name: match[1]!.toLowerCase(), explicit: hardcodedEndpoint(callArguments(text, text.indexOf("(", match.index + match[0].length - 1))) }));
  for (const match of text.matchAll(/(?:from\s{1,40}|require\(\s{0,120}|import\(\s{0,120})["']@aws-sdk\/(?:client|lib)-([a-z0-9-]+)["']/gu)) {
    const id = normalizeAwsService(match[1]!, "js");
    const explicit = id !== undefined && clients.some((client) => client.explicit && (client.name === id.replace(/-/gu, "") || client.name.startsWith(id.replace(/-/gu, ""))));
    const item = awsClientCandidate(path, text, match.index, match[1]!, explicit, "js");
    if (item !== undefined) found.push(item);
  }
  if (/\baws-sdk\b/u.test(text)) {
    for (const match of text.matchAll(/\bnew\s{1,40}AWS\.([A-Za-z0-9]+)\s{0,120}\(/gu)) {
      const item = awsClientCandidate(path, text, match.index, match[1]!, hardcodedEndpoint(callArguments(text, text.indexOf("(", match.index))), "cfn");
      if (item !== undefined) found.push(item);
    }
  }
  return found;
}

/** The folders that may carry a Node hint, root first: the same files the runtime reads per cwd (node-runtime.ts), at most 20 folders, none inside a dependency or build folder. */
function nodeHintFolders(paths: readonly string[]): string[] {
  const found = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/");
    const name = parts.pop()!;
    if (!NODE_HINT_FILES.has(name) || parts.some((part) => NODE_SKIPPED_FOLDERS.has(part))) continue;
    found.add(parts.join("/"));
  }
  return [...found].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b)).slice(0, 20);
}
const NODE_HINT_FILES: ReadonlySet<string> = new Set([".nvmrc", ".node-version", ".tool-versions", "package.json"]);
const NODE_SKIPPED_FOLDERS: ReadonlySet<string> = new Set(["node_modules", "vendor", "dist", "build", "testdata", "fixtures"]);

/**
 * Lane E: which Node the repository's own files ask for (node-version.ts), per folder, by the same rule the runtime uses for a command's cwd (the nearest folder with a hint decides). Said only when it matters: a
 * folder that needs Node 24, a folder that keeps the default where the root asks for 24, or a Node the image does not carry.
 */
async function nodeVersionNotes(repo: DetectorContext["repo"]): Promise<string[]> {
  const notes: string[] = [];
  let rootMajor: number | undefined;
  for (const folder of nodeHintFolders(repo.paths)) {
    const choice = await detectNodeMajor(repo, folder);
    notes.push(...choice.notes);
    if (!choice.hinted) continue;
    if (folder === "") rootMajor = choice.major;
    const note = folderNodeNote(folder, choice, rootMajor);
    if (note !== undefined) notes.push(note);
  }
  return notes;
}

/** The sentence for one folder with a hint, or undefined when there is nothing worth saying (see nodeVersionNotes). */
function folderNodeNote(folder: string, choice: NodeChoice, rootMajor: number | undefined): string | undefined {
  const [, other] = OFFERED_NODE;
  const source = choice.source === undefined || typeof choice.source === "string" ? "" : ` (${choice.source.path} line ${String(choice.source.line)})`;
  if (choice.major === other.major) {
    return folder === ""
      ? `This repository asks for Node ${String(other.major)}${source}; its commands run with Node ${String(other.major)} instead of the default.`
      : `In ${folder}, this repository asks for Node ${String(other.major)}${source}; commands run there use Node ${String(other.major)} instead of the default.`;
  }
  if (folder !== "" && rootMajor === other.major) return `In ${folder}, the files ask for the default Node${source}; commands run there use Node ${String(choice.major)}, not the Node ${String(other.major)} the repository root asks for.`;
  return undefined;
}

export const detectNode: Detector = async (context) => {
  const found = await detectNodeBuild(context);
  const dependencies = await nodeManifestCandidates(context.repo);
  const versionNotes = await nodeVersionNotes(context.repo);
  const withNotes = versionNotes.length === 0 ? found : { ...found, notes: [...(found.notes ?? []), ...versionNotes] };
  return dependencies.length === 0 ? withNotes : { ...withNotes, dependencies };
};
