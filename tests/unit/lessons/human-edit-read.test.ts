// L4-LM1c: reading a person's edit to a Rovara pull request. The proof that a commit is a PERSON's (by the host's own account ids, never a name or an email), a mixed push using only the person's commits, the
// bounds on a huge diff, and what is ignored. Nothing here is a real host: commits are answered from a table.
import { describe, expect, it } from "vitest";
import type { ChangeRequestFile, CommitChanges, CommitIdentity, HostScope, PageBudget } from "@agentx/contracts";
import {
  HUMAN_EDIT_COMMITS_MAX, HUMAN_EDIT_FILES_MAX, HUMAN_EDIT_HANDED_FILES_MAX, HUMAN_EDIT_HANDED_LINES_MAX, HUMAN_EDIT_LINES_MAX, personOfCommit, readPersonEdit,
} from "../../../packages/broker/src/lessons/human-edit-read.js";

const sha = (n: number): string => n.toString(16).padStart(40, "0");
const BASE = sha(1);
const scope: HostScope = { orgId: "org_aaaaaaaaaaaaaaaaaaaa" };
const repository = { url: "https://github.com/acme/api" };

const account = (login: string, id: string | undefined, accountType: "person" | "bot" | "other" = "person") => ({ login, ...(id === undefined ? {} : { hostUserId: id }), accountType });
const byPerson = (login = "rae", id = "1001"): CommitIdentity => ({ author: account(login, id), committer: account(login, id), webFlow: false });
const byBot = (): CommitIdentity => ({ author: account("rovara[bot]", "9001", "bot"), committer: account("rovara[bot]", "9001", "bot"), webFlow: false });
const unlinked = (): CommitIdentity => ({ webFlow: false });

const patchOf = (...lines: string[]): string => ["@@ -1,3 +1,3 @@ function load()", ...lines].join("\n");
const file = (path: string, additions: number, deletions: number, patch?: string, extra: Partial<ChangeRequestFile> = {}): ChangeRequestFile => ({ path, status: "modified", additions, deletions, ...(patch === undefined ? {} : { patch }), ...extra });
const EDIT = patchOf("-for (;;) { try { fetch() } catch {} }", "+await withRetry(() => fetch())", "+await withRetry(() => save())");

/** A commit: its own changes, parents and who wrote it. */
const commit = (parents: string[], identity: CommitIdentity | undefined, files: ChangeRequestFile[] = [file("src/fetch.ts", 2, 1, EDIT)], complete = true): CommitChanges => ({ files, complete, parents, ...(identity === undefined ? {} : { identity }) });

function host(table: Record<string, CommitChanges>) {
  const asked: string[] = [];
  return { asked, host: { commitChanges: async (_repo: unknown, revision: string, _scope: unknown, budget?: PageBudget) => { budget?.beforeRequest(); asked.push(revision); const found = table[revision]; if (found === undefined) throw new Error("the host has no such commit"); return found; } } };
}
const read = (table: Record<string, CommitChanges>, head: string, over: { budget?: PageBudget; base?: string } = {}) => {
  const h = host(table);
  return { h, result: readPersonEdit({ host: h.host, repository, scope, base: over.base ?? BASE, head, ...(over.budget === undefined ? {} : { budget: over.budget }) }) };
};

