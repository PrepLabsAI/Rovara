// Test services, SEED-RISK-1 (owner decision 2026-11-07, "Yes, after security review"; owner decision 15: a MEDIUM locked seed has the same reach as the project's setup): the LOCK of a seed command that runs the
// repository's own seed script, unchanged. One resolver, here, used by BOTH sides:
// the broker resolves the command against the repository at the commit it reads from the code host (never the worker's or the model's word), and the worker resolves it again from its checkout right before the
// command runs; the run is refused when the two hashes differ. Browser-safe: nothing here imports a Node module.
//
// WHAT A LOCK PINS: the seed's ENTRY files as they are on the branch (the inputs below), not everything that executes. Code the seed reaches through a package (node_modules, a workspace package, a tsconfig path alias,
// package.json `imports`), `.env` and the tools' own binaries are not hashed: that is code the task already runs with the same reach (setup commands, postinstall, the checks), which owner decision 15 accepts.
//
// WHAT IS HASHED (version 1). Every path is relative to the command's own directory (`cwd`); the hash is the sha256 of one canonical JSON text holding the version, the command (directory, program and words) and
// every input below as [label, text] pairs in label order. Nothing else is read, and anything this resolver does not understand is a refusal (the seed stays HIGH), never a guess:
//   - `npm run <s>`, `pnpm run <s>`, `yarn run <s>`, `pnpm <s>`, `yarn <s>` (never a package manager's own command, `pnpm deploy`, `yarn node`): the WHOLE package.json (label `package.json`). A `pre<s>` or
//     `post<s>` script refuses (npm and yarn run them too). The script's body must then be one of the two shapes below.
//   - a body that runs one file with node, tsx, ts-node or bun (`node prisma/seed.js extra args`, no option before the file): that file's whole text (label: its path). A file that loads another repository file by a
//     relative `require`/`import`, or loads anything by a computed name (`require(path.join(...))`, `createRequire`, `import(name)`), refuses. So does one that runs text as code or loads a file by reading it
//     (`eval`, `Function(...)`/`new Function`, `vm.`, `require.call`/`.apply`, `module.constructor._load`, `JSON.parse(readFileSync(...))`). These are pattern checks on the text: they refuse the plain forms,
//     not every way JavaScript can reach other code (see WHAT A LOCK PINS above).
//   - a body, or the command itself (`npx prisma db seed`, `npx knex seed:run`, `npx sequelize-cli db:seed:all`), that is a database tool's own seed:
//       prisma     package.json (whole) and its `prisma.seed`, which must run one file as above, and that file. A `prisma.config.*` or `.config/prisma.*` file refuses (it can move the seed elsewhere).
//       knex       the one knexfile (`knexfile.{js,ts,cjs,mjs}`; none or several refuses; one that mentions `seeds` or `directory`, or uses a computed key, refuses: its seed folder may not be the default) and every
//                  file under `seeds/`.
//       sequelize  `config/config.json` and `config/config.js` where present, and every file under `seeders/`. A `.sequelizerc` refuses (it can move the folders).
//   - a command with its own variables (`env`) refuses: a variable such as NODE_OPTIONS changes what runs without changing any file.
//   - a package manager's or runtime's own settings file in the command's folder or any folder above it up to the repository root refuses (`.npmrc`, `.yarnrc`, `.yarnrc.yml`, `bunfig.toml`: a script shell, a
//     preload or another yarn can run instead), as does `.config/prisma.*`.
// Bounds: at most 32 files, 256 KiB each, 1 MiB in all; a listing that cannot be complete refuses.
import { z } from "zod";
import type { ProjectCommandSchema } from "./project.js";
import { sha256Hex } from "./web-hash.js";

type ProjectCommand = z.infer<typeof ProjectCommandSchema>;

export const SEED_LOCK_VERSION = 1 as const;
export const SEED_LOCK_LIMITS = { files: 32, fileBytes: 262_144, totalBytes: 1_048_576 } as const;

