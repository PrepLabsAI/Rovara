// Meta repo lane B (K1, task B1): reading a setup agent's answer as a `SetupProposal`. The answer is MODEL OUTPUT built from files an outsider may have written (a README, a
// Makefile, an MCP config), so it is a proposal and nothing more. The worker runs this on what the model said and the broker runs it again on what the worker reported (the
// broker never trusts the worker's copy), so both sides read an answer the same way. Reading is idempotent: reading a proposal this function returned gives the same proposal.
//
// What it guarantees about the proposal it returns:
//   - every item carries at least one citation that parses (provenance.ts); an item with none is left out and counted in the notes;
//   - ids are assigned here, from the item's kind and key; the model's ids, risks and commits are ignored (a commit is the worker's, from what it cloned);
//   - the risk of an item is `setupItemRisk`, never the model's;
//   - texts are redacted and cut; a quote is a single line of at most 200 characters, and is dropped altogether from secrets, sources and intake (a quote of `KEY=value` is a leak);
//   - a command with a control or format character is left out; a command that can run is written as the executor will run it; a command that fetches code and runs it is
//     NEVER an item: it is listed in `flaggedCommands`, whatever the model said (`remoteCodeReason` decides, and the model may only add caution);
//   - a secret is a NAME; a name that looks like a token is left out; a domain is one the project settings accept; a dev container is a devcontainer.json inside a known repository.
import { isAllowedDomain } from "./app-projects.js";
import { FILE_PROVENANCE_KINDS, PROVENANCE_NOTE_MAX, PROVENANCE_QUOTE_MAX, PROVENANCE_PER_ITEM_MAX, ProvenanceSchema, type Provenance, type ProposalRisk } from "./provenance.js";
import { RelativeWorkspacePathSchema } from "./project.js";
import { IntakeSystemSchema } from "./intake.js";
import { redactText } from "./redaction.js";
import {
  DEVCONTAINER_PATH_PATTERN, SETUP_COMMANDS_MAX, SETUP_DEVCONTAINER_MAX_BYTES, SETUP_INTAKE_CHANNELS, SETUP_ITEM_LIMITS, SETUP_KNOWLEDGE_ACTIVATIONS, SETUP_KNOWLEDGE_KINDS, SETUP_PROPOSAL_VERSION, SETUP_SOURCE_FOUND_IN,
  SETUP_SPEC_FORMATS, SetupProposalSchema, SetupRepositoryValueSchema, setupItemRisk, type SetupItemKind, type SetupProposal,
} from "./setup-proposal.js";
import { isObject, oneLineText, readCommand, readCommands, remoteCodeReason, secretNameOf, utf8Bytes } from "./setup-draft.js";

/** The label a worker puts on the fenced block that carries its answer. */
export const SETUP_PROPOSAL_INFO_STRING = "agentx-setup-proposal";
/** The raw answer a proposal is read from is never larger than this. */
export const SETUP_PROPOSAL_ANSWER_MAX_BYTES = 262_144;

export interface SetupProposalContext {
  /** The project revision the proposal was made for: the caller's, never the model's. */
  basedOnRevision: number;
  /**
   * The project's repositories as the reader knows them. `commit` (the worker's: what it cloned) replaces any commit a citation names; the broker has none and keeps the
   * worker's. `url`, when known, lets a proposal to "add" a repository the project already has be left out.
   */
  repositories: ReadonlyArray<{ name: string; commit?: string | undefined; url?: string | undefined }>;
  /** The meta repository, when the project has one: its name and the commit the agent read it at. */
  metaRepo?: { name: string; commit: string } | undefined;
}

export type SetupProposalReading = { ok: true; proposal: SetupProposal } | { ok: false; errors: string[] };

const HEX_COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
/** Citations of these kinds never carry a quote: a quote of a secret, a source's config or a trigger could carry a value. */
const NO_QUOTE_KINDS: ReadonlySet<SetupItemKind> = new Set(["secret", "source", "intake"]);
/** The citation kinds a model may use. `person` and `connector` are the broker's: an agent has no connector and is not a person. */
const MODEL_CITATION_KINDS = ["file", "ci", "readme", "manifest", "inferred"] as const;
const CONFIDENCES = ["high", "medium", "low"] as const;
const ID_PREFIX: Record<SetupItemKind, string> = {
  repository: "repo", setup: "setup", tests: "tests", check: "check", test_environment: "env", devcontainer: "devcontainer", knowledge: "knowledge",
  spec_target: "spec", source: "source", intake: "intake", allowed_domain: "domain", secret: "secret",
};

