// Shared helpers of the dependency detectors (test services D1-D7): the image/driver name tables, safe names, and the merge that turns many sightings of one family into one candidate.
// Everything a detector puts in a candidate is a family id, a kind, a fixed word, a number or an environment variable NAME. A value read from a file (a password, a host, a token) is never copied.
import { awsSeededKinds, awsServiceKeyFromSdkName, awsEmulatorServiceRow, looksLikeSecretValue, normaliseAwsServiceKey, type AwsSdkNameKind, type TestEnvDependencyKind } from "@agentx/contracts";
import { DEPENDENCY_REFUSED_FIELDS, type DependencyCandidate, type DependencyEvidence, type DependencyHints, type DependencyStrength } from "./types.js";

export const MAX_EVIDENCE = 8;
export const MAX_CANDIDATES = 64;
const MAX_NAMES = 16;
const MAX_PORTS = 8;
const MAX_INIT_FILES = 4;
export const MAX_RESOURCES = 24;
const STRENGTH_RANK: Record<DependencyStrength, number> = { declared: 3, used: 2, mentioned: 1 };

/** What each recognised family is. The family id is the catalog's: one entry per software, with every image or driver that stands for it listed in the tables below. */
export const FAMILY_KINDS: Readonly<Record<string, TestEnvDependencyKind>> = {
  postgres: "database", mysql: "database", mariadb: "database", mongodb: "database", redis: "cache", memcached: "cache", rabbitmq: "queue", kafka: "stream", elasticsearch: "search", opensearch: "search", smtp: "email",
};

export function kindOfFamily(family: string): TestEnvDependencyKind {
  if (family.startsWith("aws:")) {
    // A legacy spelling (`cognito-idp`, `es`) is read as the key of the table.
    const service = normaliseAwsServiceKey(family.slice(4)) ?? family.slice(4);
    return service === "s3" ? "object_store" : service === "sqs" || service === "sns" ? "queue" : service === "kinesis" ? "stream" : service === "dynamodb" || service === "rds" ? "database" : service === "sagemaker-runtime" ? "model_endpoint" : service === "ses" ? "email" : service === "cognito-identity-provider" ? "identity" : service === "opensearch" || service === "elasticsearch-service" ? "search" : service === "elasticache" ? "cache" : "cloud_api";
  }
  if (family.startsWith("http:")) return "http_api";
  return FAMILY_KINDS[family] ?? "other";
}

/** An environment variable name that is safe to carry: upper-case, at most 64 characters, and not shaped like a key. */
export function safeEnvName(name: unknown): string | undefined {
  // `AWS_ENDPOINT_URL_<suffix>` of a service of the emulator's table is the SDK's own variable name: long and upper-case, which the key-shape rule below would take for a token (`..._SECRETS_MANAGER`).
  if (typeof name === "string" && name.startsWith("AWS_ENDPOINT_URL_") && awsServiceKeyFromSdkName("endpointVariable", name.slice("AWS_ENDPOINT_URL_".length)) !== undefined) return name;
  if (typeof name !== "string" || !/^[A-Z][A-Z0-9_]{1,63}$/u.test(name) || looksLikeSecretValue(name)) return undefined;
  // Real variable names have words joined by `_`. A long name without one, mixing letters and digits (or very long), looks like a token pasted as a key.
  if (!name.includes("_") && ((name.length >= 16 && /[0-9]/u.test(name) && /[A-Z]/u.test(name)) || name.length >= 24)) return undefined;
  return name;
}

/** A compose service or similar name as a family-safe slug (lower-case, letters, digits and hyphens), or undefined. */
export function slug(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined;
  const value = name.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 39);
  return /^[a-z][a-z0-9-]{0,38}$/u.test(value) ? value.replace(/-+$/u, "") : undefined;
}

// ---- images

