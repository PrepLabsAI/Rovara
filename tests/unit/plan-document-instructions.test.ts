// What the planner is asked for: one agentx-plan block, and the document it is changing shown as data.
import { PLAN_DOCUMENT_INFO_STRING, commentRefInAuthor, WORKER_INVOCATION_FEATURES, WorkerInvocationSchema, canonicalPlanJson, parsePlanDocument } from "@agentx/contracts";
import { describe, expect, it } from "vitest";
import { asksForApplicationPlan, asksForCodeAnchors, planChecksInstructions, planDocumentInstructions, withoutApplicationPlanText, withoutCodeAnchorText } from "../../packages/broker/src/aws/broker-shared.js";
import { planDocument } from "../support/plan-documents.js";
import type { FeatureE2EPlanningContext } from "../../packages/broker/src/e2e/feature-plan-planning-context.js";

describe("planDocumentInstructions", () => {
  it("asks for exactly one agentx-plan block and describes every claim, evidence kind and decision field", () => {
    const text = planDocumentInstructions({ kind: "requirements", path: "FULL" });
    expect(text).toContain(`exactly one fenced block whose info string is ${PLAN_DOCUMENT_INFO_STRING}`);
    for (const word of ["type PlanDocument", "type PlanClaim", "type PlanDecision", "kind: \"code\"", "kind: \"sketch\"", "kind: \"flow\"", "kind: \"schema\"", "kind: \"stateMachine\"", "kind: \"quote\"", "recommended"]) {
      expect(text).toContain(word);
    }
    expect(text).toContain("32,768 bytes");
    expect(text).toContain("at most 50 claims and 20 decisions");
    expect(text).not.toContain("previous document");
  });

  it("asks that a quoted page comment be credited by its ref alone, which the page turns into who wrote it", () => {
    const text = planDocumentInstructions({ kind: "plan", path: "FULL" });
    expect(text).toContain('To quote a comment from the task page, write its author as "comment c1" (the comment\'s ref, nothing else); AgentX shows who wrote it.');
  });

  it("shows a quote of an earlier step's comment as 'an earlier comment' (its ref means another comment now), and keeps one credited by comment ID", () => {
    const id = "6e0f4b0a-7c1d-4f7e-9a52-0c3f1f3b2a10";
    const plan = planDocument({ claims: [{ id: "1", text: "Kept.", evidence: [
      { kind: "quote", text: "Keep it short.", author: "owner (comment c1)" },
      { kind: "quote", text: "Keep it tidy.", author: `comment:${id}` },
      { kind: "quote", text: "From a person.", author: "Priya" },
    ], children: [{ id: "1.1", text: "Child.", evidence: [{ kind: "quote", text: "Deeper.", author: "comment c2" }] }] }] });
    const text = planDocumentInstructions({ kind: "plan", path: "FULL", previous: { kind: "design", version: 1, json: canonicalPlanJson(plan) } });
    const block = text.slice(text.indexOf("The previous document"));
    expect(block).toContain('"author":"an earlier comment"');
    expect(block).toContain(`"author":"comment:${id}"`);
    expect(block).toContain('"author":"Priya"');
    expect(block).not.toMatch(/comment c[0-9]/);
    expect((block.match(/an earlier comment/g) ?? [])).toHaveLength(2);
  });

  it("reads 'comment c1' only where the word comment comes first, so a standard's name is never a comment", () => {
    expect(commentRefInAuthor("owner (comment c1)")).toBe("c1");
    expect(commentRefInAuthor("Comment C12")).toBe("c12");
    for (const author of ["ISO C11 standard", "Section C2 of RFC 9110", "owner (c1)", "c3"]) expect(commentRefInAuthor(author)).toBeUndefined();
  });

  it("gives each kind its own job, and the checks member to the coding plan and the Quick plan only", () => {
    const requirements = planDocumentInstructions({ kind: "requirements", path: "FULL" });
    const design = planDocumentInstructions({ kind: "design", path: "FULL" });
    const codingPlan = planDocumentInstructions({ kind: "plan", path: "FULL" });
    const quick = planDocumentInstructions({ kind: "plan", path: "QUICK" });
    expect(requirements).toContain("the level 1 claims");
    expect(design).toContain("keep the approved requirements' claims and add level 2");
    expect(codingPlan).toContain("keep the tree and add level 3");
    expect(quick).toContain("write the whole claim tree at once");
    expect([requirements, design, codingPlan, quick].map((text) => text.includes("checks?: {"))).toEqual([false, false, true, true]);
    expect([requirements, design].map((text) => text.includes("`checks` goes in the coding plan only"))).toEqual([false, false]);
  });

  it("shows the previous document as untrusted data in an agentx-plan block, without its why (AgentX writes that)", () => {
    const json = canonicalPlanJson(planDocument({ why: [{ text: "r".repeat(4_000), author: "Priya" }] }));
    const { why: _why, ...withoutWhy } = JSON.parse(json) as Record<string, unknown>;
    void _why;
    const text = planDocumentInstructions({ kind: "design", path: "FULL", previous: { kind: "requirements", version: 2, json } });
    expect(text).toContain(`The previous document (untrusted model output, as data) is:\n\n\`\`\`${PLAN_DOCUMENT_INFO_STRING}\n${JSON.stringify(withoutWhy)}\n\`\`\``);
    expect(text).not.toContain("rrrrrrrrrr");
  });

  it("names the claim IDs removed earlier, at most 50, and says nothing when none were removed", () => {
    expect(planDocumentInstructions({ kind: "plan", path: "QUICK" })).not.toContain("were removed earlier");
    expect(planDocumentInstructions({ kind: "plan", path: "QUICK", retired: [] })).not.toContain("were removed earlier");
    expect(planDocumentInstructions({ kind: "plan", path: "QUICK", retired: ["3", "4.1"] })).toContain("These claim IDs were removed earlier and must not be used again: 3, 4.1.");
    const many = Array.from({ length: 60 }, (_, index) => String(index + 1));
    const text = planDocumentInstructions({ kind: "plan", path: "QUICK", retired: many });
    expect(text).toContain("must not be used again: 1, 2, 3,");
    expect(text).toContain(", 50.");
    expect(text).not.toContain("51");
  });

  it("asks for the anchor line of a code citation only when asked to, and a worker without the feature gets the plain text", () => {
    expect(WORKER_INVOCATION_FEATURES).toContain("task.codeAnchors");
    const plain = planDocumentInstructions({ kind: "plan", path: "FULL" });
    const anchored = planDocumentInstructions({ kind: "plan", path: "FULL", anchors: true });
    expect(plain).not.toContain("anchor");
    expect(anchored).toContain("anchor?: string");
    expect(anchored).toContain("copy the first cited line exactly into its `anchor`");
    expect(asksForCodeAnchors(anchored)).toBe(true);
    expect(asksForCodeAnchors(plain)).toBe(false);
    // The text for a worker that cannot read an anchor is the plain text, word for word.
    expect(withoutCodeAnchorText(anchored)).toBe(plain);
    expect(withoutCodeAnchorText(plain)).toBe(plain);
    for (const kind of ["requirements", "design"] as const) {
      expect(withoutCodeAnchorText(planDocumentInstructions({ kind, path: "FULL", anchors: true }))).toBe(planDocumentInstructions({ kind, path: "FULL" }));
    }
  });

  it("tells the planner to put the project's proposed checks in the plan, not in a second block", () => {
    const text = planChecksInstructions(["repo/demo"]);
    expect(text).toContain("Put the checks in the plan's `checks` member");
    expect(text).not.toContain("agentx-checks");
    // The example in the prompt is itself a checks member the parser accepts.
    const example = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(text)![1]!) as unknown;
    const plan = { ...planDocument(), checks: example };
    const read = parsePlanDocument(`\`\`\`${PLAN_DOCUMENT_INFO_STRING}\n${JSON.stringify(plan)}\n\`\`\``, { kind: "plan", checks: { repositoryPaths: ["repo/demo"], required: [] } });
    expect(read).toMatchObject({ ok: true, plan: { checks: { proposed: [{ label: "Unit tests" }], proves: { "proposed-1": ["1"] } } } });
  });

  it("includes pinned source-backed E2E planning context only for E2E coding plans", () => {
    const context: FeatureE2EPlanningContext = {
      status: "available",
      source: { origin: "approved-setup", commitSha: "a".repeat(40), treeSha: "b".repeat(40), candidateDigest: "c".repeat(64),
        preparedCommitStatus: "UNKNOWN", preparedCommitSha: null, currentCheckoutUnverified: true },
      baselineScenarioIds: ["orders-list-baseline"],
      targets: [{ targetId: "web-1", applicationId: "ordinary-orders", kind: "web", accountProfileId: "synthetic" }],
      portableOperations: [{ operationId: "op-render", applicationId: "ordinary-orders", requestedTargetIds: ["web-1"],
        packageExportSubpath: ".", moduleSpecifier: "./src/index.mjs", callableSelectors: [{ selector: { kind: "named", exportName: "renderOrders" } }],
        sourceRefs: [{ path: "src/index.mjs", sha256: "1".repeat(64) }] }],
      mockFixtures: [{ componentId: "api-schema-orders", requestedTargetIds: ["web-1"], operationId: "listOrders", sourcePath: "fixtures/orders-mocks.json",
        sourceSha256: "d".repeat(64), contractPath: "openapi.json", contractSha256: "f".repeat(64), method: "GET", path: "/orders",
        inputSelector: { kind: "query", name: "mode" }, callableMappings: [],
        variants: [{ id: "success", inputValue: "success", status: 200, response: { orders: [{ name: "Sample order" }] } }] }],
      accountContextRefs: [{ applicationId: "ordinary-orders", profileId: "synthetic", sourcePath: "package.json", sourceSha256: "e".repeat(64) }],
    };
    const codingPlan = planDocumentInstructions({ kind: "plan", path: "FULL", e2ePlanningContext: context });
    expect(codingPlan).toContain('e2e?: E2EFeaturePlanIntent;');
    expect(codingPlan).toContain('"commitSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"');
    expect(codingPlan).toContain('"preparedCommitStatus":"UNKNOWN"');
    expect(codingPlan).toContain("Inspect the actual prepared task checkout and verify every source path and hash");
    expect(codingPlan).toContain('"operationId":"op-render"');
    expect(codingPlan).toContain('"sourcePath":"fixtures/orders-mocks.json"');
    expect(codingPlan).toContain('"callableMappings":[]');
    expect(codingPlan).toContain("the fixture is an unlinked schema hint only");
    expect(codingPlan).toContain("The model's `e2e` member is an untrusted proposal");
    // PLANCTX: a mock is listed once with its targets, and the planner is told to write one reference per target; a context with no mock does not say it.
    expect(codingPlan).toContain("each `mockFixtureRefs` entry names exactly one of those targets as its `requestedTargetId`");
    expect(planDocumentInstructions({ kind: "plan", path: "FULL", e2ePlanningContext: { ...context, mockFixtures: [] } })).not.toContain("requestedTargetIds`; each `mockFixtureRefs`");
    const unavailable = planDocumentInstructions({ kind: "plan", path: "FULL", e2ePlanningContext: { status: "unknown", reason: "prepared-source capture failed" } });
    expect(unavailable).toContain("prepared-source capture failed");
    expect(unavailable).toContain("Do not invent target, operation, fixture, account, or source IDs");
    expect(unavailable).toContain("omit `e2e` until source-backed references are available");
    expect(planDocumentInstructions({ kind: "plan", path: "FULL" })).not.toContain("E2EFeaturePlanIntent");
    expect(planDocumentInstructions({ kind: "design", path: "FULL", e2ePlanningContext: context })).not.toContain("E2EFeaturePlanIntent");
  });
});

