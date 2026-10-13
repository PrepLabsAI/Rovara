// rovara loop (#355): where each work item stands, kept on this computer under ~/.rovara/loop. It is a
// cache: the issue (its comments, its rovara:<step> label, open or closed) is the truth it is rebuilt from.
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

export const RepoSlugSchema = z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/, "owner/name");

export const WorkItemStateSchema = z.object({
  version: z.literal(1),
  repo: RepoSlugSchema,
  issue: z.number().int().positive(),
  loop: z.string(),
  step: z.string(),
  startedBy: z.string(),
  instruction: z.string(),
  startedAt: z.string(),
  stepEnteredAt: z.string(),
  /** The agent session working this item, once one was started. */
  session: z.object({ harness: z.literal("claude-code"), tmux: z.string(), id: z.string().uuid() }).strict().optional(),
  /** The item's own git worktree and branch, once made. */
  worktree: z.object({ path: z.string(), branch: z.string() }).strict().optional(),
  /** What the agent said it did, at its last accepted claim. */
  summary: z.string().optional(),
  /** Quick (#356): the plan's digest when it was approved, which locks it, and who approved it. */
  planDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  approvedBy: z.string().optional(),
  /** Quick (#356): the last checks report, for the pull request's description. */
  checks: z.string().max(20_000).optional(),
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

  itemDir(repo: string, issue: number): string { return join(this.root, "items", slugDir(repo), String(issue)); }
  inboxDir(repo: string, issue: number): string { return join(this.itemDir(repo, issue), "inbox"); }
  sessionDir(repo: string, issue: number): string { return join(this.itemDir(repo, issue), "session"); }
  logPath(): string { return join(this.root, "daemon.log"); }
  pidPath(): string { return join(this.root, "daemon.pid"); }

  async item(repo: string, issue: number): Promise<WorkItemState | undefined> {
    return readJson(join(this.itemDir(repo, issue), "state.json"), WorkItemStateSchema);
  }

  async saveItem(state: WorkItemState): Promise<void> {
    await writeJson(join(this.itemDir(state.repo, state.issue), "state.json"), WorkItemStateSchema.parse(state));
  }

  /** One line per event and transition, never rewritten. */
  async appendEvent(repo: string, issue: number, entry: Record<string, unknown>): Promise<void> {
    const path = join(this.itemDir(repo, issue), "events.jsonl");
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

  async cursor(repo: string): Promise<PollCursor | undefined> {
    return readJson(join(this.root, "poll", `${slugDir(repo)}.json`), PollCursorSchema);
  }

  async saveCursor(repo: string, cursor: PollCursor): Promise<void> {
    await writeJson(join(this.root, "poll", `${slugDir(repo)}.json`), cursor);
  }
}