const IMAGE_NAMES: ReadonlyArray<{ names: readonly string[]; family: string }> = [
  { names: ["postgres", "postgresql", "postgis", "pgvector", "timescaledb"], family: "postgres" },
  { names: ["mysql"], family: "mysql" },
  { names: ["mariadb"], family: "mariadb" },
  { names: ["mongo", "mongodb", "mongodb-community-server"], family: "mongodb" },
  { names: ["redis", "redis-stack", "redis-stack-server", "valkey"], family: "redis" },
  { names: ["memcached"], family: "memcached" },
  { names: ["rabbitmq"], family: "rabbitmq" },
  { names: ["kafka", "cp-kafka", "cp-server", "redpanda"], family: "kafka" },
  { names: ["elasticsearch"], family: "elasticsearch" },
  { names: ["opensearch"], family: "opensearch" },
  { names: ["mailhog", "mailpit", "maildev"], family: "smtp" },
  { names: ["minio"], family: "aws:s3" },
];

/** What a container image reference stands for. Reads the NAME and the major version only: a registry, a tag suffix, a digest or a credential in the reference is dropped, never kept. */
export function familyFromImage(reference: unknown): { family: string; version?: string; localstack?: boolean } | undefined {
  if (typeof reference !== "string" || reference.length === 0 || reference.length > 300) return undefined;
  // `${NAME:-default}` takes its default; any other substitution stays unknown.
  const resolved = reference.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*:?-([^}$]*)\}/gu, "$1");
  if (resolved.includes("$")) return undefined;
  const withoutDigest = resolved.split("@")[0]!;
  const parts = withoutDigest.split("/");
  const last = parts.at(-1)!;
  const colon = last.lastIndexOf(":");
  const name = (colon < 0 ? last : last.slice(0, colon)).toLowerCase();
  const tag = colon < 0 ? undefined : last.slice(colon + 1);
  const version = tag === undefined ? undefined : /^v?(\d{1,3})(?:[.-]|$)/u.exec(tag)?.[1];
  if (name === "localstack") return { family: "localstack", localstack: true, ...(version === undefined ? {} : { version }) };
  const match = IMAGE_NAMES.find((entry) => entry.names.includes(name));
  return match === undefined ? undefined : { family: match.family, ...(version === undefined ? {} : { version }) };
}

/** Services LocalStack names in `SERVICES`, as AWS service ids; unknown words are dropped. */
export function awsServicesFromList(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return [...new Set(value.split(",").map((part) => part.trim().toLowerCase()).filter((part) => /^[a-z][a-z0-9-]{1,39}$/u.test(part)).map((part) => LOCALSTACK_ALIASES[part] ?? normalizeAwsService(part) ?? part))].slice(0, 24);
}
/** LocalStack's own short names that no SDK uses (the table knows every other spelling). */
const LOCALSTACK_ALIASES: Record<string, string> = { ddb: "dynamodb" };

// ---- constructing and merging

export function candidate(family: string, strength: DependencyStrength, evidence: DependencyEvidence, hints: DependencyHints = {}, kind?: TestEnvDependencyKind): DependencyCandidate {
  return { family, kind: kind ?? kindOfFamily(family), evidence: [evidence], strength, hints: awsStartsEmpty(family) && hints.startsEmpty === undefined ? { ...hints, startsEmpty: true } : hints };
}

/** Whether a family is an AWS service of the emulator's table that no seed handler creates resources for (`AWS_SEEDED_KINDS`): its emulator starts empty. The model-endpoint family has its own detector. */
export function awsStartsEmpty(family: string): boolean {
  if (!family.startsWith("aws:") || isOwnedElsewhere(family)) return false;
  const service = normaliseAwsServiceKey(family.slice(4));
  return service !== undefined && awsSeededKinds(service).length === 0;
}

const union = <T>(left: readonly T[] | undefined, right: readonly T[] | undefined, max: number): T[] | undefined => {
  const merged = [...new Set([...(left ?? []), ...(right ?? [])])].slice(0, max);
  return merged.length === 0 ? undefined : merged;
};