describe("who is a person", () => {
  it("is an account of kind person with a stable id, as both author and committer, on a commit with one parent", () => {
    expect(personOfCommit(commit([BASE], byPerson()))).toEqual({ login: "rae", hostUserId: "1001" });
  });
  it("is the author when the committer is the host's own web committer (an edit made on the host's web pages)", () => {
    expect(personOfCommit(commit([BASE], { author: account("rae", "1001"), committer: account("web-flow", "19864447", "other"), webFlow: true }))).toEqual({ login: "rae", hostUserId: "1001" });
  });
  it("is nobody for a bot, an app login, an unlinked identity, an account with no id, a committer who is somebody else, or a commit with no identity", () => {
    expect(personOfCommit(commit([BASE], byBot()))).toBeUndefined();
    expect(personOfCommit(commit([BASE], { author: account("rovara[bot]", "9001", "person"), committer: account("rovara[bot]", "9001", "person"), webFlow: false }))).toBeUndefined();
    expect(personOfCommit(commit([BASE], unlinked()))).toBeUndefined();
    expect(personOfCommit(commit([BASE], { author: account("rae", undefined), committer: account("rae", undefined), webFlow: false }))).toBeUndefined();
    expect(personOfCommit(commit([BASE], { author: account("rae", ""), committer: account("rae", ""), webFlow: false }))).toBeUndefined();
    expect(personOfCommit(commit([BASE], { author: account("rae", "1001"), committer: account("kim", "1002"), webFlow: false }))).toBeUndefined();
    expect(personOfCommit(commit([BASE], { author: account("rae", "1001"), committer: account("rae", "1001", "other"), webFlow: false }))).toBeUndefined();
    expect(personOfCommit(commit([BASE], { author: account("org-account", "1003", "other"), committer: account("org-account", "1003", "other"), webFlow: false }))).toBeUndefined();
    expect(personOfCommit(commit([BASE], undefined))).toBeUndefined();
  });
  it("is nobody for a merge (two parents), however it was written; the web committer alone does not make a person (the author must be one)", () => {
    expect(personOfCommit(commit([BASE, sha(77)], byPerson()))).toBeUndefined();
    expect(personOfCommit(commit([BASE], { author: account("bot-x", "5", "bot"), committer: account("web-flow", "19864447", "other"), webFlow: true }))).toBeUndefined();
    expect(personOfCommit(commit([], byPerson()))).toBeUndefined();
  });
  it("by id only: the same login with another id is a different account", () => {
    const first = personOfCommit(commit([BASE], byPerson("rae", "1001")));
    const second = personOfCommit(commit([BASE], byPerson("rae", "2002")));
    expect(first?.hostUserId).not.toBe(second?.hostUserId);
  });
});

