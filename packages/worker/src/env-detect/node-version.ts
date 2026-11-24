// Which Node the sandbox runs a repository's commands with (lane E, "Node 24 per repo"). The worker image carries two: Node 22 (the default, on PATH) and Node 24 (/opt/rovara/node/24, environments/base/Dockerfile).
// A repository's own files say which it needs: .nvmrc, .node-version, .tool-versions (the `nodejs` or `node` line), package.json `volta.node` and `engines.node`. Pure over a bounded reader: nothing is run or downloaded.
//
// The rule, in full:
//  1. Each hint is turned into the set of OFFERED majors that satisfy it. A pin file (.nvmrc, .node-version, .tool-versions, volta) naming a version, however precise (`24.21.0`, `v22`, `22.x`), is a pin on that
//     MAJOR, because the image carries one version of each major. `engines.node` is a semver range, judged against the versions the image really carries (so `^22.30.0` is not met by 22.23.2); an exact version in
//     `engines.node` also counts by its major. The aliases `lts/*`, `node`, `stable`, `latest`, `lts`, `current` are met by either major; `lts/<codename>` and `lts/-N` name a major.
//  2. A hint no offered major satisfies (`>=26`) is UNSATISFIABLE: one plain line says so, and the hint is left out of the choice.
//  3. Of the rest, the LOWEST offered major that satisfies all of them wins. When they disagree (none satisfies all of them), the STRICTEST wins: the highest of the lowest majors each one allows.
//  4. No usable hint: Node 22, the default.
import type { DetectedSource, RepositoryReader } from "./types.js";
import { findLine } from "./types.js";

/** What the image carries: the default, and the per-repo one. The versions are the ones in environments/base/Dockerfile (a contract test keeps them equal). */
export const OFFERED_NODE = [{ major: 22, version: "22.23.2" }, { major: 24, version: "24.22.3" }] as const;
export type OfferedNodeMajor = (typeof OFFERED_NODE)[number]["major"];
export const DEFAULT_NODE_MAJOR: OfferedNodeMajor = 22;

export type NodeHintKind = ".nvmrc" | ".node-version" | ".tool-versions" | "volta.node" | "engines.node";
export interface NodeHint { kind: NodeHintKind; spec: string; source: DetectedSource }
export interface NodeChoice {
  major: OfferedNodeMajor;
  /** True when at least one hint was read (a repository with none gets the default, and nothing is said about it). */
  hinted: boolean;
  /** The hint that decided it (absent: the default). */
  source?: DetectedSource;
  /** Plain statements for the maintainer, fixed words (a spec is quoted only when it parsed as a version or range). */
  notes: string[];
}

// ---- versions and ranges

type Version = readonly [number, number, number];
const compare = (a: Version, b: Version): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
interface Comparator { op: "<" | "<=" | ">" | ">=" | "="; version: Version }
type Range = Comparator[][];

const WILD = /^[xX*]$/u;
const NUMBER = /^(?:0|[1-9]\d{0,8})$/u;
/** `1`, `1.2`, `1.2.3`, with x, X or * for a missing part, a `v` or `=` prefix, and a pre-release or build tail ignored. Undefined when it is not a version. */
function partial(text: string): { major: number; minor?: number; patch?: number } | undefined {
  // A pre-release or build tail is semver's own charset only; anything else (`26.0.0-<x>`) is not a version.
  const tail = /[-+](.*)$/u.exec(text)?.[1];
  if (tail !== undefined && !/^[0-9A-Za-z.+-]{0,32}$/u.test(tail)) return undefined;
  const cleaned = text.replace(/^[v=]+/u, "").replace(/[-+].*$/u, "");
  const parts = cleaned.split(".");
  if (parts.length === 0 || parts.length > 3 || parts[0] === "") return undefined;
  const numbers: Array<number | undefined> = [];
  for (const [index, part] of parts.entries()) {
    if (WILD.test(part)) { numbers.push(undefined); continue; }
    if (!NUMBER.test(part) || (numbers.length > 0 && numbers[index - 1] === undefined)) return undefined;
    numbers.push(Number(part));
  }
  if (numbers[0] === undefined) return undefined;
  return { major: numbers[0], ...(numbers[1] === undefined ? {} : { minor: numbers[1] }), ...(numbers[2] === undefined ? {} : { patch: numbers[2] }) };
}

