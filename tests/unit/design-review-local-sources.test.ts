// The design review's packet readers on `rovara up`: the broker reads the files a design names from the repository's own code host at the commit asked for, the meta repository's files, and nothing for a
// repository the project does not have; a host that cannot answer leaves the file out; and the task's own ticket thread is withheld from the MCP items.
import { describe, expect, it } from "vitest";
import type { CodeHost, ContextSource, ProjectDefinition } from "@rovara-code/contracts";
import { localPacketSources } from "../../packages/core/src/local/app/design-review-sources.js";
import type { ContextToolsDependencies } from "../../packages/core/src/context-sources/routes.js";
import { readSlotPacket } from "../../packages/core/src/core/design-review/packet-store.js";
import { taskKey } from "../../packages/core/src/core/task-flow/keys.js";
import { COMPANY } from "../support/task-flow-harness.js";
import { design, finish, nextJob, planned, toDesignPhase, world } from "../support/design-review-flow-world.js";
import { DesignReviewBindingSchema } from "@rovara-code/contracts";

const COMMIT = "a".repeat(40);
const repositories = [
  { name: "app", url: "https://github.com/acme/app" },
  { name: "knowledge", url: "https://github.com/acme/knowledge", role: "meta" as const },
];
const definition = { repositories } as unknown as ProjectDefinition;
const task = { taskId: "t1", project: "payments", startingRevision: 3 };

/** A code host that answers from a map of `url|path|commit`, records each read, and throws for a url named `down`. */
function host(files: Record<string, string>, reads: string[]): (repository: { url: string }) => CodeHost {
  return () => ({
    async fileAtRevision(repository: { url: string }, path: string, revision: string, scope: { orgId: string }, options?: { maxBytes?: number }) {
      reads.push(`${repository.url}|${path}|${revision}|${scope.orgId}|${String(options?.maxBytes)}`);
      if (repository.url.includes("down")) throw new Error("the host is down");
      return files[`${repository.url}|${path}|${revision}`];
    },
  }) as unknown as CodeHost;
}

