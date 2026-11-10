// Review: a passing fault is injected, once, at EVERY call the draft's curate-and-settle makes (the store, the vectors, the audit sink, the alert sink), one position per run, for four kinds of draft.
// Whatever the position and whatever the retry does, the end is never MORE than the fault-free run made: no second card, no second audit line of any kind, no extra lesson, and no paid judge call at all.
import { describe, expect, it } from "vitest";
import { processDraftRetrying } from "../../../packages/broker/src/lessons/draft-retry.js";
import type { ProcessDeps } from "../../../packages/broker/src/lessons/process.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import type { LessonDraft } from "../../../packages/broker/src/lessons/reflect.js";
import { Alerts, Audit, Clock, KEY, MemoryVectors, ScriptedModel, Spend, allowAllAccess, directory, draft, embedder, facts, settings, verifier } from "./lesson-helpers.js";

const throttled = (): Error => Object.assign(new Error("secret table text"), { name: "ThrottlingException" });
const member = (over: Partial<LessonDraft> = {}, prov: Partial<LessonDraft["provenance"]> = {}): LessonDraft => draft({ ...over, provenance: { ...draft().provenance, sourceKinds: ["send_back"], memberCorrection: true, claimsSupported: true, fromSharedTask: true, ...prov } });

interface Run { maxVersion: number; lessons: number; cards: number; audit: Record<string, number>; twice: string[]; judgeCalls: number; positions: number; retried: boolean; threw: boolean }

/** A scenario: what is in the store before (made without faults), and the draft under test. */
interface Scenario { name: string; preset: "standard" | "regulated"; seed: LessonDraft[]; draft: LessonDraft }
const RETRY = "Always use withRetry for HTTP retries in the api service client calls";
const NEVER = "Never use withRetry for HTTP retries in the api service client calls";
const scenarios: Scenario[] = [
  { name: "a member's correction: add, then live on trial", preset: "standard", seed: [], draft: member({ title: "Use withRetry", body: RETRY }) },
  { name: "a plain draft: add, then pending for people (no trial)", preset: "regulated", seed: [], draft: draft({ title: "Use withRetry", description: "", body: RETRY, provenance: { ...draft().provenance, supportTasks: ["task-1", "task-2"] } }) },
  { name: "a near copy of a lesson: merged into it", preset: "standard", seed: [member({ title: "Use withRetry", body: RETRY })], draft: member({ title: "Use the withRetry", body: RETRY.replace("Always use", "Always use the") }, { supportTasks: ["task-2"] }) },
  { name: "a member's flipped copy of a lesson live on trial: a card for people, and the trial lesson retired", preset: "standard", seed: [member({ title: "Use withRetry", body: RETRY })], draft: member({ title: "Do not use withRetry", body: NEVER }, { supportTasks: ["task-2"] }) },
];

