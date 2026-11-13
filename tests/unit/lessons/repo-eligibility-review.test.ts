// The prompt header is an input, a person's edit typed in Rovara is an input, derived text of unknown origin
// is unknown, a person's name on derived text blocks, a lesson may not be merged out of a repository's file by an ineligible draft.
import { describe, expect, it } from "vitest";
import { approveLesson, type ApproveDeps } from "../../../packages/core/src/lessons/approve.js";
import { curateDraft, foldDuplicate, type CurateDeps } from "../../../packages/core/src/lessons/curate.js";
import { reflectSubject, type LessonDraft, type ReflectDeps } from "../../../packages/core/src/lessons/reflect.js";
import type { EvidenceSpan } from "../../../packages/core/src/lessons/reflect-input.js";
import { afterPersonEdit, citationsStayIn, isRepoFileEligible, mergeKeepsRepoOnly, repoVisibilityOf } from "../../../packages/core/src/lessons/repo-eligibility.js";
import { InMemoryLessonStore } from "../../../packages/core/src/lessons/store.js";
import { Alerts, Audit, Clock, KEY, MemoryVectors, ScriptedModel, Spend, allowAllAccess, candidateJson, codeCite, directory, draft, embedder, lessonRecord, memberSpan, reply, seed, settings, subject, verifier } from "./lesson-helpers.js";

const A = "github:repo/1001";
const PREFIX = "https://github.com/acme/api/pull/";
const proof = { place: A, repository: "api", linkPrefix: PREFIX };
const inRepo = (over: Partial<EvidenceSpan> = {}): EvidenceSpan => memberSpan("Use withRetry for HTTP retries in api.", { kind: "pr_comment", scopes: [A], audience: { kind: "project" }, ...over });
const reflectDeps = (model: ScriptedModel): ReflectDeps => ({ model, spend: new Spend(), audit: new Audit(), settings: settings(), edition: "public", now: new Clock().now, newId: () => "run-1" });

