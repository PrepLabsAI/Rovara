// L4-SC (DEC 254z c), the task side: a plan-approved mock applies to THAT TASK only, and the coding agent never writes a mock.
//   - `fakesFor`: the project's own fakes plus the approved plan's mocks, for this task's runs; it never writes the project's setting and never replaces a project mock;
//   - the plan's items count only with a person's APPROVE recorded for that plan's digest (`approvedCodingPlan`);
//   - `flagUnplannedMocks` marks a mock source (OpenAPI description) the approved plan did not name, only where mocks are in play; the risk rule makes it high; the pull request carries one line per task-only mock.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EVAL_NOT_READ_LINE } from "@agentx/contracts";
import {
  GENERAL_FAKES_MAX_SERVICES, canonicalPlanJson, createCandidateManifest, createWorkflowSnapshot, generalFakesPayloadOf, setupMockPrLine,
  type GeneralFakesSetting, type PlanSetupChangeItem, type WorkflowSnapshot,
} from "@agentx/contracts";
import { approvedCodingPlan } from "../../packages/broker/src/core/build-step/plan-input.js";
import { fakesFor, flagUnplannedMocks, isUnplannedMock, mockFactsOf, mockPrLines, mocksInPlay, plannedMocksOf, type MockSourceFacts } from "../../packages/broker/src/core/setup-agent/plan-setup.js";
import { assessRisk, type RiskInput } from "../../packages/broker/src/core/proof/risk.js";
import { rovaraStatusLines, evalSetupSection, setupChangeSection } from "../../packages/broker/src/core/proof/pull-request-body.js";
import { planDocument } from "../support/plan-documents.js";

const mock = (over: Record<string, unknown> = {}): PlanSetupChangeItem => ({ id: "s1", kind: "mock", service: "Stripe", variable: "STRIPE_API_URL", spec: "repo/demo/openapi/stripe.yaml", reason: "The refund code calls Stripe.", ...over });
const command = (): PlanSetupChangeItem => ({ id: "s2", kind: "command", area: "test", repo: "demo", line: "npm run test:refunds", reason: "A new test target." });
const setting = (over: Partial<GeneralFakesSetting> = {}): GeneralFakesSetting => ({ enabled: true, services: [{ variable: "PAYMENTS_API_URL", spec: "repo/demo/openapi/payments.yaml" }], ...over });

describe("a plan-approved mock applies to this task only", () => {
  it("adds the approved mocks to the project's own fakes, in that order, and nothing else", () => {
    expect(fakesFor(setting(), [mock()])).toEqual({ services: [{ variable: "PAYMENTS_API_URL", spec: "repo/demo/openapi/payments.yaml" }, { variable: "STRIPE_API_URL", spec: "repo/demo/openapi/stripe.yaml" }] });
    // Only a mock counts: a command, a variable and a dependency add no fake.
    expect(fakesFor(setting(), [command()])).toEqual(generalFakesPayloadOf(setting()));
  });

  it("serves a task's mock even where the project has its fakes off, for that task alone", () => {
    expect(fakesFor(undefined, [mock()])).toEqual({ services: [{ variable: "STRIPE_API_URL", spec: "repo/demo/openapi/stripe.yaml" }] });
    expect(fakesFor(setting({ enabled: false }), [mock()])).toEqual({ services: [{ variable: "STRIPE_API_URL", spec: "repo/demo/openapi/stripe.yaml" }] });
    // Another task, whose plan has no setup change, gets exactly what the project has: none of the first task's mocks.
    expect(fakesFor(undefined, undefined)).toBeUndefined();
    expect(fakesFor(setting({ enabled: false }), undefined)).toBeUndefined();
    expect(fakesFor(setting(), undefined)).toEqual(generalFakesPayloadOf(setting()));
  });

  it("never writes the project's setting (the input is not changed) and never replaces a project fake for the same variable", () => {
    const project = Object.freeze({ enabled: true, services: Object.freeze([Object.freeze({ variable: "STRIPE_API_URL", spec: "repo/demo/openapi/own-stripe.yaml" })]) }) as unknown as GeneralFakesSetting;
    const payload = fakesFor(project, [mock()]);
    expect(payload).toEqual({ services: [{ variable: "STRIPE_API_URL", spec: "repo/demo/openapi/own-stripe.yaml" }] });
    expect(project.services).toHaveLength(1);
  });

  it("sends none of the task's mocks when they do not fit with the project's (all or nothing), and a damaged setting adds none of its own", () => {
    const services = Array.from({ length: GENERAL_FAKES_MAX_SERVICES }, (_, index) => ({ variable: `SVC_${String(index)}_URL` }));
    expect(fakesFor({ enabled: true, services }, [mock()])).toEqual({ services });
    expect(fakesFor({ enabled: "yes" }, [mock()])).toEqual({ services: [{ variable: "STRIPE_API_URL", spec: "repo/demo/openapi/stripe.yaml" }] });
  });
});