function mergeHints(left: DependencyHints, right: DependencyHints): DependencyHints {
  const merged: DependencyHints = {};
  const version = left.version ?? right.version;
  if (version !== undefined) merged.version = version;
  const envNames = union(left.envNames, right.envNames, MAX_NAMES);
  if (envNames !== undefined) merged.envNames = envNames;
  const ports = union(left.ports, right.ports, MAX_PORTS);
  if (ports !== undefined) merged.ports = ports;
  if (left.hasHealthcheck === true || right.hasHealthcheck === true) merged.hasHealthcheck = true;
  const initFiles = union(left.initFiles, right.initFiles, MAX_INIT_FILES);
  if (initFiles !== undefined) merged.initFiles = initFiles;
  const dependsOn = union(left.dependsOn, right.dependsOn, MAX_NAMES);
  if (dependsOn !== undefined) merged.dependsOn = dependsOn;
  const refused = union(left.refused, right.refused, DEPENDENCY_REFUSED_FIELDS.length);
  if (refused !== undefined) merged.refused = refused;
  if (left.explicitEndpoint === true || right.explicitEndpoint === true) merged.explicitEndpoint = true;
  if (left.fakedByTests === true || right.fakedByTests === true) merged.fakedByTests = true;
  if (left.testcontainers === true || right.testcontainers === true) merged.testcontainers = true;
  if (left.startsEmpty === true || right.startsEmpty === true) merged.startsEmpty = true;
  const url = left.url ?? right.url;
  if (url !== undefined) merged.url = url;
  const seenResources = new Set<string>();
  const resources = [...(left.resources ?? []), ...(right.resources ?? [])].filter((item) => { const key = `${item.kind}:${item.name}`; if (seenResources.has(key)) return false; seenResources.add(key); return true; }).slice(0, MAX_RESOURCES);
  if (resources.length > 0) merged.resources = resources;
  const endpointNames = union(left.endpointNames, right.endpointNames, MAX_NAMES);
  if (endpointNames !== undefined) merged.endpointNames = endpointNames;
  const sagemakerSignals = union(left.sagemakerSignals, right.sagemakerSignals, 10);
  if (sagemakerSignals !== undefined) merged.sagemakerSignals = sagemakerSignals;
  const seenBy = union(left.seenBy, right.seenBy, 8);
  if (seenBy !== undefined) merged.seenBy = seenBy;
  return merged;
}

/** One candidate per family: the strongest strength, the evidence of every sighting (at most 8, first seen first), and the hints combined. Order is first sighting. At most 64 families. */
export function mergeCandidates(list: readonly DependencyCandidate[]): DependencyCandidate[] {
  const byFamily = new Map<string, DependencyCandidate>();
  for (const item of list) {
    const existing = byFamily.get(item.family);
    if (existing === undefined) {
      if (byFamily.size >= MAX_CANDIDATES) continue;
      byFamily.set(item.family, { ...item, evidence: item.evidence.slice(0, MAX_EVIDENCE), hints: mergeHints(item.hints, {}) });
      continue;
    }
    const seen = new Set(existing.evidence.map((entry) => `${entry.path}:${String(entry.line)}`));
    for (const entry of item.evidence) if (existing.evidence.length < MAX_EVIDENCE && !seen.has(`${entry.path}:${String(entry.line)}`)) existing.evidence.push(entry);
    if (STRENGTH_RANK[item.strength] > STRENGTH_RANK[existing.strength]) existing.strength = item.strength;
    existing.hints = mergeHints(existing.hints, item.hints);
  }
  return [...byFamily.values()];
}

