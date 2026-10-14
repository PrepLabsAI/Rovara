// rovara loop (#355, #358): where each work item stands, kept on this computer under ~/.rovara/loop. It is a
// cache: the issue (its comments, its rovara:<step> label, open or closed) is the truth it is rebuilt from. A work
// item whose plan changes several repositories has one inner loop per pull request, kept under the item.
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { ArtifactSchema } from "./definitions.js";
import { LoopEnrollmentSchema, type LoopEnrollment, type RegisteredEnrollment, type RegisteredPendingEnrollment } from "./enrollment.js";

const RepoSlug = () => z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/, "owner/name");
export const RepoSlugSchema = RepoSlug();

export const WorkItemStateSchema = z.object({
  version: z.literal(1),
  repo: RepoSlugSchema,
  issue: z.number().int().positive(),
  loop: z.string(),
  step: z.string(),
  /**
   * #358: set on an inner loop, one per pull request: the repository it changes. `repo` and `issue` stay the issue's,
   * so what the inner loop says goes on the issue; its worktree, checks, reviews and pull request are in `target`.
   */
  target: RepoSlug().optional(),
  startedBy: z.string(),
  instruction: z.string(),
  startedAt: z.string(),
  stepEnteredAt: z.string(),
  /** The agent session working this item, once one was started. */
  session: z.object({
    harness: z.enum(["claude-code", "codex"]),
    tmux: z.string(),
    /** Claude Code's session ID, chosen by the loop. Codex chooses its own; its session is the latest in the worktree. */
    id: z.string().uuid().optional(),
  }).strict().optional(),
  /** The item's own git worktree and branch, once made. */
  worktree: z.object({ path: z.string(), branch: z.string() }).strict().optional(),
  /** What the agent said it did, at its last accepted claim. */
  summary: z.string().optional(),
  /** Quick and Full (#356, #357): each approved artifact's digest when it was approved, which locks it, and who approved it. */
  approvals: z.partialRecord(ArtifactSchema, z.object({ digest: z.string().regex(/^[a-f0-9]{64}$/), by: z.string(), at: z.string() }).strict()).optional(),
  /** Full (#357): the phases declared away when the loop started, and by whom (the starter). */
  skipped: z.array(z.string()).max(10).optional(),
  /** #358: review rounds in a row that still blocked; reset when the reviews pass or a person decides. */
  reviewRounds: z.number().int().min(0).optional(),
  /** #358: the last reviews report, for the pull request's description and the evidence. */
  reviews: z.string().max(20_000).optional(),
  /** Quick (#356): the last checks report, for the pull request's description. */
  checks: z.string().max(20_000).optional(),
  /** The exact committed candidate qualified by the last local check round. */
  checksCandidate: z.object({ branch: z.string(), commitSha: z.string().regex(/^[a-f0-9]{40}$/u), treeSha: z.string().regex(/^[a-f0-9]{40}$/u), baseCommitSha: z.string().regex(/^[a-f0-9]{40}$/u) }).strict().optional(),
  /** The exact committed candidate inspected by the last independent review round. */
  reviewsCandidate: z.object({ branch: z.string(), commitSha: z.string().regex(/^[a-f0-9]{40}$/u), treeSha: z.string().regex(/^[a-f0-9]{40}$/u), baseCommitSha: z.string().regex(/^[a-f0-9]{40}$/u) }).strict().optional(),
  /** #359, Contribute: the success criteria the brief set, as they are compared (brief.ts). */
  criteria: z.array(z.string().max(1_000)).max(30).optional(),
  /**
   * #359, Contribute on someone else's pull request: where its follow-up pull request goes (that pull request's head
   * repository and branch), and the ref its worktree starts from (that pull request's head, fetched).
   */
  upstream: z.object({ repo: z.string(), branch: z.string(), ref: z.string() }).strict().optional(),
  /** #359, Review: what a collaborator asked the next round to look at too, beside the brief. */
  focus: z.string().max(20_000).optional(),
  /** #359, Review: every finding so far, numbered across rounds, and the issue each was filed as. */
  findings: z.array(z.object({
    n: z.number().int().positive(),
    /** The pull request it is about: owner/name#number. */
    pull: z.string(),
    text: z.string(),
    severity: z.enum(["HIGH", "MEDIUM", "LOW"]).optional(),
    file: z.string().optional(),
    line: z.number().int().positive().optional(),
    filed: z.number().int().positive().optional(),
  }).strict()).max(500).optional(),
  /** #359, Review: the head commit of each pull request at its last round (owner/name#number to commit). */
  reviewed: z.record(z.string(), z.string()).optional(),
  /** #359, Review: rounds run so far. */
  rounds: z.number().int().min(0).optional(),
  /** Quick (#356): the pull request the loop opened. */
  pullRequest: z.object({ number: z.number().int().positive(), url: z.string().url() }).strict().optional(),
}).strict();
export type WorkItemState = z.infer<typeof WorkItemStateSchema>;

