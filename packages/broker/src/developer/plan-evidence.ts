// Spec 061: the code a plan cites, read from GitHub at the task's base commit, so the review page shows the real lines.
import type { PlanClaim, PlanDocument, PlanEvidenceBundle, WorkflowReviewBase } from "@agentx/contracts";

const EXCERPTS_MAX = 40;
const LINES_MAX = 80;
const LINE_CHARS_MAX = 300;
const BUNDLE_MAX_BYTES = 512 * 1024;
/** The whole resolve must finish well inside the 30 s plan callback. */
const DEADLINE_MS = 12_000;
const READ_CONCURRENCY = 4;

type Excerpt = PlanEvidenceBundle["excerpts"][number];

interface Repository { name: string; path: string; url: string }
type Where = Omit<Excerpt, "status" | "commit" | "lines" | "cut">;
type FileRead = { url: string; path: string; commit: string; untilLine: number };
type ReadResult = { lines: string[] | undefined } | "unavailable";

/** The cited code of every claim, depth first, with each item's place in its claim's `evidence`. */
function citations(claims: PlanClaim[]): Where[] {
  return claims.flatMap((claim) => [
    ...(claim.evidence ?? []).flatMap((item, index) => item.kind === "code" ? [{ claimId: claim.id, index, path: item.path, startLine: item.startLine, endLine: item.endLine }] : []),
    ...citations(claim.children ?? []),
  ]);
}

/** The repository a cited path lives in and the path inside it; undefined when the path is not inside any registered repository. */
function locate(path: string, repositories: Repository[]): { repository: Repository; inRepository: string } | undefined {
  if (path.startsWith("/") || path.includes("\\") || path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) return undefined;
  const matches = repositories.filter((repository) => path.startsWith(`${repository.path}/`));
  const repository = matches.sort((a, b) => b.path.length - a.path.length)[0];
  return repository === undefined ? undefined : { repository, inRepository: path.slice(repository.path.length + 1) };
}

function fileLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function cutLine(line: string): string {
  if (line.length <= LINE_CHARS_MAX) return line;
  const head = line.slice(0, LINE_CHARS_MAX - 1);
  const last = head.charCodeAt(head.length - 1);
  return `${last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head}…`;
}

/** The bundle written when the code could not be read at all: every cited place `unavailable` (those beyond the excerpt limit `skipped`, as when resolved). */
export function unavailablePlanEvidence(plan: PlanDocument): PlanEvidenceBundle {
  return { schemaVersion: 1, excerpts: citations(plan.claims).map((where, position): Excerpt => ({ ...where, status: position >= EXCERPTS_MAX ? "skipped" : "unavailable" })) };
}

/**
 * Reads the code a plan cites. A cited place that cannot be shown says why in its status; nothing here throws.
 * Reads share one deadline (12 s unless `deadlineMs` says otherwise); a place still unread when it passes is `unavailable`.
 */
export async function resolvePlanEvidence(plan: PlanDocument, input: {
  repositories: Repository[];
  base: WorkflowReviewBase | undefined;
  readFile(url: string, path: string, commit: string, options: { untilLine: number }): Promise<string | undefined>;
  deadlineMs?: number;
  now?: () => number;
}): Promise<PlanEvidenceBundle> {
  const now = input.now ?? Date.now;
  const deadline = now() + (input.deadlineMs ?? DEADLINE_MS);

  const cited = citations(plan.claims);
  const targets = cited.map((where, position) => {
    if (position >= EXCERPTS_MAX) return undefined;
    const found = locate(where.path, input.repositories);
    const commit = found === undefined ? undefined : input.base?.find((entry) => entry.repositoryId === found.repository.name)?.baseCommitSha;
    return found === undefined || commit === undefined ? { where, file: undefined } : { where, file: { url: found.repository.url, path: found.inRepository, commit } };
  });

  // One read per file and commit, a few at a time, each only up to the last line any excerpt of it cites.
  const jobs = new Map<string, FileRead>();
  for (const target of targets) {
    if (target?.file === undefined) continue;
    const key = JSON.stringify([target.file.url, target.file.path, target.file.commit]);
    jobs.set(key, { ...target.file, untilLine: Math.max(jobs.get(key)?.untilLine ?? 0, target.where.endLine) });
  }
  const results = new Map<string, ReadResult>();
  const queue = [...jobs.entries()];
  const worker = async () => {
    for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
      const [key, file] = job;
      results.set(key, await readBeforeDeadline(file));
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, queue.length) }, worker));

  async function readBeforeDeadline(file: FileRead): Promise<ReadResult> {
    const remaining = deadline - now();
    if (remaining <= 0) return "unavailable";
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<"unavailable">((resolve) => { timer = setTimeout(() => resolve("unavailable"), remaining); });
    const read = Promise.resolve().then(() => input.readFile(file.url, file.path, file.commit, { untilLine: file.untilLine }))
      .then((text): ReadResult => ({ lines: text === undefined ? undefined : fileLines(text) }), (): ReadResult => "unavailable");
    try {
      return await Promise.race([read, expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  const excerpts: Excerpt[] = [];
  let bytes = Buffer.byteLength(JSON.stringify({ schemaVersion: 1, excerpts: [] }), "utf8");
  let full = false;
  for (const [position, where] of cited.entries()) {
    let excerpt: Excerpt = { ...where, status: "skipped" };
    const target = targets[position];
    if (target !== undefined && !full) {
      excerpt = resolveOne(target);
      const size = Buffer.byteLength(JSON.stringify(excerpt), "utf8") + 1;
      if (bytes + size > BUNDLE_MAX_BYTES) {
        full = true;
        excerpt = { ...where, status: "skipped" };
      } else bytes += size;
    }
    excerpts.push(excerpt);
  }
  return { schemaVersion: 1, excerpts };

  function resolveOne(target: { where: Where; file: { url: string; path: string; commit: string } | undefined }): Excerpt {
    const { where, file } = target;
    if (file === undefined) return { ...where, status: "not_found" };
    const result = results.get(JSON.stringify([file.url, file.path, file.commit]));
    if (result === undefined || result === "unavailable") return { ...where, status: "unavailable" };
    // The place was looked up at this commit and is not there: the page says which commit.
    if (result.lines === undefined || where.startLine > result.lines.length) return { ...where, status: "not_found", commit: file.commit };
    // A range that runs past the last line shows through the last line, and says so with its own end.
    const endLine = Math.min(where.endLine, result.lines.length);
    const wanted = result.lines.slice(where.startLine - 1, endLine);
    const cut = wanted.length > LINES_MAX;
    return { ...where, endLine, status: "ok", commit: file.commit, lines: wanted.slice(0, LINES_MAX).map(cutLine), ...(cut ? { cut: true } : {}) };
  }
}