/** A repository-relative path built from a directory and a relative reference: no `..` out of the repository, nothing absolute, no backslash, no home or variable. Undefined otherwise. */
export function joinInside(directory: string, reference: string): string | undefined {
  if (reference.length === 0 || reference.length > 300 || reference.startsWith("/") || reference.startsWith("~") || reference.includes("\\") || reference.includes("$") || reference.includes("\0")) return undefined;
  const out: string[] = [];
  for (const part of [...(directory === "" ? [] : directory.split("/")), ...reference.split("/")]) {
    if (part === "" || part === ".") continue;
    if (part === "..") { if (out.length === 0) return undefined; out.pop(); continue; }
    out.push(part);
  }
  return out.length === 0 ? undefined : out.join("/");
}

export const dirname = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** Folders whose files are never the project's own setup. */
export const DEPENDENCY_SKIP_DIRS = /(?:^|\/)(?:node_modules|dist|build|\.git|venv|\.venv|vendor|\.tox|__pycache__)\//u;

// ---- AWS service ids

/**
 * An AWS service id as the emulator's table spells it (a key such as `s3`, `secrets-manager`, `sfn`), from the spelling one SDK, package or setting uses. `kind` says which of the table's columns the spelling comes from
 * (boto3's client name, the `@aws-sdk/client-*` suffix, the last part of a Java package or Go module, CloudFormation's `AWS::<name>::`, the `AWS_ENDPOINT_URL_<name>` suffix); a spelling that is not in that column is read as a
 * key, a legacy key, or a name of any other column. A spelling the table does not know but that has the shape of an id comes back as that id (a candidate, never dropped); undefined for anything that is not an id.
 * `sagemaker-runtime` is returned as is: the model-endpoint detector (D9, `services.ts`) owns it, and the SDK rules skip it (`isOwnedElsewhere`).
 */
export function normalizeAwsService(raw: string, kind?: AwsSdkNameKind): string | undefined {
  const lower = raw.toLowerCase().replace(/_/gu, "-");
  const spellings = [raw, lower];
  const columns: AwsSdkNameKind[] = [...(kind === undefined ? [] : [kind]), "boto3", "js", "java", "go"];
  const found = (kind === undefined ? undefined : spellings.map((name) => awsServiceKeyFromSdkName(kind, name)).find((key) => key !== undefined))
    ?? normaliseAwsServiceKey(lower)
    ?? columns.flatMap((column) => [awsServiceKeyFromSdkName(column, lower)]).find((key) => key !== undefined);
  if (found !== undefined) return found;
  return /^[a-z][a-z0-9-]{1,39}$/u.test(lower) ? lower : undefined;
}

/** The service `service` is in the table (a key or legacy key), for callers that must not keep an unknown id. */
export const isTableAwsService = (service: string): boolean => awsEmulatorServiceRow(normaliseAwsServiceKey(service) ?? service) !== undefined;

/** Families an older detector already reports through `Detection.services` (SageMaker Runtime, D9): the SDK rules leave them out so that output stays as it was. */
export const isOwnedElsewhere = (family: string): boolean => family === "aws:sagemaker-runtime";

// ---- code scanning

/** The text inside the parentheses that open at `open` (the index of "("), balanced, strings skipped, at most `max` characters. Never throws. */
export function callArguments(text: string, open: number, max = 800): string {
  let depth = 0;
  let quote: string | undefined;
  const end = Math.min(text.length, open + max);
  for (let i = open; i < end; i += 1) {
    const char = text[i]!;
    if (quote !== undefined) { if (char === "\\") i += 1; else if (char === quote) quote = undefined; continue; }
    if (char === "\"" || char === "'" || char === "`") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") { depth -= 1; if (depth === 0) return text.slice(open + 1, i); }
  }
  return text.slice(open + 1, end);
}