/** A path relative to the command's directory: plain characters, no empty, `.` or `..` segment, never absolute. */
const LockPathSchema = z.string().min(1).max(300).regex(/^[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/u).refine((path) => !path.split("/").some((part) => part === "." || part === ".."), "a plain relative path");

/** The lock a broker puts on a seed command it resolved itself: the hash of what the command runs, and the files it read (shown on the card). */
export const SeedScriptLockSchema = z.object({ version: z.literal(SEED_LOCK_VERSION), hash: z.string().regex(/^[a-f0-9]{64}$/u), from: z.array(LockPathSchema).min(1).max(SEED_LOCK_LIMITS.files) }).strict();
export type SeedScriptLock = z.infer<typeof SeedScriptLockSchema>;

/**
 * What the resolver reads, rooted at the command's directory. `read`: a regular file's text, undefined when there is no regular file there; it THROWS when it cannot tell (a host error, a link). `list`: every regular
 * file under a folder, recursively, as paths relative to the command's directory; an empty list when the folder is not there; undefined when the listing cannot be complete (cut short, a link, too many).
 */
export interface SeedSourceReader {
  read(path: string): Promise<string | undefined>;
  list(folder: string): Promise<readonly string[] | undefined>;
  /** Whether one of these paths (`.npmrc`, `.config/prisma.ts`) is in the command's folder or in a folder above it, up to the repository root. Throws when it cannot tell. */
  anyAbove(paths: readonly string[]): Promise<boolean>;
}

/** The settings files that change how a package manager or runtime runs a script, refused wherever they sit between the command's folder and the repository root. */
export const SEED_LOCK_REFUSED_SETTINGS = [".npmrc", ".yarnrc", ".yarnrc.yml", "bunfig.toml"] as const;
/** Prisma's config, wherever Prisma looks for it (it can move the seed). */
const PRISMA_CONFIGS = ["ts", "js", "mjs", "cjs", "mts", "cts"].flatMap((extension) => [`prisma.config.${extension}`, `.config/prisma.${extension}`]);

export const SEED_LOCK_REFUSALS = ["not_a_repo_script", "has_env", "script_shape", "pre_post_script", "tool_config", "manager_config", "manager_command", "imports_repo_files", "runs_text_as_code", "unreadable", "too_large", "no_files"] as const;
export type SeedLockRefusal = (typeof SEED_LOCK_REFUSALS)[number];
/** Why a seed command could not be locked, in fixed words (the reason the card gives for HIGH). */
export const SEED_LOCK_REFUSAL_WORDS: Record<SeedLockRefusal, string> = {
  not_a_repo_script: "it is not a plain run of one of the repository's own seed scripts",
  has_env: "it sets its own environment variables",
  script_shape: "its script does more than run one file or a database tool's seed",
  pre_post_script: "its script has a pre- or post-script that would run too",
  tool_config: "the database tool's own settings could move the seed elsewhere",
  manager_config: "a package manager or runtime settings file (.npmrc, .yarnrc, bunfig.toml) could change how it runs",
  manager_command: "it is a package manager's own command, not one of the repository's scripts",
  imports_repo_files: "its seed code loads other files from the repository",
  runs_text_as_code: "its seed code runs text as code, or loads a file by reading it",
  unreadable: "the files it runs could not be read from the repository",
  too_large: "the files it runs are too large to check",
  no_files: "no seed files were found where it would look",
};

export type SeedLockResolution = { ok: true; lock: SeedScriptLock } | { ok: false; refusal: SeedLockRefusal };

const NODE_RUNNERS = new Set(["node", "tsx", "ts-node", "bun"]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn"]);
/** The words a package manager takes as its own command (`yarn install`), never as a script. */
const MANAGER_COMMANDS = new Set([
  "access", "add", "approve-builds", "audit", "autoclean", "bin", "bugs", "cache", "cat-file", "cat-index", "check", "ci", "config", "constraints", "create", "dedupe", "deploy", "dlx", "doctor", "docs", "env", "exec",
  "explain", "fetch", "find-hash", "generate-lock-entry", "global", "help", "ignored-builds", "import", "info", "init", "install", "install-test", "it", "licenses", "link", "list", "ln", "login", "logout", "ls",
  "node", "outdated", "owner", "pack", "patch", "patch-commit", "patch-remove", "plugin", "policies", "prefix", "prune", "publish", "rebuild", "recursive", "remove", "restart", "rm", "root", "run", "run-script",
  "search", "self-update", "server", "set", "setup", "start", "stop", "store", "tag", "team", "test", "unlink", "unplug", "up", "update", "upgrade", "upgrade-interactive", "version", "versions", "why", "workspace",
  "workspaces",
]);
const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,63}$/u;
/** Anything a shell would read as more than words: a body with one of these is not a plain run. */
const SHELL_SYNTAX = /[|;&<>`$(){}[\]*?!~"'\\#=\n\r]/u;
const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/u;
const RELATIVE_LOAD = /(?:\brequire\s*\(|\bimport\s*\(|\bfrom|\bimport)\s*["'`]\.{1,2}\//u;
/** A load by a computed name: `require(x)`, `require(path.join(...))`, `import(x)`, `createRequire`, or a template string with a placeholder. */
const DYNAMIC_LOAD = /\bcreateRequire\b|\b(?:require|import)\s*\(\s*(?!["'][^"'\\]*["']\s*\)|`[^`$\\]*`\s*\))/u;
/** Text run as code, or a file loaded by reading it: `eval(`, `Function(` (and `new Function`), `vm.`, `require.call`/`.apply`, `module.constructor._load`, `JSON.parse(... readFileSync ...)` in one statement (a readFileSync call on the fs module, however it was loaded). */
const CODE_FROM_TEXT = /\beval\s*\(|\bFunction\s*\(|\bvm\s*\.|\brequire\s*\.\s*(?:call|apply)\b|\.constructor\s*\.\s*_load\b|\bJSON\s*\.\s*parse\s*\([^;]{0,200}?\breadFileSync\b/u;
/** Why a seed file, knexfile or sequelize config's text is refused, or undefined. */
const codeProblem = (text: string): SeedLockRefusal | undefined => (RELATIVE_LOAD.test(text) || DYNAMIC_LOAD.test(text) ? "imports_repo_files" : CODE_FROM_TEXT.test(text) ? "runs_text_as_code" : undefined);
const TOOLS: ReadonlyArray<{ tool: "prisma" | "knex" | "sequelize"; words: readonly string[] }> = [
  { tool: "prisma", words: ["prisma", "db", "seed"] },
  { tool: "knex", words: ["knex", "seed:run"] },
  { tool: "sequelize", words: ["sequelize", "db:seed:all"] },
  { tool: "sequelize", words: ["sequelize-cli", "db:seed:all"] },
];

class Refused extends Error {
  constructor(readonly refusal: SeedLockRefusal) { super(refusal); }
}
const refuse = (refusal: SeedLockRefusal): never => { throw new Refused(refusal); };

const sameWords = (left: readonly string[], right: readonly string[]): boolean => left.length === right.length && left.every((word, index) => word === right[index]);
const toolOf = (words: readonly string[]) => TOOLS.find((form) => sameWords(words, form.words) || sameWords(words, ["npx", ...form.words]))?.tool;

/** A relative path as the reader takes it: `./` dropped; anything else odd refuses. */
function plainPath(word: string): string {
  const path = word.replace(/^(?:\.\/)+/u, "");
  return LockPathSchema.safeParse(path).success ? path : refuse("script_shape");
}

class Inputs {
  readonly entries = new Map<string, string>();
  readonly files = new Set<string>();
  private bytes = 0;
  add(label: string, text: string, file?: string): void {
    if (this.entries.has(label)) return;
    const size = new TextEncoder().encode(text).length;
    if (size > SEED_LOCK_LIMITS.fileBytes) refuse("too_large");
    this.bytes += size;
    if (this.bytes > SEED_LOCK_LIMITS.totalBytes) refuse("too_large");
    this.entries.set(label, text);
    if (file !== undefined) this.files.add(file);
    if (this.files.size > SEED_LOCK_LIMITS.files) refuse("too_large");
  }
}

async function readText(reader: SeedSourceReader, path: string): Promise<string | undefined> {
  try { return await reader.read(path); } catch { return refuse("unreadable"); }
}

/** A source file the seed runs: hashed whole; one that loads another repository file refuses. */
async function addSource(reader: SeedSourceReader, inputs: Inputs, path: string): Promise<void> {
  const text = await readText(reader, path);
  if (text === undefined) refuse("unreadable");
  const problem = SOURCE_FILE.test(path) ? codeProblem(text!) : undefined;
  if (problem !== undefined) refuse(problem);
  inputs.add(path, text!, path);
}

/** A body that runs ONE file with a node runner (no option before the file). */
async function addFileRun(reader: SeedSourceReader, inputs: Inputs, body: string): Promise<boolean> {
  const words = body.trim().split(/\s+/u);
  if (!NODE_RUNNERS.has(words[0] ?? "")) return false;
  const file = words[1];
  if (file === undefined || file.startsWith("-")) refuse("script_shape");
  const path = plainPath(file!);
  if (!SOURCE_FILE.test(path)) refuse("script_shape");
  await addSource(reader, inputs, path);
  return true;
}

async function addFolder(reader: SeedSourceReader, inputs: Inputs, folder: string): Promise<void> {
  let listed: readonly string[] | undefined;
  try { listed = await reader.list(folder); } catch { refuse("unreadable"); }
  if (listed === undefined) refuse("unreadable");
  if (listed!.length === 0) refuse("no_files");
  if (listed!.length > SEED_LOCK_LIMITS.files) refuse("too_large");
  for (const path of [...listed!].sort()) {
    if (plainPath(path) !== path || !path.startsWith(`${folder}/`)) refuse("unreadable");
    await addSource(reader, inputs, path);
  }
}

/** package.json, parsed, and hashed WHOLE (its scripts, `prisma`, `type`, `imports`, `workspaces` and dependencies all change what runs). */
async function packageJsonOf(reader: SeedSourceReader, inputs: Inputs): Promise<Record<string, unknown>> {
  const text = await readText(reader, "package.json");
  if (text === undefined) refuse("not_a_repo_script");
  inputs.add("package.json", text!, "package.json");
  let parsed: unknown;
  try { parsed = JSON.parse(text!); } catch { return refuse("unreadable"); }
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : refuse("unreadable");
}

const objectAt = (value: unknown): Record<string, unknown> | undefined => (value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined);

async function addTool(reader: SeedSourceReader, inputs: Inputs, tool: "prisma" | "knex" | "sequelize"): Promise<void> {
  if (tool === "prisma") {
    if (await above(reader, PRISMA_CONFIGS)) refuse("tool_config");
    const seed = objectAt((await packageJsonOf(reader, inputs))["prisma"])?.["seed"];
    if (typeof seed !== "string" || SHELL_SYNTAX.test(seed)) refuse("tool_config");
    if (!await addFileRun(reader, inputs, seed as string)) refuse("script_shape");
    return;
  }
  if (tool === "knex") {
    const found: Array<[string, string]> = [];
    for (const name of ["knexfile.js", "knexfile.ts", "knexfile.cjs", "knexfile.mjs"]) { const text = await readText(reader, name); if (text !== undefined) found.push([name, text]); }
    // A knexfile that names a seeds folder or a directory, or builds a key (`['se' + 'eds']`), may seed from somewhere other than `seeds/`.
    if (found.length !== 1 || /\b(?:seeds|directory)\b|\[\s*["'`]/u.test(found[0]![1])) refuse("tool_config");
    const [name, text] = found[0]!;
    const problem = codeProblem(text);
    if (problem !== undefined) refuse(problem);
    inputs.add(name, text, name);
    await addFolder(reader, inputs, "seeds");
    return;
  }
  if (await readText(reader, ".sequelizerc") !== undefined) refuse("tool_config");
  for (const name of ["config/config.json", "config/config.js"]) {
    const text = await readText(reader, name);
    if (text === undefined) continue;
    const problem = codeProblem(text);
    if (problem !== undefined) refuse(problem);
    inputs.add(name, text, name);
  }
  await addFolder(reader, inputs, "seeders");
}

