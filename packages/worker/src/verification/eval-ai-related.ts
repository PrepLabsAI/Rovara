// EVAL-TRIGGER-NARROW (owner 2026-11-16): which repository files are AI-related, so a change outside them does not count every model call as changed.
// Pure: no filesystem, process or network. The caller reads the candidate tree (eval-changed-prompt.ts) and hands it in.
//
// The AI-related set is the forward import closure of these roots:
//   (a) code that names a known AI SDK, model-call module or provider host (AI_MARKER: Anthropic, OpenAI, Google GenAI/Gemini, Bedrock runtime, Vertex,
//       plus the common frameworks), the project's own model-call wrappers (files that re-export such code: barrels, index files, __init__.py), and every
//       file that imports one of those (the wrapper's callers, where the prompt is usually chosen);
//   (b) prompt files by F4's path rule (setup's prompt inventory) and code under prompts/, llm/, ai/ or agents/ folders;
//   (c) files those import, transitively, inside the repository (relative imports, tsconfig/jsconfig paths, baseUrl, workspace packages, Python packages);
//   (d) files a set file names by a path-like string literal (prompts/system.txt, persona.md), matched by path suffix; the non-code files of a folder
//       it names; and, when it reads files at all (readFile, open, read_text, importlib.resources, readdir, a template loader), every non-code file under
//       its own folder, since the name may be computed.
// Fail safe: anything that cannot be resolved makes the WHOLE answer unknown: a non-literal dynamic import/require/import_module/exec in a set file,
// a relative import that names no file, an alias that maps nowhere, a bare package no package.json declares, an unclosed Python import list, and any
// limit hit, a symbolic link reached by the walk, and a repository where no model-call code is recognised at all. Known limits: callers of callers are not roots (a prompt handed down two layers of plain calls whose top file imports no wrapper), and
// unparsed bundler aliases other than tsconfig/jsconfig paths read as bare packages (unknown in a set file, ignored elsewhere unless they look like
// an alias: "@/", "~", "#"); a Python import of a package mapped by setup.py package_dir that no path suffix matches reads as an installed package.
// Linear: every file is scanned by fixed regexes once, lookups go through maps built once, and every node and edge is visited once under one total budget.
import { builtinModules } from "node:module";
import { promptFilePath } from "@agentx/contracts";

export const AI_WALK_LIMITS = {
  treeEntries: 100_000, files: 20_000, fileBytes: 1024 * 1024, totalBytes: 32 * 1024 * 1024, pathSegments: 2_000_000, edges: 2_000_000,
} as const;
export type AiWalkLimits = { -readonly [K in keyof typeof AI_WALK_LIMITS]: number };

export const CODE_PATH = /\.(?:[cm]?[jt]sx?|py|pyi)$/iu;
const PY_PATH = /\.pyi?$/iu;
const PACKAGE_JSON = /(?:^|\/)package\.json$/u;
const TS_CONFIG = /(?:^|\/)[jt]sconfig[^/]*\.json$/u;
/** Files that decide how imports resolve or which SDK version runs. A change to one is always AI-related. */
const RESOLUTION_FILE = /(?:^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|bun\.lockb?|[jt]sconfig[^/]*\.json|pyproject\.toml|setup\.py|setup\.cfg|requirements[^/]*\.(?:txt|in)|constraints[^/]*\.txt|Pipfile|Pipfile\.lock|poetry\.lock|uv\.lock|\.python-version|\.env[^/]*|[^/]*\.env)$/u;
/** Code under one of these folders is a root by F4's folder rule (models/ is left out: it is usually database models). */
const AI_FOLDER = /(?:^|\/)(?:prompts?|llm|ai|agents|system-prompts)\//iu;

