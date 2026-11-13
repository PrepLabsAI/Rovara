// A reworded rejected lesson reaches the judge, and without one a person; "near" means equal words after filler and
// stemming; a judge's "same" needs the antonym, unit and closeness floors; the lessons' embedder client has a short wait, a pause after a timeout and no fan-out; a card never names a rejected
// lesson its draft's audience cannot read. is left as documented.
import { beforeEach, describe, expect, it } from "vitest";
import { relate, wordsOf } from "../../../packages/core/src/lessons/copy-match.js";
import { curateDraft, type CurateDeps } from "../../../packages/core/src/lessons/curate.js";
import { processDraft, type ProcessDeps } from "../../../packages/core/src/lessons/process.js";
import type { LessonEmbedder } from "../../../packages/core/src/lessons/ports.js";
import { InMemoryLessonStore } from "../../../packages/core/src/lessons/store.js";
import { closeEnoughForSame, docOf, matchesRejected, resetNoEmbedderNotice, type Ranked } from "../../../packages/core/src/lessons/similarity.js";
import type { LessonDraft } from "../../../packages/core/src/lessons/reflect.js";
import { Alerts, Audit, Clock, KEY, MemoryVectors, ScriptedModel, Spend, closeEmbedder, draft, embedder, facts, lessonRecord, seed, settings, verifier } from "./lesson-helpers.js";

const answer = (...verdicts: string[]): string => JSON.stringify({ verdicts: verdicts.map((verdict, i) => ({ n: i + 1, verdict })) });
const textOf = (body: string, over: Partial<LessonDraft> = {}): LessonDraft => draft({ title: "Advice", description: "", body, citations: [], scope: {}, ...over });
const SHARED = [{ kind: "code" as const, repo: "api", path: "src/db/client.ts", startLine: 1, endLine: 2, anchor: "createClient", commit: "a".repeat(40) }];

function setup(over: { model?: ScriptedModel; embedder?: LessonEmbedder } = {}) {
  const store = new InMemoryLessonStore();
  const audit = new Audit();
  const model = over.model ?? new ScriptedModel();
  let n = 0;
  const deps: CurateDeps & ProcessDeps & { verifier: unknown; settings: unknown } = {
    store, ...(over.embedder === undefined ? {} : { embedder: over.embedder }), vectors: new MemoryVectors(), judgeModel: model, spend: new Spend(), audit, alerts: new Alerts(), now: new Clock().now,
    verifier: verifier("valid"), facts: facts(), settings: settings(), log: () => undefined, newId: () => `les_${String(++n).padStart(4, "0")}`,
  };
  return { deps, store, audit, model };
}
const rejectedLesson = (body: string, over: Partial<Parameters<typeof lessonRecord>[0]> = {}) => lessonRecord({ id: "les_rej00001", title: "Advice", description: "", body, status: "rejected", citations: [], citationChecks: [], approvals: [], tier: 1, tierReasons: [], scope: {}, ...over });
beforeEach(() => { embedder.fail = false; embedder.calls = 0; resetNoEmbedderNotice(); });

// ----
const REWORDED: Array<[string, string, string]> = [
  ["disable -> turn off", "Disable TLS verification when connecting to staging Postgres.", "Turn off TLS verification when connecting to staging Postgres."],
  ["skip -> ignore", "Skip the integration tests on release branches.", "Ignore the integration tests on release branches."],
  ["never -> avoid", "Never run the migration lock check in CI.", "Avoid running the migration lock check in CI."],
  ["store -> keep", "Store API keys in the frontend env file.", "Keep API keys in the frontend env file."],
  ["full paraphrase", "Never commit generated protobuf files to the repository.", "Do not check generated protobuf files into git."],
];