const slugOf = (key: string): string => key.toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^[^a-z0-9]+|-+$/gu, "").slice(0, 48);

interface Draft<Value> { key: string; value: Value; from: Provenance[]; confidence: (typeof CONFIDENCES)[number] }

class Reader {
  readonly notes: string[] = [];
  readonly flagged = new Map<string, { reason: string; from: Provenance[] }>();
  private readonly known: Map<string, { name: string; commit?: string | undefined; url?: string | undefined }>;
  private dropped = { noSource: 0, invalidItem: 0, badCitation: 0 };

  constructor(private readonly context: SetupProposalContext) {
    this.known = new Map(context.repositories.map((repository) => [repository.name, repository]));
  }

  /** A model-shaped item and a wrapped one (`{ value, from, confidence }`, the shape this reader returns) are both read. */
  static flatten(entry: unknown): Record<string, unknown> | undefined {
    if (!isObject(entry)) return undefined;
    const { value } = entry;
    if (isObject(value)) return { ...value, from: entry["from"], confidence: entry["confidence"] };
    if (typeof value === "string") return { value, from: entry["from"], confidence: entry["confidence"] };
    return entry;
  }

  citations(raw: unknown, kind: SetupItemKind): Provenance[] {
    const result: Provenance[] = [];
    const entries = Array.isArray(raw) ? raw.slice(0, PROVENANCE_PER_ITEM_MAX * 2) : [];
    for (const entry of entries) {
      if (result.length >= PROVENANCE_PER_ITEM_MAX) break;
      const citation = this.citation(entry, kind);
      if (citation === undefined) { this.dropped.badCitation += 1; continue; }
      if (!result.some((other) => JSON.stringify(other) === JSON.stringify(citation))) result.push(citation);
    }
    return result;
  }

  private citation(entry: unknown, kind: SetupItemKind): Provenance | undefined {
    if (!isObject(entry)) return undefined;
    const citationKind = entry["kind"];
    // `person` and `connector` citations are the broker's own; an answer that carries one is not read as one.
    if (typeof citationKind !== "string" || !(MODEL_CITATION_KINDS as readonly string[]).includes(citationKind)) return undefined;
    const candidate: Record<string, unknown> = { kind: citationKind };
    const repo = typeof entry["repo"] === "string" ? this.known.get(entry["repo"]) : undefined;
    if (typeof entry["repo"] === "string" && repo === undefined && this.context.metaRepo?.name !== entry["repo"]) return undefined;
    if (typeof entry["repo"] === "string") candidate["repo"] = entry["repo"];
    if (typeof entry["path"] === "string") {
      const path = RelativeWorkspacePathSchema.safeParse(entry["path"]);
      if (!path.success || path.data.split("/")[0] === ".git") return undefined;
      candidate["path"] = path.data;
    }
    const commit = repo?.commit ?? (this.context.metaRepo !== undefined && this.context.metaRepo.name === entry["repo"] ? this.context.metaRepo.commit : undefined) ?? (typeof entry["commit"] === "string" ? entry["commit"] : undefined);
    // Only a citation of a file in a repository names a commit: an inferred one has nothing to re-read.
    if (commit !== undefined && (FILE_PROVENANCE_KINDS as readonly string[]).includes(citationKind)) {
      if (!HEX_COMMIT.test(commit)) return undefined;
      candidate["commit"] = commit;
    }
    if (typeof entry["line"] === "number" && Number.isInteger(entry["line"]) && entry["line"] > 0 && entry["line"] <= 10_000_000) candidate["line"] = entry["line"];
    if (typeof entry["quote"] === "string" && !NO_QUOTE_KINDS.has(kind)) {
      const quote = oneLineText(entry["quote"], PROVENANCE_QUOTE_MAX);
      if (quote !== "") candidate["quote"] = quote;
    }
    if (typeof entry["note"] === "string") {
      const note = oneLineText(entry["note"], PROVENANCE_NOTE_MAX);
      if (note !== "") candidate["note"] = note;
    }
    // A line or quote without a path says nothing the broker could re-read.
    if (candidate["path"] === undefined) { delete candidate["line"]; delete candidate["quote"]; }
    const parsed = ProvenanceSchema.safeParse(candidate);
    return parsed.success ? parsed.data : undefined;
  }

