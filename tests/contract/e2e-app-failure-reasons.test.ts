import { afterEach, describe, expect, it, vi } from "vitest";
import {
  E2EDisplayScenarioSchema, E2E_APPLICATION_SEND_BACK_CODES, cutEvidenceReason, WorkflowSnapshotSchema, createCandidateManifest, createWorkflowSnapshot, sendBackInstructions, sendBackProblems,
  workflowApplicationEvidenceCodes, workflowSendBackOffered, type WorkflowSnapshot,
} from "@agentx/contracts";
import type { DockerApplicationUnavailableReason } from "@agentx/verifier";
import { E2E_OWNER_SENTENCES } from "../../packages/broker/src/e2e/owner-sentences.js";
import { buildScenarioRows, type DisplayGroupInput } from "../../packages/broker/src/e2e/application-display.js";
import { workflowMessage } from "../../packages/broker/src/developer/workflow-messages.js";
import { StrictSlackWeb, visibleSlackText } from "../support/strict-slack.js";

// M1.4 RUN-2: every reason the app host (and the worker, and the broker's own runtime gate) can end a group with has its own fixed owner sentence, shown on the rows and in the
// Slack message; the four codes the candidate causes can be sent back to the coding agent with only the fixed code and its sentence.

/** Every host code. The `Record` makes this list a compile error to leave out a code of the host's own type. */
const HOST_CODES = Object.keys({
  "build-failed": 0, "app-unhealthy": 0, "app-exited": 0, "deadline-exceeded": 0, "executor-failed": 0, "executor-result-mismatch": 0, "mock-unavailable": 0, "seed-failed": 0,
  "login-failed": 0, "model-channel-unavailable": 0, cancelled: 0,
} satisfies Record<DockerApplicationUnavailableReason, 0>) as DockerApplicationUnavailableReason[];
const OTHER_CODES = ["evidence too large", "runtime-expired", "model-environment-unsafe", "runtime-environment-drifted"] as const;
const CANDIDATE_CODES = ["build-failed", "app-exited", "app-unhealthy", "seed-failed"] as const;
const COULD_NOT_VERIFY = "this check could not be verified";

const caseOf = { caseId: "orders-case", scenarioId: "orders-scenario", targetId: "web-1", accountProfileId: "orders-owner" };
const group = (reason: string): DisplayGroupInput => ({ verdict: "UNKNOWN", reason, cases: [caseOf], scenarios: new Map(), result: undefined, observed: new Map(), screenshots: new Map() });
const rowsOf = (reason: string) => buildScenarioRows({ authoritative: true, attach: "failed-or-incomplete", targetKinds: new Map([["web-1", "web"]]), groups: [group(reason)] }).scenarios;
const sentenceOf = (code: string): string => E2E_OWNER_SENTENCES.groupCode[code]!;

afterEach(() => { vi.restoreAllMocks(); });