describe("the prompt header and the citations are inputs", () => {
  it("a header that names a second repository and its pull request blocks repoOnly, and the prompt did contain the name (positive control)", async () => {
    const model = new ScriptedModel([reply(candidateJson({ citations: [codeCite({ repo: "secret-acquisition" })] }))]);
    const result = await reflectSubject(reflectDeps(model), subject([inRepo()], { repoInputs: proof, repositories: ["api", "secret-acquisition"], links: [`${PREFIX}7`, "https://github.com/acme/secret-acquisition/pull/3"] }));
    expect((model.calls[0] as { user: string }).user).toContain("secret-acquisition");
    const p = result.drafts[0]!.provenance;
    expect(p.repoOnly).toBeUndefined();
    expect(p.repoBlockCodes).toContain("other_repo");
  });
  it("a link of another repository alone blocks it; so does a repository list that is not exactly the proved one; own repository and own pull requests pass", () => {
    const base = { kind: "task", repoInputs: proof } as const;
    expect(repoVisibilityOf({ ...base, repositories: ["api"], links: [`${PREFIX}7`] }, [inRepo()]).repoOnly).toEqual({ place: A });
    expect(repoVisibilityOf({ ...base, repositories: ["api"], links: [] }, [inRepo()]).repoOnly).toEqual({ place: A });
    for (const header of [
      { repositories: ["api"], links: ["https://github.com/acme/other/pull/3"] }, { repositories: ["api"], links: [`${PREFIX}7/files`] }, { repositories: ["api"], links: [`${PREFIX}x`] }, { repositories: ["other"], links: [] },
      { repositories: ["api", "other"], links: [] }, { repositories: [], links: [] }, { repositories: undefined, links: undefined },
    ]) expect(repoVisibilityOf({ ...base, ...header }, [inRepo()]).blocked, JSON.stringify(header)).toContain("other_repo");
  });
  it("a proof with no repository name or no pull request prefix fails closed", () => {
    for (const bad of [{ ...proof, repository: "" }, { ...proof, linkPrefix: "" }]) expect(repoVisibilityOf({ kind: "task", repoInputs: bad, repositories: ["api"], links: [] }, [inRepo()]).repoOnly).toBeUndefined();
  });
  it("the proof's URL prefix must be exactly https://<host>/<owner>/<repository>/pull/ for the proved repository (a prefix ending in the name would accept api7)", () => {
    const header = { repositories: ["api"], links: ["https://github.com/acme/api7"] };
    for (const linkPrefix of ["https://github.com/acme/api", "https://github.com/acme/api/", "https://github.com/acme/api/pull", "https://github.com/acme/api7/pull/", "https://github.com/api/pull/", "http://github.com/acme/api/pull/", "https://github.com/acme/api/pulls/", "https://github.com/acme/api/pull/ "]) {
      const v = repoVisibilityOf({ kind: "task", repoInputs: { ...proof, linkPrefix }, ...header }, [inRepo()]);
      expect(v.repoOnly, linkPrefix).toBeUndefined();
      expect(v.blocked, linkPrefix).toContain("other_repo");
      expect(citationsStayIn({ ...proof, linkPrefix }, [{ kind: "pr", url: `${linkPrefix}7` }]), `citation ${linkPrefix}`).toBe(false);
    }
    expect(repoVisibilityOf({ kind: "task", repoInputs: proof, repositories: ["api"], links: ["https://github.com/acme/api7"] }, [inRepo()]).blocked).toContain("other_repo");
    expect(repoVisibilityOf({ kind: "task", repoInputs: proof, repositories: ["api"], links: [`${PREFIX}7`] }, [inRepo()]).repoOnly).toEqual({ place: A });
  });
  it("a facts subject may name no repository and no link", () => {
    expect(repoVisibilityOf({ kind: "facts" }, [inRepo()]).repoOnly).toEqual({ place: A });
    expect(repoVisibilityOf({ kind: "facts", repositories: ["api"] }, [inRepo()]).blocked).toContain("other_repo");
    expect(repoVisibilityOf({ kind: "facts", links: [`${PREFIX}1`] }, [inRepo()]).blocked).toContain("other_repo");
  });
  it("a citation in another repository, or a pull request that is not the repository's, clears repoOnly (pure rule)", () => {
    expect(citationsStayIn(proof, [codeCite({ repo: "api" }), { kind: "pr", url: `${PREFIX}9` }, { kind: "record", eventId: "e" }])).toBe(true);
    expect(citationsStayIn(proof, [codeCite({ repo: "secret-acquisition" })])).toBe(false);
    expect(citationsStayIn(proof, [{ kind: "pr", url: "https://github.com/acme/other/pull/1" }])).toBe(false);
    expect(citationsStayIn(undefined, [codeCite({ repo: "api" })])).toBe(false);
    expect(citationsStayIn(undefined, [{ kind: "record", eventId: "e" }, { kind: "task", taskId: "t" }])).toBe(true);
  });
  it("a reflection that keeps a code citation in the proved repository stays repository-only (control)", async () => {
    const model = new ScriptedModel([reply(candidateJson({ citations: [codeCite()] }))]);
    const result = await reflectSubject(reflectDeps(model), subject([inRepo()], { repoInputs: proof, repositories: ["api"], links: [`${PREFIX}7`] }));
    expect(result.drafts[0]!.citations.some((c) => c.kind === "code")).toBe(true);
    expect(result.drafts[0]!.provenance.repoOnly).toEqual({ place: A });
  });
});

describe("derived and repository text of unknown or personal origin", () => {
  const withPlace = { scopes: [A], audience: { kind: "project" as const } };
  it("in a facts subject a plan or finding with no place is an unknown input; in a task it stays derived", () => {
    const fact: EvidenceSpan = { kind: "fact", text: "x", trust: "system", ...withPlace };
    const v = repoVisibilityOf({ kind: "facts" }, [fact, { kind: "plan", trust: "system" }, { kind: "review_finding", trust: "system" }]);
    expect(v.repoOnly).toBeUndefined();
    expect(v.blocked).toContain("unknown_input");
    expect(repoVisibilityOf({ kind: "task", repoInputs: proof, repositories: ["api"], links: [] }, [inRepo(), { kind: "plan", trust: "system" }]).repoOnly).toEqual({ place: A });
  });
  it("a plan or finding that carries a repository place still blocks when a person wrote it", () => {
    for (const kind of ["plan", "review_finding", "ci_failure"]) {
      for (const person of [{ authorId: "ann", trust: "system" }, { authorIds: ["ann", "bob"], trust: "system" }, { trust: "member" }]) {
        const v = repoVisibilityOf({ kind: "task", repoInputs: proof, repositories: ["api"], links: [] }, [inRepo(), { kind, ...withPlace, ...person }]);
        // A CI result tied to a person (who pushed the failing revision) has its own code; it still blocks.
        expect(v.repoOnly, `${kind} ${JSON.stringify(person)}`).toBeUndefined();
        expect(v.blocked, `${kind} ${JSON.stringify(person)}`).toEqual([kind === "ci_failure" ? "ci_author" : "typed_in_rovara"]);
      }
    }
  });
  it("a fact or an outcome must also have no author, and must pass the audience check", () => {
    for (const kind of ["fact", "outcome"]) {
      const subjectOf = { kind: "facts" } as const;
      expect(repoVisibilityOf(subjectOf, [{ kind, trust: "system", ...withPlace }]).repoOnly, kind).toEqual({ place: A });
      expect(repoVisibilityOf(subjectOf, [{ kind, trust: "system", authorId: "ann", ...withPlace }]).blocked, `${kind} author`).toContain("typed_in_rovara");
      expect(repoVisibilityOf(subjectOf, [{ kind, trust: "member", ...withPlace }]).blocked, `${kind} member`).toContain("typed_in_rovara");
      expect(repoVisibilityOf(subjectOf, [{ kind, trust: "system", scopes: [A] }]).blocked, `${kind} audience`).toContain("audience_not_repo");
      expect(repoVisibilityOf(subjectOf, [{ kind, trust: "system", scopes: [A], audience: { kind: "restricted", acl: { source: "slack", scope: "slack:channel/C1", capturedAt: "t", liveCheck: "none" } } }]).blocked, `${kind} slack audience`).toContain("audience_not_repo");
    }
  });
});

