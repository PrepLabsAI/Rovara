import type { EvidenceRaw } from "@agentx/contracts";
import { lstat, opendir } from "node:fs/promises";
import { openDirectory, readFileIn } from "./candidate-fs.js";
import { withIsolatedGit } from "./isolated-git.js";

export type RepositoryEdges = NonNullable<EvidenceRaw["repositoryEdges"]>;
export type RepositoryEdge = RepositoryEdges["edges"][number];
export interface EdgeRepository { name: string; directory: string; baseCommit: string }
const MANIFESTS = ["package.json", "go.mod", "pyproject.toml", "setup.cfg", "setup.py", "requirements.txt", "requirements-dev.txt", "requirements-test.txt", "pom.xml", "build.gradle", "build.gradle.kts"];
const requirementFile = (name: string) => /^requirements(?:[-_.][A-Za-z0-9_.-]+)?\.(?:txt|in)$/u.test(name);
const manifestFile = (name: string) => MANIFESTS.includes(name) || requirementFile(name);
const UNREADABLE = "dependency manifest unreadable";
const LIMIT = "too many repositories or dependencies; tested separately";
const NODE_NAME = /^(?:@[a-z0-9_-][a-z0-9._-]*\/)?[a-z0-9_-][a-z0-9._-]*$/u;
const GO_NAME = /^[A-Za-z0-9._~/-]+$/u;
const PYTHON_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const ID = /^[A-Za-z0-9@/._~-]{1,200}$/u;
const invalid = (): never => { throw new Error(UNREADABLE); };
const limited = (): never => { throw new Error(LIMIT); };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const array = (value: unknown): boolean => Array.isArray(value);
interface Declaration { name?: string; needs: string[]; paths: string[] }
const empty = (): Declaration => ({ needs: [], paths: [] });
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const normalized = (name: string) => name.toLowerCase().replace(/[-_.]+/gu, "-");
function identifier(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || value.length > 200 || !pattern.test(value) || ["__proto__", "constructor", "prototype"].includes(value)) return invalid();
  return value;
}
function node(text: string): Declaration {
  const value: unknown = JSON.parse(text); if (!record(value)) return invalid();
  const result = empty();
  if (Object.hasOwn(value, "name")) result.name = identifier(value.name, NODE_NAME);
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    if (!Object.hasOwn(value, field)) continue;
    const map = value[field]; if (!record(map)) return invalid();
    for (const [name, version] of Object.entries(map)) { identifier(name, NODE_NAME); if (typeof version !== "string") return invalid(); result.needs.push(name); }
  }
  return result;
}
function go(text: string): Declaration {
  const result = empty(); let block = "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\/\/.*$/u, "").trim(); if (!line) continue;
    if (line === ")") { if (!block) return invalid(); block = ""; continue; }
    const start = /^(require|replace|exclude|retract)\s*\($/u.exec(line);
    if (start) { if (block) return invalid(); block = start[1]!; continue; }
    if (block === "require" || line.startsWith("require ")) {
      const match = /^(\S+)\s+v[^\s()]+$/u.exec(block ? line : line.slice(8).trim());
      if (!match) return invalid(); result.needs.push(identifier(match[1], GO_NAME));
    } else if (line.startsWith("module ")) {
      // The provider spelling must also match MR1's literal module-line reader.
      if (!/^module\s+\S+\s*$/u.test(raw) || result.name !== undefined) return invalid();
      result.name = identifier(line.slice(7).trim(), GO_NAME);
    } else {
      const directive = block ? `${block} ${line}` : line;
      const supported = /^(?:go [0-9]+\.[0-9]+(?:\.[0-9]+)?|toolchain go[0-9]+\.[0-9]+(?:\.[0-9]+)?|replace [A-Za-z0-9._~/-]+(?: v[^\s()]+)? => [A-Za-z0-9._~/-]+(?: v[^\s()]+)?|exclude [A-Za-z0-9._~/-]+ v[^\s()]+|retract v[^\s()]+)$/u.test(directive);
      if (!supported) return invalid();
    }
  }
  if (block) return invalid(); return result;
}
function requirement(value: string, result: Declaration): void {
  const path = /^(?:-e\s+|--editable\s+)?(\.\.\/[A-Za-z0-9._-]+)\/?$/u.exec(value);
  if (path) { result.paths.push(path[1]!); return; }
  const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[A-Za-z0-9_,.-]+\])?(?:\s*(?:===|==|~=|!=|<=|>=|<|>)\s*[A-Za-z0-9.*+!-]+(?:\s*,\s*(?:==|!=|<=|>=|<|>)\s*[A-Za-z0-9.*+!-]+)*)?$/u.exec(value);
  if (!match) return invalid(); result.needs.push(normalized(identifier(match[1], PYTHON_NAME)));
}
function quoted(value: string): string {
  const match = /^(?:"([^"\\\r\n]*)"|'([^'\\\r\n]*)')$/u.exec(value.trim());
  if (!match) return invalid(); return match[1] ?? match[2]!;
}
function strings(value: string): string[] {
  if (!value.startsWith("[") || !value.endsWith("]")) return invalid();
  const body = value.slice(1, -1).trim(); if (!body) return [];
  // Scan once; splitting on commas would corrupt version constraints inside strings.
  const values: string[] = []; const pattern = /\s*("[^"\\]*"|'[^'\\]*')\s*(,|$)/gy; let offset = 0;
  while (offset < body.length) { pattern.lastIndex = offset; const match = pattern.exec(body); if (!match) return invalid(); values.push(quoted(match[1]!)); offset = pattern.lastIndex; }
  return values;
}
function python(files: Map<string, string>): Declaration {
  const result = empty();
  const name = (value: string) => { const next = normalized(identifier(value, PYTHON_NAME)); if (result.name !== undefined && result.name !== next) return invalid(); result.name = next; };
  const project = files.get("pyproject.toml");
  if (project !== undefined) {
    let section = ""; const lines = project.split("\n"); const seen = new Set<string>();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim(); if (!line || line.startsWith("#")) continue;
      if (/^\[[A-Za-z0-9_.-]+\]$/u.test(line)) {
        if (line.startsWith("[project.") || line.startsWith("[tool.poetry")) return invalid();
        section = line; continue;
      }
      const match = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/u.exec(line);
      if (!match || seen.has(`${section}.${match[1]}`)) return invalid(); seen.add(`${section}.${match[1]}`);
      const key = match[1]!; let value = match[2]!;
      if (value.startsWith("[")) {
        const parts = [value];
        while (!parts[parts.length - 1]!.trimEnd().endsWith("]") && i + 1 < lines.length) parts.push(lines[++i]!);
        value = parts.join("\n");
      }
      if (section === "[project]" && key === "dynamic") return invalid();
      if (section === "[project]" && key === "name") name(quoted(value));
      else if (section === "[project]" && key === "dependencies") for (const dependency of strings(value.trim())) requirement(dependency, result);
      else if (value.startsWith("[")) strings(value.trim());
      else if (!/^(?:true|false|[0-9]+(?:\.[0-9]+)?)$/u.test(value)) quoted(value);

    }
  }
  const cfg = files.get("setup.cfg");
  if (cfg !== undefined) {
    let section = ""; let dependencies = false; const seen = new Set<string>();
    for (const raw of cfg.split("\n")) {
      const line = raw.trim(); if (!line || line.startsWith("#") || line.startsWith(";")) continue;
      if (/^\[[A-Za-z0-9_.-]+\]$/u.test(line)) {
        if (line !== "[metadata]" && line !== "[options]") return invalid();
        section = line; dependencies = false; continue;
      }
      if (dependencies && /^\s/u.test(raw)) { requirement(line, result); continue; }
      dependencies = false;
      const match = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/u.exec(line); if (!match) return invalid();
      if (seen.has(`${section}.${match[1]}`)) return invalid(); seen.add(`${section}.${match[1]}`);
      if (!(section === "[metadata]" && ["name", "version", "description"].includes(match[1]!) || section === "[options]" && match[1] === "install_requires")) return invalid();
      if (section === "[metadata]" && match[1] === "name") name(match[2]!);
      if (section === "[options]" && match[1] === "install_requires") { dependencies = true; if (match[2]) requirement(match[2], result); }
    }
  }
  const setup = files.get("setup.py");
  if (setup !== undefined) {
    // This deliberately small literal-only grammar is data inspection, NEVER Python execution.
    const match = /^\s*from setuptools import setup\s+setup\(\s*([\s\S]*?)\s*\)\s*$/u.exec(setup); if (!match) return invalid();
    const fields = match[1]!.split(",").map(s => s.trim()).filter(Boolean); let found = false;
    for (const field of fields) {
      const part = /^(name|version|description)\s*=\s*(.*)$/u.exec(field); if (!part) return invalid();
      const value = quoted(part[2]!); if (part[1] === "name") { if (found) return invalid(); found = true; name(value); }
    }
    if (!found) return invalid();
  }
  for (const file of files.keys()) {
    if (!requirementFile(file)) continue;
    for (const raw of files.get(file)?.split("\n") ?? []) { const line = raw.trim(); if (line && !line.startsWith("#")) requirement(line, result); }
  }
  return result;
}

