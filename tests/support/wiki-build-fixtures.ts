// Shared fakes for the wiki build tests (W3): a file map (W0 shape), a code-host reader over fixed files, the wiki store's page sink (W2 shape, which parses every write with the
// store's own schema), and a task starter that writes the pointer in one transaction like the task flow does.
import { randomUUID } from "node:crypto";
import { WikiPageWriteSchema, type OrgId, type TransactItem, type WikiFileMap, type WikiIndexEntry, type WikiPageSink, type WikiPageWrite } from "@agentx/contracts";
import type { CitationFileReader } from "../../packages/broker/src/core/citations/citation-check.js";
import type { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import type { WikiBuildStarter } from "../../packages/broker/src/core/wiki-build/run.js";

export const COMPANY_A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
export const COMPANY_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
export const API_SHA = "a".repeat(40);
export const WEB_SHA = "b".repeat(40);
export const OLD_SHA = "0".repeat(40);

type Area = WikiFileMap["repositories"][number]["areas"][number];
export function area(path: string, extra: Partial<Area> = {}): Area {
  return { path, files: 10, kind: "source", ...extra };
}

export function repoEntry(name: string, areas: Area[], extra: Partial<WikiFileMap["repositories"][number]> = {}): WikiFileMap["repositories"][number] {
  return {
    name, url: `https://github.com/example/${name}`, status: "ok", files: 100, skipped: { generated: 0, vendored: 0, lockfiles: 0, assets: 0, secret: 0 }, languages: [], areas, testFolders: [], skippedFolders: [],
    activity: { status: "ok", days: 90 }, pages: { repository: 1, modules: areas.length, modulesCapped: false }, ...extra,
  };
}

export function fileMap(repositories: WikiFileMap["repositories"], chips: WikiFileMap["chips"] = [], modulePagesPerRepository = 40): WikiFileMap {
  return {
    version: 1, project: "beacon", computedAt: "2026-11-17T10:00:00.000Z", repositories, complete: true, repositoriesOmitted: 0, chips,
    forecast: { repositories: repositories.length, files: 0, pages: 0, pagesCapped: false, complete: true, price: "not_priced_yet" },
    limits: { activityDays: 90, modulePagesPerRepository, pagesPerProject: 300, areasPerRepository: 20 },
  };
}

export interface ReaderCall { repository: string; path: string; commit: string }
export function reader(files: Record<string, string | Error>): { read: CitationFileReader; calls: ReaderCall[] } {
  const calls: ReaderCall[] = [];
  const read: CitationFileReader = async (repository, path, commit) => {
    calls.push({ repository, path, commit });
    const found = files[`${repository}:${path}@${commit}`];
    if (found instanceof Error) throw found;
    return found;
  };
  return { read, calls };
}

export class FakeSink implements WikiPageSink {
  readonly pages = new Map<string, WikiPageWrite>();
  failNext = false;
  constructor(readonly companyId: OrgId, readonly project: string) {}
  async putPage(page: WikiPageWrite): Promise<void> {
    if (this.failNext) { this.failNext = false; throw new Error("store down"); }
    // The store parses every write with its own schema: a page the build hands over must pass it.
    this.pages.set(page.pageId, WikiPageWriteSchema.parse(page));
  }
  async deletePages(pageIds: readonly string[]): Promise<number> {
    let n = 0;
    for (const id of pageIds) if (this.pages.delete(id)) n += 1;
    return n;
  }
  async listPages(): Promise<WikiIndexEntry[]> { return []; }
}

/** The task flow's start as a build uses it: one transaction with the pointer (and the notes), a repeat of the request id answers the first task. */
export class FakeStarter implements WikiBuildStarter {
  readonly started: Array<Parameters<WikiBuildStarter["start"]>[0] & { taskId: string }> = [];
  readonly cancelled: string[] = [];
  private readonly byRequest = new Map<string, string>();
  constructor(private readonly store: MemoryDocumentStore) {}
  async start(request: Parameters<WikiBuildStarter["start"]>[0]): Promise<{ taskId: string; duplicate: boolean }> {
    const known = this.byRequest.get(request.requestId);
    if (known !== undefined) return { taskId: known, duplicate: true };
    const taskId = randomUUID();
    const items: TransactItem[] = [request.pointerItemFor(taskId)];
    const notes = request.notesItemFor(taskId);
    if (notes !== undefined) items.push(notes);
    const result = await this.store.transact(items);
    if (!result.applied) throw Object.assign(new Error("busy"), { code: "WORKSPACE_BUSY" });
    this.byRequest.set(request.requestId, taskId);
    this.started.push({ ...request, taskId });
    return { taskId, duplicate: false };
  }
  async cancel(request: { taskId: string }): Promise<void> { this.cancelled.push(request.taskId); }
}
