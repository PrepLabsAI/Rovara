import { describe, expect, it } from "vitest";
import { canonicalJson } from "@agentx/contracts";
import { WORKFLOW_E2E_DISPLAY_SCHEMA_VERSION, createWorkflowE2EDisplayObject, readWorkflowE2ENotifierProjection, workflowE2EDisplayRef } from "../../packages/broker/src/aws/workflow-e2e-notifier-projection.js";
import { workflowE2ENotifierBlocks } from "../../packages/broker/src/aws/developer-task-notifier.js";
import { renderE2EUnavailableSlackBlock } from "../../packages/broker/src/e2e-presentation.js";
import { readLegacyV2WorkflowE2ENotifierProjection } from "../support/legacy-display-v2-reader.js";
import { agentNavigation, agentRow } from "../support/e2e-agent-display.js";
import { failedBaseline, results, row } from "../support/e2e-scenario-results.js";

// M1.4 Tasks 4.4b and 4.4c: display schema v3 in the notifier's envelope. A round that uses nothing new is still written as it was (v1 for no rows, v2 for rows); a round with a
// navigation block, a baseline reason or a skipped list is v3, which a reader that knows only v2 refuses whole and answers with "Open the task page".

const owner = { ownerKey: "owner", workspaceId: "workspace" };
const current = { candidateDigest: "a".repeat(64), roundId: "11111111-1111-4111-8111-111111111111", groupRunIds: ["22222222-2222-4222-8222-222222222222"],
  admissionSha256: "b".repeat(64), evidenceSha256: "c".repeat(64) };
const shared = { schemaVersion: 1 as const, setup: { status: "unavailable" as const, selectedTargetIds: [], executionPlanDigest: null, blockingInputIds: [], mockSubstitutableInputIds: [] },
  e2e: { status: "UNKNOWN" as const, label: "Checks incomplete", executionPlanDigest: "d".repeat(64), expectedGroups: 1, receivedGroups: 1, executedCases: 6, qualifiedCriteria: 0, requiredCriteria: 7,
    unavailableCriteria: 7, optionalUnavailableCriteria: 0, mockedComponentIds: [], observedMockedComponentIds: [], unexercisedBehaviors: [], policyPresence: "present" as const,
    workflowPhase: "VERIFY", requiredUnexercisedCriteriaIds: ["browser"] }, actions: [] };
const capturedAt = "2026-10-22T12:00:00.000Z";
const readerOf = (bytes: Uint8Array) => async (key: string, max: number) => (key.startsWith("private/owner/workspace/workflow-e2e-display/") && bytes.byteLength <= max ? bytes : undefined);
const make = (scenarioResults: ReturnType<typeof results>) => {
  const object = createWorkflowE2EDisplayObject({ ...owner, view: shared, capturedAt, current, scenarioResults })!;
  return { ...object, parsed: JSON.parse(Buffer.from(object.bytes).toString("utf8")) as Record<string, unknown> };
};
const load = (object: { ref: ReturnType<typeof workflowE2EDisplayRef>; bytes: Uint8Array }) => readWorkflowE2ENotifierProjection({ ref: object.ref, ...owner, current, readPrivateObject: readerOf(object.bytes) });
const legacyLoad = (object: { ref: ReturnType<typeof workflowE2EDisplayRef>; bytes: Uint8Array }) => readLegacyV2WorkflowE2ENotifierProjection({ ref: object.ref, ...owner, current, readPrivateObject: readerOf(object.bytes) });
const taskOf = (ref: unknown) => ({ taskId: "11111111-1111-4111-8111-111111111111", ...owner, workflow: { candidate: { digest: current.candidateDigest }, e2e: { currentRoundId: current.roundId,
  currentGroupRunIds: current.groupRunIds, displayRef: ref } } });