/** One regex, case-insensitive, scanned once per file. A mention in a comment counts too: over-counting is the safe side. */
export const AI_MARKER = new RegExp([
  String.raw`\b(?:openai|anthropic|genai|generativeai|aiplatform|vertexai|litellm|ollama|cohere|mistralai|llama_index|llamaindex|groq|langchain\w*|langgraph\w*)\b`,
  String.raw`@anthropic-ai\/|@google\/genai|@google\/generative-ai|@google-cloud\/vertexai|@google-cloud\/aiplatform|@aws-sdk\/client-bedrock|@ai-sdk\/|@langchain\/|@mistralai\/|@azure\/openai|@huggingface\/inference`,
  String.raw`bedrock[-_](?:agent[-_])?runtime|invoke_?model|converse_?stream|\bconverse\b|api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|aiplatform\.googleapis\.com|openai\.azure\.com`,
  // Raw HTTP to OpenAI-compatible and other provider APIs, Azure AI Inference.
  String.raw`chat\/completions|\/v1\/messages|\/v1\/completions|\/v1\/responses|:(?:stream)?generateContent|openrouter|deepseek|api\.together|api\.mistral|api\.x\.ai|api\.groq|api\.cohere|azure\.ai\.inference|ai-inference|huggingface_hub|InferenceClient|invoke_endpoint|:11434|\/api\/chat|\/api\/generate`,
  String.raw`(["'\x60])ai(?:\/[^"'\x60\s]{0,256})?\1`,
].join("|"), "iu");

export function resolutionFile(path: string): boolean { return RESOLUTION_FILE.test(path); }
export function hasAiMarker(text: string): boolean { return AI_MARKER.test(text); }
/** Which files of the candidate tree the walk needs as text. */
export function walkReads(path: string): boolean { return CODE_PATH.test(path) || PACKAGE_JSON.test(path) || TS_CONFIG.test(path); }

export interface RepositorySnapshot {
  /** Every regular file of the candidate tree. */
  readonly paths: readonly string[];
  /** Files this change removed. They still resolve (to a member, never to "missing"), so a deleted import target is seen, not skipped. */
  readonly removed: readonly string[];
  /** Text of every candidate-tree file walkReads() names. */
  readonly text: ReadonlyMap<string, string>;
  /** Symbolic links of the candidate tree. Their target is not followed: one reached by the walk makes the answer unknown. */
  readonly links?: readonly string[];
}
export type AiRelatedSet = { readonly known: true; has(path: string): boolean } | { readonly known: false };
const UNKNOWN: AiRelatedSet = { known: false };

class Unknown extends Error {}
const unknown = (): never => { throw new Unknown(); };

