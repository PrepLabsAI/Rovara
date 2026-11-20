// L4-SC (DEC 254z c, DEC 254zw), the plan side: the "Setup change" section the planner proposes and a maintainer approves with the plan. The items are fixed-shape data (no secret value; a variable is a name); the
// stored plan carries them, so the plan's digest covers them; they raise the plan's risk by ONE level (card, gate and chat agree); a plan with none is exactly what it was.
import { describe, expect, it } from "vitest";
import {
  PLAN_SETUP_CHANGES_MAX, PlanSetupChangesSchema, SETUP_CHANGE_AGENT_WORDS, SETUP_CHANGE_CARD_WORDS, SETUP_CHANGE_CHIP, canonicalPlanJson, parsePlanDocument, planDocumentMarkdown, setupChangeLines, setupChangesDigest,
  type PlanDocument, type PlanSetupChangeItem,
} from "@agentx/contracts";
import { bumpForSetupChanges, gradePlanRisk, planDecidedOnCard, planFactsOf, planRiskOf } from "../../packages/broker/src/core/decisions/plan-risk.js";
import { riskTierOf } from "../../packages/broker/src/core/decisions/risk-tier.js";
import { cardOfItem, type DecisionItem } from "../../packages/broker/src/core/decisions/project.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";

const mock = (over: Record<string, unknown> = {}): PlanSetupChangeItem => ({ id: "s1", kind: "mock", service: "Stripe", variable: "STRIPE_API_URL", spec: "payments/openapi/stripe.yaml", reason: "The refund code calls Stripe.", ...over });
const command = (over: Record<string, unknown> = {}): PlanSetupChangeItem => ({ id: "s2", kind: "command", area: "test", repo: "demo", line: "npm run test:refunds", reason: "A new test target.", ...over });
const variable = (over: Record<string, unknown> = {}): PlanSetupChangeItem => ({ id: "s3", kind: "variable", name: "STRIPE_WEBHOOK_SECRET", reason: "The webhook handler reads it.", ...over });
const dependency = (over: Record<string, unknown> = {}): PlanSetupChangeItem => ({ id: "s4", kind: "dependency", service: "Redis", reason: "The queue needs it.", ...over });

const proved = { proposed: [{ id: "unit", label: "Unit tests", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 60 } }], proves: { unit: ["1", "2"] } };
const claims = [{ id: "1", text: "Retry in src/retry/backoff.ts." }, { id: "2", text: "A retry is never charged twice." }];
const lowPlan = (extra: Partial<PlanDocument> = {}) => planDocument({ claims, checks: proved, ...extra });
const structured = (plan: PlanDocument, markdown = "Retry in src/retry/backoff.ts.") => ({ format: "structured" as const, artifact: {} as never, plan, markdown });
const workflow = {} as never;

describe("the setup change items", () => {
  it("accept the four kinds in their fixed shapes", () => {
    expect(PlanSetupChangesSchema.safeParse([mock(), command(), variable(), dependency()]).success).toBe(true);
    expect(PlanSetupChangesSchema.safeParse([mock({ cite: { path: "src/refund.ts", line: 12 } })]).success).toBe(true);
  });

  it("refuse an unknown key, an unknown kind, a value on a variable, a reserved variable, a spec outside the workspace, duplicates and too many", () => {
    const bad: unknown[][] = [
      [{ ...mock(), extra: 1 }],
      [{ id: "s1", kind: "secret", name: "X" }],
      [{ ...variable(), value: "sk_live_x" }],
      [mock({ variable: "PATH" })],
      [mock({ variable: "ROVARA_TOKEN" })],
      [mock({ spec: "../outside.yaml" })],
      [mock({ spec: "/etc/openapi.yaml" })],
      [mock({ spec: ".hidden/openapi.yaml" })],
      [mock({ variable: "lowercase" })],
      [variable({ name: "lower" })],
      [mock({ id: "s1" }), command({ id: "s1" })],
      [mock({ id: "s1" }), mock({ id: "s2" })],
      [mock({ reason: "line\nbreak" })],
      [command({ line: "npm test\u0000" })],
      [],
      Array.from({ length: PLAN_SETUP_CHANGES_MAX + 1 }, (_, index) => variable({ id: `s${String(index + 1)}`, name: `VAR_${String(index)}` })),
      Array.from({ length: 5 }, (_, index) => mock({ id: `s${String(index + 1)}`, variable: `SVC_${String(index)}_URL` })),
    ];
    for (const list of bad) expect(PlanSetupChangesSchema.safeParse(list).success, JSON.stringify(list).slice(0, 80)).toBe(false);
  });

  it("show fixed words around the planner's text, redacted and on one line; a variable is a name only", () => {
    const lines = setupChangeLines([mock(), command(), variable(), dependency()]);
    expect(lines).toEqual([
      "Adds a mock for Stripe (`STRIPE_API_URL`), made by Rovara from `payments/openapi/stripe.yaml`. The refund code calls Stripe.",
      "Adds the test command `npm run test:refunds` (in demo). A new test target.",
      "Adds the variable `STRIPE_WEBHOOK_SECRET` (name only; you set the value). The webhook handler reads it.",
      "Adds Redis as a service the tests talk to. The queue needs it.",
    ]);
    const key = ["sk", "live", "0123456789abcdef0123456789"].join("_");
    const leaky = setupChangeLines([mock({ reason: `Use ${key} here` })]);
    expect(leaky[0]).not.toContain(key);
  });

  it("have a digest that ignores key order and item order but moves with any change", () => {
    const a = [mock(), command()];
    const reordered = [command(), { ...mock(), spec: "payments/openapi/stripe.yaml" }];
    expect(setupChangesDigest(a)).toBe(setupChangesDigest(reordered));
    expect(setupChangesDigest(a)).not.toBe(setupChangesDigest([mock({ spec: "payments/openapi/other.yaml" }), command()]));
    expect(setupChangesDigest(a)).not.toBe(setupChangesDigest([mock(), command({ line: "npm run test:other" })]));
  });
});