describe("RUN-2 item 1: a fixed owner sentence for every reason a group can end with", () => {
  it("gives every host code, the worker's 'evidence too large', runtime-expired and model-environment-unsafe a sentence of its own", () => {
    const sentences = [...HOST_CODES, ...OTHER_CODES].map((code) => {
      const sentence = sentenceOf(code);
      expect(sentence, code).toBeTypeOf("string");
      expect(sentence.length, code).toBeGreaterThan(20);
      expect(sentence.length, code).toBeLessThanOrEqual(300);
      expect(sentence, code).not.toMatch(/could not be verified/i);
      return sentence;
    });
    expect(new Set(sentences).size).toBe(sentences.length);
  });

  it("shows the sentence on the rows, whatever worker text follows the code, instead of 'could not be verified'", () => {
    const secret = "password=hunter2-secret /srv/app/node_modules/.bin/x ops@tenant-a.example";
    for (const code of [...HOST_CODES, ...OTHER_CODES]) {
      if (code === "model-environment-unsafe" || code === "runtime-environment-drifted") vi.spyOn(console, "log").mockImplementation(() => undefined);
      for (const reason of [code, `${code}: ${secret}`]) {
        const [row] = rowsOf(reason);
        expect(row!.status).toBe("UNKNOWN");
        expect(row!.reason, reason).toBe(sentenceOf(code));
        expect(JSON.stringify(row)).not.toContain("hunter2-secret");
        expect(JSON.stringify(row)).not.toContain("/srv/app");
        expect(JSON.stringify(row)).not.toContain("tenant-a.example");
      }
    }
  });

  it("still says 'could not be verified' for a code nobody knows, a look-alike, or a worker text that merely mentions a code", () => {
    for (const reason of ["build-failed-2: detail", "Build-Failed", "x build-failed", "the build-failed again", "evidence too large and more", "evidence-too-large", "", "boom: build-failed"]) {
      expect(rowsOf(reason)[0]!.reason, reason).toBe(COULD_NOT_VERIFY);
    }
  });

  it("keeps the operator's log line for model-environment-unsafe, with the code only", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    rowsOf("model-environment-unsafe: HTTPS_PROXY is set to http://10.0.0.5:3128 password=hunter2-secret");
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ component: "broker", event: "workflow.e2e_group_reason", code: "model-environment-unsafe" });
    expect(String(log.mock.calls[0]![0])).not.toContain("hunter2-secret");
  });

  it("names the codes' sentences exactly as the owner approved them (the table in the report)", () => {
    expect(Object.fromEntries([...HOST_CODES, ...OTHER_CODES].map((code) => [code, sentenceOf(code)]))).toMatchInlineSnapshot(`
      {
        "app-exited": "The app stopped right after it started. The coding agent needs to fix it.",
        "app-unhealthy": "The app didn't answer its health check in time. If it listens on another port, answers on another path, or needs longer to start, change that in the project's browser and API check settings; otherwise the coding agent needs to fix it.",
        "build-failed": "The app didn't install or build with this change. The coding agent needs to fix it.",
        "cancelled": "The checks were stopped before they finished. Retry the checks.",
        "deadline-exceeded": "The checks ran out of time before they finished. Retry the checks; if it happens again, tell Rovara support (code deadline-exceeded).",
        "evidence too large": "The checks produced more evidence than Rovara can keep, so they could not be decided. Retry the checks; if it happens again, tell Rovara support (code evidence too large).",
        "executor-failed": "The browser runner stopped before it finished. Retry the checks; if it happens again, tell Rovara support (code executor-failed).",
        "executor-result-mismatch": "The browser runner's report didn't match what was run, so it can't be trusted. Retry the checks; if it happens again, tell Rovara support (code executor-result-mismatch).",
        "login-failed": "The test account couldn't sign in. Signed-in checks work only with a plain email-and-password form and the test accounts Rovara creates; sign-in through Auth0, Clerk, Google or similar is not supported yet.",
        "mock-unavailable": "A stand-in for one of the app's outside services couldn't start. Retry the checks; if it happens again, tell Rovara support (code mock-unavailable).",
        "model-channel-unavailable": "Rovara couldn't set up the AI navigation connection for these checks. Retry the checks; if it happens again, tell Rovara support (code model-channel-unavailable).",
        "model-environment-unsafe": "This runner's setup could let AI model calls be redirected, so AI navigation was not run. Tell Rovara support (code model-environment-unsafe).",
        "runtime-environment-drifted": "The test machine changed since it was qualified. An administrator must qualify it again, then retry the checks.",
        "runtime-expired": "The browser and API runtime's qualification expired. An administrator must qualify it again, then retry the checks.",
        "seed-failed": "The app couldn't load its test data. The coding agent needs to fix it.",
      }
    `);
  });

  it("an old stored row, which holds its sentence as text, still passes the display schema", () => {
    const old = { scenarioId: "s", title: "S", kind: "web", accountLabel: "Owner", status: "UNKNOWN", reason: COULD_NOT_VERIFY, mockedOrigins: [] };
    expect(E2EDisplayScenarioSchema.safeParse(old).success).toBe(true);
    const fresh = { ...old, reason: sentenceOf("build-failed") };
    expect(E2EDisplayScenarioSchema.safeParse(fresh).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// The block reason the broker writes, and what a workflow makes of it
// ---------------------------------------------------------------------------------------------
const taskId = "11111111-1111-4111-8111-111111111111";
const now = "2026-10-07T12:00:00.000Z";
const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "a".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) }]);
const plan = { id: "plan-v1", type: "plan" as const, version: 1, sha256: "c".repeat(64), producer: "p", objectKey: "private/o/w/op/plan.md", createdAt: now };
const roundId = "33333333-3333-4333-8333-333333333333";
const checkPolicy = { required: [{ id: "required-1", label: "npm test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } }], optional: [], selectedOptionalIds: [] };
const blockedOn = (blockReason: string, extra: Record<string, unknown> = {}): WorkflowSnapshot => {
  const base = createWorkflowSnapshot({ taskId, ownerId: "a".repeat(64), now });
  return WorkflowSnapshotSchema.parse({ ...base, revision: 7, stage: "VERIFY", state: "BLOCKED", artifacts: [plan], checkPolicy, candidate, blockReason,
    e2e: { contractDigest: "1".repeat(64), policyDigest: "2".repeat(64), bundleDigest: "3".repeat(64), executionPlanDigest: "4".repeat(64), required: true, currentRoundId: roundId,
      currentGroupRunIds: [roundId], resultRefs: [] }, ...extra });
};
const incomplete = (...segments: string[]) => `admitted E2E evidence is incomplete or unknown (${segments.join("; ")})`;

describe("RUN-2: reading the codes out of the block reason", () => {
  it("reads one code per group, and refuses (undefined) anything that is not exactly 'group: code' for every group", () => {
    expect(workflowApplicationEvidenceCodes(incomplete("group-1: build-failed"))).toEqual(["build-failed"]);
    expect(workflowApplicationEvidenceCodes(incomplete("group-1: build-failed", "group-2: evidence too large"))).toEqual(["build-failed", "evidence too large"]);
    // A reason the broker cut on whole entries ends with "; …": the entries before it are read, the marker is not a code (and only a last entry may be one).
    expect(workflowApplicationEvidenceCodes(incomplete("group-1: build-failed", "group-2: executor-failed", "…"))).toEqual(["build-failed", "executor-failed"]);
    for (const reason of [incomplete("…"), incomplete("…", "group-1: build-failed"), incomplete("group-1: build-failed", "…", "group-2: build-failed"), incomplete("group-1: build-failed", "x…")]) {
      expect(workflowApplicationEvidenceCodes(reason), reason).toBeUndefined();
    }
    // A code-shaped word is read as written; whether it is the candidate's is decided by the closed list, not by the shape.
    expect(workflowApplicationEvidenceCodes(incomplete("group-1: build-fail"))).toEqual(["build-fail"]);
    for (const reason of [undefined, "", "one or more admitted E2E groups failed", "admitted E2E evidence is incomplete or unknown", "admitted E2E evidence is incomplete or unknown (accepted-group-evidence-integrity)",
      incomplete("group-1: build-failed", "group-2: the group's lifecycle does not confirm a clean run"), incomplete("group-1: boom: build-failed"), incomplete("group 1: build-failed"),
      "admitted E2E evidence is incomplete or unknown (group-1: build-failed", incomplete("g: Build-Failed")]) {
      expect(workflowApplicationEvidenceCodes(reason), String(reason)).toBeUndefined();
    }
  });

  it("lists exactly build-failed, app-exited, app-unhealthy and seed-failed as the candidate's", () => {
    expect([...E2E_APPLICATION_SEND_BACK_CODES].sort()).toEqual([...CANDIDATE_CODES].sort());
  });
});

describe("RUN-2 item 2: Send back for the codes the candidate causes", () => {
  it("is offered for each candidate-caused code, alone or repeated across groups, and carries the code and its sentence to the coder", () => {
    for (const code of CANDIDATE_CODES) {
      const workflow = blockedOn(incomplete(`group-1: ${code}`));
      expect(workflowSendBackOffered(workflow), code).toBe(true);
      expect(sendBackProblems(workflow, sentenceOf)).toEqual([{ source: "check", text: `the browser and API checks could not run on this change (${code}): ${sentenceOf(code)}` }]);
      expect(sendBackInstructions(workflow)).toContain(code);
    }
    const twice = blockedOn(incomplete("group-1: build-failed", "group-2: build-failed"));
    expect(workflowSendBackOffered(twice)).toBe(true);
    expect(sendBackProblems(twice, sentenceOf)).toHaveLength(1);
    const two = blockedOn(incomplete("group-1: build-failed", "group-2: seed-failed"));
    expect(workflowSendBackOffered(two)).toBe(true);
    expect(sendBackProblems(two, sentenceOf).map((problem) => problem.text.match(/\((.*?)\)/)?.[1])).toEqual(["build-failed", "seed-failed"]);
  });

  it("is not offered for an infrastructure code, a code nobody knows, a mix with one, a reason it cannot read, or a task that needs no round", () => {
    for (const code of [...HOST_CODES.filter((item) => !(CANDIDATE_CODES as readonly string[]).includes(item)), ...OTHER_CODES, "something-new"]) {
      const workflow = blockedOn(incomplete(`group-1: ${code}`));
      expect(workflowSendBackOffered(workflow), code).toBe(false);
      expect(sendBackProblems(workflow, sentenceOf), code).toEqual([]);
    }
    for (const reason of [incomplete("group-1: build-failed", "group-2: the group's lifecycle does not confirm a clean run"),
      "admitted E2E evidence is incomplete or unknown", "one or more admitted E2E groups failed: build-failed"]) {
      expect(workflowSendBackOffered(blockedOn(reason)), reason).toBe(false);
    }
    const notRequired = blockedOn(incomplete("group-1: build-failed"), { e2e: { contractDigest: "1".repeat(64), policyDigest: "2".repeat(64), bundleDigest: "3".repeat(64), executionPlanDigest: "4".repeat(64),
      required: false, currentRoundId: roundId, currentGroupRunIds: [roundId], resultRefs: [] } });
    expect(workflowSendBackOffered(notRequired)).toBe(false);
  });

  it("is not offered once the task is no longer blocked at VERIFY (a stale card), and without a describer the problem carries the code alone", () => {
    const moved = WorkflowSnapshotSchema.parse({ ...blockedOn(incomplete("group-1: build-failed")), stage: "IMPLEMENT", state: "RUNNING", blockReason: undefined });
    expect(workflowSendBackOffered(moved)).toBe(false);
    expect(sendBackProblems(blockedOn(incomplete("group-1: build-failed")))).toEqual([{ source: "check", text: "the browser and API checks could not run on this change (build-failed)" }]);
  });
});

// ---------------------------------------------------------------------------------------------
// The Slack message
// ---------------------------------------------------------------------------------------------
type Button = { action_id: string; text: { text: string }; value: string };
const buttonsOf = (blocks: Array<Record<string, unknown>>): string[] => blocks.filter((block) => block.type === "actions").flatMap((block) => (block.elements as Button[]).map((button) => button.action_id));
const messageOf = (blockReason: string) => workflowMessage({ taskId, workflow: blockedOn(blockReason) })!;
const GENERIC = "The required E2E evidence is incomplete or unavailable. Some required runtime checks may not have run. Nothing was sent to GitHub.";

describe("RUN-2: the Slack message says why, and offers Send back only where the candidate is the cause", () => {
  it("says the code's own sentence instead of the one fixed text, for every host code", () => {
    for (const code of [...HOST_CODES, ...OTHER_CODES]) {
      const message = messageOf(incomplete(`group-1: ${code}`));
      expect(message.text, code).toContain(sentenceOf(code));
      expect(message.text, code).not.toBe(GENERIC);
      expect(message.text, code).toContain("Nothing was sent to GitHub.");
      expect(() => new StrictSlackWeb({ briefLimit: 1_200 }).post({ channel: "C0123456789", threadTs: "1695500000.000001", ...message }), code).not.toThrow();
      expect(visibleSlackText(message.text), code).not.toMatch(/\b(candidate|revision|digest|operation|artifact|workflow|invalid json)\b/i);
      expect(visibleSlackText(message.text), code).not.toMatch(/\b(SUCCEEDED|FAILED|INTERRUPTED|CANCELLED)\b/);
    }
  });

  it("puts Send back first for a candidate-caused code, beside Retry checks and Close, and not for an infrastructure code", () => {
    for (const code of [...HOST_CODES, ...OTHER_CODES]) {
      const actions = buttonsOf(messageOf(incomplete(`group-1: ${code}`)).blocks);
      if ((CANDIDATE_CODES as readonly string[]).includes(code)) expect(actions, code).toEqual(["agentx_workflow_send_back", "agentx_workflow_retry_checks", "agentx_workflow_close"]);
      else expect(actions, code).toEqual(["agentx_workflow_retry_checks", "agentx_workflow_close"]);
    }
  });

  it("names each distinct sentence once for several groups, and offers Send back when any group's code is the candidate's", () => {
    const same = messageOf(incomplete("group-1: build-failed", "group-2: build-failed"));
    expect(same.text.split(sentenceOf("build-failed"))).toHaveLength(2);
    const mixed = messageOf(incomplete("group-1: build-failed", "group-2: executor-failed"));
    expect(mixed.text).toContain(sentenceOf("build-failed"));
    expect(mixed.text).toContain(sentenceOf("executor-failed"));
    expect(buttonsOf(mixed.blocks)).toContain("agentx_workflow_send_back");
  });

  it("keeps the one fixed text, and no Send back, for a reason that carries no code it can read", () => {
    for (const reason of ["admitted E2E evidence is incomplete or unknown", incomplete("accepted-group-evidence-integrity"), incomplete("group-1: the group's lifecycle does not confirm a clean run"),
      incomplete("group-1: something-new")]) {
      const message = messageOf(reason);
      expect(message.text, reason).toBe(GENERIC);
      expect(buttonsOf(message.blocks), reason).toEqual(["agentx_workflow_retry_checks", "agentx_workflow_close"]);
    }
  });
});

describe("review round 1: minors", () => {
  it("M-2: says how many more reasons there are instead of dropping a fourth distinct sentence silently", () => {
    const four = messageOf(incomplete("g1: build-failed", "g2: app-exited", "g3: app-unhealthy", "g4: seed-failed"));
    for (const code of ["build-failed", "app-exited", "app-unhealthy"]) expect(four.text).toContain(sentenceOf(code));
    expect(four.text).not.toContain(sentenceOf("seed-failed"));
    expect(four.text).toContain("And 1 more.");
    expect(() => new StrictSlackWeb({ briefLimit: 1_200 }).post({ channel: "C0123456789", threadTs: "1695500000.000001", ...four })).not.toThrow();
    expect(messageOf(incomplete("g1: build-failed", "g2: app-exited", "g3: app-unhealthy")).text).not.toContain("more.");
  });

  it("M-1: a reason cut for the block is cut on whole entries and ends with a marker that is not read as a code", () => {
    const entries = Array.from({ length: 12 }, (_, index) => `group-${"x".repeat(14)}${index}: build-failed`);
    const full = incomplete(...entries);
    expect(full.length).toBeGreaterThan(240);
    const inner = entries.join("; ");
    const cut = cutEvidenceReason(inner, 240);
    expect(cut.length).toBeLessThanOrEqual(240);
    expect(cut.endsWith("; …")).toBe(true);
    expect(cut.slice(0, -3).split("; ").every((entry) => entries.includes(entry))).toBe(true);
    // The marker is not a code: the entries before it are read, and every one is the candidate's, so Send back is offered (round 2).
    expect(workflowApplicationEvidenceCodes(`admitted E2E evidence is incomplete or unknown (${cut})`)).toEqual(cut.slice(0, -3).split("; ").map(() => "build-failed"));
    // Short reasons, and a reason whose first entry alone is over the limit, are cut as they always were.
    expect(cutEvidenceReason("g: build-failed", 240)).toBe("g: build-failed");
    expect(cutEvidenceReason("y".repeat(300), 240)).toBe("y".repeat(240));
  });
});

describe("review round 2: Send back in a mixed round, and from a long reason", () => {
  it("is offered when at least one group ended with a candidate-caused code, whatever the other groups ended with, and the coder gets only the candidate's codes", () => {
    for (const other of ["executor-failed", "deadline-exceeded", "evidence too large", "runtime-expired", "something-new", "login-failed"]) {
      const workflow = blockedOn(incomplete("group-1: executor-failed", "group-2: build-failed", `group-3: ${other}`, "group-4: seed-failed"));
      expect(workflowSendBackOffered(workflow), other).toBe(true);
      const problems = sendBackProblems(workflow, sentenceOf);
      expect(problems.map((problem) => problem.text.match(/\((.*?)\)/)?.[1])).toEqual(["build-failed", "seed-failed"]);
      for (const text of problems.map((problem) => problem.text)) for (const infra of ["executor-failed", "deadline-exceeded", "evidence too large", "login-failed", "something-new"]) expect(text).not.toContain(infra);
    }
  });

  it("is still not offered when no group ended with a candidate-caused code", () => {
    for (const reason of [incomplete("group-1: executor-failed", "group-2: deadline-exceeded"), incomplete("group-1: build-fail"), incomplete("group-1: login-failed")]) {
      expect(workflowSendBackOffered(blockedOn(reason)), reason).toBe(false);
      expect(sendBackProblems(blockedOn(reason), sentenceOf), reason).toEqual([]);
    }
  });

  it("puts Send back beside Retry checks and Close on the card of a mixed round, with every sentence still shown", () => {
    const mixed = messageOf(incomplete("group-1: build-failed", "group-2: executor-failed"));
    expect(buttonsOf(mixed.blocks)).toEqual(["agentx_workflow_send_back", "agentx_workflow_retry_checks", "agentx_workflow_close"]);
    expect(mixed.text).toContain(sentenceOf("build-failed"));
    expect(mixed.text).toContain(sentenceOf("executor-failed"));
    // An unknown code has no sentence (the one fixed text), but the candidate's code beside it still earns Send back.
    const unknown = messageOf(incomplete("group-1: build-failed", "group-2: something-new"));
    expect(unknown.text).toBe(GENERIC);
    expect(buttonsOf(unknown.blocks)).toEqual(["agentx_workflow_send_back", "agentx_workflow_retry_checks", "agentx_workflow_close"]);
  });

  it("depends on the parsed codes, not on the cut text: a reason over 240 characters where every group is build-failed still offers Send back", () => {
    const entries = Array.from({ length: 14 }, (_, index) => `group-${"x".repeat(14)}${index}: build-failed`);
    const inner = entries.join("; ");
    expect(inner.length).toBeGreaterThan(240);
    const cut = cutEvidenceReason(inner, 240);
    expect(cut.endsWith("; …")).toBe(true);
    const workflow = blockedOn(`admitted E2E evidence is incomplete or unknown (${cut})`);
    expect(workflowApplicationEvidenceCodes(workflow.blockReason)!.length).toBeGreaterThan(1);
    expect(workflowSendBackOffered(workflow)).toBe(true);
    expect(sendBackProblems(workflow, sentenceOf)).toEqual([{ source: "check", text: `the browser and API checks could not run on this change (build-failed): ${sentenceOf("build-failed")}` }]);
    expect(buttonsOf(workflowMessage({ taskId, workflow })!.blocks)).toEqual(["agentx_workflow_send_back", "agentx_workflow_retry_checks", "agentx_workflow_close"]);
    // A cut that leaves only infrastructure codes visible offers nothing.
    const infra = cutEvidenceReason(Array.from({ length: 14 }, (_, index) => `group-${"x".repeat(14)}${index}: executor-failed`).join("; "), 240);
    expect(workflowSendBackOffered(blockedOn(`admitted E2E evidence is incomplete or unknown (${infra})`))).toBe(false);
  });
});
