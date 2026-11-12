// Env and settings detector (test services D3; design test-services.md 3.2). Finds the settings that point code at a dependency: `DATABASE_URL`, `REDIS_URL`, `*_HOST`/`*_PORT`, `AMQP_URL`, `KAFKA_BROKERS`,
// `AWS_ENDPOINT_URL_*`, `*_API_KEY` and the like, in `.env*` files and in settings files (`settings.py`, `config/*.y*ml|json|toml|properties`, `application*.properties|y*ml`, `appsettings*.json`).
//
// What leaves this file is the variable NAME, a family, a line, and (for a connection URL) its scheme and HOST FAMILY (`local`, `private`, `cloud`, `unknown`). Never a value, a host name, a user, a password or a
// token. How that is kept:
//   - the user-information part of a URL is skipped by the pattern itself, never captured;
//   - a REAL env file (`.env`, `.env.local`, `.env.production`, ...) is read for names only: no value is looked at. Only the example / sample / template / test / ci / dist files are read for their URL values, because
//     those are written to be copied;
//   - a name must be an upper-case variable name and must not be shaped like a key (the contracts' secret-shape rule), or it is dropped;
//   - http(s) URLs are not read here: outside API hosts are the services detector's (D8).
// Nothing is run; a file is read only if the reader was given its path.
import { candidate, DEPENDENCY_SKIP_DIRS, FAMILY_KINDS, kindOfFamily, mergeCandidates, normalizeAwsService, safeEnvName, slug } from "./dependency-candidates.js";
import { blocksBetween, lineOf, type DependencyCandidate, type DependencyHints, type Detector } from "./types.js";

const DOTENV = /(?:^|\/)\.env(?:\.[A-Za-z0-9_-]{1,32})?$/u;
const DOTENV_ENCRYPTED = /\.(?:enc|age|gpg|sops|vault)$/u;
/** The suffixes of env files written to be copied, so their values are read (for a URL's scheme and host family only). */
const COPYABLE_ENV = /\.(?:example|sample|template|dist|defaults?|test|ci)$/u;
const SETTINGS_FILE = /(?:^|\/)(?:settings(?:\/[A-Za-z0-9_]+)?\.py|config\/[^/]+\.(?:ya?ml|json|toml|properties)|application(?:-[A-Za-z0-9_]+)?\.(?:properties|ya?ml)|appsettings(?:\.[A-Za-z0-9_]+)?\.json)$/u;
export const ENV_CONFIG_MAX_FILES = 40;
const MAX_LINES = 2_000;

// ---- names

const NAME_RULES: ReadonlyArray<{ pattern: RegExp; family: string | ((match: RegExpExecArray) => string | undefined) }> = [
  { pattern: /^(?:POSTGRES|POSTGRESQL|PGHOST|PGPORT|PGUSER|PGDATABASE|PGPASSWORD|PGURL|PG_(?:HOST|PORT|USER|DATABASE|DB|URL|PASSWORD))(?:_|$)/u, family: "postgres" },
  { pattern: /^MYSQL(?:_|$)/u, family: "mysql" },
  { pattern: /^MARIADB(?:_|$)/u, family: "mariadb" },
  { pattern: /^MONGO(?:DB)?(?:_|$)/u, family: "mongodb" },
  { pattern: /^(?:REDIS|VALKEY)(?:_|$)/u, family: "redis" },
  { pattern: /^MEMCACHED?(?:_|$)/u, family: "memcached" },
  { pattern: /^(?:RABBITMQ|AMQP)(?:_|$)/u, family: "rabbitmq" },
  { pattern: /^KAFKA(?:_|$)/u, family: "kafka" },
  { pattern: /^(?:ELASTICSEARCH|ELASTIC_SEARCH|ES_(?:HOST|URL|ENDPOINT|NODES))(?:_|$)/u, family: "elasticsearch" },
  { pattern: /^OPENSEARCH(?:_|$)/u, family: "opensearch" },
  { pattern: /^SMTP(?:_|$)/u, family: "smtp" },
  { pattern: /^AWS_ENDPOINT_URL_([A-Z0-9_]{2,40})$/u, family: (match) => awsService(match[1]!) },
  { pattern: /^S3_(?:BUCKET|ENDPOINT|REGION|PREFIX)(?:_|$)/u, family: "aws:s3" },
  { pattern: /^SQS_/u, family: "aws:sqs" },
  { pattern: /^SNS_/u, family: "aws:sns" },
  { pattern: /^DYNAMO(?:DB)?_/u, family: "aws:dynamodb" },
  { pattern: /^KINESIS_/u, family: "aws:kinesis" },
  { pattern: /^SAGEMAKER_(?:RUNTIME_)?ENDPOINT/u, family: "aws:sagemaker-runtime" },
];
/** The service `AWS_ENDPOINT_URL_<suffix>` is for: the table's variable suffix (`SECRETS_MANAGER`), else any other spelling the table knows, else the suffix as an id. */
function awsService(suffix: string): string | undefined {
  const id = normalizeAwsService(suffix, "endpointVariable");
  return id === undefined ? undefined : `aws:${id}`;
}