describe("the plan document", () => {
  const withChanges = (kind: "plan" | "requirements", changes: unknown) => parsePlanDocument(planAnswer({ ...planDocument(), setupChanges: changes } as PlanDocument), { kind });

  it("takes setupChanges in a coding plan only", () => {
    const ok = withChanges("plan", [mock(), variable()]);
    expect(ok.ok).toBe(true);
    const refused = withChanges("requirements", [mock()]);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.errors.join(" ")).toContain("setup changes belong only in the coding plan");
    expect(withChanges("plan", [{ ...mock(), extra: 1 }]).ok).toBe(false);
  });

  it("stores the items in the plan, so the plan's digest covers them: one changed spec changes the stored bytes", () => {
    const base = planDocument({ setupChanges: [mock()] });
    const changed = planDocument({ setupChanges: [mock({ spec: "payments/openapi/other.yaml" })] });
    expect(canonicalPlanJson(base)).not.toBe(canonicalPlanJson(changed));
    expect(canonicalPlanJson(base)).toContain("payments/openapi/stripe.yaml");
  });

  it("adds a Setup change section to the Markdown copy, with the card's words; a plan with none is byte-identical to before", () => {
    const input = { kind: "plan" as const, version: 1, sha256: "a".repeat(64) };
    const without = planDocumentMarkdown(planDocument(), input);
    expect(without).not.toContain("Setup change");
    const withSection = planDocumentMarkdown(planDocument({ setupChanges: [mock(), variable()] }), input);
    expect(withSection).toContain("## Setup change");
    expect(withSection).toContain("- Adds a mock for Stripe (`STRIPE_API_URL`)");
    expect(withSection).toContain(SETUP_CHANGE_CARD_WORDS);
    expect(withSection).toContain(SETUP_CHANGE_AGENT_WORDS);
    expect(planDocumentMarkdown(planDocument({ setupChanges: undefined }), input)).toBe(without);
  });
});

