// The web start box's path suggestion (lead 4 J3; DEC 173): the service and the hosted route. Any project role asks; anyone else, a missing project, another
// company's and a malformed name read the same; the role is read before the body; small talk never reaches the model; the model's reason is never returned; refusals are fixed words with no echo.
import { describe, expect, it } from "vitest";
import { START_SUGGEST_WORDS, StartSuggestResponseSchema, pickOfKind, type OrgId, type RequestRouteKind, type RequestRouteOutcome } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createStartSuggest, type StartRouter } from "../../packages/broker/src/core/answers/start-suggest.js";
import { routeHostedStartSuggest, type HostedStartSuggestWiring } from "../../packages/broker/src/core-host/start-suggest-routes.js";
import type { SetupRunStanding } from "../../packages/broker/src/core-host/setup-run-routes.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const T0 = Date.parse("2026-11-17T10:00:00.000Z");
const PATH = "/v1/app/projects/alpha/code/suggest";
const body = (text = "Fix the typo in the README title", extra: Record<string, unknown> = {}) => ({ requestId: "request-0001", text, ...extra });
const NOT_FOUND = { error: { code: "NOT_FOUND", message: START_SUGGEST_WORDS.projectNotFound } };

function router(kind: RequestRouteKind, outcome: RequestRouteOutcome = "ok") {
  const calls: Array<{ text: string; signal: AbortSignal }> = [];
  const route: StartRouter = async (text, signal) => { calls.push({ text, signal }); return { kind, outcome }; };
  return { route, calls };
}

describe("the pick of each kind", () => {
  it("a question and an unclear message are answered first; a small change suggests Quick; a large one Full", () => {
    expect(pickOfKind("question")).toBe("answer");
    expect(pickOfKind("unclear")).toBe("answer");
    expect(pickOfKind("small_change")).toBe("quick");
    expect(pickOfKind("large_change")).toBe("full");
  });
});

describe("the suggest service", () => {
  const make = (route: StartRouter | undefined, allowed = true, extra: Partial<Parameters<typeof createStartSuggest>[0]> = {}) =>
    createStartSuggest({ mayAsk: async () => allowed, route, now: () => T0, ...extra });
  const ask = (service: ReturnType<typeof make>, ...rest: [unknown?, string?]) => service.suggest({ personId: rest[1] ?? "ada", project: "alpha", body: rest.length === 0 ? body() : rest[0] });

  it.each([["question", "answer"], ["small_change", "quick"], ["large_change", "full"], ["unclear", "answer"]] as const)("%s is classified and suggests %s", async (kind, pick) => {
    const r = router(kind);
    expect(await ask(make(r.route))).toEqual({ kind, classifier: "ok", pick });
    expect(r.calls).toHaveLength(1);
  });

  it("small talk is a fixed first look: no model is asked, nothing is counted", async () => {
    const r = router("small_change");
    const service = make(r.route, true, { limit: 1 });
    for (const [text, talk] of [["hi", "greeting"], ["thanks!", "thanks"], ["what can you do?", "help"]] as const) {
      expect(await ask(service, body(text))).toEqual({ kind: "small_talk", classifier: "ok", pick: "answer", smallTalk: talk });
    }
    expect(r.calls).toHaveLength(0);
    // The one place is still there for a real request.
    expect((await ask(service)).classifier).toBe("ok");
  });

  it("with no classifier the suggestion is 'unavailable' and Just answer, and nothing is asked", async () => {
    expect(await ask(make(undefined))).toEqual({ kind: "unknown", classifier: "unavailable", pick: "answer" });
    expect(await ask(make(router("question", "unavailable").route))).toEqual({ kind: "unknown", classifier: "unavailable", pick: "answer" });
  });

  it("a timeout, an unusable answer and a throw are 'failed', never a guess at Quick or Full", async () => {
    for (const outcome of ["timeout", "invalid"] as const) expect(await ask(make(router("large_change", outcome).route))).toEqual({ kind: "unknown", classifier: "failed", pick: "answer" });
    const throwing: StartRouter = async () => { throw new Error("boom: the secret text"); };
    expect(await ask(make(throwing))).toEqual({ kind: "unknown", classifier: "failed", pick: "answer" });
  });

  it("waits for the classifier no longer than its deadline, and tells it to stop", async () => {
    let seen: AbortSignal | undefined;
    const slow: StartRouter = (_text, signal) => new Promise((_resolve, reject) => { seen = signal; signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); });
    const result = await ask(make(slow, true, { timeoutMs: 20 }));
    expect(result).toEqual({ kind: "unknown", classifier: "failed", pick: "answer" });
    expect(seen?.aborted).toBe(true);
  });

  it("limits each person's classifier calls in an hour, by person, and starts afresh the next hour", async () => {
    let now = T0;
    const r = router("question");
    const service = make(r.route, true, { limit: 2, now: () => now });
    await ask(service, body(), "ada");
    await ask(service, body(), "ada");
    await expect(ask(service, body(), "ada")).rejects.toThrow(START_SUGGEST_WORDS.rate);
    await ask(service, body(), "bob");
    expect(r.calls).toHaveLength(3);
    now += 3_600_000;
    await ask(service, body(), "ada");
    expect(r.calls).toHaveLength(4);
  });
});

