// L4-LM1c: the worker's half of the human-edit job. The queued job is trusted for nothing but where to look: the company, the task, the pull request, the repository, the head and each author are proved again from the
// company's own records and the code host before anything is handed to the extractor, and the extractor is handed the lines ONCE with the authors as canonical member ids.
import { describe, expect, it } from "vitest";
import type { ChangeRequestFile, CommitChanges, CommitIdentity, OrgId } from "@agentx/contracts";
import type { TaskRecord } from "../../../packages/broker/src/core/task-flow/records.js";
import type { HumanEditExtractorPort, HumanEditInput, HumanEditJob } from "../../../packages/broker/src/lessons/capture-types.js";
import { HUMAN_EDIT_WORK_REQUESTS_MAX, createHumanEditRun, type HumanEditRepository, type HumanEditRunDeps } from "../../../packages/broker/src/lessons/human-edit-work.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const sha = (n: number): string => n.toString(16).padStart(40, "0");
const BASE = sha(1);
const HEAD = sha(2);
const URL = "https://github.com/acme/api/pull/7";
const EDIT = ["@@ -1,3 +1,3 @@ function load()", "-for (;;) { try { fetch() } catch {} }", "+await withRetry(() => fetch())", "+await withRetry(() => save())"].join("\n");
const acct = (login: string, id: string, accountType: "person" | "bot" = "person") => ({ login, hostUserId: id, accountType });
const rae: CommitIdentity = { author: acct("rae", "1001"), committer: acct("rae", "1001"), webFlow: false };
const kim: CommitIdentity = { author: acct("kim", "1002"), committer: acct("kim", "1002"), webFlow: false };
const bot: CommitIdentity = { author: acct("rovara[bot]", "9001", "bot"), committer: acct("rovara[bot]", "9001", "bot"), webFlow: false };
const file = (path: string): ChangeRequestFile => ({ path, status: "modified", additions: 2, deletions: 1, patch: EDIT });
const commit = (parents: string[], identity: CommitIdentity, path = "src/fetch.ts"): CommitChanges => ({ files: [file(path)], complete: true, parents, identity });

function setup(over: { table?: Record<string, CommitChanges>; liveHead?: string; liveBranch?: string; members?: Record<string, string>; repoFullName?: string; task?: Partial<TaskRecord> | null; noRepo?: boolean } = {}) {
  const table = over.table ?? { [HEAD]: commit([BASE], rae) };
  const handed: HumanEditInput[] = [];
  let requests = 0;
  const codeHost = {
    kind: "github", provider: "github",
    commitChanges: async (_r: unknown, revision: string, _s: unknown, budget?: { beforeRequest(): void }) => { budget?.beforeRequest(); requests += 1; const found = table[revision]; if (found === undefined) throw new Error("no such commit"); return found; },
    getChangeRequest: async () => { requests += 1; return { ref: { repository: { url: "https://github.com/acme/api" }, id: "7", url: URL }, state: "open", sourceBranch: over.liveBranch ?? "agentx/branch", targetBranch: "main", headRevision: over.liveHead ?? HEAD, title: "t", body: "" }; },
  };
  const repository: HumanEditRepository = { url: "https://github.com/acme/api", place: "github:repo/4242", fullName: over.repoFullName ?? "acme/api", codeHost: codeHost as unknown as HumanEditRepository["codeHost"], repository: { url: "https://github.com/acme/api" }, scope: { orgId: A } };
  const task = over.task === null ? undefined : { taskId: "task-1", companyId: A, project: "payments", startingRevision: 1, workflow: { pullRequests: [{ repositoryId: "api", number: 7, url: URL }] }, ...over.task } as unknown as TaskRecord;
  const extractor: HumanEditExtractorPort = { async extract(input) { handed.push(input); return { candidates: 1 }; } };
  const members = over.members ?? { "1001": "member-rae", "1002": "member-kim" };
  const asked: string[] = [];
  const deps: HumanEditRunDeps = {
    companyId: A, ownTask: async (taskId) => (taskId === "task-1" ? task : undefined),
    repos: { ofTask: async (project, _revision, name) => { asked.push(`${project}/${name}`); return over.noRepo === true ? undefined : repository; } },
    personOf: async (account) => members[account.hostUserId], extractor, now: () => Date.parse("2026-11-17T10:00:00.000Z"),
  };
  const job = (extra: Partial<HumanEditJob> = {}): HumanEditJob => ({
    repo: { host: "github", id: "4242", fullName: "acme/api", isPrivate: true, workspaceId: A, project: "payments" }, project: "payments", taskId: "task-1", pullRequest: { number: 7, url: URL },
    candidateHeadSha: BASE, headSha: HEAD, headRef: "agentx/branch", ...extra,
  });
  return { run: createHumanEditRun(deps), job, handed, asked, requests: () => requests, repoHost: async () => codeHost };
}