describe("the plan counts only with a person's approval of exactly that plan", () => {
  const plan = planDocument({ setupChanges: [mock(), command()] });
  const text = canonicalPlanJson(plan);
  const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
  const artifact = { id: "11111111-1111-4111-8111-111111111111", type: "plan", version: 1, sha256, producer: "agentx-worker-untrusted", objectKey: "plans/p.json", createdAt: "2026-11-09T10:00:00.000Z", format: "structured" };
  const reader = { get: async (key: string) => (key === "plans/p.json" ? new TextEncoder().encode(text) : undefined) };
  const approve = (extra: object = {}) => ({ requestId: "r", workflowRevision: 1, decision: "APPROVE", actorId: "a".repeat(64), actorRole: "TASK_OWNER", reason: "Approved.", artifactDigest: sha256, at: "2026-11-09T10:00:00.000Z", ...extra });
  const read = (decisions: object[]) => approvedCodingPlan(reader, { artifacts: [artifact], decisions } as never);

  it("returns the items when a gate APPROVE is recorded for this plan's digest", async () => {
    const approved = await read([approve()]);
    expect(approved.setupChanges).toEqual([mock(), command()]);
    expect(plannedMocksOf(approved.setupChanges)).toHaveLength(1);
  });

  it("leaves them out without an approval, with an approval of another plan, or with a decision that is not a person's approval", async () => {
    expect((await read([])).setupChanges).toBeUndefined();
    expect((await read([approve({ artifactDigest: "b".repeat(64) })])).setupChanges).toBeUndefined();
    expect((await read([approve({ source: "SEND_BACK" })])).setupChanges).toBeUndefined();
    expect((await read([approve({ source: "AUTO_FIX" })])).setupChanges).toBeUndefined();
    expect((await read([approve({ decision: "REQUEST_CHANGES" })])).setupChanges).toBeUndefined();
  });

  it("leaves the field off a plan with no setup changes, as before", async () => {
    const plain = planDocument();
    const plainText = canonicalPlanJson(plain);
    const plainSha = createHash("sha256").update(plainText, "utf8").digest("hex");
    const approved = await approvedCodingPlan({ get: async () => new TextEncoder().encode(plainText) }, { artifacts: [{ ...artifact, sha256: plainSha }], decisions: [approve({ artifactDigest: plainSha })] } as never);
    expect(Object.hasOwn(approved, "setupChanges")).toBe(false);
  });
});