/** Prefixes that say nothing about WHICH outside service a key belongs to. */
const GENERIC_PREFIXES = new Set(["api", "app", "auth", "secret", "service", "internal", "private", "public", "admin", "master", "access", "default", "base", "client", "server", "backend", "frontend", "web", "my", "your", "test", "dev", "prod", "api-key", "key", "token", "aws", "jwt", "session", "cookie", "encryption", "signing", "csrf", "django", "flask", "rails", "node", "database", "db", "cache", "queue", "storage", "redis"]);
const OUTSIDE_API = /^([A-Z][A-Z0-9]{1,24}(?:_[A-Z0-9]{2,24}){0,2})_(?:API_KEY|API_TOKEN|API_SECRET|API_URL|API_BASE_URL|API_BASE|API_HOST|BASE_URL)$/u;

/** The family a variable name stands for, or undefined. */
export function familyOfName(name: string): string | undefined {
  for (const rule of NAME_RULES) {
    const match = rule.pattern.exec(name);
    if (match === null) continue;
    return typeof rule.family === "string" ? rule.family : rule.family(match);
  }
  const outside = OUTSIDE_API.exec(name)?.[1];
  if (outside === undefined) return undefined;
  const family = slug(outside);
  return family === undefined || GENERIC_PREFIXES.has(family) ? undefined : family;
}

// ---- connection URLs

