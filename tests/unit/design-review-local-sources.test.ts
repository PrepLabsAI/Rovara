// The design review's packet readers on `rovara up`: the broker reads the files a design names from the repository's own code host at the commit asked for, the meta repository's files, and nothing for a
// repository the project does not have; a host that cannot answer leaves the file out; and the task's own ticket thread is withheld from the MCP items.
import { describe, expect, it } from "vitest";
import type { CodeHost, ContextSource, ProjectDefinition } from "@agentx/contracts";
import { localPacketSources } from "../../packages/broker/src/local/app/design-review-sources.js";
import type { ContextToolsDependencies } from "../../packages/broker/src/context-sources/routes.js";

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

  it("withholds the sources of the tracker a task's ticket came from, and every tracker's when the tracker is not known", async () => {
    const source = (sourceId: string, system: string | undefined): ContextSource => ({ sourceId, system, stages: ["PLAN_CRITIQUE"] }) as unknown as ContextSource;
    const contextTools = { now: () => 0, sources: async () => ({ sources: [source("lin", "linear"), source("jir", "jira"), source("docs", "notion"), source("other", "linear")].map((entry, index) => (index === 3 ? { ...entry, stages: ["PLAN"] } as unknown as ContextSource : entry)) }) } as unknown as ContextToolsDependencies;
    const deps = { companyId: "c1", projectAt: async () => ({ definition }), codeHostOf: host({}, []), contextTools };
    const linear = await localPacketSources(deps, { ...task, ticket: { system: "linear", id: "LIN-1" } }, "op1");
    expect(linear.origin.map((item) => item.sourceId)).toEqual(["lin"]);
    const unknown = await localPacketSources(deps, { ...task, ticket: { system: "shortcut", id: "SC-1" } }, "op1");
    expect(unknown.origin.map((item) => item.sourceId).sort()).toEqual(["jir", "lin"]);
    const plain = await localPacketSources(deps, task, "op1");
    expect(plain.origin).toEqual([]);
  });
});