describe("the coding agent never writes its own mock", () => {
  const facts = (over: Partial<MockSourceFacts> = {}): MockSourceFacts => ({ setting: setting(), changes: undefined, repositoryPaths: { demo: "repo/demo", other: "repo/other" }, ...over });
  const file = (path: string, over: Record<string, unknown> = {}) => ({ repository: "demo", path, ...over });

  it("is silent where no mock is in play: a project with its fakes off and a plan with no mock is exactly as it was", () => {
    const quiet = facts({ setting: undefined });
    expect(mocksInPlay(quiet)).toBe(false);
    expect(flagUnplannedMocks([file("openapi.yaml"), file("docs/swagger.json")], quiet)).toEqual([file("openapi.yaml"), file("docs/swagger.json")]);
    expect(isUnplannedMock(file("openapi.yaml"), facts({ setting: { enabled: false, services: [] } }))).toBe(false);
    expect(isUnplannedMock(file("openapi.yaml"), facts({ setting: { enabled: false, services: [] }, changes: [command()] }))).toBe(false);
  });

  it("marks an OpenAPI or Swagger description the agent adds, changes or removes when the project's fakes are on", () => {
    for (const path of ["openapi.yaml", "api/openapi.json", "docs/swagger.yml", "payments.openapi.yaml", "Swagger.JSON", ".openapi.yaml", "api/.openapi.json"]) expect(isUnplannedMock(file(path), facts()), path).toBe(true);
    for (const path of ["openapi.yaml.txt", "docs/openapi-notes.md", "openapi-payments.yaml", "src/openapi_client.ts", "swaggerish.yaml.bak", "src/refund.ts"]) expect(isUnplannedMock(file(path), facts()), path).toBe(false);
    const [flagged] = flagUnplannedMocks([file("api/openapi.yaml")], facts());
    expect(flagged).toEqual({ repository: "demo", path: "api/openapi.yaml", mockUnplanned: true });
  });

  it("marks the spec the project's own setting names, even under another name", () => {
    expect(isUnplannedMock(file("openapi/payments.yaml"), facts())).toBe(true);
    expect(isUnplannedMock(file("openapi/payments.yaml", { repository: "other" }), facts())).toBe(false);
  });

  it("does not mark the spec the approved plan names (exact path, workspace or repository form), and marks any other", () => {
    const planned = facts({ setting: undefined, changes: [mock()] });
    expect(mocksInPlay(planned)).toBe(true);
    expect(isUnplannedMock(file("openapi/stripe.yaml"), planned)).toBe(false);
    // The plan names this spec in the demo repository; the same name elsewhere, or a different spec, is not it.
    const namedLikeSpec = facts({ setting: undefined, changes: [mock({ spec: "repo/demo/api/openapi.yaml" })] });
    expect(isUnplannedMock(file("api/openapi.yaml"), namedLikeSpec)).toBe(false);
    expect(isUnplannedMock(file("api/openapi.yaml", { repository: "other" }), namedLikeSpec)).toBe(true);
    expect(isUnplannedMock(file("old/api/openapi.yaml"), namedLikeSpec)).toBe(true);
    expect(isUnplannedMock(file("api/other.openapi.yaml"), namedLikeSpec)).toBe(true);
    // A file that is not a mock source is not flagged even beside the planned one.
    expect(isUnplannedMock(file("stripe.yaml"), planned)).toBe(false);
    expect(isUnplannedMock(file("openapi/stripe.yaml.bak"), planned)).toBe(false);
  });

  it("judges a rename on both names: moving a mock source out of, or onto, a path the plan did not name is marked", () => {
    const planned = facts({ setting: undefined, changes: [mock({ spec: "repo/demo/api/openapi.yaml" })] });
    expect(isUnplannedMock(file("api/openapi.yaml", { renamedFrom: "api/old.openapi.yaml" }), planned)).toBe(true);
    expect(isUnplannedMock(file("api/new.openapi.yaml", { renamedFrom: "api/openapi.yaml" }), planned)).toBe(true);
    expect(isUnplannedMock(file("docs/readme.md", { renamedFrom: "api/openapi.yaml" }), planned)).toBe(false);
    expect(isUnplannedMock(file("api/openapi.yaml", { renamedFrom: "docs/readme.md" }), planned)).toBe(false);
  });

  it("reads its facts from the task's project revision and the approved plan, and the verified-changes step uses them", () => {
    const definition = { generalFakes: setting(), repositories: [{ name: "demo", path: "repo/demo" }, { name: "__proto__", path: "repo/proto" }] };
    expect(mockFactsOf(definition, [mock()])).toEqual({ setting: setting(), changes: [mock()], repositoryPaths: { demo: "repo/demo", ["__proto__"]: "repo/proto" } });
    expect(mockFactsOf(undefined, undefined)).toEqual({ setting: undefined, changes: undefined, repositoryPaths: {} });
    // The wiring: the step that reads the host's file list marks mock sources from these facts before the risk is judged (a pin, because that step needs a whole task to run).
    const source = readFileSync("packages/broker/src/core/build-step/changed-files.ts", "utf8");
    expect(source).toContain("flagUnplannedMocks(all, mockFactsOf(project?.definition, plan?.setupChanges))");
    expect(source.indexOf("flagUnplannedMocks(")).toBeLessThan(source.indexOf("riskFromFiles(workflow, read)"));
    // ... and the step that starts a task's checks and coding run sends the plan's mocks with the project's own fakes (also a pin: starting a run needs a whole task).
    const start = readFileSync("packages/broker/src/core/build-step/start.ts", "utf8");
    expect(start).toContain("return fakesFor(setting, approved?.setupChanges);");
    expect(start).toContain("await generalFakesOf(deps, task, workflow)");
  });

  it("raises the risk to high with a fixed sentence, in an ordinary change and in a fix, and a file the plan named does not", () => {
    const base = (files: RiskInput["changedFiles"], over: Partial<RiskInput> = {}): RiskInput => ({
      changedFiles: files, changedFilesComplete: true, report: { passed: [], failed: [], notChecked: [], reviewOnly: false } as never, acceptedFindings: [], securityFindings: 0, candidateDigest: "c".repeat(64), ...over,
    });
    const clean = assessRisk(base([{ repository: "demo", path: "src/refund.ts", added: 3, removed: 1 }]));
    const marked = assessRisk(base([{ repository: "demo", path: "api/openapi.yaml", added: 3, removed: 1, mockUnplanned: true }]));
    expect(marked.level).toBe("high");
    expect(marked.reasons.some((reason) => reason.startsWith("Adds or changes a mock source the approved plan did not name (api/openapi.yaml)."))).toBe(true);
    expect(assessRisk(base([{ repository: "demo", path: "api/openapi.yaml", added: 3, removed: 1, mockUnplanned: true }], { fix: true })).level).toBe("high");
    expect(clean.reasons.join(" ")).not.toContain("mock source");
    // an ordinary file that is not marked is what it was
    expect(assessRisk(base([{ repository: "demo", path: "openapi/stripe.yaml", added: 3, removed: 1 }])).reasons.join(" ")).not.toContain("mock source");
  });
});