describe("a reworded rejected lesson reaches the judge, and without a judge a person", () => {
  it.each(REWORDED)("%s: the judge is shown the rejected lesson and its \"same\" on a reworded draft sends it to a person (never dropped: the words are not the same advice by structure)", async (_name, rejected, reworded) => {
    const s = setup({ model: new ScriptedModel([answer("same")]) });
    await seed(s.store, rejectedLesson(rejected));
    const out = await curateDraft(s.deps, KEY, textOf(reworded));
    expect(out).toMatchObject({ outcome: "contradiction", other: "les_rej00001", matchesRejected: true, lesson: { status: "pending", tierReasons: ["contradiction", "matches_rejected"] } });
    expect(s.model.calls).toHaveLength(1);
    expect(String(s.model.calls[0]!.user)).toContain("state=previously_rejected");
  });

  it.each(REWORDED)("%s: with no judge (the call fails) but a close vector it goes to a person, never a plain candidate", async (_name, rejected, reworded) => {
    const s = setup({ embedder: closeEmbedder });
    await seed(s.store, rejectedLesson(rejected));
    const out = await curateDraft(s.deps, KEY, textOf(reworded));
    expect(out).toMatchObject({ outcome: "contradiction", other: "les_rej00001", matchesRejected: true, lesson: { status: "pending", contradictsWith: "les_rej00001" } });
  });

  it.each(REWORDED)("%s: a judge that says \"different\" leaves an ordinary candidate (the judge had the say)", async (_name, rejected, reworded) => {
    const s = setup({ model: new ScriptedModel([answer("different")]), embedder: closeEmbedder });
    await seed(s.store, rejectedLesson(rejected));
    expect((await curateDraft(s.deps, KEY, textOf(reworded))).outcome).toBe("added");
    expect(s.model.calls).toHaveLength(1);
  });

  it("the rejected lesson keeps its place even when six live neighbours compete, and is shown IN ADDITION to five live ones", async () => {
    const s = setup({ model: new ScriptedModel([answer("different", "different", "different", "different", "different", "same")]) });
    await seed(s.store, rejectedLesson("Disable TLS verification when connecting to staging Postgres."));
    for (let i = 0; i < 6; i += 1) await seed(s.store, lessonRecord({ id: `les_live${i}000`, title: "Advice", description: "", body: `TLS verification step ${i} when connecting to staging Postgres in the build ${i}`, status: "candidate", citations: [], citationChecks: [], approvals: [], tier: 1, tierReasons: [], scope: {} }));
    const out = await curateDraft(s.deps, KEY, textOf("Turn off TLS verification when connecting to staging Postgres."));
    const prompt = String(s.model.calls[0]!.user);
    expect(prompt.match(/^\d\. state=/gmu)).toHaveLength(6);
    expect(prompt).toContain("state=previously_rejected");
    // Five places go to live lessons; the judge's "same" on the last one is the rejected lesson's. The draft is reworded, so a person sees it.
    expect(out).toMatchObject({ outcome: "contradiction", matchesRejected: true });
  });

  it("the opposite of the rejected advice is still an ordinary candidate with a close vector and no judge (the stance differs); an unrelated draft is too", async () => {
    const s = setup({ embedder: closeEmbedder });
    await seed(s.store, rejectedLesson("Never commit generated protobuf files to the repository."));
    expect((await curateDraft(s.deps, KEY, textOf("Always commit generated protobuf files to the repository."))).outcome).toBe("added");
    expect((await curateDraft(s.deps, KEY, textOf("Retry the payment webhook 9 times before failing."))).outcome).toBe("added");
  });

  it("a changed number or a reordered pair is not a synonym swap: no card even with a close vector", async () => {
    const s = setup({ embedder: closeEmbedder });
    await seed(s.store, rejectedLesson("Retry the payment webhook 3 times before failing."));
    expect((await curateDraft(s.deps, KEY, textOf("Retry the payment webhook 9 times before failing."))).outcome).toBe("added");
  });

  it("matchesRejected: a close vector counts when the pair is only a synonym swap, and polarity words that really differ still block it", () => {
    const hit = (draftBody: string, rejectedBody: string, cosineValue: number | undefined) => matchesRejected(docOf(textOf(draftBody)), docOf(textOf(rejectedBody)), cosineValue, draftBody, rejectedBody);
    expect(hit("Turn off TLS verification when connecting to staging Postgres.", "Disable TLS verification when connecting to staging Postgres.", 0.95)).toBe(true);
    expect(hit("Turn off TLS verification when connecting to staging Postgres.", "Disable TLS verification when connecting to staging Postgres.", 0.8)).toBe(false);
    expect(hit("Turn on TLS verification when connecting to staging Postgres.", "Disable TLS verification when connecting to staging Postgres.", 0.99)).toBe(false);
    expect(hit("Enable TLS verification when connecting to staging Postgres.", "Disable TLS verification when connecting to staging Postgres.", 0.99)).toBe(false);
  });
});

