import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { runFileOp } from "./sandbox-file-ops.js";
import { PLAN_DOCUMENT_INFO_STRING, lastFencedBlock, replaceLastFencedBlock, type PlanClaim, type PlanDocument } from "@agentx/contracts";

/** A cited file is read whole only up to this size; a larger one is only counted, so its anchors are not checked. */
export const CITED_FILE_MAX_BYTES = 2 * 1024 * 1024;

/** What the check needs of a cited file: its line count, and the lines unless the file is too large to hold. */
export interface CitedFile { lineCount: number; lines: string[] | undefined }
/** Reads a cited file by absolute path; undefined when there is no such file, or it lies outside the workspace. */
export type CitedFileReader = (path: string) => Promise<CitedFile | undefined>;

export interface CitationRepository { path: string }

type CodeEvidence = Extract<NonNullable<PlanClaim["evidence"]>[number], { kind: "code" }>;

/** The lines of a text: split on CRLF or LF, and the empty piece after a final newline is not a line. */
function textLines(text: string): string[] {
  const lines = text.split(/\r?\n/u);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Reads a file inside `root`; a larger file than CITED_FILE_MAX_BYTES is counted while streaming, never held. With the
 * workspace's repositories, a file is read only from the repository that holds it. On Linux the read never lets the kernel
 * follow a link (the file tools' own walk, rooted at that folder): the task controls these files, and in a devcontainer
 * project its code can run while the plan is checked, flipping one between a real file and a link to a worker file.
 */
export function citedFileReader(root: string, repositories?: readonly CitationRepository[]): CitedFileReader {
  return async (path) => {
    if (process.platform === "linux") return readConfined(root, repositories, path);
    let real: string;
    let size: number;
    try {
      real = await realpath(path);
      const rootReal = await realpath(root);
      const inside = relative(rootReal, real);
      if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return undefined;
      const info = await stat(real);
      if (!info.isFile()) return undefined;
      size = info.size;
    } catch {
      return undefined;
    }
    try {
      if (size <= CITED_FILE_MAX_BYTES) {
        const lines = textLines(await readFile(real, "utf8"));
        return { lineCount: lines.length, lines };
      }
      let newlines = 0;
      let last = 0x0a;
      for await (const chunk of createReadStream(real)) {
        const bytes = chunk as Buffer;
        for (const byte of bytes) if (byte === 0x0a) newlines += 1;
        last = bytes[bytes.length - 1] ?? last;
      }
      return { lineCount: last === 0x0a ? newlines : newlines + 1, lines: undefined };
    } catch {
      return undefined;
    }
  };
}

async function readConfined(root: string, repositories: readonly CitationRepository[] | undefined, path: string): Promise<CitedFile | undefined> {
  try {
    const rootReal = await realpath(root);
    const below = relative(resolve(root), resolve(path));
    if (below === "" || below === ".." || below.startsWith(`..${sep}`) || isAbsolute(below)) return undefined;
    const posixBelow = below.split(sep).join("/");
    let folder = rootReal;
    let inner = posixBelow;
    if (repositories !== undefined) {
      const repository = repositoryOf(posixBelow, repositories);
      if (repository === undefined || posixBelow === repository.path) return undefined;
      folder = await realpath(resolve(root, repository.path));
      inner = posixBelow.slice(repository.path.length + 1);
      // The repository folder must be where the workspace put it: a link the task made for it, to anywhere, is refused.
      if (folder !== resolve(rootReal, repository.path)) return undefined;
    }
    const info = await runFileOp({ root: folder, op: "stat", path: inner });
    if (!info.ok || (info.result as { type?: string }).type !== "file") return undefined;
    if ((info.result as { size: number }).size > CITED_FILE_MAX_BYTES) {
      const counted = await runFileOp({ root: folder, op: "countLines", path: inner });
      return counted.ok ? { lineCount: (counted.result as { lineCount: number }).lineCount, lines: undefined } : undefined;
    }
    const read = await runFileOp({ root: folder, op: "readFile", path: inner });
    if (!read.ok) return undefined;
    const lines = textLines(Buffer.from((read.result as { contentBase64: string }).contentBase64, "base64").toString("utf8"));
    return { lineCount: lines.length, lines };
  } catch {
    return undefined;
  }
}

function repositoryOf(path: string, repositories: readonly CitationRepository[]): CitationRepository | undefined {
  return [...repositories]
    .sort((a, b) => b.path.length - a.path.length)
    .find((repository) => path === repository.path || path.startsWith(`${repository.path}/`));
}

/**
 * Checks every `code` citation of a plan against the files in the workspace before the plan is posted.
 *
 * - A range that runs past the last line is cut to it; a start past the last line is a problem.
 * - An `anchor` (the first cited line, copied from the file) that is inside the range keeps it. One found once elsewhere
 *   moves the range to start at it, keeping its length and ending no later than the file. One missing, or found several
 *   times with none inside the range, is a problem the planner is asked to fix.
 * - A file that is not in the workspace is a problem.
 *
 * Returns the plan with corrected ranges, and the problems in the planner's own words.
 */
export async function checkCodeCitations(
  plan: PlanDocument,
  root: string,
  repositories: readonly CitationRepository[],
  read: CitedFileReader = citedFileReader(root, repositories),
): Promise<{ plan: PlanDocument; issues: string[] }> {
  const issues: string[] = [];
  const files = new Map<string, Promise<CitedFile | undefined>>();
  const fileOf = (path: string): Promise<CitedFile | undefined> => {
    let found = files.get(path);
    if (found === undefined) {
      const repository = repositoryOf(path, repositories);
      found = repository === undefined ? Promise.resolve(undefined) : read(resolve(root, path));
      files.set(path, found);
    }
    return found;
  };

  async function claims(list: PlanClaim[]): Promise<PlanClaim[]> {
    const result: PlanClaim[] = [];
    for (const claim of list) {
      const next: PlanClaim = { ...claim };
      if (claim.evidence !== undefined) {
        next.evidence = [];
        for (const [index, item] of claim.evidence.entries()) next.evidence.push(item.kind === "code" ? await citation(claim.id, index, item) : item);
      }
      if (claim.children !== undefined) next.children = await claims(claim.children);
      result.push(next);
    }
    return result;
  }

  async function citation(claimId: string, index: number, item: CodeEvidence): Promise<CodeEvidence> {
    // Counted from 1, as the plan's format errors count evidence.
    const name = `evidence ${claimId}#${index + 1} ${item.path}`;
    const file = await fileOf(item.path);
    if (file === undefined) {
      issues.push(`${name}: the file does not exist in the workspace`);
      return item;
    }
    const total = file.lineCount;
    if (item.startLine > total) {
      issues.push(`${name}: the file has ${total} ${total === 1 ? "line" : "lines"}; cite lines inside it`);
      return item;
    }
    let { startLine, endLine } = item;
    if (item.anchor !== undefined && file.lines !== undefined) {
      const wanted = item.anchor.trimEnd();
      const found: number[] = [];
      for (const [position, line] of file.lines.entries()) if (line.trimEnd() === wanted) found.push(position + 1);
      if (found.some((line) => line >= startLine && line <= endLine)) {
        // The anchor is inside the cited range: the numbers are right.
      } else if (found.length === 1) {
        const length = endLine - startLine;
        startLine = Math.max(1, Math.min(found[0]!, total - length));
        endLine = startLine + length;
      } else {
        issues.push(`${name}: the anchor line is not in the file; copy one exact line from the lines you cite`);
        return item;
      }
    }
    endLine = Math.min(endLine, total);
    return startLine === item.startLine && endLine === item.endLine ? item : { ...item, startLine, endLine };
  }

  return { plan: { ...plan, claims: await claims(plan.claims) }, issues };
}

/** Whether two plans cite the same ranges. */
export function sameCitedRanges(a: PlanDocument, b: PlanDocument): boolean {
  const ranges = (plan: PlanDocument): string[] => {
    const found: string[] = [];
    const walk = (list: PlanClaim[]): void => {
      for (const claim of list) {
        for (const item of claim.evidence ?? []) if (item.kind === "code") found.push(`${item.startLine}-${item.endLine}`);
        walk(claim.children ?? []);
      }
    };
    walk(plan.claims);
    return found;
  };
  return ranges(a).join() === ranges(b).join();
}

/**
 * The answer with the corrected ranges written into its last `agentx-plan` block. The block's own JSON is changed, not
 * rebuilt from the parsed plan, so a coding plan's checks stay as the planner wrote them.
 */
export function withCorrectedRanges(answer: string, corrected: PlanDocument): string {
  const block = lastFencedBlock(answer, PLAN_DOCUMENT_INFO_STRING);
  if (typeof block !== "string") return answer;
  let raw: unknown;
  try {
    raw = JSON.parse(block);
  } catch {
    return answer;
  }
  const apply = (rawClaims: unknown, fixed: PlanClaim[]): void => {
    if (!Array.isArray(rawClaims)) return;
    for (const [position, claim] of fixed.entries()) {
      const rawClaim: unknown = rawClaims[position];
      if (typeof rawClaim !== "object" || rawClaim === null) continue;
      const record = rawClaim as { evidence?: unknown; children?: unknown };
      if (Array.isArray(record.evidence)) {
        for (const [index, item] of (claim.evidence ?? []).entries()) {
          const rawItem: unknown = record.evidence[index];
          if (item.kind !== "code" || typeof rawItem !== "object" || rawItem === null) continue;
          Object.assign(rawItem, { startLine: item.startLine, endLine: item.endLine });
        }
      }
      apply(record.children, claim.children ?? []);
    }
  };
  if (typeof raw !== "object" || raw === null) return answer;
  apply((raw as { claims?: unknown }).claims, corrected.claims);
  return replaceLastFencedBlock(answer, PLAN_DOCUMENT_INFO_STRING, JSON.stringify(raw, null, 2));
}