// ---- source scanning ----------------------------------------------------------------------------------------------------------------------
interface Imports { specs: string[]; python: PyImport[]; dynamic: boolean; unparsed: boolean; barrel: boolean }
interface PyImport { level: number; module: string; names: string[] }
const TS_STATIC = /\b(?:from|import)\s*(["'])([^"'\r\n]{1,1024})\1/gu;
const TS_CALL = /(^|[^.\w$])(require(?:\.resolve)?|import)\s*\(/gu;
const LITERAL_ARG = /\s*(?:(["'])([^"'\r\n]{0,1024})\1|\x60([^\x60$\\\r\n]{0,1024})\x60)\s*[,)]/uy;
const TS_DYNAMIC = /\bcreateRequire\b|\bimport\.meta\.glob\b|\brequire\.context\b|\bnew\s+Function\b|\beval\s*\(/u;
const TS_BARREL = /\bexport\s*(?:\*|\{|type\s*\{)/u;
const PY_IMPORT = /(?:^|[;:])[ \t]*import[ \t]+([^\r\n#;]{1,4096})/gmu;
const PY_FROM = /(?:^|[;:])[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]*(\(|[^\r\n#;]{0,4096})/gmu;
const PY_CALL = /(^|[^.\w])(importlib\.import_module|import_module|__import__|exec|execfile|run_path|run_module|spec_from_file_location|SourceFileLoader|load_source)\s*\(/gmu;
const PY_MODULE = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/u;
const NPM_NAME = /^(?:@[a-z0-9~][\w.~-]*\/)?[a-z0-9~][\w.~-]*$/u;

function literalArgument(text: string, at: number): string | undefined {
  LITERAL_ARG.lastIndex = at;
  const match = LITERAL_ARG.exec(text);
  return match === null ? undefined : (match[2] ?? match[3]);
}
function scanTs(text: string): Imports {
  const found: Imports = { specs: [], python: [], dynamic: TS_DYNAMIC.test(text), unparsed: false, barrel: TS_BARREL.test(text) };
  for (const m of text.matchAll(TS_STATIC)) found.specs.push(m[2]!);
  for (const m of text.matchAll(TS_CALL)) {
    const spec = literalArgument(text, m.index + m[0].length);
    if (spec === undefined) found.dynamic = true; else found.specs.push(spec);
  }
  return found;
}
/** Names of an import list. A piece that is not a plain dotted name (prose, a stray token) makes the file unparsed: never silently dropped. */
function pyNames(list: string, found: Imports): string[] {
  const names: string[] = [];
  for (const part of list.split(",")) {
    const name = part.trim().split(/\s+as\s+/u)[0]!.trim();
    if (name === "" || name === "*") continue;
    if (PY_MODULE.test(name)) names.push(name); else found.unparsed = true;
  }
  return names;
}
/** The body of a parenthesised import list from just after "(": comments are skipped (a ")" inside one does not close it). Undefined if unclosed. */
function pyParenList(text: string, open: number): { body: string; end: number } | undefined {
  let body = "";
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (c === "#") { while (i < text.length && text[i] !== "\n") i++; body += " "; continue; }
    if (c === ")") return { body, end: i };
    if (c === "(" || c === "\"" || c === "'") return undefined;
    body += c;
  }
  return undefined;
}
function scanPython(source: string): Imports {
  const text = source.replace(/\\\r?\n/gu, " ");
  const found: Imports = { specs: [], python: [], dynamic: false, unparsed: false, barrel: false };
  for (const m of text.matchAll(PY_IMPORT)) {
    for (const name of pyNames(m[1]!, found)) found.python.push({ level: 0, module: name, names: [] });
  }
  for (const m of text.matchAll(PY_FROM)) {
    const module = m[2]!;
    if (module !== "" && !PY_MODULE.test(module)) { found.unparsed = true; continue; }
    let list = m[3]!;
    if (list === "(") {
      const paren = pyParenList(text, m.index + m[0].length);
      // An unclosed list stops the scan: the file is unparsed either way, and no later list is rescanned (linear).
      if (paren === undefined) { found.unparsed = true; break; }
      list = paren.body;
    }
    found.python.push({ level: m[1]!.length, module, names: pyNames(list, found) });
  }
  for (const m of text.matchAll(PY_CALL)) {
    const loader = m[2]!;
    const spec = literalArgument(text, m.index + m[0].length);
    if ((loader === "import_module" || loader === "importlib.import_module" || loader === "__import__") && spec !== undefined && PY_MODULE.test(spec)) {
      found.python.push({ level: 0, module: spec, names: [] });
    } else found.dynamic = true;
  }
  return found;
}
/** Python or TS/JS import statements that load code at run time from a computed name. Used on changed files too. */
export function hasDynamicLoad(path: string, text: string): boolean {
  return CODE_PATH.test(path) && (PY_PATH.test(path) ? scanPython(text).dynamic : scanTs(text).dynamic);
}
const READ_CALL = /\b(?:readFileSync|readFile|readTextFile|createReadStream|readdirSync|readdir|opendir|read_text|read_bytes|open|files|file|get_data|resource_string|resource_stream|read_resource|listdir|scandir|iterdir|walk|glob|globSync|sync|rglob|FileSystemLoader|PackageLoader|load_prompt)\s*\(/u;
/** A computed read that may leave the reader's folder: one level up, or from the working directory (the repository root). */
const READ_UP = /\.\.\/|parent\.parent|dirname\(\s*dirname|\bparents\[/u;
const READ_CWD = /\bcwd\s*\(|\bgetcwd\s*\(|Path\.cwd/u;
const LITERAL = /"([^"\\\r\n]{1,512})"|'([^'\\\r\n]{1,512})'|\x60([^\x60\\\r\n]{1,512})\x60/gu;
const PATHISH = /^[\w@.\-/ ]*[A-Za-z][\w@.\-/ ]*$/u;
function pathLiterals(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(LITERAL)) {
    // A computed path (`${dir}/instructions/${r}.md`, f"{base}/prompts/{r}.txt") contributes its static pieces.
    for (const value of (m[1] ?? m[2] ?? m[3])!.split(/\$?\{[^}]{0,512}\}/u)) {
      if (!PATHISH.test(value)) continue;
      const key = value.split("/").filter(part => part !== "" && part !== "." && part !== "..").join("/");
      if (key !== "") out.push(key);
    }
  }
  return out;
}

// ---- path helpers -------------------------------------------------------------------------------------------------------------------------
function dirOf(path: string): string { const i = path.lastIndexOf("/"); return i < 0 ? "" : path.slice(0, i); }
function joinPath(dir: string, rel: string): string | undefined {
  const parts = dir === "" ? [] : dir.split("/");
  for (const part of rel.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") { if (parts.length === 0) return undefined; parts.pop(); } else parts.push(part);
  }
  return parts.join("/");
}
const TS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".d.ts", ".json"];
function tsCandidates(base: string): string[] {
  const out = [base, ...TS_EXTENSIONS.map(e => base + e), ...TS_EXTENSIONS.map(e => `${base}/index${e}`)];
  const swap: Record<string, readonly string[]> = { ".js": [".ts", ".tsx", ".d.ts"], ".jsx": [".tsx"], ".mjs": [".mts", ".d.mts"], ".cjs": [".cts", ".d.cts"] };
  for (const [from, tos] of Object.entries(swap)) if (base.endsWith(from)) for (const to of tos) out.push(base.slice(0, -from.length) + to);
  return out;
}
function packageName(spec: string): string { const parts = spec.split("/"); return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!; }
const BUILTINS = new Set(builtinModules);
/** Strip // and /* comments and trailing commas outside strings, then JSON.parse. Undefined when it still does not parse. */
function looseJson(text: string): unknown {
  let out = ""; let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "\"") { const start = i; i++; while (i < text.length && text[i] !== "\"") i += text[i] === "\\" ? 2 : 1; i++; out += text.slice(start, i); continue; }
    if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c === "/" && text[i + 1] === "*") { const end = text.indexOf("*/", i + 2); i = end < 0 ? text.length : end + 2; continue; }
    out += c; i++;
  }
  try { return JSON.parse(out.replace(/,(\s*[}\]])/gu, "$1")); } catch { return undefined; }
}
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// ---- the walk -----------------------------------------------------------------------------------------------------------------------------
interface Alias { prefix: string; suffix: string; wildcard: boolean; targets: string[] }
interface NodeInfo { edges: string[]; unresolved: boolean; barrel: boolean }

export function aiRelatedSet(snapshot: RepositorySnapshot, limits: AiWalkLimits = AI_WALK_LIMITS): AiRelatedSet {
  try { return walk(snapshot, limits); } catch { return UNKNOWN; }
}

function walk(snapshot: RepositorySnapshot, limits: AiWalkLimits): AiRelatedSet {
  const { paths, removed, text } = snapshot;
  const links = new Set(snapshot.links ?? []);
  if (paths.length + removed.length + links.size > limits.treeEntries) unknown();
  let budget = limits.edges;
  const spend = (n = 1): void => { budget -= n; if (budget < 0) unknown(); };
  let readFiles = 0; let readBytes = 0;
  for (const [, body] of text) { readFiles++; readBytes += body.length; if (body.length > limits.fileBytes) unknown(); }
  if (readFiles > limits.files || readBytes > limits.totalBytes) unknown();

  // Universe, suffix indexes and directory listings, all built in one pass over every path segment.
  const universe = new Set<string>();
  const fileSuffix = new Map<string, string[]>(); const dirSuffix = new Map<string, string[]>(); const underDir = new Map<string, string[]>();
  let segments = 0;
  const push = (map: Map<string, string[]>, key: string, value: string) => { const list = map.get(key); if (list) list.push(value); else map.set(key, [value]); };
  for (const path of [...paths, ...removed, ...links]) {
    if (universe.has(path)) continue;
    universe.add(path);
    let from = 0;
    for (;;) {
      if (++segments > limits.pathSegments) unknown();
      push(fileSuffix, path.slice(from), path);
      const slash = path.indexOf("/", from);
      if (slash < 0) break;
      from = slash + 1;
    }
    for (let dir = dirOf(path); dir !== ""; dir = dirOf(dir)) {
      if (++segments > limits.pathSegments) unknown();
      const fresh = !underDir.has(dir);
      push(underDir, dir, path);
      if (!fresh) continue;
      let at = 0;
      for (;;) {
        if (++segments > limits.pathSegments) unknown();
        push(dirSuffix, dir.slice(at), dir);
        const slash = dir.indexOf("/", at);
        if (slash < 0) break;
        at = slash + 1;
      }
    }
  }
  const exists = (path: string) => universe.has(path);
  const removedSet = new Set(removed);

  // package.json: declared dependencies and workspace packages. tsconfig/jsconfig: paths aliases and baseUrl roots.
  const declared = new Set<string>(); const workspaces = new Map<string, string>(); let manifestUnreadable = false; let anyManifest = false;
  const aliases: Alias[] = []; const baseRoots = new Set<string>();
  for (const [path, body] of text) {
    if (PACKAGE_JSON.test(path)) {
      anyManifest = true;
      const json = looseJson(body);
      if (!isRecord(json)) { manifestUnreadable = true; continue; }
      if (typeof json.name === "string") { workspaces.set(json.name, dirOf(path)); declared.add(json.name); }
      for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
        const deps = json[field];
        if (isRecord(deps)) for (const name of Object.keys(deps)) declared.add(name);
      }
    } else if (TS_CONFIG.test(path)) {
      const json = looseJson(body);
      const options = isRecord(json) && isRecord(json.compilerOptions) ? json.compilerOptions : undefined;
      if (json === undefined) { manifestUnreadable = true; continue; }
      if (options === undefined) continue;
      const base = typeof options.baseUrl === "string" ? joinPath(dirOf(path), options.baseUrl) : dirOf(path);
      if (base === undefined) unknown();
      if (typeof options.baseUrl === "string") baseRoots.add(base!);
      if (isRecord(options.paths)) for (const [pattern, targets] of Object.entries(options.paths)) {
        if (!Array.isArray(targets)) { manifestUnreadable = true; continue; }
        const star = pattern.indexOf("*");
        aliases.push({ prefix: star < 0 ? pattern : pattern.slice(0, star), suffix: star < 0 ? "" : pattern.slice(star + 1), wildcard: star >= 0,
          targets: targets.filter((t): t is string => typeof t === "string").map(t => joinPath(base!, t) ?? unknown()) });
      }
    }
  }

  const nodes = new Map<string, NodeInfo>();
  const PKG = "\0pkg:"; const DIR = "\0dir:";
  const virtual = (key: string, members: () => string[]): string => {
    if (!nodes.has(key)) { const edges = members(); spend(edges.length); nodes.set(key, { edges, unresolved: false, barrel: true }); }
    return key;
  };
  const aliasLike = (spec: string): boolean => /^(?:@\/|~|#)/u.test(spec);
  const resolveTs = (from: string, spec: string): { targets: string[]; unresolved: boolean; alias?: true } => {
    const targets: string[] = [];
    const tryBase = (base: string | undefined): boolean => {
      if (base === undefined) return false;
      let hit = false;
      for (const c of tsCandidates(base)) { spend(); if (exists(c)) { targets.push(c); hit = true; } }
      return hit;
    };
    if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === ".." || spec.startsWith("/")) {
      return { targets, unresolved: !tryBase(spec.startsWith("/") ? joinPath("", spec) : joinPath(dirOf(from), spec)) };
    }
    if (spec.startsWith("node:") || BUILTINS.has(spec) || BUILTINS.has(packageName(spec))) return { targets, unresolved: false };
    let aliased = false; let hit = false;
    for (const alias of aliases) {
      spend();
      if (alias.wildcard ? !(spec.startsWith(alias.prefix) && spec.endsWith(alias.suffix) && spec.length >= alias.prefix.length + alias.suffix.length) : spec !== alias.prefix) continue;
      aliased = true;
      const middle = alias.wildcard ? spec.slice(alias.prefix.length, spec.length - alias.suffix.length) : "";
      for (const target of alias.targets) if (tryBase(target.replace("*", middle))) hit = true;
    }
    for (const root of baseRoots) if (tryBase(joinPath(root, spec))) hit = true;
    const name = packageName(spec);
    const workspace = workspaces.get(name);
    if (workspace !== undefined) {
      targets.push(virtual(PKG + workspace, () => (underDir.get(workspace) ?? []).filter(p => CODE_PATH.test(p) || /\.json$/u.test(p))));
      hit = true;
    }
    if (hit) return { targets, unresolved: false };
    // An alias that maps nowhere could hide a caller of a model-call module, wherever it is: the caller makes the whole answer unknown.
    if (aliased || aliasLike(spec)) return { targets, unresolved: true, alias: true };
    if (!NPM_NAME.test(name)) return { targets, unresolved: false }; // not an import at all (prose such as from 'the docs')
    return { targets, unresolved: !anyManifest || manifestUnreadable || !declared.has(name) };
  };
  const resolvePy = (from: string, imp: PyImport): { targets: string[]; unresolved: boolean } => {
    const targets: string[] = [];
    const add = (list: string[] | undefined) => { if (list) for (const p of list) { spend(); targets.push(p); } };
    const modulePath = imp.module.replace(/\./gu, "/");
    if (imp.level > 0) {
      let dir: string | undefined = dirOf(from);
      for (let up = 1; up < imp.level && dir !== undefined; up++) dir = dir === "" ? undefined : dirOf(dir);
      if (dir === undefined) return { targets, unresolved: true };
      const base = modulePath === "" ? dir : joinPath(dir, modulePath)!;
      const prefix = base === "" ? "" : `${base}/`;
      const candidates = [`${base}.py`, `${base}.pyi`, `${prefix}__init__.py`, `${prefix}__init__.pyi`, ...imp.names.flatMap(n => [`${prefix}${n}.py`, `${prefix}${n}.pyi`, `${prefix}${n}/__init__.py`])];
      for (const c of candidates) { spend(); if (exists(c)) targets.push(c); }
      return { targets, unresolved: targets.length === 0 };
    }
    const parts = modulePath.split("/");
    for (let i = 1; i < parts.length; i++) add(fileSuffix.get(`${parts.slice(0, i).join("/")}/__init__.py`));
    for (const ext of [".py", ".pyi", "/__init__.py", "/__init__.pyi"]) add(fileSuffix.get(modulePath + ext));
    for (const n of imp.names) for (const ext of [".py", ".pyi", "/__init__.py"]) add(fileSuffix.get(`${modulePath}/${n}${ext}`));
    return { targets, unresolved: false }; // not in the repository: an installed package
  };

  // Every code file's edges, once.
  const markerSeeds: string[] = []; const roots = new Set<string>();
  for (const path of universe) {
    if (promptFilePath(path) || AI_FOLDER.test(path)) roots.add(path);
    if (!CODE_PATH.test(path)) continue;
    const body = text.get(path);
    if (body === undefined) {
      // A removed file has no candidate text; a present code file the caller did not read is a broken snapshot.
      if (!removedSet.has(path)) unknown();
      continue;
    }
    if (hasAiMarker(body)) markerSeeds.push(path);
    const python = PY_PATH.test(path);
    const scanned = python ? scanPython(body) : scanTs(body);
    const edges: string[] = []; let unresolved = scanned.dynamic || scanned.unparsed;
    for (const spec of scanned.specs) {
      const r = resolveTs(path, spec);
      if (r.alias) unknown();
      edges.push(...r.targets); unresolved ||= r.unresolved;
    }
    for (const imp of scanned.python) { const r = resolvePy(path, imp); edges.push(...r.targets); unresolved ||= r.unresolved; }
    spend(edges.length + 1);
    nodes.set(path, { edges, unresolved, barrel: scanned.barrel || /(?:^|\/)(?:index\.[cm]?[jt]sx?|__init__\.pyi?)$/u.test(path) });
  }
  // Calls are being evaluated, so model-call code exists. If none was recognised it is somewhere the walk cannot see: unknown.
  if (markerSeeds.length === 0) unknown();
  // Model-call modules: marker files, then barrels/packages that re-export them. Their importers (callers) are roots too.
  const reverse = new Map<string, string[]>();
  for (const [path, node] of nodes) for (const target of node.edges) { spend(); push(reverse, target, path); }
  const modelModules = new Set<string>(markerSeeds);
  const queue = [...markerSeeds];
  while (queue.length > 0) {
    const target = queue.pop()!;
    for (const importer of reverse.get(target) ?? []) {
      spend();
      roots.add(importer); // a direct caller of a model-call module
      if (nodes.get(importer)?.barrel && !modelModules.has(importer)) { modelModules.add(importer); queue.push(importer); }
    }
  }
  for (const m of modelModules) roots.add(m);

  const assetDir = (dir: string): string => virtual(DIR + dir, () => {
    const files = dir === "" ? [...universe] : underDir.get(dir) ?? [];
    spend(files.length);
    return files.filter(f => !CODE_PATH.test(f));
  });
  // Forward closure from the roots, with literal path references (assets and directories) from every reached code file.
  const member = new Set<string>(); const seenLiteral = new Set<string>();
  const todo = [...roots];
  const visit = (path: string) => { if (!member.has(path)) { member.add(path); todo.push(path); } };
  for (const r of roots) member.add(r);
  while (todo.length > 0) {
    const path = todo.pop()!;
    spend();
    if (links.has(path)) unknown();
    const node = nodes.get(path);
    if (node === undefined) continue;
    if (node.unresolved) unknown();
    for (const target of node.edges) { spend(); visit(target); }
    const body = path.startsWith("\0") ? undefined : text.get(path);
    if (body === undefined) continue;
    // A file read by a computed name (join(__dirname, role + ".md"), importlib.resources): every non-code file under the reader's own folder.
    if (READ_CALL.test(body)) {
      spend(); const own = dirOf(path); visit(assetDir(own));
      if (READ_UP.test(body) && own !== "") visit(assetDir(dirOf(own)));
      if (READ_CWD.test(body)) visit(assetDir(""));
    }
    for (const literal of pathLiterals(body)) {
      spend();
      if (seenLiteral.has(literal)) continue;
      seenLiteral.add(literal);
      for (const file of fileSuffix.get(literal) ?? []) { spend(); visit(file); }
      // A named folder (a prompts folder read with readdir): its non-code files. Its code is reached through imports instead.
      for (const dir of dirSuffix.get(literal) ?? []) { spend(); visit(assetDir(dir)); }
    }
  }
  return { known: true, has: (path: string) => member.has(path) };
}