// ----
describe("near means equal words after filler removal and stemming", () => {
  const base = "Call createClient with pooling enabled and a statement timeout for every service connecting to Postgres from the API layer, including background workers, cron jobs, migration runners, seed scripts and admin consoles";
  const EDITS: Array<[string, string]> = [
    ["an inserted 'legacy'", base.replace("every service", "every legacy service")],
    ["an inserted 'staging'", base.replace("connecting to Postgres", "connecting to staging Postgres")],
    ["an inserted 'read replica'", base.replace("to Postgres", "to Postgres read replica")],
    ["a dropped 'pooling'", base.replace("pooling ", "")],
    ["a dropped 'cron jobs'", base.replace(" cron jobs,", "")],
  ];
  it.each(EDITS)("%s on a long lesson is not near", (_name, edited) => {
    expect(relate(edited, base).near).toBe(false);
    expect(relate(base, edited).near).toBe(false);
  });
  it.each(EDITS)("%s never merges with no judge, with the same cited file", async (_name, edited) => {
    const s = setup();
    await seed(s.store, lessonRecord({ id: "les_target01", title: "Advice", description: "", body: base, status: "candidate", citations: SHARED, citationChecks: [], approvals: [], tier: 1, tierReasons: [] }));
    const out = await curateDraft(s.deps, KEY, textOf(edited, { citations: SHARED }));
    expect(out.outcome).not.toBe("merged");
    expect((await s.store.get(KEY, "les_target01"))!.version).toBe(1);
  });
  it("positive controls: filler, a plural, a contraction and punctuation are still near", () => {
    expect(relate(`${base}, also`, base).near).toBe(true);
    expect(relate(base.replace("the API layer", "API layer").replace("a statement", "the statement"), base).near).toBe(true);
    expect(relate("Cache the tokens for ten minutes in the api service.", "Cache the token for ten minutes in the api service.").near).toBe(true);
    expect(relate("Don't use withRetry for HTTP calls in the api service.", "Do not use withRetry for HTTP calls in the api service.").near).toBe(true);
  });
});