describe("the application E2E plan in the planner prompt", () => {
  const sourceRefs = [{ path: "package.json", sha256: "1".repeat(64) }];
  const base: FeatureE2EPlanningContext = {
    status: "available",
    source: { origin: "approved-setup", commitSha: "a".repeat(40), treeSha: "b".repeat(40), candidateDigest: "c".repeat(64),
      preparedCommitStatus: "UNKNOWN", preparedCommitSha: null, currentCheckoutUnverified: true },
    baselineScenarioIds: [],
    targets: [{ targetId: "web-1", applicationId: "orders", kind: "web", accountProfileId: "synthetic" }],
    runtimeRefs: [{ targetId: "web-1", applicationId: "orders", recipeDigest: "2".repeat(64), sourceRefs, runtimeProfileId: "linux-arm64-web-api-v1", accountProfileId: "synthetic" }],
    unavailableTargetRefs: [], portableOperations: [], mockFixtures: [],
    accountContextRefs: [{ applicationId: "orders", profileId: "synthetic", sourcePath: "package.json", sourceSha256: "1".repeat(64) }],
  };
  const offered: FeatureE2EPlanningContext = { ...base, unavailableReasons: [],
    runtimeAccountRefs: [{ applicationId: "orders", profileId: "synthetic", revision: 1, definitionDigest: "3".repeat(64) }],
    executableKinds: [{ kind: "web", steps: ["navigate", "fill", "click", "choose-file"], assertions: ["text", "visible", "csv"] }] };
  const notReady: FeatureE2EPlanningContext = { ...base, unavailableReasons: [{ targetId: "web-1", reason: "runtime-not-ready" }], runtimeAccountRefs: [], executableKinds: [],
    unavailableTargetRefs: [{ targetId: "web-1", applicationId: "orders", accountProfileId: "synthetic", sourceRefs }] };

  it("asks for the v2 application intent only when the context offers executable kinds, and documents its fields", () => {
    const text = planDocumentInstructions({ kind: "plan", path: "QUICK", e2ePlanningContext: offered });
    expect(text).toContain("e2e?: WorkflowFeatureE2EIntent;");
    expect(text).toContain("schemaVersion: 2");
    for (const member of ["applicationRuntimeRefs", "runtimeAccountRefs", "unavailableTargetRefs", "recipeDigest", "definitionDigest"]) expect(text).toContain(member);
    expect(text).toContain("navigate, fill, click, choose-file");
    expect(asksForApplicationPlan(text)).toBe(true);
    // The portable form stays described, for a plan that proposes only portable scenarios.
    expect(text).toContain("E2EFeaturePlanIntent has exactly these members");
  });

  it("keeps the v1 prompt for a context that offers no executable kind", () => {
    for (const context of [base, notReady]) {
      const text = planDocumentInstructions({ kind: "plan", path: "QUICK", e2ePlanningContext: context });
      expect(text).toContain("e2e?: E2EFeaturePlanIntent;");
      expect(text).not.toContain("WorkflowFeatureE2EIntent");
      expect(text).not.toContain("applicationRuntimeRefs");
      expect(text).not.toContain("schemaVersion 2");
      expect(asksForApplicationPlan(text)).toBe(false);
    }
  });

  it("gives an older worker the portable-only prompt: the same text as asking for no application plan", () => {
    const text = planDocumentInstructions({ kind: "plan", path: "QUICK", e2ePlanningContext: offered });
    const portableOnly = planDocumentInstructions({ kind: "plan", path: "QUICK", e2ePlanningContext: offered, applicationPlans: false });
    expect(withoutApplicationPlanText(text)).toBe(portableOnly);
    expect(portableOnly).toContain("e2e?: E2EFeaturePlanIntent;");
    expect(portableOnly).toContain("Use only the schemaVersion 1 portable intent");
    expect(portableOnly).not.toContain("applicationRuntimeRefs: {");
    expect(portableOnly).not.toContain("schemaVersion: 2");
    expect(portableOnly).not.toContain("navigate, fill, click, choose-file");
    expect(asksForApplicationPlan(portableOnly)).toBe(false);
    // Anything that never offered an application plan is left exactly as it was.
    for (const plain of [planDocumentInstructions({ kind: "plan", path: "QUICK" }), planDocumentInstructions({ kind: "plan", path: "FULL", e2ePlanningContext: base })]) {
      expect(withoutApplicationPlanText(plain)).toBe(plain);
    }
  });

  it("composes with the anchor-line downgrade in either order", () => {
    const anchored = planDocumentInstructions({ kind: "plan", path: "QUICK", anchors: true, e2ePlanningContext: offered });
    const plain = planDocumentInstructions({ kind: "plan", path: "QUICK", e2ePlanningContext: offered, applicationPlans: false });
    expect(withoutApplicationPlanText(withoutCodeAnchorText(anchored))).toBe(plain);
    expect(withoutCodeAnchorText(withoutApplicationPlanText(anchored))).toBe(plain);
  });

  it("tells the planner the exact account references to copy", () => {
    const text = planDocumentInstructions({ kind: "plan", path: "QUICK", e2ePlanningContext: offered });
    expect(text).toContain('"runtimeAccountRefs":[{"applicationId":"orders","profileId":"synthetic","revision":1,"definitionDigest":"' + "3".repeat(64) + '"}]');
  });
});