describe("the hosted route", () => {
  function world(standings: Record<string, SetupRunStanding["access"]>, route?: StartRouter) {
    const standingCalls: string[] = [];
    // The hourly counter is stored in each company's own store.
    const stores = new Map<OrgId, MemoryDocumentStore>([[A, new MemoryDocumentStore()], [B, new MemoryDocumentStore()]]);
    const wiring: HostedStartSuggestWiring = {
      standing: async (personId, companyId, project) => { standingCalls.push(`${companyId}/${project}/${personId}`); const access = standings[`${companyId}/${project}/${personId}`] ?? "none"; return access === "manage" ? { access, basis: "company-admin" } : { access }; },
      ...(route === undefined ? {} : { route: (companyId: OrgId) => (companyId === A ? route : undefined) }),
    };
    const post = async (companyId: OrgId, personId: string, input: unknown, path = PATH, overrides: Partial<HostedStartSuggestWiring> = {}) => {
      const answered = await routeHostedStartSuggest({ request: { method: "POST", path, headers: {}, body: typeof input === "string" ? input : JSON.stringify(input) }, path, personId, companyId, store: stores.get(companyId) ?? new MemoryDocumentStore(), wiring: { ...wiring, ...overrides }, now: () => T0 });
      return { status: answered.statusCode, body: JSON.parse(answered.body ?? "{}") as Record<string, unknown>, raw: answered.body ?? "" };
    };
    return { post, standingCalls };
  }

  it.each([["a project grant (view)", "ada", "view"], ["a company owner or admin (manage)", "owner", "manage"]] as const)("%s gets the suggestion", async (_name, person, access) => {
    const r = router("large_change");
    const w = world({ [`${A}/alpha/${person}`]: access }, r.route);
    const result = await w.post(A, person, body());
    expect(result.status).toBe(200);
    expect(StartSuggestResponseSchema.parse(result.body)).toEqual({ kind: "large_change", classifier: "ok", pick: "full" });
    expect(r.calls).toHaveLength(1);
  });

  it("no role, a project of another person's, another company's project and a malformed name all read the same 404, and the classifier is never asked", async () => {
    const r = router("question");
    const w = world({ [`${A}/alpha/ada`]: "view", [`${B}/alpha/ada`]: "none" }, r.route);
    // Role on alpha, not on beta (two projects); the same person asking the other company's mount (two companies); a stranger.
    for (const [company, person, path] of [[A, "ada", "/v1/app/projects/beta/code/suggest"], [B, "ada", PATH], [A, "stranger", PATH], [A, "ada", "/v1/app/projects/%E0%A4%A/code/suggest"]] as const) {
      const result = await w.post(company, person, body(), path);
      expect(result.status, `${company} ${person} ${path}`).toBe(404);
      expect(result.body).toEqual(NOT_FOUND);
    }
    expect(r.calls).toHaveLength(0);
  });

  it("refusals are fixed words with no echo of what was sent, and a fault is a fixed 503", async () => {
    const CANARY = "TEXT-CANARY-9f3a";
    const w = world({ [`${A}/alpha/ada`]: "view" }, router("question").route);
    const bad = await w.post(A, "ada", { requestId: "request-0001", text: `${CANARY}\u0000` });
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: { code: "CONFIG_INVALID", message: START_SUGGEST_WORDS.badRequest } });
    expect(bad.raw).not.toContain(CANARY);
    const notJson = await w.post(A, "ada", `{${CANARY}`);
    expect(notJson.status).toBe(400);
    expect(notJson.raw).not.toContain(CANARY);
    const down = await w.post(A, "ada", body(), PATH, { standing: async () => { throw new Error(`secret ${CANARY}`); } });
    expect(down.status).toBe(503);
    expect(down.body).toEqual({ error: { code: "RUNTIME_UNAVAILABLE", message: START_SUGGEST_WORDS.unavailable } });
    expect(down.raw).not.toContain(CANARY);
  });

  it("the hourly limit is per company and per person: the same person id in another company has their own places", async () => {
    const r = router("question");
    const w = world({ [`${A}/alpha/limiter-person`]: "view", [`${B}/alpha/limiter-person`]: "view", [`${A}/alpha/other-person`]: "view" }, r.route);
    // Company B has no classifier wired in this world, so B's places are asked of a classifier of its own.
    const rb = router("small_change");
    for (let i = 0; i < 60; i += 1) expect((await w.post(A, "limiter-person", body())).status).toBe(200);
    const refused = await w.post(A, "limiter-person", body());
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({ error: { code: "TOO_MANY_REQUESTS", message: START_SUGGEST_WORDS.rate } });
    // Another person in the same company, and the same person id in the other company, are not held back.
    expect((await w.post(A, "other-person", body())).status).toBe(200);
    expect((await w.post(B, "limiter-person", body(), PATH, { route: () => rb.route })).status).toBe(200);
    expect(rb.calls).toHaveLength(1);
  });

});