describe("the pull request says so once per mock", () => {
  const candidate = createCandidateManifest([{ repositoryId: "app", commitSha: "1".repeat(40), treeSha: "1".repeat(40), baseCommitSha: "e".repeat(40) }]);
  const workflow = { ...createWorkflowSnapshot({ taskId: "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6", ownerId: "a".repeat(64), now: "2026-11-13T12:00:00.000Z", definitionVersion: "1.1.0" }), candidate } as unknown as WorkflowSnapshot;
  const status = (setupLines?: readonly string[]) => rovaraStatusLines(workflow, { ...(setupLines === undefined ? {} : { setupLines }) }, () => ["- no findings"]);

  it("words the line as the design does: fake made by Rovara for this task, not yet part of the project's setup", () => {
    expect(mockPrLines([mock(), command()])).toEqual(["Stripe: fake made by Rovara for this task. Not yet part of the project's setup."]);
    expect(setupMockPrLine("Stripe", "Raj")).toBe("Stripe: fake made by Rovara for this task, approved with the plan by Raj. Not yet part of the project's setup.");
    expect(mockPrLines(undefined)).toEqual([]);
  });

  it("adds a Setup change section only when there is a line, and a description without one is what it was", () => {
    const without = status();
    expect(without.join("\n")).not.toContain("Setup change");
    expect(status([])).toEqual(without);
    const withLine = status(mockPrLines([mock()]));
    expect(withLine).toContain("## Setup change");
    expect(withLine).toContain("Stripe: fake made by Rovara for this task. Not yet part of the project's setup.");
  });

  it("makes the service name inert: no link, mention, heading or line break reaches the description", () => {
    const hostile = mockPrLines([mock({ service: "[click](https://evil.example) @everyone\n# Heading" })]);
    const section = setupChangeSection(hostile).join("\n");
    expect(section).not.toContain("](https://evil.example)");
    expect(section).not.toContain("@everyone");
    expect(setupChangeSection(["a\nb", "", "fine line"]).filter((line) => line.includes("fine line"))).toHaveLength(1);
    expect(setupChangeSection(undefined)).toEqual([]);
  });
});

// L4-EVW4 (DEC 254zzz43): the one line the pull request carries while the project's eval card is set aside and an eval is still unread.
describe("the pull request says an eval was not read", () => {
  const candidate = createCandidateManifest([{ repositoryId: "app", commitSha: "1".repeat(40), treeSha: "1".repeat(40), baseCommitSha: "e".repeat(40) }]);
  const workflow = { ...createWorkflowSnapshot({ taskId: "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6", ownerId: "a".repeat(64), now: "2026-11-13T12:00:00.000Z", definitionVersion: "1.1.0" }), candidate } as unknown as WorkflowSnapshot;
  const status = (evalSetupLines?: readonly string[]) => rovaraStatusLines(workflow, { ...(evalSetupLines === undefined ? {} : { evalSetupLines }) }, () => ["- no findings"]);

  it("adds an Eval section with the fixed line, and a description without one is what it was", () => {
    const without = status();
    expect(without.join("\n")).not.toContain("Eval not read");
    expect(status([])).toEqual(without);
    const withLine = status([EVAL_NOT_READ_LINE]);
    expect(withLine).toContain("## Eval");
    expect(withLine).toContain("Eval not read: setup needed");
    expect(evalSetupSection(undefined)).toEqual([]);
    // Free text cannot ride in it: a line with a break is dropped, a link or mention is made inert.
    expect(evalSetupSection(["a\nb"])).toEqual([]);
    expect(evalSetupSection(["[x](https://evil.example) @everyone"]).join("\n")).not.toMatch(/\]\(https:\/\/evil|@everyone/u);
  });
});