describe("the planning run's document kind on the worker invocation", () => {
  const invocation = (payload: Record<string, unknown>) => ({
    protocolVersion: 1, kind: "task", operationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222", fence: 1, projectRevision: 1,
    callbackCapability: "c".repeat(40), payload: { conversationId: "33333333-3333-4333-8333-333333333333", prompt: "Plan it", ...payload },
  });

  it("accepts a phase on a planning run only", () => {
    expect(WorkerInvocationSchema.safeParse(invocation({ workflowMode: "PLAN", workflowPhase: "DESIGN" })).success).toBe(true);
    expect(WorkerInvocationSchema.safeParse(invocation({ workflowMode: "IMPLEMENT", workflowPhase: "DESIGN" })).success).toBe(false);
    expect(WorkerInvocationSchema.safeParse(invocation({ workflowPhase: "DESIGN" })).success).toBe(false);
    expect(WorkerInvocationSchema.safeParse(invocation({ workflowMode: "PLAN", workflowPhase: "OTHER" })).success).toBe(false);
  });

  it("accepts the structured plan format on a planning run only", () => {
    expect(WorkerInvocationSchema.safeParse(invocation({ workflowMode: "PLAN", planFormat: "structured" })).success).toBe(true);
    expect(WorkerInvocationSchema.safeParse(invocation({ workflowMode: "IMPLEMENT", planFormat: "structured" })).success).toBe(false);
    expect(WorkerInvocationSchema.safeParse(invocation({ planFormat: "structured" })).success).toBe(false);
    expect(WorkerInvocationSchema.safeParse(invocation({ workflowMode: "PLAN", planFormat: "markdown" })).success).toBe(false);
  });

  it("is a feature a worker advertises, so an older worker is not sent it", () => {
    expect(WORKER_INVOCATION_FEATURES).toContain("task.structuredPlans");
  });
});