const SCHEME_FAMILIES: Record<string, string> = { postgres: "postgres", postgresql: "postgres", postgis: "postgres", mysql: "mysql", mysql2: "mysql", mariadb: "mariadb", mongodb: "mongodb", "mongodb+srv": "mongodb", redis: "redis", rediss: "redis", valkey: "redis", amqp: "rabbitmq", amqps: "rabbitmq" };
/** `scheme://[userinfo@]host`: the user information is matched and thrown away, never captured. */
const URL_PATTERN = /(?:jdbc:)?([a-z][a-z0-9+.-]{1,15}):\/\/(?:[^@/?#\s"'`]*@)?(\[[0-9A-Fa-f:.]+\]|[^:/?#\s"'`,;)>}]*)/gu;

export function hostFamily(host: string): "local" | "private" | "cloud" | "unknown" {
  const lower = host.toLowerCase();
  if (lower === "" || /[$<{*]/u.test(lower)) return "unknown";
  if (lower === "localhost" || lower === "[::1]" || lower === "0.0.0.0" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(lower) || lower === "host.docker.internal") return "local";
  const octets = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/u.exec(lower);
  if (octets !== null) { const a = Number(octets[1]); const b = Number(octets[2]); return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) ? "private" : "unknown"; }
  if (/\.(?:amazonaws\.com|amazonaws\.com\.cn|azure\.com|azure\.net|windows\.net|googleapis\.com|cloud\.google\.com|rds\.[a-z0-9.-]+|cache\.windows\.net|mongodb\.net|upstash\.io|cloud\.redislabs\.com)$/u.test(lower)) return "cloud";
  if (!lower.includes(".") || /\.(?:local|internal|svc|lan|cluster\.local|svc\.cluster\.local|home\.arpa)$/u.test(lower) || lower.startsWith("[")) return "private";
  return "unknown";
}

interface UrlReading { family: string; scheme: string; hostFamily: ReturnType<typeof hostFamily> }
/** Every connection URL (a database, cache or broker scheme) in a piece of text: its family, scheme and host family. */
export function connectionUrls(text: string): UrlReading[] {
  const found: UrlReading[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const scheme = match[1]!;
    const family = SCHEME_FAMILIES[scheme];
    if (family !== undefined) found.push({ family, scheme, hostFamily: hostFamily(match[2] ?? "") });
  }
  return found;
}

// ---- readers

function add(out: DependencyCandidate[], family: string, path: string, line: number, hints: DependencyHints): void {
  // A family no table knows came from a `<NAME>_API_KEY`-style setting: an outside API.
  const known = kindOfFamily(family);
  out.push(candidate(family, "used", { path, line }, { ...hints, seenBy: ["env"] }, known === "other" ? "http_api" : known));
}

const unquote = (value: string): string => { const trimmed = value.trim(); return /^(["']).*\1$/u.test(trimmed) ? trimmed.slice(1, -1) : trimmed; };

function readDotenv(path: string, text: string, out: DependencyCandidate[]): void {
  const copyable = COPYABLE_ENV.test(path);
  const lines = text.split("\n").slice(0, MAX_LINES);
  lines.forEach((raw, index) => {
    const match = /^[ \t]*(?:export\s{1,40})?([A-Za-z_][A-Za-z0-9_]*)\s{0,40}=(.*)$/u.exec(raw);
    if (match === null) return;
    const name = safeEnvName(match[1]);
    if (name === undefined) return;
    // A real env file: the name is all that is read. The value is not looked at.
    const url = copyable ? connectionUrls(unquote(match[2]!))[0] : undefined;
    const family = url?.family ?? familyOfName(name);
    if (family === undefined) return;
    add(out, family, path, index + 1, { envNames: [name], ...(url === undefined ? {} : { url: { scheme: url.scheme, hostFamily: url.hostFamily } }) });
  });
}

/** Settings files: URL literals, `${VAR}` / `os.environ.get("VAR")` names, and the few framework keys that name a database or cache. */
function readSettings(path: string, text: string, out: DependencyCandidate[]): void {
  for (const match of text.matchAll(URL_PATTERN)) {
    const family = SCHEME_FAMILIES[match[1]!];
    if (family !== undefined) add(out, family, path, lineOf(text, match.index), { url: { scheme: match[1]!, hostFamily: hostFamily(match[2] ?? "") } });
  }
  const names = new Map<string, number>();
  for (const match of text.matchAll(/\$\{([A-Z][A-Z0-9_]{1,63})(?=[:}])/gu)) names.set(match[1]!, lineOf(text, match.index));
  for (const match of text.matchAll(/(?:environ(?:\.get)?|getenv|env(?:\.[a-z_]+)?|config)\(\s{0,120}['"]([A-Z][A-Z0-9_]{1,63})['"]/gu)) names.set(match[1]!, lineOf(text, match.index));
  for (const match of text.matchAll(/environ\[\s{0,40}['"]([A-Z][A-Z0-9_]{1,63})['"]\s{0,40}\]/gu)) names.set(match[1]!, lineOf(text, match.index));
  for (const [raw, line] of names) {
    const name = safeEnvName(raw);
    const family = name === undefined ? undefined : familyOfName(name);
    if (name !== undefined && family !== undefined) add(out, family, path, line, { envNames: [name] });
  }
  const keyed: ReadonlyArray<[RegExp, string]> = [
    [/django(?:\.contrib\.gis)?\.db\.backends\.(?:postgresql|postgis)/u, "postgres"],
    [/django\.db\.backends\.mysql/u, "mysql"],
    [/django_redis|django\.core\.cache\.backends\.redis/u, "redis"],
    [/django\.core\.cache\.backends\.(?:memcached|pymemcache)/u, "memcached"],
    [/^[ \t]*spring\.(?:data\.)?redis\.[a-z.-]+\s{0,40}[=:]/mu, "redis"],
    [/^[ \t]*spring\.rabbitmq\.[a-z.-]+\s{0,40}[=:]/mu, "rabbitmq"],
    [/^[ \t]*spring\.kafka\.[a-z.-]+\s{0,40}[=:]/mu, "kafka"],
    [/^[ \t]*spring\.data\.mongodb\.[a-z.-]+\s{0,40}[=:]/mu, "mongodb"],
    [/^[ \t]*spring\.elasticsearch\.[a-z.-]+\s{0,40}[=:]/mu, "elasticsearch"],
  ];
  for (const [pattern, family] of keyed) {
    const match = pattern.exec(text);
    if (match !== null) add(out, family, path, lineOf(text, match.index), {});
  }
  if (/(?:^|\/)application[^/]*\.ya?ml$/u.test(path)) {
    // Spring settings in YAML are nested: `spring:` then `redis:` / `rabbitmq:` / `kafka:` / `data: mongodb:` below it.
    for (const [pattern, family] of [[/^[ \t]{2,4}redis:[ \t]*$/mu, "redis"], [/^[ \t]{2,4}rabbitmq:[ \t]*$/mu, "rabbitmq"], [/^[ \t]{2,4}kafka:[ \t]*$/mu, "kafka"], [/^[ \t]{2,6}mongodb:[ \t]*$/mu, "mongodb"], [/^[ \t]{2,4}elasticsearch:[ \t]*$/mu, "elasticsearch"]] as const) {
      const match = /^spring:/mu.test(text) ? pattern.exec(text) : null;
      if (match !== null) add(out, family, path, lineOf(text, match.index), {});
    }
  }
  const connection = /"ConnectionStrings"\s{0,40}:/u.exec(text);
  if (connection !== null) {
    // .NET: the names under ConnectionStrings say what each is. The strings themselves are not read.
    const block = text.slice(connection.index, connection.index + 2_000);
    for (const [pattern, family] of [[/"[^"]*(?:postgres|npgsql)[^"]*"\s{0,40}:/iu, "postgres"], [/"[^"]*mysql[^"]*"\s{0,40}:/iu, "mysql"], [/"[^"]*redis[^"]*"\s{0,40}:/iu, "redis"], [/"[^"]*mongo[^"]*"\s{0,40}:/iu, "mongodb"], [/"[^"]*(?:rabbit|amqp)[^"]*"\s{0,40}:/iu, "rabbitmq"]] as const) {
      const match = pattern.exec(block);
      if (match !== null) add(out, family, path, lineOf(text, connection.index + match.index), {});
    }
  }
}

/** Prisma names its database in the schema file: `provider = "postgresql"`. The connection string is an env() call; nothing of it is read. */
const PRISMA_PROVIDERS: Readonly<Record<string, string>> = { postgresql: "postgres", postgres: "postgres", mysql: "mysql", mongodb: "mongodb" };
function readPrismaSchema(path: string, text: string, out: DependencyCandidate[]): void {
  const datasource = /(?:^|\n)\s{0,40}datasource\s{1,40}[A-Za-z_][A-Za-z0-9_]{0,40}\s{0,40}\{/u.exec(text);
  if (datasource === null) return;
  const block = text.slice(datasource.index, datasource.index + 1_500);
  const provider = /provider\s{0,40}=\s{0,40}"([a-z]{2,20})"/u.exec(block);
  const family = provider === null ? undefined : PRISMA_PROVIDERS[provider[1]!];
  const url = /url\s{0,40}=\s{0,40}env\(\s{0,40}"([A-Z][A-Z0-9_]{1,63})"/u.exec(block);
  const name = url === null ? undefined : safeEnvName(url[1]);
  if (family !== undefined) add(out, family, path, lineOf(text, datasource.index + (provider?.index ?? 0)), name === undefined ? {} : { envNames: [name] });
}

// ---- ORM and migration tool configs (knex, sequelize, typeorm, drizzle): the database they name. Only the dialect word is read; a connection string or password never is.

/** The dialect words the tools use, as the family a test service starts. SQLite and the rest run in-process or are not offered: no candidate. */
const ORM_DIALECTS: Readonly<Record<string, string>> = { pg: "postgres", postgres: "postgres", postgresql: "postgres", "pg-native": "postgres", mysql: "mysql", mysql2: "mysql", mariadb: "mariadb", mongodb: "mongodb" };
/** Each tool's config file and the key that names its dialect (`client` in a knexfile, `dialect` for sequelize and drizzle, `type` for typeorm, drizzle's older `driver`). */
const ORM_CONFIGS: ReadonlyArray<{ file: RegExp; keys: readonly string[] }> = [
  { file: /(?:^|\/)knexfile\.(?:[cm]?js|ts)$/u, keys: ["client"] },
  { file: /(?:^|\/)(?:\.sequelizerc|config\/(?:config|database)\.(?:json|[cm]?js|ts))$/u, keys: ["dialect"] },
  { file: /(?:^|\/)(?:ormconfig\.(?:json|[cm]?js|ts|ya?ml)|data-source\.(?:[cm]?js|ts))$/u, keys: ["type"] },
  { file: /(?:^|\/)drizzle\.config\.(?:[cm]?js|ts|json)$/u, keys: ["dialect", "driver"] },
];
const ORM_CONFIG_MAX_FILES = 8;

/** The databases ORM and migration tool configs name, each cited at the line of its dialect key. Bounded (8 files); a file that names none gives none. */
export async function ormConfigCandidates(repo: Pick<Parameters<Detector>[0]["repo"], "paths" | "read">): Promise<DependencyCandidate[]> {
  const found: DependencyCandidate[] = [];
  const paths = repo.paths.filter((path) => !DEPENDENCY_SKIP_DIRS.test(path) && ORM_CONFIGS.some((config) => config.file.test(path))).slice(0, ORM_CONFIG_MAX_FILES);
  for (const path of paths) {
    const text = await repo.read(path);
    if (text === undefined) continue;
    const config = ORM_CONFIGS.find((item) => item.file.test(path))!;
    const clean = withoutComments(text, false);
    for (const key of config.keys) {
      // `client: 'pg'`, `"dialect": "postgres"`, `type: postgres` (YAML): the key, then one quoted or bare word.
      const pattern = new RegExp(`(?:^|[\\s{,])["']?${key}["']?\\s{0,40}[:=]\\s{0,40}["'\`]?([a-z][a-z0-9-]{1,20})["'\`]?`, "gu");
      for (const match of clean.matchAll(pattern)) {
        const family = Object.hasOwn(ORM_DIALECTS, match[1]!) ? ORM_DIALECTS[match[1]!] : undefined;
        if (family !== undefined) found.push(candidate(family, "used", { path, line: lineOf(clean, match.index) }, { seenBy: ["orm"] }));
      }
    }
  }
  return mergeCandidates(found);
}

export const detectEnvConfig: Detector = async ({ repo }) => {
  const prismaFound: DependencyCandidate[] = [...await ormConfigCandidates(repo)];
  for (const path of repo.paths.filter((candidate) => /(?:^|\/)schema\.prisma$/u.test(candidate) && !DEPENDENCY_SKIP_DIRS.test(candidate)).slice(0, 4)) {
    const text = await repo.read(path);
    if (text !== undefined) readPrismaSchema(path, text, prismaFound);
  }
  const files = repo.paths.filter((path) => !DEPENDENCY_SKIP_DIRS.test(path) && ((DOTENV.test(path) && !DOTENV_ENCRYPTED.test(path)) || SETTINGS_FILE.test(path))).slice(0, ENV_CONFIG_MAX_FILES);
  if (files.length === 0 && prismaFound.length === 0) return {};
  const found: DependencyCandidate[] = [...prismaFound];
  for (const path of files) {
    const text = await repo.read(path);
    if (text === undefined) continue;
    if (DOTENV.test(path)) readDotenv(path, text, found);
    else readSettings(path, text, found);
  }
  const dependencies = mergeCandidates(found);
  return dependencies.length === 0 ? {} : { dependencies };
};

// ---- references to a setting in source code (TS-UX-1)
//
// A project that reads its database address from `process.env.DATABASE_URL` and has no `.env.example` still depends on a database. These readers find the NAME of a setting the code reads, in JavaScript, TypeScript and
// Python source, with its line. Read-only and bounded by the caller (the source files of the SDK pass). A comment, a block comment and a Python docstring are blanked first, so a commented-out line is not a use. No value
// is looked at: a name only, through the same name rules as an env file.

const JS_SOURCE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/u;
const PY_SOURCE = /\.py$/u;
const NAME = "[A-Z][A-Z0-9_]{1,63}";
const MAX_CODE_REFERENCES = 60;

/** The text with every comment replaced by spaces (newlines kept, so lines still line up). One pass per kind of block: no pattern rescans to the end of the text. */
function withoutComments(text: string, python: boolean): string {
  const blank = (value: string): string => value.replace(/[^\n]/gu, " ");
  let out = text;
  const blocks = python ? [...blocksBetween(out, '"""', '"""'), ...blocksBetween(out, "'''", "'''")] : blocksBetween(out, "/*", "*/");
  for (const block of blocks.sort((a, b) => b.index - a.index)) out = out.slice(0, block.index) + blank(block.text) + out.slice(block.end);
  return out.split("\n").map((line) => {
    if (python) { const at = line.indexOf("#"); return at < 0 ? line : line.slice(0, at); }
    const trimmed = line.trimStart();
    if (trimmed.startsWith("*")) return "";
    for (let at = line.indexOf("//"); at >= 0; at = line.indexOf("//", at + 2)) if (at === 0 || line[at - 1] !== ":") return line.slice(0, at);
    return line;
  }).join("\n");
}

export interface CodeEnvReference { name: string; line: number }

/** The names of the settings a JavaScript, TypeScript or Python file reads, each once, with the line of its first use. Anything else gives none. */
export function codeEnvReferences(path: string, text: string): CodeEnvReference[] {
  const python = PY_SOURCE.test(path);
  if (!python && !JS_SOURCE.test(path)) return [];
  const clean = withoutComments(text, python);
  const found = new Map<string, number>();
  const note = (raw: string | undefined, index: number): void => {
    if (raw === undefined || found.size >= MAX_CODE_REFERENCES) return;
    const name = safeEnvName(raw);
    if (name !== undefined && !found.has(name)) found.set(name, lineOf(clean, index));
  };
  const patterns: RegExp[] = python
    ? [new RegExp(`environ\\[\\s{0,40}["'](${NAME})["']\\s{0,40}\\]`, "gu"), new RegExp(`(?:environ\\.get|getenv)\\(\\s{0,40}["'](${NAME})["']`, "gu")]
    : [
      new RegExp(`(?:process|Bun)\\.env\\.(${NAME})(?![A-Za-z0-9_])`, "gu"),
      new RegExp(`import\\.meta\\.env\\.(${NAME})(?![A-Za-z0-9_])`, "gu"),
      new RegExp(`(?:process\\.env|import\\.meta\\.env|Bun\\.env)\\[\\s{0,40}["'\x60](${NAME})["'\x60]\\s{0,40}\\]`, "gu"),
      new RegExp(`Deno\\.env\\.get\\(\\s{0,40}["'\x60](${NAME})["'\x60]`, "gu"),
    ];
  const hits: Array<{ name: string; index: number }> = [];
  for (const pattern of patterns) for (const match of clean.matchAll(pattern)) hits.push({ name: match[1]!, index: match.index });
  if (!python) {
    // const { DATABASE_URL, REDIS_URL: url = "x" } = process.env
    for (const match of clean.matchAll(/\{([^{}]{1,400})\}\s{0,40}=\s{0,40}process\.env(?![A-Za-z0-9_.[])/gu)) {
      for (const part of match[1]!.split(",")) { const name = /^\s*([A-Z][A-Z0-9_]{1,63})\s*(?::|=|$)/u.exec(part)?.[1]; if (name !== undefined) hits.push({ name, index: match.index }); }
    }
  }
  for (const hit of hits.sort((a, b) => a.index - b.index)) note(hit.name, hit.index);
  return [...found].map(([name, line]) => ({ name, line }));
}

/** A setting that names a database without saying which software: `DATABASE_URL`, `DB_HOST`. */
const GENERIC_DATABASE_NAME = /^(?:DATABASE|DB)_(?:URL|URI|HOST|PORT|NAME|USER|PASSWORD|CONNECTION(?:_STRING)?)$/u;

/** Whether a source file reads a setting that names a database (`DATABASE_URL`, `PGHOST`, `MYSQL_HOST`, `MONGO_URI`): a command that runs it needs the database (TS-UX-1 item 7). */
export function readsDatabaseSetting(path: string, text: string): CodeEnvReference | undefined {
  return codeEnvReferences(path, text).find((reference) => {
    if (GENERIC_DATABASE_NAME.test(reference.name)) return true;
    const family = familyOfName(reference.name);
    return family !== undefined && kindOfFamily(family) === "database";
  });
}

export const ASSUMED_POSTGRES_NOTE = "The code reads a database setting (such as DATABASE_URL) and no database driver was found, so Rovara assumed Postgres. Check that it is right before you approve.";
export const WHICH_DATABASE_QUESTION = "The code reads a database setting (such as DATABASE_URL), and more than one kind of database is in use, so Rovara can't tell which one it points at.";

/**
 * Candidates from the settings the code reads. A name a table knows stands for its family. A bare database setting goes to the one database software the other findings (`known`: drivers in code and manifests)
 * name; with none it is Postgres, said in a note; with two or more it is a question and no candidate. Only families the catalog can back (`FAMILY_KINDS`, AWS) come from code: an outside API's key is for a file to name.
 */
export function codeReferenceFindings(references: ReadonlyArray<CodeEnvReference & { path: string }>, known: readonly DependencyCandidate[]): { dependencies: DependencyCandidate[]; notes: string[]; questions: string[] } {
  const out: DependencyCandidate[] = [];
  const notes: string[] = [];
  const questions: string[] = [];
  const databases = [...new Set(known.filter((item) => item.kind === "database" && !item.family.startsWith("aws:")).map((item) => item.family))];
  for (const reference of references) {
    const evidence = { path: reference.path, line: reference.line };
    const hints = { envNames: [reference.name], seenBy: ["code"] };
    if (GENERIC_DATABASE_NAME.test(reference.name)) {
      if (databases.length === 1) out.push(candidate(databases[0]!, "used", evidence, hints));
      else if (databases.length === 0) { out.push(candidate("postgres", "mentioned", evidence, hints)); notes.push(ASSUMED_POSTGRES_NOTE); }
      else questions.push(WHICH_DATABASE_QUESTION);
      continue;
    }
    const family = familyOfName(reference.name);
    if (family === undefined || !(Object.hasOwn(FAMILY_KINDS, family) || family.startsWith("aws:"))) continue;
    out.push(candidate(family, "used", evidence, hints));
  }
  return { dependencies: out, notes: [...new Set(notes)], questions: [...new Set(questions)] };
}