export const RegisteredRepoSchema = z.object({ repo: RepoSlugSchema, path: z.string() }).strict();
export type RegisteredRepo = z.infer<typeof RegisteredRepoSchema>;

/** Where the poller is up to on a repository: comments are read from `since`, and `seen` stops a repeat. */
export const PollCursorSchema = z.object({ since: z.string(), seen: z.array(z.number().int()).max(1_000) }).strict();
export type PollCursor = z.infer<typeof PollCursorSchema>;

const slugDir = (repo: string) => repo.replace("/", "__");

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Written whole, then renamed, so a reader never sees half a file.
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  const parsed = schema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`${path} is not a rovara loop file this version can read`);
  return parsed.data;
}

/** Everything the loop keeps on this computer, under one root (~/.rovara/loop). */
export class LoopStore {
  constructor(readonly root: string) {}

  /** An item's directory; with `target` (#358), its inner loop's for that repository, inside it. */
  itemDir(repo: string, issue: number, target?: string): string {
    const dir = join(this.root, "items", slugDir(repo), String(issue));
    return target === undefined ? dir : join(dir, "pulls", slugDir(target));
  }
  inboxDir(repo: string, issue: number, target?: string): string { return join(this.itemDir(repo, issue, target), "inbox"); }
  sessionDir(repo: string, issue: number, target?: string): string { return join(this.itemDir(repo, issue, target), "session"); }
  logPath(): string { return join(this.root, "daemon.log"); }
  pidPath(): string { return join(this.root, "daemon.pid"); }
  enrollmentPath(): string { return join(this.root, "enrollments.json"); }

  /** Host-owned lane enrollment receipts live beside loop state, outside repository configuration. */
  async enrollments(): Promise<LoopEnrollment[]> {
    return (await readJson(this.enrollmentPath(), z.array(LoopEnrollmentSchema))) ?? [];
  }

  async saveEnrollment(enrollment: LoopEnrollment): Promise<void> {
    const parsed = LoopEnrollmentSchema.parse(enrollment);
    const records = await this.enrollments();
    if (parsed.kind === "standalone-local" && records.some((record) =>
      (record.kind === "registered" && (record.repositoryId === parsed.repositoryId || record.repository.toLowerCase() === parsed.project.toLowerCase() ||
        record.checkoutPath === parsed.checkoutPath || (record.commonGitDir !== undefined && record.commonGitDir === parsed.commonGitDir))) ||
      (record.kind === "registered-pending" && record.sources.some((source) => source.repository?.toLowerCase() === parsed.project.toLowerCase())))) {
      throw new Error(`a registered native binding already exists for ${parsed.project}; standalone enrollment cannot replace it`);
    }
    if (records.some((record) => record.enrollmentId === parsed.enrollmentId)) return;
    await writeJson(this.enrollmentPath(), [...records, parsed]);
  }

