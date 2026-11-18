// Knowledge resolver (K1, C4): skills from the meta repo.
//
// R4: Rovara reads meta-repo skills itself, at the pinned `knowledgeCommit`, and pins them by digest. Pi's own skill discovery stays off.
// A skill grants nothing:
// - `allowed-tools` is never read, and its line is removed from the text the session sees;
// - shell pre-run lines (!`cmd`) are removed, so nothing in a skill runs when it loads;
// - scripts in a skill folder are files the agent may read; running one is an ordinary sandboxed command under the usual policy;
// - the result is `AgentSkillFile`s, which carry a name, a description, a digest and text, and no tool list at all.
// Only `name` and `description` sit in the prompt until the model calls `read_skill`. At most 32 skills a stage; skills in code repositories
// are not read (Q8).
import { createHash } from "node:crypto";
import { MAX_META_SKILLS, RovaraSkillsPayloadSchema, type MetaSkillPin, type MetaSkillSkipReason, type MetaSkillSnapshot } from "@agentx/contracts";
import { inertContextText } from "../context-text.js";
import type { AgentSkillFile } from "../agent-step.js";
import { parseFrontMatter } from "./frontmatter.js";
import { createReaderRegistry, type ReaderRegistry } from "./registry.js";
import type { KnowledgeFileSource } from "./source.js";

/** Matches the limit `materializeSkills` enforces on a skill's text. */
export const SKILL_TEXT_MAX_BYTES = 32_768;
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const SKILL_FILE = "SKILL.md";

export interface MetaSkillSkip { path: string; reason: MetaSkillSkipReason }

export interface MetaSkills {
  skills: AgentSkillFile[];
  snapshots: MetaSkillSnapshot[];
  skipped: MetaSkillSkip[];
}

/** Text with the shell pre-run syntax removed: a `!` followed by a backtick span, wherever it sits, and a front-matter `allowed-tools` line. */
export function stripSkillExecution(text: string): string {
  const withoutPreRun = text.replace(/\r\n?/gu, "\n").replace(/!`[^`\n]*`/gu, "").replace(/^[ \t]*!`.*$/gmu, "");
  // Only the front matter's key is removed; a body that mentions the words is left alone.
  const match = /^---[ \t]*\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)/u.exec(withoutPreRun);
  if (match === null) return withoutPreRun;
  const header = match[1]!.split("\n").filter((line) => !/^[ \t]*allowed-tools[ \t]*:/iu.test(line)).join("\n");
  return `${withoutPreRun.slice(0, match.index)}---\n${header}\n---\n${withoutPreRun.slice(match.index + match[0].length)}`;
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