async function run(scenario: Scenario, failAt: number | undefined): Promise<Run> {
  const store = new InMemoryLessonStore();
  const audit = new Audit();
  const clock = new Clock();
  const vectors = new MemoryVectors();
  const alerts = new Alerts();
  const model = new ScriptedModel();
  const spend = new Spend();
  // The judge is off (the spend look refuses it), so a retry is allowed and no paid call can happen unnoticed: the model counts every call anyway.
  spend.admitted = false;
  let n = 0;
  const base = {
    store, embedder, vectors, judgeModel: model, spend, audit, alerts, now: clock.now, verifier: verifier("valid"), facts: facts(), settings: settings({ preset: scenario.preset }), newId: () => `les_${String(++n).padStart(4, "0")}`,
    judge: { rate: async () => "unrelated" }, directory: directory({ eligibleIds: ["owner", "ann", "bob"] }), access: allowAllAccess,
  } as unknown as ProcessDeps;
  for (const seeded of scenario.seed) await processDraftRetrying(base, KEY, seeded, { sleep: async () => undefined });
  const seededAudit = audit.events.length;
  // From here every call to a port counts as one position; the one at `failAt` throws once.
  let position = 0;
  const hit = (): void => { position += 1; if (position === failAt) throw throttled(); };
  const wrap = <T extends object>(target: T): T => new Proxy(target, {
    get(inner, property, receiver) {
      const value = Reflect.get(inner, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      const method = (value as (...args: unknown[]) => unknown).bind(inner);
      return async (...args: unknown[]) => { hit(); return method(...args); };
    },
  });
  const probe: ProcessDeps = {
    ...base, store: wrap(store), vectors: wrap(vectors), alerts: wrap(alerts),
    // the read-only ports too: a fault there fails before any write
    embedder: wrap(embedder), verifier: wrap(verifier("valid")), facts: wrap(facts()), settings: wrap(settings({ preset: scenario.preset })), spend: wrap(spend),
    audit: { emit: async (event, options) => { hit(); await audit.emit(event, options); } },
  };
  let retried = false, threw = false;
  try { await processDraftRetrying(probe, KEY, scenario.draft, { sleep: async () => undefined, log: (event) => { if (event === "learning.draft_retried") retried = true; } }); } catch { threw = true; }
  const after = await store.list(KEY);
  const counts: Record<string, number> = {};
  const lines = new Map<string, number>();
  for (const event of audit.events.slice(seededAudit)) { counts[event.action] = (counts[event.action] ?? 0) + 1; const line = `${event.action}|${event.lessonId ?? ""}`; lines.set(line, (lines.get(line) ?? 0) + 1); }
  return { maxVersion: Math.max(0, ...after.map((lesson) => lesson.version)), twice: [...lines].filter(([, times]) => times > 1).map(([line]) => line), lessons: after.length, cards: after.filter((lesson) => lesson.status === "pending" && lesson.contradictsWith !== undefined).length, audit: counts, judgeCalls: model.calls.length, positions: position, retried, threw };
}

describe.each(scenarios)("a passing fault at every call of the draft's processing: $name", (scenario) => {
  it("never ends with more than the fault-free run made, and never calls the paid judge", async () => {
    const clean = await run(scenario, undefined);
    expect(clean.threw).toBe(false);
    // positive control: the walk is long enough to be a walk, and the scenario really did what it is named for
    expect(clean.positions).toBeGreaterThanOrEqual(8);
    if (scenario.name.includes("flipped")) { expect(clean.cards).toBe(1); expect(clean.audit["lesson.contradiction"]).toBe(1); expect(clean.audit["lesson.trial_retired"]).toBe(1); }
    let retries = 0;
    for (let position = 1; position <= clean.positions + 1; position += 1) {
      const faulted = await run(scenario, position);
      const where = `${scenario.name}, fault at call ${position} of ${clean.positions}`;
      if (faulted.retried) retries += 1;
      expect(faulted.judgeCalls, where).toBe(0);
      expect(faulted.lessons, where).toBeLessThanOrEqual(clean.lessons);
      // A retry of the settle step does not write a lesson again when nothing changed (no extra version)
      expect(faulted.maxVersion, where).toBeLessThanOrEqual(clean.maxVersion);
      expect(faulted.cards, where).toBeLessThanOrEqual(clean.cards);
      // No audit line (the same action on the same lesson) twice. And no more of an action than the fault-free run wrote, except a single line of the way a fault itself sends a lesson to people (e.g. the go-live's own
      // audit failed, so the lesson waits for a person: `lesson.pending`), which the fault-free run never writes.
      expect(faulted.twice, where).toEqual([]);
      for (const [action, count] of Object.entries(faulted.audit)) expect(count, `${where}: ${action}`).toBeLessThanOrEqual(Math.max(clean.audit[action] ?? 0, 1));
      for (const action of ["lesson.contradiction", "lesson.candidate_created", "lesson.merged", "lesson.trial_started", "lesson.trial_retired"]) expect(faulted.audit[action] ?? 0, `${where}: ${action}`).toBeLessThanOrEqual(clean.audit[action] ?? 0);
    }
    // at least some positions were mended by the retry (the walk is not all swallowed faults)
    expect(retries).toBeGreaterThan(0);
  });
});