  confidence(raw: unknown): (typeof CONFIDENCES)[number] {
    return typeof raw === "string" && (CONFIDENCES as readonly string[]).includes(raw) ? (raw as (typeof CONFIDENCES)[number]) : "low";
  }

  /**
   * The list of items of one kind: an entry with no citation that parses is left out; entries with the same key become one item (their citations join, and `merge` joins
   * their values); the list is cut at the limit.
   */
  collect<Value>(
    raw: unknown, kind: SetupItemKind, limit: number,
    read: (entry: Record<string, unknown>, from: Provenance[]) => { key: string; value: Value } | undefined,
    merge?: (existing: Value, incoming: Value) => Value,
  ): Array<Draft<Value>> {
    const out = new Map<string, Draft<Value>>();
    const entries = Array.isArray(raw) ? raw.slice(0, limit * 2) : [];
    for (const rawEntry of entries) {
      const entry = Reader.flatten(rawEntry);
      if (entry === undefined) { this.dropped.invalidItem += 1; continue; }
      const from = this.citations(entry["from"], kind);
      if (from.length === 0) { this.dropped.noSource += 1; continue; }
      const value = read(entry, from);
      if (value === undefined) { this.dropped.invalidItem += 1; continue; }
      const existing = out.get(value.key);
      if (existing !== undefined) {
        for (const citation of from) if (existing.from.length < PROVENANCE_PER_ITEM_MAX && !existing.from.some((other) => JSON.stringify(other) === JSON.stringify(citation))) existing.from.push(citation);
        if (merge !== undefined) existing.value = merge(existing.value, value.value);
        continue;
      }
      if (out.size >= limit) { this.notes.push(`Only the first ${String(limit)} ${kind.replace("_", " ")} proposals are listed.`); break; }
      out.set(value.key, { key: value.key, value: value.value, from, confidence: this.confidence(entry["confidence"]) });
    }
    return [...out.values()];
  }

  knownRepo(name: unknown): string | undefined {
    return typeof name === "string" && (this.known.has(name) || this.context.metaRepo?.name === name) ? name : undefined;
  }

  repoUrlKnown(url: string): boolean {
    const wanted = normalizedUrl(url);
    return [...this.known.values()].some((repository) => repository.url !== undefined && normalizedUrl(repository.url) === wanted);
  }

  noteDrops(): void {
    if (this.dropped.noSource > 0) this.notes.push(`${String(this.dropped.noSource)} proposal${this.dropped.noSource === 1 ? " was" : "s were"} left out because ${this.dropped.noSource === 1 ? "it names" : "they name"} no place it came from.`);
    if (this.dropped.invalidItem > 0) this.notes.push(`${String(this.dropped.invalidItem)} proposal${this.dropped.invalidItem === 1 ? " was" : "s were"} left out because ${this.dropped.invalidItem === 1 ? "it was" : "they were"} not in a form Rovara can use.`);
  }
}

const normalizedUrl = (url: string): string => url.trim().toLowerCase().replace(/\.git$/u, "").replace(/\/+$/u, "");

function idsFor<Value>(kind: SetupItemKind, drafts: ReadonlyArray<Draft<Value>>, used: Set<string>): Array<{ id: string; value: Value; from: Provenance[]; confidence: (typeof CONFIDENCES)[number]; risk: ProposalRisk }> {
  return drafts.map((draft) => {
    const base = `${ID_PREFIX[kind]}-${slugOf(draft.key) || "item"}`.slice(0, 60);
    let id = base;
    for (let n = 2; used.has(id); n += 1) id = `${base}-${String(n)}`;
    used.add(id);
    return { id, value: draft.value, from: draft.from, confidence: draft.confidence, risk: setupItemRisk(kind, draft.value) };
  });
}

/**
 * Reads a model's answer (already parsed from JSON) as a proposal. Lenient about what the model adds, strict about what it keeps. `ok: false` only when the answer is not an
 * object, or has nothing a person could use.
 */
