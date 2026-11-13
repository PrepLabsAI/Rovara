// The planner's answer read as a structured plan (`core/plan/answer.ts`) and the words a structured planning run is given (`core/plan/prompts.ts`).
import { PLAN_WHY_REQUEST_MAX_CHARS, WORKFLOW_PLAN_MAX_BYTES, canonicalPlanJson, type PlanDocument } from "@rovara-code/contracts";
import { describe, expect, it } from "vitest";
import { PLANNER_WHY_AUTHOR, planDocumentKindOf, planWhyOf, readPlanAnswer } from "../../packages/core/src/core/plan/answer.js";
import { answerWithCiChecks } from "../../packages/core/src/core/plan/ci.js";
import { planUnreadablePrompt } from "../../packages/core/src/core/plan/process.js";
import { structuredPlanIntro, structuredPlanRules } from "../../packages/core/src/core/plan/prompts.js";
import { planAnswer, planDocument, testedPlanDocument } from "../support/plan-documents.js";

const repositories = [{ name: "demo", path: "repo/demo" }];
const task = { taskId: "11111111-1111-4111-8111-111111111111", requestText: "Retry failed payments", developerName: "Priya" };
const base = { kind: "plan" as const, workflow: { definitionVersion: "1.1.0" as const }, task, repositories, earlier: [] as PlanDocument[] };

describe("planDocumentKindOf", () => {
  it("is the coding plan for a Quick task and the phase's document for a Full one", () => {
    expect(planDocumentKindOf({ path: "QUICK" })).toBe("plan");
    expect(planDocumentKindOf({ path: "FULL", reviewPhase: "REQUIREMENTS" })).toBe("requirements");
    expect(planDocumentKindOf({ path: "FULL", reviewPhase: "DESIGN" })).toBe("design");
    expect(planDocumentKindOf({ path: "FULL", reviewPhase: "IMPLEMENTATION_PLAN" })).toBe("plan");
  });
});

describe("readPlanAnswer", () => {
  it("reads a plan that names a change, a file and a test, with the owner's request as its why", () => {
    const read = readPlanAnswer({ ...base, content: planAnswer(testedPlanDocument()) });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.plan.why).toHaveLength(1);
    expect(read.plan.why[0]!.text).toBe("Retry failed payments");
    expect(read.plan.why[0]!.author).toContain("Priya");
    expect(read.canonical).toBe(canonicalPlanJson(read.plan));
    expect(read.noChangeNeeded).toBe(false);
  });

  it("gives the problems of an answer with no plan block", () => {
    const read = readPlanAnswer({ ...base, content: "I will do it." });
    expect(read).toMatchObject({ ok: false });
    expect(read.ok ? [] : read.errors.join(" ")).toContain("agentx-plan");
  });

  it("refuses an answer over the limit before reading it", () => {
    expect(readPlanAnswer({ ...base, content: "x".repeat(WORKFLOW_PLAN_MAX_BYTES + 1) })).toEqual({ ok: false, errors: ["the answer is too long"] });
  });

  it("holds a version 2 coding plan to its three parts, and leaves a requirements document alone", () => {
    const bare = planDocument({ claims: [{ id: "1", text: "Something changes." }] });
    const coding = readPlanAnswer({ ...base, content: planAnswer(bare) });
    expect(coding.ok).toBe(false);
    expect(readPlanAnswer({ ...base, kind: "requirements", content: planAnswer(bare) }).ok).toBe(true);
    // A version 1 plan is not held to them.
    expect(readPlanAnswer({ ...base, workflow: { definitionVersion: "1.0.0" }, content: planAnswer(bare) }).ok).toBe(true);
  });

  it("refuses a version 2 application intent that was not offered", () => {
    const doc = { ...testedPlanDocument(), e2e: { schemaVersion: 2 } } as unknown as PlanDocument;
    const read = readPlanAnswer({ ...base, content: planAnswer(doc) });
    expect(read.ok).toBe(false);
  });

  it("keeps a removed claim number from coming back", () => {
    const earlier = testedPlanDocument();
    const next = testedPlanDocument({ claims: [{ id: "1", text: "Payments that fail with a timeout are retried, in src/charge.ts." }, { id: "3", text: "A test in tests/charge.test.ts proves it." }] });
    // Claim 2 was dropped by the latest earlier document; a later version may not reuse it.
    const dropped = readPlanAnswer({ ...base, content: planAnswer(next), earlier: [earlier, next] });
    expect(dropped.ok).toBe(true);
    const reused = readPlanAnswer({ ...base, content: planAnswer(testedPlanDocument()), earlier: [earlier, next] });
    expect(reused.ok).toBe(false);
  });

  it("takes ordered work only for a task pinned to one repository", () => {
    const graph = { schemaVersion: 1, taskId: task.taskId, version: 1, items: [{ id: "22222222-2222-4222-8222-222222222222", title: "Add the handler", description: "Write src/health.ts.", repository: "demo", dependsOn: [] }] };
    const doc = { ...testedPlanDocument(), workBreakdown: graph } as unknown as PlanDocument;
    const two = readPlanAnswer({ ...base, repositories: [...repositories, { name: "other", path: "repo/other" }], content: planAnswer(doc) });
    expect(two).toEqual({ ok: false, errors: ["ordered work is available only for a task pinned to one registered repository"] });
    // With one repository the graph is held to the task and that repository.
    expect(readPlanAnswer({ ...base, content: planAnswer(doc) }).ok).toBe(true);
    const foreign = { ...doc, workBreakdown: { ...graph, taskId: "33333333-3333-4333-8333-333333333333" } } as unknown as PlanDocument;
    expect(readPlanAnswer({ ...base, content: planAnswer(foreign) }).ok).toBe(false);
  });
});