describe("display envelope v3", () => {
  it("is the newest version the reader knows", () => {
    expect(WORKFLOW_E2E_DISPLAY_SCHEMA_VERSION).toBe(3);
  });

  it("writes displaySchemaVersion 3 for a round with a navigation block, and the current reader reads the block back exactly", async () => {
    const made = make(results({ scenarios: [agentRow(), ...results().scenarios] }));
    expect(made.parsed.displaySchemaVersion).toBe(3);
    const loaded = await load(made);
    expect(loaded?.scenarioResults?.scenarios[0]?.agentNavigation).toEqual(agentNavigation());
    expect(loaded?.scenarioResults?.scenarios).toHaveLength(6);
  });

  it("writes version 3 for a baseline that has a reason, and for one that has a skipped list; and the current reader reads both back", async () => {
    const reason = make(results({ baseline: { status: "UNAVAILABLE", scenarios: [], reason: "agent-steps-only" } }));
    expect(reason.parsed.displaySchemaVersion).toBe(3);
    expect((await load(reason))?.scenarioResults?.baseline).toEqual({ status: "UNAVAILABLE", scenarios: [], reason: "agent-steps-only" });
    const skipped = make(results({ baseline: { status: "PASSED", scenarios: [row()], skippedAiScenarios: [{ scenarioId: "owner-export-ai", title: "Owner export ai" }] } }));
    expect(skipped.parsed.displaySchemaVersion).toBe(3);
    expect((await load(skipped))?.scenarioResults?.baseline?.skippedAiScenarios).toEqual([{ scenarioId: "owner-export-ai", title: "Owner export ai" }]);
  });

  it("still writes version 2, byte for byte as M1.3 wrote it, for a round with none of the new fields", () => {
    const plain = results({ baseline: failedBaseline() });
    const made = make(plain);
    const expected = canonicalJson({ displaySchemaVersion: 2, capturedAt, ...current, ...shared, scenarios: plain.scenarios, baseline: plain.baseline });
    expect(Buffer.from(made.bytes).toString("utf8")).toBe(expected);
    const noRows = createWorkflowE2EDisplayObject({ ...owner, view: shared, capturedAt, current })!;
    expect((JSON.parse(Buffer.from(noRows.bytes).toString("utf8")) as { displaySchemaVersion: number }).displaySchemaVersion).toBe(1);
  });

  it("drops the baseline, not the rows, when a v3 display no longer fits, and refuses one whose rows alone do not fit", () => {
    const origins = (prefix: string) => Array.from({ length: 32 }, (_, index) => `${prefix}${"o".repeat(180)}-${index}`);
    const big = (id: string) => row({ scenarioId: id, mockedOrigins: origins(id) });
    const rows = Array.from({ length: 20 }, (_, index) => big(`s-${index}`));
    const withBaseline = results({ scenarios: [agentRow(), ...rows], baseline: { status: "PASSED", scenarios: Array.from({ length: 40 }, (_, index) => big(`b-${index}`)), skippedAiScenarios: [{ scenarioId: "x", title: "X" }] } });
    const made = make(withBaseline);
    expect(made.parsed.displaySchemaVersion).toBe(3);
    expect(made.parsed.baseline).toBeUndefined();
    expect((made.parsed.scenarios as unknown[])).toHaveLength(21);
    const huge = results({ scenarios: [agentRow(), ...Array.from({ length: 63 }, (_, index) => big(`h-${index}`))] });
    expect(createWorkflowE2EDisplayObject({ ...owner, view: shared, capturedAt, current, scenarioResults: huge })).toBeUndefined();
  });

  it("scrubs the navigation block again before it is stored", () => {
    const dirty = agentRow({ agentNavigation: agentNavigation({ steps: [{ goal: "Open ops@tenant-a.example with password=hunter2-secret", actedOn: [{ role: "button", name: "Mail ops@tenant-a.example" }], stop: "concluded" }] }) } as never);
    const stored = Buffer.from(make(results({ scenarios: [dirty] })).bytes).toString("utf8");
    for (const secret of ["ops@tenant-a.example", "hunter2-secret"]) expect(stored).not.toContain(secret);
  });
});