/** A package manager's run of a script: the script's name, or undefined when the words are not one. A package manager's own command (`pnpm deploy`, `yarn node`) refuses, even where a script has its name. */
function scriptNameOf(command: ProjectCommand): string | undefined {
  const args = command.args;
  if (args.length === 2 && (args[0] === "run" || args[0] === "run-script") && SCRIPT_NAME.test(args[1]!)) return args[1];
  if (args.length === 1 && command.executable !== "npm" && SCRIPT_NAME.test(args[0]!)) return MANAGER_COMMANDS.has(args[0]!) ? refuse("manager_command") : args[0];
  return undefined;
}

async function above(reader: SeedSourceReader, paths: readonly string[]): Promise<boolean> {
  try { return await reader.anyAbove(paths); } catch { return refuse("unreadable"); }
}

/** The canonical text the lock hashes: version, command, and every input in label order. */
export function seedLockMaterial(command: Pick<ProjectCommand, "cwd" | "executable" | "args">, entries: ReadonlyMap<string, string>): string {
  return JSON.stringify({ version: SEED_LOCK_VERSION, command: { cwd: command.cwd, executable: command.executable, args: command.args }, inputs: [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) });
}

/** The lock of a seed command, resolved through `reader`, or why it cannot be locked. Never throws. */
export async function seedScriptLockOf(command: ProjectCommand, reader: SeedSourceReader): Promise<SeedLockResolution> {
  try {
    if (command.env !== undefined && Object.keys(command.env).length > 0) refuse("has_env");
    const inputs = new Inputs();
    if (await above(reader, SEED_LOCK_REFUSED_SETTINGS)) refuse("manager_config");
    const words = [command.executable, ...command.args];
    const tool = toolOf(words);
    if (tool !== undefined) await addTool(reader, inputs, tool);
    else if (PACKAGE_MANAGERS.has(command.executable)) {
      const name = scriptNameOf(command);
      if (name === undefined) refuse("not_a_repo_script");
      const scripts = objectAt((await packageJsonOf(reader, inputs))["scripts"]);
      const body = scripts?.[name!];
      if (typeof body !== "string") refuse("not_a_repo_script");
      if (scripts!["pre" + name!] !== undefined || scripts!["post" + name!] !== undefined) refuse("pre_post_script");
      if (SHELL_SYNTAX.test(body as string)) refuse("script_shape");
      const bodyTool = toolOf((body as string).trim().split(/\s+/u));
      if (bodyTool !== undefined) await addTool(reader, inputs, bodyTool);
      else if (!await addFileRun(reader, inputs, body as string)) refuse("script_shape");
    } else refuse("not_a_repo_script");
    const from = [...inputs.files].sort();
    const lock = SeedScriptLockSchema.safeParse({ version: SEED_LOCK_VERSION, hash: sha256Hex(seedLockMaterial(command, inputs.entries)), from });
    return lock.success ? { ok: true, lock: lock.data } : { ok: false, refusal: "unreadable" };
  } catch (error) {
    return { ok: false, refusal: error instanceof Refused ? error.refusal : "unreadable" };
  }
}

/** Whether a lock still holds: the command resolves again, through `reader`, to exactly the same hash and files. Any refusal or difference is false. */
export async function seedLockHolds(command: ProjectCommand, lock: SeedScriptLock, reader: SeedSourceReader): Promise<boolean> {
  const again = await seedScriptLockOf(command, reader);
  return again.ok && again.lock.hash === lock.hash && again.lock.version === lock.version;
}