/** Whether call arguments hard-code where the service is: a connection URL string, or a host / address / brokers / endpoint set to a string literal (not a variable, a setting lookup or a template). */
export function hardcodedEndpoint(args: string): boolean {
  return /["'`](?:jdbc:)?(?:postgres(?:ql)?|mysql|mariadb|redis|rediss|mongodb(?:\+srv)?|amqps?|kafka|https?):\/\/[^"'`\s$%{]{2,}/u.test(args)
    || /\b(?:host|hosts|hostname|addr|address|brokers|bootstrap_servers|bootstrap\.servers|nodes?|endpoint|endpoint_url|endpointOverride|BaseEndpoint|Endpoint|Addr|Brokers|setHost|setUri|URI\.create)\b["']?\s{0,40}(?:[=:,(]|=>)\s{0,40}\[?\s{0,40}(?:aws\.String\(\s{0,120})?[fFrb]?["'`][^"'`$%{\s]{2,}["'`]/u.test(args)
    // a literal host:port (`"localhost:6379"`), or a libpq / ADO style `host=...` setting inside a connection string
    || /["'`][A-Za-z0-9][A-Za-z0-9.-]*:\d{2,5}["'`]/u.test(args)
    || /["'`][^"'`]*\bhost=[^\s"'`$%{]+/u.test(args);
}

export interface DriverRule {
  family: string;
  /** The import / require / usage of the driver in a source file. */
  uses: RegExp;
  /** Where the driver is pointed at a server; its arguments are checked for a hard-coded endpoint. */
  call?: RegExp;
}

/** Candidates for the drivers a source file uses (strength `used`), flagged when a call hard-codes its endpoint. */
export function scanDrivers(path: string, text: string, rules: readonly DriverRule[]): DependencyCandidate[] {
  const found: DependencyCandidate[] = [];
  for (const rule of rules) {
    const use = rule.uses.exec(text);
    if (use === null) continue;
    let explicit = false;
    if (rule.call !== undefined) {
      const flags = rule.call.flags.includes("g") ? rule.call.flags : `${rule.call.flags}g`;
      for (const call of text.matchAll(new RegExp(rule.call.source, flags))) {
        const open = text.indexOf("(", call.index + call[0].length - 1);
        if (open >= 0 && hardcodedEndpoint(callArguments(text, open))) { explicit = true; break; }
      }
    }
    found.push(candidate(rule.family, "used", { path, line: lineAt(text, use.index) }, { ...(explicit ? { explicitEndpoint: true } : {}), seenBy: ["sdk"] }));
  }
  return found;
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let at = text.indexOf("\n"); at !== -1 && at < index; at = text.indexOf("\n", at + 1)) line += 1;
  return line;
}

/** Connection URLs written as string literals in source code: the family, flagged as a hard-coded endpoint. The host is never kept. */
export function urlLiteralCandidates(path: string, text: string): DependencyCandidate[] {
  const found: DependencyCandidate[] = [];
  const families: Record<string, string> = { postgres: "postgres", postgresql: "postgres", mysql: "mysql", mariadb: "mariadb", mongodb: "mongodb", "mongodb+srv": "mongodb", redis: "redis", rediss: "redis", amqp: "rabbitmq", amqps: "rabbitmq" };
  for (const match of text.matchAll(/["'`](?:jdbc:)?(postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?):\/\/(?![$%{])[^"'`\s]{2,}/gu)) {
    const family = families[match[1]!];
    if (family !== undefined) found.push(candidate(family, "used", { path, line: lineAt(text, match.index) }, { explicitEndpoint: true, seenBy: ["sdk"] }));
  }
  return found;
}

/** An AWS client built in code: one candidate per service, flagged when its builder hard-codes an endpoint. */
export function awsClientCandidate(path: string, text: string, index: number, service: string, explicit: boolean, kind?: AwsSdkNameKind): DependencyCandidate | undefined {
  const normalized = normalizeAwsService(service, kind);
  if (normalized === undefined || isOwnedElsewhere(`aws:${normalized}`)) return undefined;
  return candidate(`aws:${normalized}`, "used", { path, line: lineAt(text, index) }, { ...(explicit ? { explicitEndpoint: true } : {}), seenBy: ["sdk"] });
}
