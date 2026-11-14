// Static workspace declarations only: never evaluate repository code or invoke a build tool.
import { posix } from "node:path";
import { boundedReader } from "./index.js";
import { blankBlocks } from "./java.js";
import { blocksBetween } from "./types.js";
import { parseSafeYaml } from "./safe-yaml.js";

const MANIFEST = /(?:^|\/)(?:package\.json|project\.json|pyproject\.toml|pom\.xml|build\.gradle(?:\.kts)?)$/u;
const DEFINITIONS = new Set(["package.json", "pnpm-workspace.yaml", "nx.json", "workspace.json", "turbo.json", "settings.gradle", "settings.gradle.kts", "pyproject.toml", "pom.xml"]);
const invalid = (): never => { throw new Error("Workspace definitions are unsupported or unresolved."); };
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
const strings = (value: unknown): string[] => Array.isArray(value) && value.every((item): item is string => typeof item === "string") ? value : invalid();
const relative = (path: string): boolean => path.length > 0 && path.length <= 512 && !path.startsWith("/") && !/[\\\p{Cc}\p{Cf}]/u.test(path) && !path.split("/").some((part) => part === "" || part === "." || part === "..");

function yaml(text: string): unknown {
  const parsed = parseSafeYaml(text);
  if (!parsed.ok) return invalid();
  return parsed.value.toPlain(parsed.value.document.contents);
}