describe("reading the person's edit", () => {
  it("walks from the head to the commit Rovara pushed and returns the person, the commits and the changed lines with the symbols the hunk names", async () => {
    const { result } = read({ [sha(2)]: commit([BASE], byPerson()) }, sha(2));
    const edit = await result;
    expect(edit).toMatchObject({ kind: "edit", commits: [sha(2)], people: [{ login: "rae", hostUserId: "1001" }] });
    if (edit.kind !== "edit") throw new Error("expected an edit");
    expect(edit.files).toEqual([{
      path: "src/fetch.ts", additions: 2, deletions: 1, symbols: ["function load()"],
      hunks: ["@@ -1,3 +1,3 @@ function load()", "-for (;;) { try { fetch() } catch {} }", "+await withRetry(() => fetch())", "+await withRetry(() => save())"],
    }]);
  });

  it("a bot's push is ignored: no person commit, nothing read of it", async () => {
    const { result } = read({ [sha(2)]: commit([BASE], byBot()) }, sha(2));
    expect(await result).toEqual({ kind: "skip", reason: "no_person_commit" });
  });
  it("an unlinked identity (Rovara's own git identity is linked to no account) is ignored", async () => {
    const { result } = read({ [sha(2)]: commit([BASE], unlinked()) }, sha(2));
    expect(await result).toEqual({ kind: "skip", reason: "no_person_commit" });
  });
  it("a mixed push uses only the person's commits: a bot's commit and a merge from the base are walked past and their lines never come back", async () => {
    const table = {
      [sha(2)]: commit([BASE], byPerson("rae", "1001"), [file("src/fetch.ts", 2, 1, EDIT)]),
      [sha(3)]: commit([sha(2)], byBot(), [file("src/bot-only.ts", 1, 0, patchOf("+const botLine = 1"))]),
      [sha(4)]: commit([sha(3), sha(99)], byPerson("rae", "1001"), [file("src/from-main.ts", 5, 0, patchOf("+a", "+b", "+c", "+d", "+mainLine"))]),
      [sha(5)]: commit([sha(4)], byPerson("kim", "1002"), [file("src/save.ts", 1, 1, patchOf("-old()", "+await withRetry(() => later())"))]),
    };
    const { result } = read(table, sha(5));
    const edit = await result;
    if (edit.kind !== "edit") throw new Error("expected an edit");
    expect(edit.commits).toEqual([sha(2), sha(5)]);
    expect(edit.people.map((person) => person.hostUserId)).toEqual(["1001", "1002"]);
    expect(edit.files.map((entry) => entry.path)).toEqual(["src/fetch.ts", "src/save.ts"]);
    expect(JSON.stringify(edit)).not.toContain("botLine");
    expect(JSON.stringify(edit)).not.toContain("mainLine");
  });
  it("one person with two commits is one person, and their files in the two commits are one file", async () => {
    const table = {
      [sha(2)]: commit([BASE], byPerson(), [file("src/fetch.ts", 1, 1, patchOf("-a()", "+b()"))]),
      [sha(3)]: commit([sha(2)], byPerson(), [file("src/fetch.ts", 2, 0, patchOf("+c()", "+d()"))]),
    };
    const edit = await read(table, sha(3)).result;
    if (edit.kind !== "edit") throw new Error("expected an edit");
    expect(edit.people).toHaveLength(1);
    expect(edit.files).toHaveLength(1);
    expect(edit.files[0]).toMatchObject({ path: "src/fetch.ts", additions: 3, deletions: 1 });
  });

  it("asks the host once for each commit it walks, charging each to the budget", async () => {
    let charged = 0;
    const table = { [sha(2)]: commit([BASE], byPerson()), [sha(3)]: commit([sha(2)], byBot()) };
    const { h, result } = read(table, sha(3), { budget: { beforeRequest: () => { charged += 1; } } });
    await result;
    expect(h.asked).toEqual([sha(3), sha(2)]);
    expect(charged).toBe(2);
  });
  it("a host that cannot answer THROWS (a failed read is never a skip), and the budget's stop goes up", async () => {
    await expect(read({}, sha(2)).result).rejects.toThrow("no such commit");
    const stop = new Error("allowance used up");
    await expect(read({ [sha(2)]: commit([BASE], byPerson()) }, sha(2), { budget: { beforeRequest: () => { throw stop; } } }).result).rejects.toBe(stop);
  });
  it("a host with no commit read, an answer that is not shaped as asked, a history that does not reach the base and a chain that is too long are skips, not guesses", async () => {
    expect(await readPersonEdit({ host: {}, repository, scope, base: BASE, head: sha(2) })).toEqual({ kind: "skip", reason: "host_cannot_read" });
    const odd = await read({ [sha(2)]: { files: [], complete: true, parents: ["not a sha"] } }, sha(2)).result;
    expect(odd).toEqual({ kind: "skip", reason: "host_cannot_read" });
    // A force push: the history from the head never meets the commit Rovara pushed.
    expect(await read({ [sha(2)]: commit([sha(50)], byPerson()), [sha(50)]: commit([], byPerson()) }, sha(2)).result).toEqual({ kind: "skip", reason: "base_not_reached" });
    expect(await read({ [sha(2)]: { files: "nope" as unknown as ChangeRequestFile[], complete: true, parents: [BASE], identity: byPerson() } }, sha(2)).result).toEqual({ kind: "skip", reason: "host_cannot_read" });
    expect(await read({}, "not-a-sha").result).toEqual({ kind: "skip", reason: "base_not_reached" });
    const long: Record<string, CommitChanges> = {};
    for (let n = 0; n <= HUMAN_EDIT_COMMITS_MAX; n += 1) long[sha(1_000 + n)] = commit([sha(1_001 + n)], byPerson());
    expect(await read(long, sha(1_000)).result).toEqual({ kind: "skip", reason: "too_many_commits" });
    // Exactly the most is still read.
    const exact: Record<string, CommitChanges> = {};
    for (let n = 0; n < HUMAN_EDIT_COMMITS_MAX; n += 1) exact[sha(1_000 + n)] = commit([n === HUMAN_EDIT_COMMITS_MAX - 1 ? BASE : sha(1_001 + n)], byPerson());
    expect((await read(exact, sha(1_000)).result).kind).toBe("edit");
  });
});