describe("the plan's risk goes up one level (DEC 254z c)", () => {
  it("bumps low to medium and medium to high; high stays high; no setup change leaves it", () => {
    expect(bumpForSetupChanges("low", true)).toBe("medium");
    expect(bumpForSetupChanges("medium", true)).toBe("high");
    expect(bumpForSetupChanges("high", true)).toBe("high");
    for (const risk of ["low", "medium", "high"] as const) {
      expect(bumpForSetupChanges(risk, undefined)).toBe(risk);
      expect(bumpForSetupChanges(risk, false)).toBe(risk);
    }
  });

  it("the plan facts carry setupChange only when the stored plan has changes (a plan without them is exactly as before)", () => {
    const plain = planFactsOf(structured(lowPlan()));
    expect(plain).toEqual({ files: plain.files, untestedClaims: 0, unread: false });
    expect(Object.hasOwn(planFactsOf(structured(lowPlan())), "setupChange")).toBe(false);
    expect(planFactsOf(structured(lowPlan({ setupChanges: [mock()] }))).setupChange).toBe(true);
    expect(Object.hasOwn(planFactsOf(structured(lowPlan({ setupChanges: undefined }))), "setupChange")).toBe(false);
    // A Markdown plan and an unreadable one cannot carry a setup change.
    expect(planFactsOf({ format: "markdown", artifact: {} as never, markdown: "x" }).setupChange).toBeUndefined();
    expect(planFactsOf(undefined).setupChange).toBeUndefined();
  });

  it("the gate's tier (gradePlanRisk) and the chat rule (planDecidedOnCard) both read it: a low plan with a mock is medium and decided on the card", () => {
    expect(gradePlanRisk({ loaded: structured(lowPlan()), workflow })).toBe("low");
    expect(gradePlanRisk({ loaded: structured(lowPlan({ setupChanges: [mock()] })), workflow })).toBe("medium");
    expect(planDecidedOnCard(structured(lowPlan()), workflow, undefined)).toBeUndefined();
    expect(planDecidedOnCard(structured(lowPlan({ setupChanges: [mock()] })), workflow, undefined)).toBe("medium");
    // A plan that was medium is high with one; one that is high stays high; the floor cannot hide it.
    const mediumPlan = planDocument({ claims, setupChanges: [command()] });
    expect(gradePlanRisk({ loaded: structured(planDocument({ claims })), workflow })).toBe("medium");
    expect(gradePlanRisk({ loaded: structured(mediumPlan), workflow })).toBe("high");
    expect(gradePlanRisk({ loaded: structured(lowPlan({ setupChanges: [mock()] })), workflow, requestText: "Also change infra/prod/main.tf" })).toBe("high");
    // the planner's own words about proof cannot lower it: the raw planner tier ignores the bump, the final one never does
    expect(planRiskOf(planFactsOf(structured(lowPlan({ setupChanges: [mock()] }))), undefined)).toBe("low");
  });

  it("the card's tier reads it too, in the tally, after every other rule, with a reason and a chip", () => {
    const plan = { files: ["src/a.ts"], untestedClaims: 0 };
    expect(riskTierOf("approve_plan", { plan }).risk).toBe("low");
    const bumped = riskTierOf("approve_plan", { plan: { ...plan, setupChange: true } });
    expect(bumped.risk).toBe("medium");
    expect(bumped.reasons).toContain("The plan changes the test setup.");
    expect(riskTierOf("approve_plan", { plan: { ...plan, untestedClaims: 1, setupChange: true } }).risk).toBe("high");
    expect(riskTierOf("approve_plan", { plan: { files: ["infra/iam/role.tf"], untestedClaims: 0, setupChange: true } }).risk).toBe("high");
    expect(riskTierOf("approve_plan", { plan: { ...plan, setupChange: false } }).risk).toBe("low");
    const item: DecisionItem = {
      kind: "approve_plan", subjectId: "t1", project: "p", title: "Refunds", createdAt: "2026-11-17T10:00:00.000Z", contentVersion: "v1", openPath: "/app/projects/p", path: "quick", files: ["src/a.ts"], claims: 2, untestedClaims: 0,
      setupChange: true, details: [{ title: "Setup change (1)", lines: setupChangeLines([mock()]) }],
    };
    const card = cardOfItem(item)!.card;
    expect(card.risk).toBe("medium");
    expect(card.evidence.map((chip) => `${chip.label}: ${chip.value}`)).toContain(`Setup: ${SETUP_CHANGE_CHIP}`);
    expect(cardOfItem({ ...item, setupChange: undefined })!.card.risk).toBe("low");
    expect(cardOfItem({ ...item, setupChange: undefined })!.card.evidence.map((chip) => chip.label)).not.toContain("Setup");
  });
});

describe("a plan with a setup change is never skipped as small", () => {
  it("keeps the plan approval for a plan the lighter flow would skip, and only because of the setup change", async () => {
    const { smallPlanRoute } = await import("../../packages/broker/src/core/task-flow/stage-selection.js");
    const { WorkflowSnapshotSchema, createWorkflowSnapshot } = await import("@agentx/contracts");
    const submitted = WorkflowSnapshotSchema.parse({
      ...createWorkflowSnapshot({ taskId: "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6", ownerId: "a".repeat(64), now: "2026-11-13T12:00:00.000Z", definitionVersion: "1.1.0" }),
      stage: "PLAN_REVIEW", state: "WAITING", path: "QUICK",
    });
    const input = (plan: PlanDocument) => ({ submitted, plan, requestText: "Fix the typo in docs/guide/intro.md", noChangeNeeded: false, at: "2026-11-13T12:00:00.000Z", planText: "Fix docs/guide/intro.md", costHighUsd: 1 });
    const small = planDocument({ claims: [{ id: "1", text: "Fix the typo in docs/guide/intro.md." }] });
    const plain = smallPlanRoute(input(small));
    expect(plain?.skipped.length ?? 0).toBeGreaterThan(0);
    expect(smallPlanRoute(input({ ...small, setupChanges: [command()] }))).toBeUndefined();
  });
});