describe("a person's edit-and-approve is text typed in Rovara", () => {
  function setup(repoOnly: boolean) {
    const store = new InMemoryLessonStore();
    let n = 0;
    const deps: ApproveDeps = { access: allowAllAccess, store, directory: directory(), settings: settings(), audit: new Audit(), now: new Clock().now, newId: () => `ap-${++n}` };
    const base = lessonRecord();
    const lesson = lessonRecord({ id: "les_pend0001", status: "pending", tier: 1, tierReasons: ["not_a_fact"], approvals: [], type: "convention", pendingExpiresAt: 9e15, provenance: { ...base.provenance, authors: ["carl"], ...(repoOnly ? { repoOnly: { place: A } } : { repoBlockCodes: ["other_place" as const] }) } });
    return { store, deps, seeded: seed(store, lesson) };
  }
  const edit = { title: "Retries", description: "", body: "Per the Q3 customer escalation in #deals, retries stay at 3." };
  it("an edit clears repoOnly and records typed_in_rovara, keeping the reasons it had; the file gate then refuses the lesson", async () => {
    const s = setup(true);
    await s.seeded;
    expect(await approveLesson(s.deps, { ...KEY, lessonId: "les_pend0001", approverId: "ann", edit })).toMatchObject({ ok: true });
    const after = (await s.store.get(KEY, "les_pend0001"))!;
    expect(after.body).toContain("#deals");
    expect(after.provenance.repoOnly).toBeUndefined();
    expect(after.provenance.repoBlockCodes).toEqual(["typed_in_rovara"]);
    expect(isRepoFileEligible({ ...after, status: "active", trial: { state: "stable", startedAt: 1 } }, A, [])).toBe(false);
  });
  it("an edit of a lesson that was already blocked keeps those reasons and adds typed_in_rovara", async () => {
    const s = setup(false);
    await s.seeded;
    await approveLesson(s.deps, { ...KEY, lessonId: "les_pend0001", approverId: "ann", edit });
    expect((await s.store.get(KEY, "les_pend0001"))!.provenance.repoBlockCodes).toEqual(["typed_in_rovara", "other_place"]);
  });
  it("an approval without an edit keeps repoOnly (control: only typed text clears it)", async () => {
    const s = setup(true);
    await s.seeded;
    expect(await approveLesson(s.deps, { ...KEY, lessonId: "les_pend0001", approverId: "ann" })).toMatchObject({ ok: true });
    expect((await s.store.get(KEY, "les_pend0001"))!.provenance.repoOnly).toEqual({ place: A });
  });
  it("afterPersonEdit is pure and never leaves repoOnly", () => {
    expect(afterPersonEdit({ repoOnly: { place: A } })).toEqual({ repoBlockCodes: ["typed_in_rovara"] });
    expect(afterPersonEdit({ repoBlockCodes: ["other_place"] })).toEqual({ repoBlockCodes: ["typed_in_rovara", "other_place"] });
  });
});