const lower = (p: { major: number; minor?: number; patch?: number }): Version => [p.major, p.minor ?? 0, p.patch ?? 0];
/** The version just past everything the partial covers: `1` -> 2.0.0, `1.2` -> 1.3.0, `1.2.3` -> 1.2.4. */
const above = (p: { major: number; minor?: number; patch?: number }): Version => p.minor === undefined ? [p.major + 1, 0, 0] : p.patch === undefined ? [p.major, p.minor + 1, 0] : [p.major, p.minor, p.patch + 1];

type Partial3 = { major: number; minor?: number; patch?: number };
const between = (from: Version, to: Version): Comparator[] => [{ op: ">=", version: from }, { op: "<", version: to }];

/** `^`: changes that keep the left-most non-zero part. */
function caretRange(p: Partial3): Comparator[] {
  const [major, minor, patch] = lower(p);
  if (major > 0) return between([major, minor, patch], [major + 1, 0, 0]);
  if (p.minor === undefined) return between([0, 0, 0], [1, 0, 0]);
  if (minor > 0 || p.patch === undefined) return between([0, minor, patch], [0, minor + 1, 0]);
  return between([0, 0, patch], [0, 0, patch + 1]);
}

/** The comparators of one operator applied to a parsed version (`""` and `=` are an exact or a partial version). */
function operatorRange(op: string, p: Partial3): Comparator[] {
  if (op === "^") return caretRange(p);
  if (op === "~" || op === "~>") return between(lower(p), p.minor === undefined ? [p.major + 1, 0, 0] : [p.major, p.minor + 1, 0]);
  if (op === ">=") return [{ op: ">=", version: lower(p) }];
  if (op === ">") return [{ op: ">=", version: above(p) }];
  if (op === "<") return [{ op: "<", version: lower(p) }];
  if (op === "<=") return [{ op: "<", version: above(p) }];
  // No operator, or `=`: a whole version is that version; a partial one is everything it covers.
  return p.patch === undefined ? between(lower(p), above(p)) : [{ op: "=", version: lower(p) }];
}

/** One simple term (`^1.2`, `>=22`, `~24.1.0`, `22.x`, `*`) as comparators ANDed together, or undefined when it is not one. */
function term(raw: string): Comparator[] | undefined {
  const match = /^(\^|~>?|>=|<=|>|<|=)?\s*(\S*)$/u.exec(raw);
  if (match === null) return undefined;
  const op = match[1] ?? "";
  const text = match[2]!;
  if (text === "") return undefined;
  if (WILD.test(text)) return op === "<" || op === ">" ? undefined : [];
  const p = partial(text);
  return p === undefined ? undefined : operatorRange(op, p);
}

/** The comparators of one `||` alternative (its words ANDed, `A - B` hyphen ranges included), or undefined when a word is not a term. */
function parseAlternative(piece: string): Comparator[] | undefined {
  // `>= 22` (a space after the operator) is one term.
  const words = piece.trim().replace(/(\^|~>?|>=|<=|>|<|=)\s+/gu, "$1").split(/\s+/u).filter((word) => word !== "");
  const comparators: Comparator[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    if (words[index + 1] === "-" && words[index + 2] !== undefined) {
      const low = partial(word);
      const high = partial(words[index + 2]!);
      if (low === undefined || high === undefined) return undefined;
      comparators.push({ op: ">=", version: lower(low) }, { op: "<", version: above(high) });
      index += 2;
      continue;
    }
    const parsed = term(word);
    if (parsed === undefined) return undefined;
    comparators.push(...parsed);
  }
  return comparators;
}

/** An npm-style range: terms joined by spaces (AND), alternatives joined by `||` (OR), and `A - B` hyphen ranges. Undefined when any part is not one. */
export function parseNodeRange(spec: string): Range | undefined {
  if (spec.length === 0 || spec.length > 200) return undefined;
  const alternatives: Range = [];
  for (const piece of spec.split("||")) {
    const comparators = parseAlternative(piece);
    if (comparators === undefined) return undefined;
    alternatives.push(comparators);
  }
  return alternatives;
}

const parseVersion = (text: string): Version => text.split(".").map(Number) as unknown as Version;
function satisfies(range: Range, version: Version): boolean {
  return range.some((all) => all.every((comparator) => {
    const order = compare(version, comparator.version);
    switch (comparator.op) {
      case ">=": return order >= 0;
      case ">": return order > 0;
      case "<=": return order <= 0;
      case "<": return order < 0;
      case "=": return order === 0;
    }
  }));
}

// ---- hints