describe("a queued human-edit job", () => {
  it("hands the person's lines to the extractor once, with the authors as member ids, the repository's place as the scope and the pull request's link", async () => {
    const w = setup({ table: { [HEAD]: commit([sha(3)], rae), [sha(3)]: commit([BASE], kim, "src/save.ts") } });
    expect(await w.run(w.job())).toBe("handed_on");
    expect(w.handed).toHaveLength(1);
    const input = w.handed[0]!;
    expect(input).toMatchObject({ workspaceId: A, project: "payments", repo: "acme/api", taskId: "task-1", pullRequest: { number: 7, url: URL }, trust: "member", authorCount: 2, scope: "github:repo/4242", link: URL });
    expect(input.authors.sort()).toEqual(["member-kim", "member-rae"]);
    expect(input.files.map((entry) => entry.path)).toEqual(["src/fetch.ts", "src/save.ts"]);
    expect(input.audience).toMatchObject({ kind: "restricted", acl: { source: "github", scope: "github:repo/4242", liveCheck: "none" } });
  });
  it("two accounts of one member are one author", async () => {
    const w = setup({ table: { [HEAD]: commit([sha(3)], rae), [sha(3)]: commit([BASE], kim, "src/save.ts") }, members: { "1001": "member-one", "1002": "member-one" } });
    await w.run(w.job());
    expect(w.handed[0]!.authors).toEqual(["member-one"]);
  });
  it("a mixed push hands on only the person's lines", async () => {
    const w = setup({ table: { [HEAD]: commit([sha(3)], bot, "src/bot.ts"), [sha(3)]: commit([BASE], rae) } });
    expect(await w.run(w.job())).toBe("handed_on");
    expect(w.handed[0]!.files.map((entry) => entry.path)).toEqual(["src/fetch.ts"]);
    expect(w.handed[0]!.authors).toEqual(["member-rae"]);
  });

  it("another company's job is skipped before anything is read; so is a task that is not this company's, one on another project, or one that is gone", async () => {
    const other = setup();
    expect(await other.run(other.job({ repo: { host: "github", id: "4242", fullName: "acme/api", isPrivate: true, workspaceId: B, project: "payments" } }))).toBe("skipped");
    expect(other.requests()).toBe(0);
    expect(other.asked).toEqual([]);
    const gone = setup({ task: null });
    expect(await gone.run(gone.job())).toBe("skipped");
    const project = setup();
    expect(await project.run(project.job({ project: "another" }))).toBe("skipped");
    const noFlow = setup({ task: { workflow: undefined } });
    expect(await noFlow.run(noFlow.job())).toBe("skipped");
    for (const w of [gone, project, noFlow]) { expect(w.handed).toEqual([]); expect(w.requests()).toBe(0); }
  });
  it("a pull request the task does not have (another number, or another address) and a repository the project does not pin or the host names differently are skipped", async () => {
    const number = setup();
    expect(await number.run(number.job({ pullRequest: { number: 8, url: URL } }))).toBe("skipped");
    const address = setup();
    expect(await address.run(address.job({ pullRequest: { number: 7, url: "https://github.com/acme/other/pull/7" } }))).toBe("skipped");
    const unpinned = setup({ noRepo: true });
    expect(await unpinned.run(unpinned.job())).toBe("skipped");
    const renamed = setup({ repoFullName: "acme/other" });
    expect(await renamed.run(renamed.job())).toBe("skipped");
    expect([number, address, unpinned, renamed].map((w) => w.handed.length)).toEqual([0, 0, 0, 0]);
    // The repository's name is compared the way the host cases it.
    const cased = setup({ repoFullName: "Acme/API" });
    expect(await cased.run(cased.job())).toBe("handed_on");
  });
  it("a head the host no longer shows (it moved on, or another branch) is skipped: the newer push has its own job", async () => {
    const moved = setup({ liveHead: sha(9) });
    expect(await moved.run(moved.job())).toBe("skipped");
    const branch = setup({ liveBranch: "someone/else" });
    expect(await branch.run(branch.job())).toBe("skipped");
    expect(moved.handed).toEqual([]);
    expect(branch.handed).toEqual([]);
  });

  it("an author that is not a member of this company, or that cannot be placed, means nothing is handed on (a lesson never names the wrong person)", async () => {
    const one = setup({ table: { [HEAD]: commit([sha(3)], rae), [sha(3)]: commit([BASE], kim, "src/save.ts") }, members: { "1001": "member-rae" } });
    expect(await one.run(one.job())).toBe("skipped");
    const empty = setup({ members: { "1001": "" } });
    expect(await empty.run(empty.job())).toBe("skipped");
    expect(one.handed).toEqual([]);
    expect(empty.handed).toEqual([]);
  });
  it("no person's commit, a huge or trivial diff and a history that does not reach the base are skipped", async () => {
    const botted = setup({ table: { [HEAD]: commit([BASE], bot) } });
    expect(await botted.run(botted.job())).toBe("skipped");
    const lost = setup({ table: { [HEAD]: commit([sha(50)], rae), [sha(50)]: { files: [], complete: true, parents: [], identity: rae } } });
    expect(await lost.run(lost.job())).toBe("skipped");
    expect(botted.handed).toEqual([]);
    expect(lost.handed).toEqual([]);
  });
  it("a host that cannot answer THROWS so the job is retried", async () => {
    const w = setup({ table: {} });
    await expect(w.run(w.job())).rejects.toThrow();
    expect(w.handed).toEqual([]);
  });
  it("the job has its own request allowance: a history that takes more requests than that (a page each for many commits) is a diff too large, skipped, never thrown for retry", async () => {
    const table: Record<string, CommitChanges> = {};
    const chain = 15;
    for (let n = 0; n < chain; n += 1) table[sha(100 + n)] = commit([n === chain - 1 ? BASE : sha(101 + n)], rae, `src/f${String(n)}.ts`);
    const pages = 3;
    const w = setup({ table, liveHead: sha(100) });
    // A host that asks the budget once for each page it reads: three pages a commit.
    const host = (await w.repoHost()) as { commitChanges: (...args: unknown[]) => Promise<CommitChanges> };
    const original = host.commitChanges;
    host.commitChanges = async (r, revision, s, budget) => { for (let page = 0; page < pages; page += 1) (budget as { beforeRequest(): void }).beforeRequest(); return original(r, revision, s, undefined); };
    expect(chain * pages + 1).toBeGreaterThan(HUMAN_EDIT_WORK_REQUESTS_MAX);
    expect(await w.run(w.job({ headSha: sha(100) }))).toBe("skipped");
    expect(w.handed).toEqual([]);
  });
});