export async function loadMetaSkills(input: {
  source: KnowledgeFileSource;
  /** The meta repository's name and the commit the source reads. */
  repo: string;
  commit: string;
  directories?: readonly string[];
  pins?: readonly MetaSkillPin[];
  /** Where each format keeps skills when the project names no folders (the readers know; nothing here does). */
  registry?: ReaderRegistry;
}): Promise<MetaSkills> {
  const skills: AgentSkillFile[] = [];
  const snapshots: MetaSkillSnapshot[] = [];
  const skipped: MetaSkillSkip[] = [];
  const names = new Set<string>();
  const pinned = new Map((input.pins ?? []).map((pin) => [pin.path, pin.digest] as const));
  let listings = 0;
  for (const directory of (input.directories ?? (input.registry ?? createReaderRegistry()).skillDirectories()).map((path) => path.replace(/\/+$/u, ""))) {
    const entries = (await input.source.listDirectory(directory))?.toSorted((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries ?? []) {
      if (entry.kind !== "dir") continue;
      listings += 1;
      const folder = `${directory}/${entry.name}`;
      if (skills.length >= MAX_META_SKILLS || listings > MAX_META_SKILLS * 4) {
        skipped.push({ path: folder, reason: "over_cap" });
        continue;
      }
      const read = await input.source.readFile(`${folder}/${SKILL_FILE}`, SKILL_TEXT_MAX_BYTES);
      if (read.kind === "missing") continue;
      if (read.kind === "too_large") { skipped.push({ path: folder, reason: "too_large" }); continue; }
      if (read.kind === "symlink") { skipped.push({ path: folder, reason: "symlink" }); continue; }
      if (read.kind !== "file") { skipped.push({ path: folder, reason: "unreadable" }); continue; }
      const text = stripSkillExecution(inertContextText(read.content).text);
      if (Buffer.byteLength(text, "utf8") > SKILL_TEXT_MAX_BYTES) { skipped.push({ path: folder, reason: "too_large" }); continue; }
      const parsed = parseFrontMatter(text);
      if (!parsed.ok) { skipped.push({ path: folder, reason: "bad_front_matter" }); continue; }
      const name = typeof parsed.data.name === "string" && parsed.data.name !== "" ? parsed.data.name : entry.name;
      const description = typeof parsed.data.description === "string" ? parsed.data.description : "";
      if (!NAME.test(name) || [...description].length > 1024) { skipped.push({ path: folder, reason: "bad_name" }); continue; }
      if (names.has(name)) { skipped.push({ path: folder, reason: "duplicate_name" }); continue; }
      const digest = sha256(text);
      const expected = pinned.get(folder);
      // When the broker pinned skills, only pinned folders load: a folder added after the pin is left out.
      if (pinned.size > 0 && expected === undefined) { skipped.push({ path: folder, reason: "not_pinned" }); continue; }
      if (expected !== undefined && expected !== digest) { skipped.push({ path: folder, reason: "digest_mismatch" }); continue; }
      names.add(name);
      skills.push({ name, description, digest, content: text });
      snapshots.push({ source: "meta", repo: input.repo, path: folder, commit: input.commit, digest });
    }
  }
  return { skills, snapshots, skipped };
}

/**
 * The skills a session gets: the step's own first, then the meta repo's, then Rovara's own (L4-AK3). A name already taken by an earlier source leaves the later one out, so the meta repo's skill wins over a Rovara skill
 * of the same name; `onClash` is told each Rovara skill that was left out for that reason (the session says so in its diagnostics).
 */
export function mergeSkills(own: readonly AgentSkillFile[] | undefined, meta: readonly AgentSkillFile[], rovara: readonly AgentSkillFile[] = [], onClash?: (name: string) => void): AgentSkillFile[] | undefined {
  if (own === undefined && meta.length === 0 && rovara.length === 0) return undefined;
  const taken = new Set((own ?? []).map((skill) => skill.name));
  const metaKept = meta.filter((skill) => !taken.has(skill.name));
  for (const skill of metaKept) taken.add(skill.name);
  const rovaraKept = rovara.filter((skill) => {
    if (!taken.has(skill.name)) { taken.add(skill.name); return true; }
    onClash?.(skill.name);
    return false;
  });
  return [...(own ?? []), ...metaKept, ...rovaraKept];
}

/**
 * The Rovara skills a step was sent (`payload.rovaraSkills`, L4-AK3), as skill files for the same `read_skill` path: each checked against the digest the broker sent (a text that does not match is left out), its pre-run
 * lines and tool grant removed and its hidden characters stripped as for a meta-repo skill, and its digest taken again over the text the session is given (`read_skill` checks that one). Only for the modes that read skills (plan and
 * build). Anything that does not parse leaves out the whole set: never a part. A skill grants nothing.
 */
export function rovaraSkillFiles(raw: unknown, mode: string | undefined): AgentSkillFile[] {
  if (raw === undefined || (mode !== "PLAN" && mode !== "IMPLEMENT")) return [];
  const parsed = RovaraSkillsPayloadSchema.safeParse(raw);
  if (!parsed.success) return [];
  const files: AgentSkillFile[] = [];
  for (const skill of parsed.data) {
    if (sha256(skill.content) !== skill.digest) continue;
    const text = stripSkillExecution(inertContextText(skill.content).text);
    if (text.trim() === "" || Buffer.byteLength(text, "utf8") > SKILL_TEXT_MAX_BYTES) continue;
    files.push({ name: skill.name, description: inertContextText(skill.description).text.replace(/\s*\n\s*/gu, " ").trim() || skill.name, digest: sha256(text), content: text });
  }
  return files;
}
