// The readers of a design review's packets on `rovara up`: the broker reads, by itself and never through the worker, the files a design names from the project's repositories at the commits the task was prepared
// at (through the code host the repository's record names), the meta repository's files at its knowledge commit, and the MCP items a design cites through the project's context sources (the same route a running stage
// uses, with the plan check's stage). The same readers a hosted install has (one read per source per round, made by `round-start.ts`).
//
// A reader that cannot answer (no code host set up, a file that is not there, a host that is down) answers nothing and the source is left out of the packet, the way a hosted install's does: the reviewer is then told it
// was not read, and the review still runs on the design and the requirements. The task's own request thread (a ticket intake started it from) is never read for a packet: every source of that tracker is withheld,
// and for a tracker Rovara has no rule for, every source that is not a known non-tracker kind (`originOfTicket`).
import { randomUUID } from "node:crypto";
import { metaRepositoryOf, type CodeHost, type ContextSource, type OrgId, type ProjectDefinition } from "@agentx/contracts";
import { callContextTool, type ContextToolsDependencies } from "../../context-sources/routes.js";
import { mcpItemReaderOf, type PacketReaders } from "../../core/design-review/packet.js";
import { originOfTicket } from "../../core/design-review/round-inputs.js";
import type { RoundSourceReaders } from "../../core/design-review/round-ports.js";
import type { TaskRecord } from "../../core/task-flow/records.js";

/** What the readers are built from: the project's revisions, the code host of a repository record, and the context-tool route's dependencies (absent when no sources are set up). */
export interface LocalPacketSourceDeps {
  companyId: OrgId;
  projectAt(project: string, revision: number): Promise<{ definition: ProjectDefinition } | undefined>;
  codeHostOf(repository: ProjectDefinition["repositories"][number]): CodeHost;
  contextTools?: ContextToolsDependencies | undefined;
}

const NONE: RoundSourceReaders = { readers: { readRepoFile: async () => undefined, readMetaFile: async () => undefined, fetchMcpItem: async () => ({ ok: false }) }, repositoryNames: [], origin: [] };

/** The readers of one task's packet sources. A project revision that cannot be read gives readers that read nothing (the review runs on the design and the requirements). */
export async function localPacketSources(deps: LocalPacketSourceDeps, task: Pick<TaskRecord, "taskId" | "project" | "startingRevision" | "ticket">, operationId: string): Promise<RoundSourceReaders> {
  const project = await deps.projectAt(task.project, task.startingRevision).catch(() => undefined);
  if (project === undefined) return NONE;
  const repositories = project.definition.repositories;
  const meta = metaRepositoryOf(project.definition);
  const fileAt = async (record: ProjectDefinition["repositories"][number] | undefined, path: string, commit: string, maxBytes: number): Promise<string | undefined> => {
    if (record === undefined) return undefined;
    try { return await deps.codeHostOf(record).fileAtRevision({ url: record.url }, path, commit, { orgId: deps.companyId }, { maxBytes, timeoutMs: 10_000 }); } catch { return undefined; }
  };
  const context = deps.contextTools;
  const configured: ContextSource[] = context === undefined ? [] : (await context.sources(deps.companyId, task.project).catch(() => ({ sources: [] as ContextSource[] }))).sources.filter((source) => source.stages.includes("PLAN_CRITIQUE"));
  const origin = task.ticket === undefined ? [] : originOfTicket(task.ticket.system, configured);
  const fetchMcpItem: PacketReaders["fetchMcpItem"] = context === undefined ? async () => ({ ok: false }) : mcpItemReaderOf(
    (request) => callContextTool(context, { orgId: deps.companyId, task: { taskId: task.taskId, project: task.project }, operation: { id: operationId, workflowMode: "PLAN_CRITIQUE" } }, request),
    { sources: configured, now: context.now, newRequestId: randomUUID, origin },
  );
  return {
    readers: {
      readRepoFile: async ({ repo, path, commit, maxBytes }) => fileAt(repositories.find((candidate) => candidate.name === repo), path, commit, maxBytes),
      readMetaFile: async ({ path, commit, maxBytes }) => fileAt(meta, path, commit, maxBytes),
      fetchMcpItem,
    },
    repositoryNames: repositories.map((repository) => repository.name), origin,
  };
}