const ANY: readonly OfferedNodeMajor[] = OFFERED_NODE.map((offered) => offered.major);
/** The LTS majors, newest first: `lts/-1` is the one before the newest. */
const LTS_MAJORS = [26, 24, 22, 20, 18, 16, 14, 12, 10, 8, 6, 4] as const;
const LTS_CODENAMES: Readonly<Record<string, number>> = { argon: 4, boron: 6, carbon: 8, dubnium: 10, erbium: 12, fermium: 14, gallium: 16, hydrogen: 18, iron: 20, jod: 22, krypton: 24, lithium: 26 };
const ALIASES = new Set(["node", "stable", "latest", "current", "lts", "lts/*", "lts/latest"]);
const forMajor = (major: number): readonly OfferedNodeMajor[] => ANY.filter((offered) => offered === major);

/** The offered majors for `lts/-N` (`relative`, the digits) or `lts/<codename>` (`name`); undefined when it names nothing. */
function ltsMajors(relative: string | undefined, name: string | undefined): readonly OfferedNodeMajor[] | undefined {
  if (relative !== undefined) {
    const major = relative.startsWith("-") ? LTS_MAJORS[Number(relative.slice(1))] : undefined;
    return major === undefined ? undefined : forMajor(major);
  }
  const named = LTS_CODENAMES[name!];
  return named === undefined ? undefined : forMajor(named);
}

/** The offered majors that satisfy one hint; undefined when the spec cannot be read at all. `pin` is a pin file's value (a version is a pin on its major), `engines` a package.json range. */
export function majorsFor(spec: string, pin: boolean): readonly OfferedNodeMajor[] | undefined {
  const text = spec.trim().toLowerCase();
  if (ALIASES.has(text)) return ANY;
  const lts = /^lts[/-](?:(-?\d{1,2})|([a-z]{3,12}))$/u.exec(text);
  if (lts !== null) return ltsMajors(lts[1], lts[2]);
  const range = parseNodeRange(text);
  if (range === undefined) return undefined;
  // An exact version (`24.21.0`, `v22`) is a pin on its major; so is a bare `22.x` in a pin file or a range with no operator.
  const exact = /^v?(\d{1,9})(?:\.(?:\d{1,9}|[xX*])){0,2}$/u.exec(text);
  if (exact !== null && (pin || /^v?\d{1,9}\.\d{1,9}\.\d{1,9}$/u.test(text))) return forMajor(Number(exact[1]));
  return OFFERED_NODE.filter((offered) => satisfies(range, parseVersion(offered.version))).map((offered) => offered.major);
}