  /** Persist the server-declared binding before local source reconciliation can succeed or fail. */
  async savePendingEnrollment(pending: RegisteredPendingEnrollment): Promise<RegisteredPendingEnrollment> {
    const parsed = LoopEnrollmentSchema.parse(pending);
    if (parsed.kind !== "registered-pending") throw new Error("pending enrollment has the wrong kind");
    const records = await this.enrollments();
    const prior = records.filter((record) => record.kind === "registered-pending" && record.namespace === parsed.namespace && record.project === parsed.project);
    const sources = new Map<string, RegisteredPendingEnrollment["sources"][number]>();
    for (const item of prior) if (item.kind === "registered-pending") for (const source of item.sources) sources.set(source.repository?.toLowerCase() ?? source.repositoryUrl.toLowerCase(), source);
    for (const source of parsed.sources) sources.set(source.repository?.toLowerCase() ?? source.repositoryUrl.toLowerCase(), source);
    const combined = { ...parsed, sources: [...sources.values()] };
    await writeJson(this.enrollmentPath(), [...records.filter((record) => !prior.includes(record)), combined]);
    return combined;
  }

  /** Confirm one source after fresh host/GitHub validation, leaving every other registered source pending. */
  async promotePendingEnrollment(pendingId: string, repository: string, enrollment: RegisteredEnrollment): Promise<void> {
    const records = await this.enrollments();
    const updated: LoopEnrollment[] = [];
    for (const record of records) {
      if (record.kind !== "registered-pending" || record.enrollmentId !== pendingId) { updated.push(record); continue; }
      const sources = record.sources.filter((source) => source.repository?.toLowerCase() !== repository.toLowerCase());
      if (sources.length > 0) updated.push({ ...record, sources });
    }
    updated.push(LoopEnrollmentSchema.parse(enrollment));
    await writeJson(this.enrollmentPath(), updated);
  }

  async item(repo: string, issue: number, target?: string): Promise<WorkItemState | undefined> {
    return readJson(join(this.itemDir(repo, issue, target), "state.json"), WorkItemStateSchema);
  }

  async saveItem(state: WorkItemState): Promise<void> {
    await writeJson(join(this.itemDir(state.repo, state.issue, state.target), "state.json"), WorkItemStateSchema.parse(state));
  }

  /** #358: an item's inner loops, one per pull request, in the order of the repositories' names. */
  async pulls(repo: string, issue: number): Promise<WorkItemState[]> {
    const dir = join(this.itemDir(repo, issue), "pulls");
    let names: string[];
    try { names = (await readdir(dir)).sort(); } catch { return []; }
    const found = await Promise.all(names.filter((name) => /^[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+$/u.test(name)).map((name) => this.item(repo, issue, name.replace("__", "/"))));
    return found.filter((state): state is WorkItemState => state !== undefined);
  }

  /** One line per event and transition, never rewritten. */
  async appendEvent(repo: string, issue: number, entry: Record<string, unknown>, target?: string): Promise<void> {
    const path = join(this.itemDir(repo, issue, target), "events.jsonl");
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await appendFile(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }

  async items(repo: string): Promise<WorkItemState[]> {
    const dir = join(this.root, "items", slugDir(repo));
    let names: string[];
    try { names = await readdir(dir); } catch { return []; }
    const found = await Promise.all(names.filter((name) => /^\d+$/.test(name)).map((name) => this.item(repo, Number(name))));
    return found.filter((state): state is WorkItemState => state !== undefined);
  }

  async repos(): Promise<RegisteredRepo[]> {
    return (await readJson(join(this.root, "repos.json"), z.array(RegisteredRepoSchema))) ?? [];
  }

  async saveRepos(repos: RegisteredRepo[]): Promise<void> {
    await writeJson(join(this.root, "repos.json"), repos);
  }

  /** Where the poller is up to on a repository's issue comments, or (#358) its pull requests' review comments and reviews. */
  async cursor(repo: string, kind: "issues" | "pulls" = "issues"): Promise<PollCursor | undefined> {
    return readJson(join(this.root, "poll", `${slugDir(repo)}${kind === "issues" ? "" : "__pulls"}.json`), PollCursorSchema);
  }

  async saveCursor(repo: string, cursor: PollCursor, kind: "issues" | "pulls" = "issues"): Promise<void> {
    await writeJson(join(this.root, "poll", `${slugDir(repo)}${kind === "issues" ? "" : "__pulls"}.json`), cursor);
  }
}