/** Read a literal string array without treating brackets or comments inside strings as syntax. */
function literalArray(body: string, key: string, required: boolean): string[] {
  const starts = [...body.matchAll(new RegExp(`^[ \\t]*${key}[ \\t]*=`, "gmu"))];
  if (starts.length === 0) return required ? invalid() : [];
  if (starts.length !== 1) return invalid();
  const start = starts[0]!;
  const tail = body.slice(start.index + start[0].length).trimStart();
  if (!tail.startsWith("[")) return invalid();
  let quote = "";
  let comment = false;
  for (let index = 1; index < tail.length; index += 1) {
    const char = tail[index]!;
    if (comment) { if (char === "\n") comment = false; continue; }
    if (quote !== "") {
      if (char === "\\" && quote === '"') index += 1;
      else if (char === quote) quote = "";
    } else if (char === "#") comment = true;
    else if (char === '"' || char === "'") quote = char;
    else if (char === "]") {
      if (!/^[ \t\r]*(?:#[^\n]*)?$/u.test(tail.slice(index + 1).split("\n")[0]!)) return invalid();
      return strings(yaml(tail.slice(0, index + 1)));
    }
  }
  return invalid();
}

/** Literal TOML arrays in the uv workspace table. Other TOML tables are left to their existing detectors. */
function pythonMembers(text: string): { members: string[]; exclude: string[] } | undefined {
  const table = /^[ \t]*\[tool\.uv\.workspace\][ \t]*(?:#[^\n]*)?\r?$/mu.exec(text);
  if (table === null) return undefined;
  const rest = text.slice(table.index + table[0].length);
  const body = rest.split(/^[ \t]*\[[A-Za-z_]/mu)[0]!;
  return { members: literalArray(body, "members", true), exclude: literalArray(body, "exclude", false) };
}

/** undefined means no workspace; an empty/invalid declaration is refused, never guessed from directory names. */
export async function discoverWorkspaceRoots(paths: readonly string[], load: (path: string) => Promise<string | undefined>): Promise<string[] | undefined> {
  const inventory = new Set(paths);
  const metadata = paths.filter((path) => DEFINITIONS.has(path) || (inventory.has("nx.json") && path.endsWith("/project.json")) || path.endsWith("/pom.xml"));
  // Root declarations must remain readable even when unrelated nested examples fill the inventory.
  metadata.sort((left, right) => Number(DEFINITIONS.has(right)) - Number(DEFINITIONS.has(left)));
  const bounded = boundedReader(metadata, load);
  const read = async (path: string): Promise<string> => {
    const text = await bounded.reader.read(path);
    if (text === undefined) throw new Error("Workspace definitions could not be read.");
    return text;
  };
  const candidates = [...new Set(paths.filter((path) => MANIFEST.test(path)).map((path) => posix.dirname(path)))];
  const roots = new Set<string>();
  let workspace = false;
  const add = (root: string): void => {
    if (!candidates.includes(root)) return invalid();
    roots.add(root);
  };
  const expand = (members: string[], exclude: string[] = []): void => {
    workspace = true;
    const positive = members.filter((pattern) => !pattern.startsWith("!"));
    const negative = [...exclude, ...members.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1))];
    for (const pattern of [...positive, ...negative]) if (pattern !== "." && !relative(pattern)) return invalid();
    for (const pattern of positive) {
      const matches = candidates.filter((root) => posix.matchesGlob(root, pattern));
      if (matches.length === 0) return invalid();
      for (const root of matches) if (!negative.some((pattern) => posix.matchesGlob(root, pattern))) add(root);
    }
  };

  if (inventory.has("pnpm-workspace.yaml")) expand(strings(object(yaml(await read("pnpm-workspace.yaml")))["packages"]));
  if (inventory.has("package.json")) {
    const manifest = object(JSON.parse(await read("package.json")) as unknown);
    if (Object.hasOwn(manifest, "workspaces") && !inventory.has("pnpm-workspace.yaml")) {
      const value = manifest["workspaces"];
      expand(strings(Array.isArray(value) ? value : object(value)["packages"]));
    }
  }
  if (inventory.has("nx.json")) {
    if (bounded.truncated) return invalid();
    object(JSON.parse(await read("nx.json")) as unknown);
    workspace = true;
    if (inventory.has("workspace.json")) {
      const projects = object(object(JSON.parse(await read("workspace.json")) as unknown)["projects"]);
      for (const project of Object.values(projects)) {
        const root = typeof project === "string" ? project : object(project)["root"];
        if (typeof root !== "string") return invalid();
        add(root);
      }
    }
    for (const path of metadata.filter((path) => path.endsWith("/project.json"))) {
      object(JSON.parse(await read(path)) as unknown);
      add(posix.dirname(path));
    }
  }
  if (inventory.has("turbo.json")) {
    object(JSON.parse(await read("turbo.json")) as unknown);
    if (!workspace) return invalid(); // Turbo takes its package roots from the package manager.
  }
  for (const path of ["settings.gradle", "settings.gradle.kts"]) {
    if (!inventory.has(path)) continue;
    const text = blankBlocks(await read(path), "/*", "*/").replace(/\/\/[^\n]*/gu, "");
    if (/\b(?:projectDir|includeBuild)\b/u.test(text)) return invalid();
    for (const match of text.matchAll(/\binclude\s*(\([^)]*\)|[^\n;]*)/gu)) {
      workspace = true;
      const body = match[1]!.replace(/^\(|\)$/gu, "").trim();
      if (!/^["'][^"'\n]+["'](?:\s*,\s*["'][^"'\n]+["'])*\s*,?$/u.test(body)) return invalid();
      for (const item of body.matchAll(/["']([^"']+)["']/gu)) add(item[1]!.replace(/^:/u, "").replaceAll(":", "/"));
    }
  }
  if (inventory.has("pom.xml")) {
    const queue = ["pom.xml"];
    for (const path of queue) {
      const text = blankBlocks(await read(path), "<!--", "-->");
      const blocks = blocksBetween(text, "<modules>", "</modules>");
      if (blankBlocks(text, "<modules>", "</modules>").includes("<modules")) return invalid();
      if (blocksBetween(text, "<profiles>", "</profiles>").some((block) => block.inner.includes("<modules"))) return invalid();
      for (const block of blocks) {
        workspace = true;
        const body = block.inner;
        if (body.replace(/<module>[^<]+<\/module>/gu, "").trim() !== "") return invalid();
        for (const item of body.matchAll(/<module>([^<]+)<\/module>/gu)) {
          const name = item[1]!.trim();
          if (!relative(name) || /[${}]/u.test(name)) return invalid();
          const root = posix.join(posix.dirname(path), name);
          add(root);
          const child = `${root}/pom.xml`;
          if (!inventory.has(child)) return invalid();
          if (!queue.includes(child)) queue.push(child);
        }
      }
    }
  }
  if (inventory.has("pyproject.toml")) {
    const members = pythonMembers(await read("pyproject.toml"));
    if (members !== undefined) expand(members.members, members.exclude);
  }
  if (!workspace) return undefined;
  if (paths.some((path) => !relative(path))) return invalid();
  if (roots.size === 0) return invalid();
  // Preserve the root package's own commands, while excluding every child unit from its reader.
  if (candidates.includes(".")) roots.add(".");
  return [...roots].sort();
}