describe("a huge diff is skipped with a fixed reason", () => {
  it("a diff the host cut is too large, and nothing of it is read", async () => {
    expect(await read({ [sha(2)]: commit([BASE], byPerson(), [file("src/a.ts", 2, 1, EDIT)], false) }, sha(2)).result).toEqual({ kind: "skip", reason: "diff_too_large" });
  });
  it("too many changed lines, or too many files, in the person's commits together is too large", async () => {
    const big = (lines: number) => [file("src/a.ts", lines, 0, patchOf("+x"))];
    expect(await read({ [sha(2)]: commit([BASE], byPerson(), big(HUMAN_EDIT_LINES_MAX + 1)) }, sha(2)).result).toEqual({ kind: "skip", reason: "diff_too_large" });
    expect((await read({ [sha(2)]: commit([BASE], byPerson(), big(HUMAN_EDIT_LINES_MAX)) }, sha(2)).result).kind).toBe("edit");
    const many = (count: number) => Array.from({ length: count }, (_, n) => file(`src/f${String(n)}.ts`, 3, 0, patchOf("+a", "+b", "+c")));
    expect(await read({ [sha(2)]: commit([BASE], byPerson(), many(HUMAN_EDIT_FILES_MAX + 1)) }, sha(2)).result).toEqual({ kind: "skip", reason: "diff_too_large" });
    expect((await read({ [sha(2)]: commit([BASE], byPerson(), many(HUMAN_EDIT_FILES_MAX)) }, sha(2)).result).kind).toBe("edit");
  });
  it("the size is the PERSON's commits together: a huge bot commit beside a small person's edit does not make the edit too large", async () => {
    const table = {
      [sha(2)]: commit([BASE], byPerson(), [file("src/fetch.ts", 2, 1, EDIT)]),
      [sha(3)]: commit([sha(2)], byBot(), [file("src/gen.ts", HUMAN_EDIT_LINES_MAX * 2, 0, patchOf("+x"))], false),
    };
    expect((await read(table, sha(3)).result).kind).toBe("edit");
  });
  it("what is handed on is cut: at most the files and the changed lines in all, each line redacted and short", async () => {
    const lines = (n: number) => patchOf(...Array.from({ length: n }, (_, k) => `+const value${String(k)} = ${String(k)};`));
    const files = Array.from({ length: HUMAN_EDIT_HANDED_FILES_MAX + 5 }, (_, n) => file(`src/f${String(n).padStart(2, "0")}.ts`, 90, 0, lines(90)));
    const edit = await read({ [sha(2)]: commit([BASE], byPerson(), files) }, sha(2)).result;
    if (edit.kind !== "edit") throw new Error("expected an edit");
    expect(edit.files.length).toBeLessThanOrEqual(HUMAN_EDIT_HANDED_FILES_MAX);
    const changed = edit.files.flatMap((entry) => entry.hunks.filter((line) => line.startsWith("+") || line.startsWith("-")));
    expect(changed.length).toBeLessThanOrEqual(HUMAN_EDIT_HANDED_LINES_MAX);
    const token = ["ghp", "_", "A".repeat(36)].join("");
    const secret = await read({ [sha(2)]: commit([BASE], byPerson(), [file("src/a.ts", 3, 0, patchOf(`+const token = "${token}";`, `+const long = "${"x".repeat(2_000)}";`, "+ok()"))]) }, sha(2)).result;
    if (secret.kind !== "edit") throw new Error("expected an edit");
    const text = JSON.stringify(secret);
    expect(text).not.toContain(token);
    expect(Math.max(...secret.files[0]!.hunks.map((line) => line.length))).toBeLessThanOrEqual(300);
  });
});

describe("what teaches nothing is ignored", () => {
  const edit = (files: ChangeRequestFile[]) => read({ [sha(2)]: commit([BASE], byPerson(), files) }, sha(2)).result;
  it("lockfiles, generated and vendored files and snapshots", async () => {
    const lines = patchOf("+a", "+b", "+c", "+d");
    for (const path of ["package-lock.json", "web/yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "dist/app.js", "src/__generated__/types.ts", "vendor/lib/x.go", "assets/app.min.js", "src/__snapshots__/a.snap", "go.sum"]) {
      expect(await edit([file(path, 4, 0, lines)]), path).toEqual({ kind: "skip", reason: "trivial" });
    }
    // A file renamed OUT of an ignored path is ignored too.
    expect(await edit([file("src/new-name.ts", 4, 0, lines, { status: "renamed", previousPath: "package-lock.json" })])).toEqual({ kind: "skip", reason: "trivial" });
    const mixed = await edit([file("package-lock.json", 40, 0, lines), file("src/fetch.ts", 2, 1, EDIT)]);
    if (mixed.kind !== "edit") throw new Error("expected an edit");
    expect(mixed.files.map((entry) => entry.path)).toEqual(["src/fetch.ts"]);
  });
  it("a rename with nothing changed, a file the host gave no text for, and a whitespace-only change", async () => {
    expect(await edit([file("src/new.ts", 0, 0, undefined, { status: "renamed", previousPath: "src/old.ts" })])).toEqual({ kind: "skip", reason: "trivial" });
    expect(await edit([file("assets/logo.png", 40, 0, undefined)])).toEqual({ kind: "skip", reason: "trivial" });
    expect(await edit([file("src/a.ts", 3, 3, patchOf("-  const a = 1;", "-b()", "-if (x) { y() }", "+const a = 1;", "+  b()", "+if (x) {y()}"))])).toEqual({ kind: "skip", reason: "trivial" });
  });
  it("an edit under 3 changed lines in all", async () => {
    expect(await edit([file("src/a.ts", 1, 1, patchOf("-a()", "+b()"))])).toEqual({ kind: "skip", reason: "trivial" });
    expect((await edit([file("src/a.ts", 2, 1, patchOf("-a()", "+b()", "+c()"))])).kind).toBe("edit");
  });
});