/** `nodejs 22.3.0 20.1.0` (the first version is the one that is used): the spec of the `nodejs` or `node` line, with its line number. */
function toolVersionsSpec(text: string): { spec: string; line: number } | undefined {
  const lines = text.split(/\r\n|\r|\n/u);
  for (const [index, raw] of lines.entries()) {
    const words = raw.replace(/#.*$/u, "").trim().split(/\s+/u);
    if ((words[0] === "nodejs" || words[0] === "node") && words[1] !== undefined) return { spec: words[1], line: index + 1 };
  }
  return undefined;
}

const at = (directory: string, name: string): string => (directory === "" ? name : `${directory}/${name}`);
const asObject = (value: unknown): Record<string, unknown> | undefined => (value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined);
type HintReader = Pick<RepositoryReader, "paths" | "read">;

/** The hint of a pin file (`.nvmrc`, `.node-version`): its first line with something on it. */
async function pinFileHint(repo: HintReader, directory: string, kind: ".nvmrc" | ".node-version"): Promise<NodeHint | undefined> {
  if (!repo.paths.includes(at(directory, kind))) return undefined;
  const text = await repo.read(at(directory, kind));
  if (text === undefined) return undefined;
  const lines = text.split(/\r\n|\r|\n/u).map((line) => line.replace(/#.*$/u, "").trim());
  const line = lines.findIndex((candidate) => candidate !== "");
  return line >= 0 ? { kind, spec: lines[line]!, source: { path: at(directory, kind), line: line + 1 } } : undefined;
}

async function toolVersionsHint(repo: HintReader, directory: string): Promise<NodeHint | undefined> {
  if (!repo.paths.includes(at(directory, ".tool-versions"))) return undefined;
  const text = await repo.read(at(directory, ".tool-versions"));
  const found = text === undefined ? undefined : toolVersionsSpec(text);
  return found === undefined ? undefined : { kind: ".tool-versions", spec: found.spec, source: { path: at(directory, ".tool-versions"), line: found.line } };
}

/** The `volta.node` and `engines.node` hints of a package.json. */
async function packageJsonHints(repo: HintReader, directory: string): Promise<NodeHint[]> {
  if (!repo.paths.includes(at(directory, "package.json"))) return [];
  const text = await repo.read(at(directory, "package.json"));
  if (text === undefined) return [];
  let manifest: unknown;
  try { manifest = JSON.parse(text); } catch { manifest = undefined; }
  const volta = asObject(asObject(manifest)?.["volta"])?.["node"];
  const engines = asObject(asObject(manifest)?.["engines"])?.["node"];
  const path = at(directory, "package.json");
  const hints: NodeHint[] = [];
  if (typeof volta === "string") hints.push({ kind: "volta.node", spec: volta, source: { path, line: findLine(text, /"volta"\s{0,40}:/u) ?? 1 } });
  if (typeof engines === "string") hints.push({ kind: "engines.node", spec: engines, source: { path, line: findLine(text, /"engines"\s{0,40}:/u) ?? 1 } });
  return hints;
}

/** The hints a repository's files give, in the order they decide ties: the version-manager files, then volta, then engines. `directory` is "" for the repository root. */
export async function readNodeHints(repo: HintReader, directory = ""): Promise<NodeHint[]> {
  const hints: NodeHint[] = [];
  for (const kind of [".nvmrc", ".node-version"] as const) {
    const hint = await pinFileHint(repo, directory, kind);
    if (hint !== undefined) hints.push(hint);
  }
  const toolVersions = await toolVersionsHint(repo, directory);
  if (toolVersions !== undefined) hints.push(toolVersions);
  hints.push(...await packageJsonHints(repo, directory));
  return hints;
}

/**
 * The spec as it may be quoted in a note: only a spec that parsed as a version or range reaches here, and even then a pre-release or build tail (`-rc.1`, free text of semver's charset) is left out, so what is
 * quoted holds version characters, range operators and spaces and nothing else. Anything else is described, not quoted.
 */
const quoted = (spec: string): string => {
  const plain = spec.trim().replace(/\s+/gu, " ").replace(/([0-9xX*])[-+][0-9A-Za-z.+-]*/gu, "$1");
  return /^[0-9xXv.*^~<>=| -]{1,60}$/u.test(plain) ? plain : "an unsupported version";
};

/** Chooses the Node for a repository from its hints (the rule at the top of this file). Pure. */
export function chooseNode(hints: readonly NodeHint[]): NodeChoice {
  const notes: string[] = [];
  const usable: Array<{ hint: NodeHint; majors: readonly OfferedNodeMajor[] }> = [];
  let unsatisfiable: NodeHint | undefined;
  let unreadable = false;
  for (const hint of hints) {
    const majors = majorsFor(hint.spec, hint.kind !== "engines.node");
    if (majors === undefined) { unreadable = true; continue; }
    if (majors.length === 0) { unsatisfiable ??= hint; continue; }
    usable.push({ hint, majors });
  }
  if (unsatisfiable !== undefined) notes.push(`Rovara offers Node ${OFFERED_NODE.map((offered) => String(offered.major)).join(" and ")}; this repo asks for ${quoted(unsatisfiable.spec)}.`);
  if (unreadable) notes.push("A Node version setting in this repository could not be read, so it was not used.");
  if (usable.length === 0) return { major: DEFAULT_NODE_MAJOR, hinted: hints.length > 0, notes };
  const common = ANY.filter((major) => usable.every((entry) => entry.majors.includes(major)));
  let major: OfferedNodeMajor;
  if (common.length > 0) major = common[0]!;
  else {
    major = Math.max(...usable.map((entry) => Math.min(...entry.majors))) as OfferedNodeMajor;
    notes.push("This repository's Node version files disagree; the newest Node they ask for is used.");
  }
  const decider = usable.find((entry) => entry.majors.includes(major) && Math.min(...entry.majors) === major) ?? usable.find((entry) => entry.majors.includes(major))!;
  return { major, hinted: true, source: decider.hint.source, notes };
}

/** Reads a repository's hints and chooses. `directory` is where to look, relative to the reader's root ("" for the root). */
export async function detectNodeMajor(repo: Pick<RepositoryReader, "paths" | "read">, directory = ""): Promise<NodeChoice> {
  return chooseNode(await readNodeHints(repo, directory));
}