/** MR3/MR2b must NEVER use an edge's absence from the candidate to skip or narrow tests.
 * The base/candidate union is invocation-scoped fact data, not a selection decision. */
export async function deriveRepositoryEdges(repositories: readonly EdgeRepository[], budget: { signal: AbortSignal; remainingMs(): number }): Promise<RepositoryEdges> {
  const checkTime = () => { if (budget.signal.aborted || budget.remainingMs() <= 0) throw new Error("aborted"); };
  let bytes = 0; let totalBytes = 0; let items = 0; let filesRead = 0; let entries = 0;
  const totalLimit = 2 * 1024 * 1024 + 512 * 1024;
  const chargeMetadata = (size: number) => { totalBytes += size; if (totalBytes > totalLimit) return limited(); };
  const remainingBytes = () => Math.min(2 * 1024 * 1024 - bytes, totalLimit - totalBytes);
  const countEntry = () => { checkTime(); if (++entries > 4096) return limited(); };
  const charge = (buffer: Buffer) => { bytes += buffer.length; chargeMetadata(buffer.length); if (bytes > 2 * 1024 * 1024) return limited(); return buffer.toString("utf8"); };
  const edges = new Map<string, RepositoryEdge>(); const notes = new Set<RepositoryEdges["notes"][number]>();
  try {
    checkTime();
    if (!array(repositories)) return invalid();
    if (repositories.length > 32) return limited();
    const ids = new Set<string>();
    for (const repo of repositories) {
      if (!record(repo) || typeof repo.name !== "string" || !ID.test(repo.name) || typeof repo.directory !== "string" || typeof repo.baseCommit !== "string" || !/^[a-f0-9]{40}$/u.test(repo.baseCommit) || ids.has(repo.name)) return invalid();
      ids.add(repo.name);
    }
    for (const source of ["base", "candidate"] as const) {
      const declarations = new Map<string, Map<string, Declaration>>(); const unsupported = new Map<"maven" | "gradle", number>();
      for (const repo of repositories) {
        checkTime(); const files = new Map<string, string>();
        if (source === "candidate") {
          const directory = await openDirectory(repo.directory);
          try {
            const stream = await opendir(directory.descriptorPath ?? directory.path);
            for await (const entry of stream) {
              countEntry(); chargeMetadata(Buffer.byteLength(entry.name));
              const file = entry.name; if (!manifestFile(file)) continue;
              if (++filesRead > 704) return limited();
              const stat = await lstat(directory.entry(file));
              if (!stat.isFile() || stat.isSymbolicLink()) return invalid();
              if (stat.size > remainingBytes()) return limited();
              const buffer = await readFileIn(directory, file, remainingBytes()).catch(() => invalid());
              if (buffer === undefined) return invalid(); files.set(file, charge(buffer));
            }
          } finally { await directory.close(); }
        } else {
          const directory = await openDirectory(repo.directory);
          try {
            await withIsolatedGit(directory.descriptorPath ?? directory.path, "read", async git => {
              const options = () => ({ signal: budget.signal, timeout: Math.max(1, budget.remainingMs()), maxBuffer: totalLimit - totalBytes + 1 });
              const listing = await git.text(["ls-tree", "-l", "-z", repo.baseCommit], options());
              chargeMetadata(Buffer.byteLength(listing));
              for (const entry of listing.split("\0").filter(Boolean)) {
                countEntry();
                const match = /^([0-9]{6}) (blob|tree|commit) ([a-f0-9]{40}) +([0-9]+|-)\t([\s\S]+)$/u.exec(entry); if (!match) return invalid();
                const file = match[5]!; if (!manifestFile(file)) continue;
                if (++filesRead > 704) return limited();
                if (!/^100(?:644|755)$/u.test(match[1]!) || match[2] !== "blob" || match[4] === "-") return invalid();
                if (Number(match[4]) > remainingBytes()) return limited();
                const buffer = await git.bytes(["cat-file", "blob", match[3]!], options()); files.set(file, charge(buffer));
              }
            });
          } finally { await directory.close(); }
        }
        const parsed = new Map<string, Declaration>();
        if (files.has("package.json")) parsed.set("node", node(files.get("package.json")!));
        if (files.has("go.mod")) parsed.set("go", go(files.get("go.mod")!));
        parsed.set("python", python(files));
        for (const declaration of parsed.values()) { items += declaration.needs.length + declaration.paths.length; if (items > 32_768) return limited(); }
        declarations.set(repo.name, parsed);
        for (const language of ["maven", "gradle"] as const) if (language === "maven" ? files.has("pom.xml") : files.has("build.gradle") || files.has("build.gradle.kts")) unsupported.set(language, (unsupported.get(language) ?? 0) + 1);
      }
      for (const language of ["node", "go", "python"] as const) {
        const providers = new Map<string, string>();
        for (const [id, parsed] of declarations) { const name = parsed.get(language)?.name; if (name === undefined) continue; if (providers.has(name)) throw new Error("ambiguous"); providers.set(name, id); }
        const byDirectory = new Map(repositories.map(repo => [repo.directory, repo.name]));
        for (const repo of repositories) {
          const declared = declarations.get(repo.name)?.get(language); if (!declared) continue;
          const targets = declared.needs.map(name => providers.get(name));
          // Local requirements are matched only to this prepared set; no arbitrary path is opened.
          for (const path of declared.paths) {
            const directory = repo.directory.slice(0, repo.directory.lastIndexOf("/"));
            const target = byDirectory.get(`${directory}/${path.slice(3)}`);
            if (target !== undefined && declarations.get(target)?.get("python")?.name === undefined) return invalid();
            targets.push(target);
          }
          for (const provider of targets) {
            checkTime(); if (provider === undefined || provider === repo.name) continue;
            const key = JSON.stringify([repo.name, provider, language]); const previous = edges.get(key);
            edges.set(key, { consumer: repo.name, provider, language, source: previous !== undefined && previous.source !== source ? "both" : source });
            if (edges.size > 64) return limited();
          }
        }
      }
      for (const [language, count] of unsupported) if (count >= 2) notes.add(`tested separately: no cross-repo wiring for ${language}`);
    }
    checkTime();
    return { edges: [...edges.values()].sort((a, b) => compare(a.consumer, b.consumer) || compare(a.provider, b.provider) || compare(a.language, b.language)), notes: edges.size ? [] : [...notes].sort() };
  } catch (error) {
    checkTime();
    return { edges: [], notes: [error instanceof Error && (error.message === LIMIT || error.message === "ambiguous") ? error.message : UNREADABLE] };
  }
}