// ----
const SAFE = { bodyMutual: 0.95, cosine: 0.97, sharedFile: true, bothUncited: false } as Pick<Ranked, "bodyMutual" | "cosine" | "sharedFile" | "bothUncited">;
describe("a judge's \"same\" is refused for antonyms, units and weak closeness", () => {
  const OPPOSITES: Array<[string, string, string]> = [
    ["min / max", "Set the minimum pool size to the number of cores.", "Set the maximum pool size to the number of cores."],
    ["sync / async", "Use the sync API of the payment client in handlers.", "Use the async API of the payment client in handlers."],
    ["synchronously / asynchronously", "Call the payment client synchronously from the handler.", "Call the payment client asynchronously from the handler."],
    ["public / private", "Make the bucket for build output public.", "Make the bucket for build output private."],
    ["accept / reject", "Accept requests without a request id header.", "Reject requests without a request id header."],
    ["allow / deny", "Allow the CI bot to push to the release branch.", "Deny the CI bot to push to the release branch."],
    ["include / exclude", "Include the auth header in retry requests.", "Exclude the auth header in retry requests."],
    ["enable / disable", "Enable caching for the build step.", "Disable caching for the build step."],
    ["increase / decrease", "Increase the lambda timeout for the importer.", "Decrease the lambda timeout for the importer."],
    ["safe / unsafe", "Treat the shell helper as safe in the sandbox.", "Treat the shell helper as unsafe in the sandbox."],
    ["valid / invalid", "Treat an expired session as valid on the status page.", "Treat an expired session as invalid on the status page."],
    ["authenticated / unauthenticated", "Serve the health route to authenticated callers.", "Serve the health route to unauthenticated callers."],
    ["prefix un-", "Mark the flag as used in the config loader.", "Mark the flag as unused in the config loader."],
    ["prefix dis- (dis, not just en)", "Treat the connection pool as connected after the handshake.", "Treat the connection pool as disconnected after the handshake."],
    ["prefix non-", "Treat the cache layer as blocking in handlers.", "Treat the cache layer as nonblocking in handlers."],
    ["deprecated", "Use the v1 client for billing calls.", "Use the deprecated v1 client for billing calls."],
    ["ms / s", "Set the request timeout to 500 ms.", "Set the request timeout to 500 s."],
    ["milliseconds / seconds", "Set the request timeout to 500 milliseconds.", "Set the request timeout to 500 seconds."],
    ["MB / GB", "Cap uploads at 10 MB.", "Cap uploads at 10 GB."],
    ["KB / MB", "Cap the log line at 64 KB.", "Cap the log line at 64 MB."],
  ];
  it.each(OPPOSITES)("%s: not close enough, whatever the closeness", (_name, a, b) => {
    expect(closeEnoughForSame(SAFE, a, b)).toBe(false);
    expect(closeEnoughForSame(SAFE, b, a)).toBe(false);
  });
  it.each(OPPOSITES.slice(0, 3))("%s: a judge that says same still does not merge", async (_name, existing, reworded) => {
    const s = setup({ model: new ScriptedModel([answer("same")]) });
    await seed(s.store, lessonRecord({ id: "les_target01", title: "Advice", description: "", body: existing, status: "candidate", citations: [], citationChecks: [], approvals: [], tier: 1, tierReasons: [] }));
    const out = await curateDraft(s.deps, KEY, textOf(reworded));
    expect(out.outcome).not.toBe("merged");
    expect((await s.store.get(KEY, "les_target01"))!.version).toBe(1);
  });
  it("positive control: a copy that differs by filler and a plural is the same by structure; a reworded pair with the same critical words is NOT (it is a possible duplicate for a person)", () => {
    const a = "Use withRetry from src/retry/index.ts for HTTP retries in the api service client calls";
    expect(closeEnoughForSame(SAFE, a, "Use the withRetry from src/retry/index.ts for the HTTP retry in the api service client call")).toBe(true);
    expect(closeEnoughForSame(SAFE, a, "Wrap outbound HTTP calls in the api service with withRetry from src/retry/index.ts")).toBe(false);
    expect(closeEnoughForSame({ bodyMutual: 0.8, sharedFile: true, bothUncited: false }, a, "Wrap outbound HTTP calls in the api service with withRetry from src/retry/index.ts")).toBe(false);
  });
  it("the closeness figures no longer matter (equal words are as close as two texts get, and anything else is never the same however close the cosine)", () => {
    const a = "Use withRetry from src/retry/index.ts for HTTP retries in the api service client calls";
    const b = "Wrap outbound HTTP calls in the api service with withRetry from src/retry/index.ts";
    const copy = "Use the withRetry from src/retry/index.ts for the HTTP retry in the api service client call";
    for (const ranked of [{ bodyMutual: 0.95, cosine: 0.99, sharedFile: true, bothUncited: false }, { bodyMutual: 0.1, cosine: 0.2, sharedFile: false, bothUncited: false }, { bodyMutual: 0.95, sharedFile: true, bothUncited: false }]) {
      expect(closeEnoughForSame(ranked, a, b)).toBe(false);
      expect(closeEnoughForSame(ranked, a, copy)).toBe(true);
    }
  });
  it("text with negation markers we cannot classify (German, French, CJK, any non-ASCII word) is never \"same\" by a judge's word, only verbatim", () => {
    const pairs: Array<[string, string]> = [
      ["Verwende withRetry nicht fuer HTTP Aufrufe im api Dienst.", "Verwende withRetry fuer HTTP Aufrufe im api Dienst."],
      ["N'utilisez pas withRetry pour les appels HTTP du service api.", "Utilisez withRetry pour les appels HTTP du service api."],
      ["APIサービスのHTTP呼び出しにwithRetryを使わない。", "APIサービスのHTTP呼び出しにwithRetryを使う。"],
      ["Utilisez withRetry pour les appels HTTP du service api, évitez fetch.", "Utilisez withRetry pour les appels HTTP du service api."],
    ];
    for (const [a, b] of pairs) expect(closeEnoughForSame(SAFE, a, b)).toBe(false);
    expect(closeEnoughForSame(SAFE, pairs[0]![0], pairs[0]![0])).toBe(true);
  });
  it("wordsOf keeps unit words and prefix words as words", () => {
    expect(wordsOf("Cap uploads at 10 MB.")).toEqual(["cap", "uploads", "at", "10", "mb"]);
  });
});