describe("an ineligible draft may not merge a repository-file lesson out of its file", () => {
  const only = { place: A };
  const stable = { state: "stable" as const, startedAt: 1, stableAt: 2 };
  const fileLesson = (over: Partial<ReturnType<typeof lessonRecord>> = {}) => lessonRecord({ id: "les_file0001", trial: stable, ...over, provenance: { ...lessonRecord().provenance, repoOnly: only, ...over.provenance } });
  const draftWith = (prov: Record<string, unknown>): LessonDraft => { const { repoOnly: _o, repoBlockCodes: _b, ...rest } = draft().provenance; void _o; void _b; return draft({ provenance: { ...rest, memberCorrection: true, claimsSupported: true, ...prov } }); };

  it("pure rule: allowed when the merge stays repository-only or neither side is; refused across that line", () => {
    expect(mergeKeepsRepoOnly(fileLesson(), draftWith({ repoOnly: only }))).toBe(true);
    expect(mergeKeepsRepoOnly(fileLesson(), draftWith({ repoBlockCodes: ["typed_in_rovara"] }))).toBe(false);
    expect(mergeKeepsRepoOnly(fileLesson(), draftWith({}))).toBe(false);
    expect(mergeKeepsRepoOnly(fileLesson(), draftWith({ repoOnly: { place: "github:repo/2002" } }))).toBe(false);
    // The target's state no longer matters; a repo-only target on trial or retired is protected the same way, and a pair with no repoOnly on either side is free to merge.
    expect(mergeKeepsRepoOnly(fileLesson({ trial: { state: "trial", startedAt: 1 } }), draftWith({}))).toBe(false);
    expect(mergeKeepsRepoOnly(fileLesson({ status: "retired" }), draftWith({}))).toBe(false);
    expect(mergeKeepsRepoOnly(lessonRecord({ trial: stable }), draftWith({}))).toBe(true);
    expect(mergeKeepsRepoOnly(lessonRecord({ trial: stable }), draftWith({ repoOnly: only }))).toBe(false);
  });

  function setup() {
    const store = new InMemoryLessonStore();
    let n = 0;
    const vectors = new MemoryVectors();
    const deps: CurateDeps & { verifier: unknown; settings: unknown } = {
      store, embedder, vectors, judgeModel: new ScriptedModel(), spend: new Spend(), audit: new Audit(), alerts: new Alerts(), now: new Clock().now, verifier: verifier("valid"), settings: settings(),
      newId: () => `les_${String(++n).padStart(4, "0")}`,
    };
    return { deps, store, vectors };
  }
  it("curateDraft: an identical but ineligible draft stays its own lesson and the file lesson is untouched; an eligible draft still merges", async () => {
    const { deps, store, vectors } = setup();
    const target = fileLesson({ title: draft().title, description: draft().description, body: draft().body });
    await seed(store, target);
    await vectors.upsert(target.workspaceId, target.project, target.id, await embedder.embed(`${target.title}\n${target.description}\n${target.body}`), { status: "active" });
    const outcome = await curateDraft(deps, KEY, draftWith({ repoBlockCodes: ["typed_in_rovara"] }));
    // Kept apart, but linked to the lesson it may duplicate, so a person sees it (merge, keep both or reject).
    expect(outcome).toMatchObject({ outcome: "possible_duplicate", duplicateOf: target.id });
    expect((await store.list(KEY)).find((l) => l.id !== target.id)).toMatchObject({ status: "pending", possibleDuplicateOf: target.id });
    // Linked both ways: the target's text and mark are untouched, it only learns who its twin is.
    expect((await store.get(KEY, target.id))).toMatchObject({ version: 2, repoTwins: [(await store.list(KEY)).find((l) => l.id !== target.id)!.id], provenance: { repoOnly: only } });
    expect((await store.list(KEY)).length).toBe(2);
    const second = setup();
    await seed(second.store, target);
    await second.vectors.upsert(target.workspaceId, target.project, target.id, await embedder.embed(`${target.title}\n${target.description}\n${target.body}`), { status: "active" });
    expect((await curateDraft(second.deps, KEY, draftWith({ repoOnly: only }))).outcome).toBe("merged");
    expect((await second.store.get(KEY, target.id))!.provenance.repoOnly).toEqual(only);
  });
  it("a person's merge (foldDuplicate) of an ineligible duplicate into a file lesson is refused", async () => {
    const store = new InMemoryLessonStore();
    const target = fileLesson();
    const duplicate = { ...lessonRecord({ id: "les_dup00001" }), status: "pending" as const };
    duplicate.provenance = { ...duplicate.provenance, memberCorrection: true, claimsSupported: true };
    await seed(store, target, duplicate);
    expect(await foldDuplicate({ store, now: () => 5 }, KEY, target, duplicate)).toBeUndefined();
    const same = { ...duplicate, provenance: { ...duplicate.provenance, repoOnly: only } };
    expect(await foldDuplicate({ store, now: () => 5 }, KEY, target, same)).toBeDefined();
  });
});