describe("the packet readers of a design review on a laptop", () => {
  it("reads a repository file at the commit asked for, through that repository's code host, and the meta repository's files from the meta repository", async () => {
    const reads: string[] = [];
    const sources = await localPacketSources({
      companyId: "c1", projectAt: async (project, revision) => (project === "payments" && revision === 3 ? { definition } : undefined),
      codeHostOf: host({ [`https://github.com/acme/app|src/pay.ts|${COMMIT}`]: "export const pay = 1;\n", [`https://github.com/acme/knowledge|docs/pay.md|${COMMIT}`]: "# Pay\n" }, reads),
    }, task, "op1");
    expect(sources.repositoryNames).toEqual(["app", "knowledge"]);
    expect(await sources.readers.readRepoFile({ repo: "app", path: "src/pay.ts", commit: COMMIT, maxBytes: 1000 })).toBe("export const pay = 1;\n");
    expect(await sources.readers.readMetaFile({ path: "docs/pay.md", commit: COMMIT, maxBytes: 500 })).toBe("# Pay\n");
    expect(reads).toEqual([`https://github.com/acme/app|src/pay.ts|${COMMIT}|c1|1000`, `https://github.com/acme/knowledge|docs/pay.md|${COMMIT}|c1|500`]);
    // A repository the project does not have is never asked for.
    expect(await sources.readers.readRepoFile({ repo: "other", path: "src/pay.ts", commit: COMMIT, maxBytes: 1000 })).toBeUndefined();
    expect(reads).toHaveLength(2);
    // No context sources set up: no MCP item is read.
    expect(await sources.readers.fetchMcpItem({ sourceId: "s1", itemRef: "X-1" })).toMatchObject({ ok: false });
  });

  it("leaves a file out when the host cannot answer, and reads nothing when the project revision cannot be read", async () => {
    const reads: string[] = [];
    const down = { repositories: [{ name: "app", url: "https://down.example/acme/app" }] } as unknown as ProjectDefinition;
    const sources = await localPacketSources({ companyId: "c1", projectAt: async () => ({ definition: down }), codeHostOf: host({}, reads) }, task, "op1");
    expect(await sources.readers.readRepoFile({ repo: "app", path: "src/pay.ts", commit: COMMIT, maxBytes: 1000 })).toBeUndefined();
    const none = await localPacketSources({ companyId: "c1", projectAt: async () => { throw new Error("unreadable"); }, codeHostOf: host({}, reads) }, task, "op1");
    expect(none.repositoryNames).toEqual([]);
    expect(await none.readers.readRepoFile({ repo: "app", path: "src/pay.ts", commit: COMMIT, maxBytes: 1000 })).toBeUndefined();
  });

  it("withholds the sources of the tracker a task's ticket came from, its own source always, and for a tracker with no rule every source that could carry a thread", async () => {
    const source = (sourceId: string, system: string | undefined, stages: string[] = ["PLAN_CRITIQUE"]): ContextSource => ({ sourceId, ...(system === undefined ? {} : { system }), stages }) as unknown as ContextSource;
    const configured = [source("lin", "linear"), source("jir", "jira"), source("docs", "notion"), source("mon", "sentry"), source("sc", "shortcut"), source("gl", "gitlab"), source("nokind", undefined), source("planonly", "linear", ["PLAN"])];
    const contextTools = { now: () => 0, sources: async () => ({ sources: configured }) } as unknown as ContextToolsDependencies;
    const deps = { companyId: "c1", projectAt: async () => ({ definition }), codeHostOf: host({}, []), contextTools };
    const withheld = async (system: string | undefined): Promise<string[]> => (await localPacketSources(deps, system === undefined ? task : { ...task, ticket: { system, id: "T-1" } }, "op1")).origin.map((item) => item.sourceId).sort();
    // A known tracker: its own sources and a source that names no kind.
    expect(await withheld("linear")).toEqual(["lin", "nokind"]);
    // A tracker with no rule: its OWN source is withheld, and so is every source that could hold or mirror a thread (a documents source included); only the monitor is still read.
    expect(await withheld("shortcut")).toEqual(["docs", "gl", "jir", "lin", "nokind", "sc"]);
    expect(await withheld("gitlab")).toEqual(["docs", "gl", "jir", "lin", "nokind", "sc"]);
    // A ticket from a documents tool withholds its own source; one from a monitor that keeps tickets withholds that monitor's source too, though a monitor is otherwise read.
    expect(await withheld("notion")).toContain("docs");
    expect(await withheld("sentry")).toContain("mon");
    expect(await withheld("GitLab")).toContain("gl");
    // A task no ticket started withholds nothing.
    expect(await withheld(undefined)).toEqual([]);
  });
});

describe("a design that names a meta repository file", () => {
  it("has it read for the reviewers at the task's knowledge commit, and put in their packets", async () => {
    const w = await world();
    const reads: string[] = [];
    w.runtime.ports.sourceReaders = async () => ({
      readers: { readRepoFile: async () => undefined, readMetaFile: async ({ path, commit }) => { reads.push(`${path}@${commit}`); return "# Payments glossary\n"; }, fetchMcpItem: async () => ({ ok: false }) },
      repositoryNames: ["demo"], origin: [],
    });
    await toDesignPhase(w);
    const knowledge = "c".repeat(40);
    await w.h.store.update({ key: taskKey(w.taskId), ops: [{ op: "set", path: ["knowledgeCommit"], value: knowledge }] });
    const planning = await nextJob(w);
    const withMeta = design().replace('"sources":[]', '"sources":[{"kind":"meta_repo_file","ref":"docs/glossary.md"}]');
    expect(withMeta).toContain("docs/glossary.md");
    await finish(w, planning.operation, planned(w, planning.operation, "design", withMeta, 1));
    const round = await nextJob(w);
    const binding = DesignReviewBindingSchema.parse(round.operation.designReview);
    expect(reads).toEqual([`docs/glossary.md@${knowledge}`]);
    const packets = await Promise.all(binding.reviewers.map((reviewer) => readSlotPacket(w.h.store, COMPANY, round.operation.id, 1, reviewer.keySlot)));
    expect(packets.some((packet) => packet!.text.includes("Payments glossary"))).toBe(true);
  });
});
