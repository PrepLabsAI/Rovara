// Shared fixtures of the knowledge wiring tests (lead 4 L4-AK2). Plain objects, no real credentials.
import type { KnowledgeContext, KnowledgeUnit, LearnedContext, LearnedLesson } from "../../../packages/contracts/src/index.js";

export const lesson = (id: string, over: Partial<LearnedLesson> = {}): LearnedLesson => ({
  id, version: 1, type: "pitfall", title: "Do not call the billing API from tests; use FakeBilling", description: "Real calls charge the sandbox account.",
  body: "When writing a test under src/billing/, build the client with makeFakeBilling().", scopeLabel: "beacon-api: src/billing/**", citations: [], ...over,
});
export const learned = (stage: LearnedContext["stage"], lessons: LearnedLesson[] = [lesson("7Kq2mA"), lesson("3xWf9d", { type: "convention", title: "Take customer error text from copy/errors.ts", body: "Support searches by these strings. When adding a failure, add its text there first." })]): LearnedContext => ({ v: 1, setVersion: 214, stage, lessons });

export const unit = (id: string, over: Partial<KnowledgeUnit> = {}): KnowledgeUnit => ({
  kind: "lesson", id, version: 1, subtype: "pitfall", statement: "Verify the webhook signature before parsing the body", why: "A parse error before the check causes a retry storm.",
  detail: "When handling a webhook in src/billing/webhooks.ts, verify the signature first.", scopeLabel: "beacon-api: src/billing/webhooks.ts", repos: ["beacon-api"], paths: ["src/billing/webhooks.ts"],
  trust: "team_approved", ...over,
});

export const facts = [
  { id: "flaky3f9a", statement: 'Known flaky: tests/upload/retry.test.ts "retries on 503". Do not chase it unless your change touches upload retry.', evidence: { count: 4, windowDays: 30 }, paths: ["tests/upload/**"] },
  { id: "ci0a1c2x", statement: "The lint check often fails on import order. A past fix that passed: run `make fmt`.", evidence: { count: 3, windowDays: 30 }, paths: [] },
];

/** A knowledge context that carries every part, for a stage. The worker cuts it to what the stage may have. */
export const maximal = (stage: KnowledgeContext["stage"], over: Partial<KnowledgeContext> = {}): KnowledgeContext => ({
  v: 1, stage, facts,
  skills: [{ id: "addwebhook", name: "add-webhook", description: "Add a handler for a new provider webhook event. Use when a task handles a new event type." }],
  more: { areas: [{ label: "src/billing/", units: 4 }, { label: "tests/", units: 2 }], leftOut: 0 },
  pull: { units: [unit("b81TqZ"), unit("9dQe1x", { statement: "Use FakeQueue in worker tests", why: "Real queues cost money.", detail: "When testing src/workers/, use tests/support/queue.ts.", scopeLabel: "beacon-api: src/workers/**", paths: ["src/workers/**"] })], leftOut: 0 },
  pushedScopes: [{ id: "L-7Kq2mA", repos: ["beacon-api"], paths: ["src/billing/**"] }],
  ...over,
});