// ----
// ----
describe("a card never names a rejected lesson the draft's audience cannot read", () => {
  const acl = (principals: string[]) => ({ kind: "restricted" as const, acl: { source: "slack" as const, scope: "slack:T1/C9", principals, capturedAt: "2026-10-30T09:00:00.000Z", liveCheck: "none" as const } });
  const REJECTED = "Never commit generated protobuf files to the repository.";
  const restricted = () => rejectedLesson(REJECTED, { provenance: { ...lessonRecord().provenance, audience: acl(["U-x"]) } });

  it("a project-wide draft that resembles a restricted rejected lesson is held for a person with the generic reason and NO id", async () => {
    const s = setup();
    await seed(s.store, restricted());
    const out = await curateDraft(s.deps, KEY, textOf("Never commit generated protobuf output to the repository."));
    expect(out.outcome).toBe("contradiction");
    if (out.outcome !== "contradiction") throw new Error("unreachable");
    expect(out.matchesRejected).toBe(true);
    expect(out.other).toBeUndefined();
    expect(out.lesson).toMatchObject({ status: "pending" });
    expect(out.lesson.contradictsWith).toBeUndefined();
    expect(out.lesson.tierReasons).toEqual(expect.arrayContaining(["contradiction", "matches_rejected"]));
    // Nothing in the stored card or the audit names the restricted lesson.
    expect(JSON.stringify(await s.store.get(KEY, out.lesson.id))).not.toContain("les_rej00001");
    expect(JSON.stringify(s.audit.events)).not.toContain("les_rej00001");
  });

  it("the judge is not shown the restricted lesson either, and a draft whose audience can read it still gets the link", async () => {
    const s = setup({ model: new ScriptedModel([answer("different")]) });
    await seed(s.store, restricted());
    await curateDraft(s.deps, KEY, textOf("Never commit generated protobuf output to the repository."));
    expect(s.model.calls).toHaveLength(0);
    const t = setup();
    await seed(t.store, restricted());
    const out = await curateDraft(t.deps, KEY, textOf("Never commit generated protobuf output to the repository.", { provenance: { ...draft().provenance, audience: acl(["U-x"]) } }));
    expect(out).toMatchObject({ outcome: "contradiction", other: "les_rej00001", lesson: { contradictsWith: "les_rej00001" } });
  });

  it("the card stays in front of people after it is settled (no contradiction link is needed to keep it pending, and it never goes live on trial)", async () => {
    const s = setup();
    await seed(s.store, restricted());
    const result = await processDraft(s.deps, KEY, textOf("Never commit generated protobuf output to the repository.", { provenance: { ...draft().provenance, memberCorrection: true, claimsSupported: true } }));
    expect(result.outcome.outcome).toBe("contradiction");
    expect(result.lesson).toMatchObject({ status: "pending" });
    expect(result.lesson!.trial).toBeUndefined();
    expect(result.lesson!.contradictsWith).toBeUndefined();
    expect(result.lesson!.tierReasons).toContain("matches_rejected");
  });
});