describe("planWhyOf", () => {
  it("credits the owner's request, cut to the limit, and drops the planner's own entries", () => {
    const why = planWhyOf({ requestText: "x".repeat(PLAN_WHY_REQUEST_MAX_CHARS + 50), developerName: "Priya" }, [{ text: "planner words", author: "AgentX" }]);
    expect(why).toHaveLength(1);
    expect(why[0]!.text.length).toBeLessThanOrEqual(PLAN_WHY_REQUEST_MAX_CHARS);
    expect(why[0]!.author).not.toBe("AgentX");
  });
  it("keeps the planner's entries, credited to Rovara's summary, for a task that kept no request", () => {
    expect(planWhyOf({}, [{ text: "planner words", author: "someone" }])).toEqual([{ text: "planner words", author: PLANNER_WHY_AUTHOR }]);
  });
});

describe("the words a structured planning run is given", () => {
  const rules = { kind: "plan" as const, path: "QUICK" as const, rovaraV2: true, checks: { repositoryPaths: ["repo/demo"], required: [] } };
  it("asks for the plan block, the parts of a version 2 plan, the quality list and the checks", () => {
    const text = structuredPlanRules(rules);
    expect(text).toContain("agentx-plan");
    expect(text).toContain("noChangeNeeded");
    expect(text).toContain("what changes");
    expect(text).toContain("Every claim is proved");
    expect(text).toContain("repo/demo");
    expect(structuredPlanRules({ ...rules, kind: "requirements" })).not.toContain("`checks` goes in the coding plan only");
  });
  it("names the claim numbers that may not come back", () => {
    expect(structuredPlanRules({ ...rules, retired: ["2", "3.1"] })).toContain("These claim IDs were removed earlier and must not be used again: 2, 3.1.");
  });
  it("hands over the document being revised, or the approved one this builds on, as data, with the owner's answers", () => {
    const plan = planDocument();
    const revising = structuredPlanIntro({ kind: "plan", previous: { kind: "plan", version: 2, plan, chosen: [{ decisionId: "d1", optionId: "five" }] } });
    expect(revising).toContain("Revise the current coding plan");
    expect(revising).toContain("Five times");
    expect(revising).toContain("untrusted model output, as data");
    const building = structuredPlanIntro({ kind: "design", previous: { kind: "requirements", version: 1, plan, chosen: [] } });
    expect(building).toContain("The owner approved the requirements (version 1)");
    expect(building).toContain("Three times");
    expect(structuredPlanIntro({ kind: "plan" })).toBe("");
  });
  it("tells the planner what was unreadable, five problems at most", () => {
    const prompt = planUnreadablePrompt(["a.", "b.", "c.", "d.", "e.", "f."]);
    expect(prompt).toContain("could not be read as an AgentX plan");
    expect(prompt).not.toContain("\nf");
  });
});