describe("test 28: a reader that knows only v2 falls back for a v3 display", () => {
  it("refuses a v3 envelope whole, and the notifier it serves then says 'Open the task page'", async () => {
    const v3 = make(results({ scenarios: [agentRow(), ...results().scenarios] }));
    expect(v3.parsed.displaySchemaVersion).toBe(3);
    expect(await legacyLoad(v3)).toBeUndefined();
    expect(renderE2EUnavailableSlackBlock("https://agentx.test/review/t/task", true).text.text).toContain("Open the task page");
    // Each new field alone is enough for the pinned v2 reader to refuse the display (it is strict), and v3 is what carries them.
    for (const only of [make(results({ baseline: { status: "UNAVAILABLE", scenarios: [], reason: "agent-steps-only" } })),
      make(results({ baseline: { status: "PASSED", scenarios: [row()], skippedAiScenarios: [{ scenarioId: "a", title: "A" }] } }))]) {
      expect(await legacyLoad(only)).toBeUndefined();
    }
    // Positive control: the same reader does read a v2 display (the bytes of a round with none of the new fields), so the refusal above is the version and nothing else.
    const v2 = make(results({ baseline: failedBaseline() }));
    expect(v2.parsed.displaySchemaVersion).toBe(2);
    expect((await legacyLoad(v2))?.scenarioResults?.baseline?.status).toBe("FAILED");
  });

  it("a v3 display relabelled as v2 is refused by the current reader too: version 2 is strict", async () => {
    const v3 = make(results({ scenarios: [agentRow()] }));
    const relabelled = Buffer.from(JSON.stringify({ ...v3.parsed, displaySchemaVersion: 2 }), "utf8");
    const ref = workflowE2EDisplayRef({ ...current, ...owner, bytes: relabelled });
    expect(await readWorkflowE2ENotifierProjection({ ref, ...owner, current, readPrivateObject: readerOf(relabelled) })).toBeUndefined();
  });
});

describe("stored v2 displays keep their meaning", () => {
  it("the current reader returns the very same rows and baseline as the reader M1.3 shipped, for a display written by the code before this change", async () => {
    const plain = results({ baseline: failedBaseline() });
    // Written the way Task 3.7 wrote it: canonical JSON of the v2 envelope, nothing else.
    const bytes = Buffer.from(canonicalJson({ displaySchemaVersion: 2, capturedAt, ...current, ...shared, scenarios: plain.scenarios, baseline: plain.baseline }), "utf8");
    const object = { bytes, ref: workflowE2EDisplayRef({ ...current, ...owner, bytes }) };
    const now = await load(object);
    const then = await legacyLoad(object);
    expect(then?.scenarioResults).toBeDefined();
    expect(now?.scenarioResults).toEqual(then?.scenarioResults);
    expect(now?.view).toEqual(then?.view);
    expect(now?.capturedAt).toBe(then?.capturedAt);
  });

  it("an M1.3 baseline record parses under the current baseline schema and renders as it did", async () => {
    const task = taskOf(make(results({ baseline: failedBaseline() })).ref);
    const made = make(results({ baseline: failedBaseline() }));
    const text = JSON.stringify(await workflowE2ENotifierBlocks({ task: { ...task, workflow: { ...task.workflow, e2e: { ...task.workflow.e2e, displayRef: made.ref } } } as never, readPrivateObject: readerOf(made.bytes),
      taskPageUrl: "https://agentx.test/review/11111111-1111-4111-8111-111111111111/task" }));
    expect(text).toContain("Before the change: 2 of 5 failed, as expected for new behaviour.");
    expect(text).not.toContain("AI navigation");
    expect(text).not.toContain("AI-navigated");
  });
});

describe("test 26 through the notifier", () => {
  it("the notifier built for v3 adds the one AI navigation line from the stored block", async () => {
    const made = make(results({ scenarios: [agentRow(), ...results().scenarios] }));
    const blocks = (await workflowE2ENotifierBlocks({ task: taskOf(made.ref) as never, readPrivateObject: readerOf(made.bytes), taskPageUrl: "https://agentx.test/review/11111111-1111-4111-8111-111111111111/task" }))!;
    const lines = blocks.map((block) => block.text.text).join("\n").split("\n");
    expect(lines.filter((line) => line.startsWith("AI navigation:"))).toEqual(["AI navigation: 1 step, 3 model calls (checks decide)"]);
  });
});