export function sanitizeSetupProposal(raw: unknown, context: SetupProposalContext): SetupProposalReading {
  if (!isObject(raw)) return { ok: false, errors: ["the answer is not a JSON object"] };
  const reader = new Reader(context);
  const notes = reader.notes;
  const flagged = reader.flagged;
  const used = new Set<string>();

  // A command list: each command read as the executor runs it; one that fetches code and runs it is flagged and NOT kept.
  const commandsOf = (value: unknown, from: Provenance[], extraFlags: ReadonlySet<string>): string[] => {
    const read = readCommands(value);
    const kept: string[] = [];
    for (const command of read.commands) {
      const reason = remoteCodeReason(command) ?? (extraFlags.has(command) ? "Rovara flagged this command." : undefined);
      if (reason !== undefined) { if (!flagged.has(command)) flagged.set(command, { reason, from }); continue; }
      kept.push(command);
    }
    if (read.leftOut.hidden > 0) notes.push(`${String(read.leftOut.hidden)} command${read.leftOut.hidden === 1 ? " was" : "s were"} left out because ${read.leftOut.hidden === 1 ? "it has" : "they have"} hidden or control characters.`);
    if (read.leftOut.tooLong > 0) notes.push(`${String(read.leftOut.tooLong)} command${read.leftOut.tooLong === 1 ? " was" : "s were"} left out because ${read.leftOut.tooLong === 1 ? "it is" : "they are"} too long.`);
    if (read.leftOut.extra > 0) notes.push(`${String(read.leftOut.extra)} more command${read.leftOut.extra === 1 ? " was" : "s were"} left out: at most 16 are kept for a repository.`);
    return kept;
  };

  // Commands the model flagged that appear in a list: the model may only add caution.
  const modelFlags = new Set<string>();
  for (const entry of Array.isArray(raw["flaggedCommands"]) ? raw["flaggedCommands"].slice(0, 80) : []) {
    const command = isObject(entry) && typeof entry["command"] === "string" ? readCommand(entry["command"]) : undefined;
    if (command?.kind === "kept") modelFlags.add(command.text);
  }
  // Flags carried by a proposal this reader returned earlier (the broker reading the worker's copy): kept, with their reasons.
  const carried = Array.isArray(raw["flaggedCommands"]) ? raw["flaggedCommands"] : [];

  const repositories = reader.collect(raw["repositories"], "repository", SETUP_ITEM_LIMITS.repositories, (entry) => {
    const url = typeof entry["url"] === "string" ? entry["url"].trim() : "";
    const name = typeof entry["name"] === "string" ? entry["name"] : "";
    const defaultBranch = typeof entry["defaultBranch"] === "string" ? entry["defaultBranch"] : undefined;
    if (url === "" || reader.repoUrlKnown(url)) return undefined;
    const value = { name, url, ...(defaultBranch === undefined ? {} : { defaultBranch }) };
    return SetupRepositoryValueSchema.safeParse(value).success ? { key: normalizedUrl(url), value } : undefined;
  });

  const commandItems = (kind: "setup" | "tests") => reader.collect<{ repo: string; commands: string[] }>(raw[kind], kind, SETUP_ITEM_LIMITS[kind], (entry, from) => {
    const repo = reader.knownRepo(entry["repo"]);
    if (repo === undefined) return undefined;
    const commands = commandsOf(entry["commands"], from, modelFlags);
    return commands.length === 0 ? undefined : { key: repo, value: { repo, commands } };
  }, (existing, incoming) => ({ repo: existing.repo, commands: [...new Set([...existing.commands, ...incoming.commands])].slice(0, SETUP_COMMANDS_MAX) }));
  const setup = commandItems("setup");
  const tests = commandItems("tests");

  const checks = reader.collect(raw["checks"], "check", SETUP_ITEM_LIMITS.checks, (entry, from) => {
    const repo = reader.knownRepo(entry["repo"]);
    const name = oneLineText(entry["name"], 80);
    const command = typeof entry["command"] === "string" ? readCommand(entry["command"]) : undefined;
    if (repo === undefined || name === "" || command?.kind !== "kept") return undefined;
    const reason = remoteCodeReason(command.text) ?? (modelFlags.has(command.text) ? "Rovara flagged this command." : undefined);
    if (reason !== undefined) { if (!flagged.has(command.text)) flagged.set(command.text, { reason, from }); return undefined; }
    return { key: `${repo}:${name.toLowerCase()}`, value: { name, repo, command: command.text } };
  });

  const testEnvironment = reader.collect(raw["testEnvironment"], "test_environment", SETUP_ITEM_LIMITS.testEnvironment, (entry) => {
    const hint = oneLineText(entry["hint"], 500);
    return hint === "" ? undefined : { key: hint.toLowerCase().slice(0, 40), value: { hint } };
  });

  const knowledge = reader.collect(raw["knowledge"], "knowledge", SETUP_ITEM_LIMITS.knowledge, (entry) => {
    const path = typeof entry["path"] === "string" ? RelativeWorkspacePathSchema.safeParse(entry["path"]) : undefined;
    const kind = typeof entry["kind"] === "string" && (SETUP_KNOWLEDGE_KINDS as readonly string[]).includes(entry["kind"]) ? (entry["kind"] as (typeof SETUP_KNOWLEDGE_KINDS)[number]) : undefined;
    if (path?.success !== true || path.data.split("/")[0] === ".git" || kind === undefined) return undefined;
    const activation = typeof entry["activation"] === "string" && (SETUP_KNOWLEDGE_ACTIVATIONS as readonly string[]).includes(entry["activation"]) ? (entry["activation"] as (typeof SETUP_KNOWLEDGE_ACTIVATIONS)[number]) : undefined;
    return { key: path.data, value: { path: path.data, kind, ...(activation === undefined ? {} : { activation }) } };
  });

  const specTargets = reader.collect(raw["specTarget"] === undefined ? [] : [raw["specTarget"]], "spec_target", 1, (entry) => {
    const path = typeof entry["path"] === "string" ? RelativeWorkspacePathSchema.safeParse(entry["path"]) : undefined;
    const format = typeof entry["format"] === "string" && (SETUP_SPEC_FORMATS as readonly string[]).includes(entry["format"]) ? (entry["format"] as (typeof SETUP_SPEC_FORMATS)[number]) : undefined;
    return path?.success === true && path.data.split("/")[0] !== ".git" && format !== undefined ? { key: "spec", value: { format, path: path.data } } : undefined;
  });

  const nameLike = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/u;
  const sources = reader.collect(raw["sources"], "source", SETUP_ITEM_LIMITS.sources, (entry) => {
    const name = typeof entry["name"] === "string" ? entry["name"].trim() : "";
    const foundIn = typeof entry["foundIn"] === "string" && (SETUP_SOURCE_FOUND_IN as readonly string[]).includes(entry["foundIn"]) ? (entry["foundIn"] as (typeof SETUP_SOURCE_FOUND_IN)[number]) : undefined;
    const matches = typeof entry["matchesConnection"] === "string" && nameLike.test(entry["matchesConnection"]) ? entry["matchesConnection"] : undefined;
    return nameLike.test(name) && foundIn !== undefined && redactText(name) === name ? { key: name.toLowerCase(), value: { name, foundIn, ...(matches === undefined ? {} : { matchesConnection: matches }) } } : undefined;
  });

  const intake = reader.collect(raw["intake"], "intake", SETUP_ITEM_LIMITS.intake, (entry) => {
    const channel = typeof entry["channel"] === "string" && (SETUP_INTAKE_CHANNELS as readonly string[]).includes(entry["channel"]) ? (entry["channel"] as (typeof SETUP_INTAKE_CHANNELS)[number]) : undefined;
    const hint = oneLineText(entry["hint"], 200);
    if (channel === undefined || hint === "") return undefined;
    // What an applier needs to make a source of it: each is kept only when it is plainly what it says (a lower-case system, a connection NAME, a label with no credential in it).
    const system = typeof entry["system"] === "string" && IntakeSystemSchema.safeParse(entry["system"]).success ? entry["system"] : undefined;
    const connection = typeof entry["connection"] === "string" && /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/u.test(entry["connection"]) && redactText(entry["connection"]) === entry["connection"] ? entry["connection"] : undefined;
    const labelText = oneLineText(entry["label"], 100);
    const label = labelText !== "" && typeof entry["label"] === "string" && labelText === entry["label"].trim() && redactText(labelText) === labelText ? labelText : undefined;
    return { key: [channel, system, label].filter((part) => part !== undefined).join("-"), value: { channel, hint, ...(system === undefined ? {} : { system }), ...(connection === undefined ? {} : { connection }), ...(label === undefined ? {} : { label }) } };
  });

  let rejectedDomains = 0;
  const allowedDomains = reader.collect(raw["allowedDomains"], "allowed_domain", SETUP_ITEM_LIMITS.allowedDomains, (entry) => {
    const text = typeof entry["value"] === "string" ? entry["value"] : typeof entry["domain"] === "string" ? entry["domain"] : "";
    const lower = text.trim().toLowerCase();
    if (!isAllowedDomain(lower)) { rejectedDomains += 1; return undefined; }
    return { key: lower, value: lower };
  });
  if (rejectedDomains > 0) notes.push(`${String(rejectedDomains)} domain${rejectedDomains === 1 ? " was" : "s were"} left out: not a domain the project settings accept.`);

  let tokenNames = 0;
  const secretsNeeded = reader.collect(raw["secretsNeeded"], "secret", SETUP_ITEM_LIMITS.secrets, (entry) => {
    const read = secretNameOf(entry["name"]);
    if (read === "token") { tokenNames += 1; return undefined; }
    return read === undefined ? undefined : { key: read.name, value: { name: read.name, why: oneLineText(entry["why"], 300) } };
  });
  if (tokenNames > 0) notes.push(`${String(tokenNames)} secret name${tokenNames === 1 ? " was" : "s were"} left out because ${tokenNames === 1 ? "it looks" : "they look"} like a token.`);

  // The dev container: one, inside a known repository, at a devcontainer path. `exists` is the worker's own answer (it looks in the clone); the broker keeps it.
  let devcontainer: { id: string; value: unknown; from: Provenance[]; confidence: (typeof CONFIDENCES)[number]; risk: ProposalRisk } | undefined;
  const devEntry = Reader.flatten(raw["devcontainer"]);
  if (devEntry !== undefined) {
    const repository = reader.knownRepo(devEntry["repository"]);
    const configPath = typeof devEntry["configPath"] === "string" ? devEntry["configPath"] : "";
    if (repository === undefined || !DEVCONTAINER_PATH_PATTERN.test(configPath)) {
      notes.push("A dev container was left out: it has to be a devcontainer.json inside one of the project's repositories.");
    } else {
      const exists = devEntry["exists"] === true;
      const proposed = typeof devEntry["proposedContent"] === "string" ? redactText(devEntry["proposedContent"]).replace(/\r\n?/gu, "\n") : undefined;
      const usable = !exists && proposed !== undefined && proposed.trim() !== "" && utf8Bytes(proposed) <= SETUP_DEVCONTAINER_MAX_BYTES && !/[\p{Cc}\p{Cf}]/u.test(proposed.replace(/[\n\t]/gu, ""))
        // The file is put inside a fenced block in the request to a coding agent: it must be a JSON object and must not hold a fence that would close the block.
        && proposed.trimStart().startsWith("{") && !proposed.includes("```");
      if (!exists && proposed !== undefined && !usable) notes.push("A proposed dev container file was left out: it is empty, too long, not a JSON object, or has control characters or a code fence in it.");
      const from = reader.citations(devEntry["from"], "devcontainer");
      if (from.length === 0) {
        notes.push("A dev container was left out because it names no place it came from.");
      } else {
        const value = { repository, configPath, exists, ...(usable ? { proposedContent: proposed } : {}) };
        devcontainer = { id: "devcontainer", value, from, confidence: reader.confidence(devEntry["confidence"]), risk: setupItemRisk("devcontainer", value) };
        used.add("devcontainer");
      }
    }
  }

  for (const entry of carried.slice(0, SETUP_ITEM_LIMITS.flagged)) {
    if (!isObject(entry) || typeof entry["command"] !== "string") continue;
    const command = readCommand(entry["command"]);
    if (command.kind !== "kept" || flagged.has(command.text)) continue;
    const from = reader.citations(entry["from"], "setup");
    const reason = oneLineText(entry["reason"], 300);
    flagged.set(command.text, { reason: reason === "" ? "Rovara flagged this command." : reason, from: from.length === 0 ? [{ kind: "inferred", note: "flagged while reading the repository" }] : from });
  }

  const foundNotUsed: SetupProposal["foundNotUsed"] = [];
  for (const entry of Array.isArray(raw["foundNotUsed"]) ? raw["foundNotUsed"].slice(0, SETUP_ITEM_LIMITS.found * 2) : []) {
    if (!isObject(entry) || (entry["kind"] !== "hook" && entry["kind"] !== "mcp_config")) continue;
    const repo = reader.knownRepo(entry["repo"]);
    const path = typeof entry["path"] === "string" ? RelativeWorkspacePathSchema.safeParse(entry["path"]) : undefined;
    if (repo === undefined || path?.success !== true || path.data.split("/")[0] === ".git") continue;
    if (foundNotUsed.length < SETUP_ITEM_LIMITS.found && !foundNotUsed.some((other) => other.repo === repo && other.path === path.data)) foundNotUsed.push({ kind: entry["kind"], repo, path: path.data });
  }

  reader.noteDrops();
  const noteText = typeof raw["notes"] === "string" ? redactText(raw["notes"]).replace(/\r\n?/gu, "\n").replace(/(?!\n)\p{Cc}|\p{Cf}/gu, " ").replace(/[^\S\n]+/gu, " ").trim() : "";
  const allNotes = [...(noteText === "" ? [] : [noteText]), ...new Set(notes)].join("\n");

  const proposal: SetupProposal = {
    version: SETUP_PROPOSAL_VERSION,
    basedOnRevision: context.basedOnRevision,
    ...(context.metaRepo === undefined ? {} : { metaRepo: { name: context.metaRepo.name, commit: context.metaRepo.commit } }),
    repositories: idsFor("repository", repositories, used),
    setup: idsFor("setup", setup, used),
    tests: idsFor("tests", tests, used),
    checks: idsFor("check", checks, used),
    testEnvironment: idsFor("test_environment", testEnvironment, used),
    ...(devcontainer === undefined ? {} : { devcontainer: devcontainer as unknown as NonNullable<SetupProposal["devcontainer"]> }),
    knowledge: idsFor("knowledge", knowledge, used),
    ...(specTargets[0] === undefined ? {} : { specTarget: idsFor("spec_target", specTargets, used)[0]! }),
    sources: idsFor("source", sources, used),
    intake: idsFor("intake", intake, used),
    allowedDomains: idsFor("allowed_domain", allowedDomains, used),
    secretsNeeded: idsFor("secret", secretsNeeded, used),
    flaggedCommands: [...flagged].slice(0, SETUP_ITEM_LIMITS.flagged).map(([command, entry]) => ({ command, reason: entry.reason, from: entry.from.slice(0, PROVENANCE_PER_ITEM_MAX) })),
    foundNotUsed,
    notes: [...allNotes].slice(0, 2000).join(""),
  };
  const empty = proposal.repositories.length + proposal.setup.length + proposal.tests.length + proposal.checks.length + proposal.testEnvironment.length + proposal.knowledge.length
    + proposal.sources.length + proposal.intake.length + proposal.allowedDomains.length + proposal.secretsNeeded.length + proposal.flaggedCommands.length + proposal.foundNotUsed.length === 0
    && proposal.devcontainer === undefined && proposal.specTarget === undefined;
  if (empty) return { ok: false, errors: ["the answer has nothing in it a person could use"] };
  const checked = SetupProposalSchema.safeParse(proposal);
  return checked.success ? { ok: true, proposal: checked.data } : { ok: false, errors: [`the proposal is not valid: ${checked.error.issues[0]?.path.join(".") ?? "proposal"}`] };
}

/**
 * The JSON in the LAST block fenced with the setup-proposal label of a model's final message, parsed; undefined when there is none or it is not JSON or is too large.
 * Anything outside the block is ignored: it is chat, not the proposal.
 */
export function setupProposalAnswerOf(text: string): unknown {
  const pattern = new RegExp(String.raw`(?:^|\n)\x60\x60\x60${SETUP_PROPOSAL_INFO_STRING}[ \t]*\n([\s\S]*?)\n\x60\x60\x60(?=\n|$)`, "gu");
  let last: string | undefined;
  for (const match of text.matchAll(pattern)) last = match[1];
  if (last === undefined || utf8Bytes(last) > SETUP_PROPOSAL_ANSWER_MAX_BYTES) return undefined;
  try { return JSON.parse(last) as unknown; } catch { return undefined; }
}