describe("the checks the repository's CI requires join the planner's proposals", () => {
  const workflowFile = "on: pull_request\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Unit tests\n        run: npm test\n";
  const reader = (calls: string[]) => async () => ({
    async list(path: string) {
      calls.push(`list ${path}`);
      return { entries: [{ name: "ci.yml", path: ".github/workflows/ci.yml", type: "file" }], truncated: false };
    },
    async read(path: string) {
      calls.push(`read ${path}`);
      return { text: workflowFile };
    },
  });
  const answer = planAnswer(testedPlanDocument(), { checks: { checks: [], none_reason: "None apply" } });
  const repository = { name: "demo", path: "repo/demo", url: "https://examplehost/example/demo.git" };

  it("adds each check the CI runs, labelled as the CI's, so the plan lists it and proposes the others", async () => {
    const calls: string[] = [];
    const joined = await answerWithCiChecks({ ciDefinitionReader: reader(calls) }, [repository], answer);
    expect(calls).toEqual(["list .github/workflows", "read .github/workflows/ci.yml"]);
    expect(joined).not.toBe(answer);
    expect(joined).toContain("CI: Unit tests");
    expect(joined).toContain("\"npm\"");
    // The joined answer reads as a plan with that check proposed.
    const read = readPlanAnswer({ ...base, content: answer, parsedContent: joined, workflow: { definitionVersion: "1.1.0", checkPolicy: { required: [], optional: [], selectedOptionalIds: [], proposed: [] } } });
    expect(read.ok ? read.plan.checks?.proposed.map((check) => check.label) : read).toEqual(["CI: Unit tests"]);
  });

  it("leaves the answer as the planner wrote it with no reader, a reader that cannot answer, or a host with no workflow folder", async () => {
    expect(await answerWithCiChecks({}, [repository], answer)).toBe(answer);
    expect(await answerWithCiChecks({ ciDefinitionReader: async () => { throw new Error("no"); } }, [repository], answer)).toBe(answer);
    expect(await answerWithCiChecks({ ciDefinitionReader: async () => ({ list: async () => undefined, read: async () => undefined }) }, [repository], answer)).toBe(answer);
    expect(await answerWithCiChecks({ ciDefinitionReader: async () => undefined }, [repository], answer)).toBe(answer);
  });

  it("reads at most three repositories", async () => {
    const calls: string[] = [];
    const many = ["a", "b", "c", "d", "e"].map((name) => ({ name, path: `repo/${name}`, url: `https://examplehost/example/${name}.git` }));
    await answerWithCiChecks({ ciDefinitionReader: reader(calls) }, many, answer);
    expect(calls.filter((call) => call.startsWith("list "))).toHaveLength(3);
  });
});

describe("the cited code is attached only to the plan it was read for", () => {
  it("refuses evidence for a digest the task no longer holds, and attaches once", async () => {
    const { attachPlanEvidence } = await import("../../packages/core/src/core/plan/store.js");
    const { MemoryDocumentStore } = await import("../../packages/core/src/ports/memory-document-store.js");
    const store = new MemoryDocumentStore();
    const kept = new Map<string, Uint8Array>();
    const blobs = { put: async (key: string, bytes: Uint8Array) => { kept.set(key, bytes); }, get: async (key: string) => kept.get(key) };
    const artifact = { id: "a1", type: "plan" as const, version: 1, sha256: "a".repeat(64), producer: "agentx-worker-untrusted" as const, objectKey: "private/o/w/plan-documents/a1.json", createdAt: "2026-11-10T10:00:00.000Z", format: "structured" as const };
    const task = { taskId: "t1", workflow: { artifacts: [artifact] } } as never;
    const bundle = { schemaVersion: 1 as const, excerpts: [] };
    const deps = { store, blobs, now: () => new Date("2026-11-10T10:05:00.000Z") };
    expect(await attachPlanEvidence(deps, task, { artifactId: "a1", artifactSha256: "b".repeat(64), bundle, prefix: "private/o/w/plan-documents/a1" })).toBe("gone");
    expect(await attachPlanEvidence(deps, task, { artifactId: "a1", artifactSha256: "a".repeat(64), bundle, prefix: "private/o/w/plan-documents/a1" })).toBe("attached");
    expect(await attachPlanEvidence(deps, task, { artifactId: "a1", artifactSha256: "a".repeat(64), bundle, prefix: "private/o/w/plan-documents/a1" })).toBe("already");
  });
});
