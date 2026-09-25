import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  CONFIRMATION_TTL_MS,
  confirmationClickEventId,
  type ConnectorCatalog,
  type PendingConfirmation,
  type SlackRequestMessage,
  type SlackThreadWorkspaceResult,
} from "../../packages/contracts/src/index.js";
import { ClassifierError, type ClassifierInput } from "../../packages/orchestrator/src/action-classifier.js";
import { argumentsHash } from "../../packages/orchestrator/src/action-gate.js";
import { ControlPlaneApi } from "../../packages/orchestrator/src/control-plane-api.js";
import type { OrchestrationApi } from "../../packages/orchestrator/src/orchestration-tools.js";
import { runOrchestratorTurn } from "../../packages/orchestrator/src/orchestrator.js";
import { createDynamoConfirmationStore } from "../../packages/slack-service/src/confirmation-store.js";
import { UNPOSTED_MARK } from "../../packages/slack-service/src/confirmations.js";
import { processSlackRequest, type ProcessorDependencies, type TurnInput } from "../../packages/slack-service/src/processor.js";
import { classifierTimeoutMs, createHostedClassifier, createHostedSlackRuntime, gateDecisionLogFields } from "../../packages/slack-service/src/runtime.js";
import { createFixtureDirectory } from "../fixtures/index.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { FAUX_MODEL, fauxModelRuntime } from "../support/faux-model.js";

const thread = { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000001" };
const subject = "T0BSHLLUGBD/C0123456789/1695500000.000001";
const requester = "U0123456789";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const start = Date.parse("2026-09-25T10:00:00.000Z");
const policy = { rules: [{ tool: "tracker__save_item", outcome: "ask" as const }] };
const close = { tool: "tracker__close_item", input: { id: "TRK-9" } };

function slackMessage(eventId: string, text: string, overrides: Partial<SlackRequestMessage> = {}): SlackRequestMessage {
  return { version: 1, eventId, thread, userId: requester, text, receivedAt: new Date(start).toISOString(), ...overrides };
}

/** The processor with a real confirmation store over the fake table; each turn's gate is scripted by the test. */
function harness(turn: (input: TurnInput) => Promise<string>, status: () => "READY" | "UNHEALTHY" = () => "READY") {
  const db = new FakeDynamoDb();
  let now = start;
  const posts: string[] = [];
  const confirmationsPosted: Array<{ confirmation: PendingConfirmation; text: string }> = [];
  const turns: TurnInput[] = [];
  const logs: Array<{ event: string; fields: Readonly<Record<string, string | number | boolean>> }> = [];
  const ensureWorkspace = vi.fn(async (): Promise<SlackThreadWorkspaceResult> => ({
    outcome: "WORKSPACE", workspaceId, status: status(), operationId: null, created: false, orchestratorInstructions: "Delegate.", actionPolicy: policy,
  }));
  const finish = vi.fn(async () => undefined);
  const confirmations = createDynamoConfirmationStore(db, "threads", () => now);
  const dependencies: ProcessorDependencies = {
    api: () => ({ ensureWorkspace, createConversation: async () => "33333333-3333-4333-8333-333333333333", waitForOperation: vi.fn(), startClose: vi.fn(), completeClose: vi.fn() }),
    threads: { load: async () => ({ workspaceId, conversationId: "33333333-3333-4333-8333-333333333333" }), saveConversation: vi.fn(), saveSettingsRevision: vi.fn(), close: vi.fn(), finish },
    runTurn: async (input) => { turns.push(input); return turn(input); },
    post: async (_thread, text) => { posts.push(text); },
    postConfirmation: async (_thread, confirmation, text) => { confirmationsPosted.push({ confirmation, text }); },
    confirmations,
    now: () => now,
    log: (event, fields) => { logs.push({ event, fields }); },
  };
  return { db, posts, confirmationsPosted, turns, logs, ensureWorkspace, finish, confirmations, dependencies, advance: (ms: number) => { now += ms; } };
}

/** A turn that asks to close TRK-9 unless the requester confirmed it, then runs it. */
const closeTurn = async (input: TurnInput) => {
  if (input.gate!.approvals.length === 0) {
    input.gate!.asks.push({ toolCallId: "c1", tool: close.tool, argumentsHash: argumentsHash(close.tool, close.input), summary: "tracker__close_item: id=TRK-9", kind: "destructive" });
    return "I asked you to confirm closing TRK-9.";
  }
  // The confirmed call ran.
  input.gate!.ran += 1;
  return "Closed TRK-9.";
};

describe("confirmations through the Slack processor", () => {
  it("posts one confirmation with buttons before the reply, then runs exactly the confirmed call on the requester's Approve", async () => {
    const { posts, confirmationsPosted, turns, dependencies, advance, confirmations } = harness(closeTurn);
    await processSlackRequest(slackMessage("EvGATE000001", "close TRK-9"), dependencies, { finalAttempt: false });
    expect(turns[0]!.gate).toMatchObject({ requesterId: requester, approvals: [], yesToAll: false });
    expect(turns[0]!.actionPolicy).toEqual(policy);
    expect(confirmationsPosted).toHaveLength(1);
    expect(confirmationsPosted[0]!.text).toContain("• tracker__close_item: id=TRK-9 (destructive)");
    // The confirmation is the reply: nothing else ran, so the model's own words are not posted.
    // (An older ingress sends no queue count, so the start notice is still said.)
    expect(posts).toEqual(["Working on it now. I'll post the result in this thread when it's done."]);
    const { confirmationId } = confirmationsPosted[0]!.confirmation;
    advance(60_000);
    await processSlackRequest(slackMessage(confirmationClickEventId(confirmationId, "approve"), "yes", { receivedAt: new Date(start + 60_000).toISOString() }), dependencies, { finalAttempt: false });
    expect(turns[1]!.gate!.approvals).toEqual([{ tool: close.tool, argumentsHash: argumentsHash(close.tool, close.input), summary: "tracker__close_item: id=TRK-9" }]);
    expect(posts.at(-1)).toBe("Closed TRK-9.");
    expect(await confirmations.load(subject)).toMatchObject({ confirmationId, usedBy: confirmationClickEventId(confirmationId, "approve") });
    // A second press of Approve runs nothing (deviation from the brief: after Task 6's review, only
    // a click or a redelivery hears "no longer pending"; a later plain "yes" is an ordinary request).
    const postedAt = confirmationsPosted[0]!.confirmation.postedAt;
    await processSlackRequest(slackMessage(confirmationClickEventId(confirmationId, "approve", postedAt), "yes", { receivedAt: new Date(start + 90_000).toISOString() }), dependencies, { finalAttempt: false });
    expect(posts.at(-1)).toBe("That confirmation is no longer pending, so nothing was run.");
    expect(turns).toHaveLength(2);
    await processSlackRequest(slackMessage("EvGATE000003", "yes", { receivedAt: new Date(start + 100_000).toISOString() }), dependencies, { finalAttempt: false });
    expect(turns).toHaveLength(3);
    expect(turns[2]!.gate!.approvals).toEqual([]);
  });

  it("keeps the confirmation pending when the turn cannot start, and runs it on the next yes (C5)", async () => {
    let state: "READY" | "UNHEALTHY" = "READY";
    const { posts, turns, dependencies, advance, confirmations, confirmationsPosted } = harness(closeTurn, () => state);
    await processSlackRequest(slackMessage("EvGATE000011", "close TRK-9"), dependencies, { finalAttempt: false });
    const { confirmationId } = confirmationsPosted[0]!.confirmation;
    state = "UNHEALTHY";
    advance(60_000);
    await processSlackRequest(slackMessage("EvGATE000012", "yes", { receivedAt: new Date(start + 60_000).toISOString() }), dependencies, { finalAttempt: false });
    expect(posts.at(-1)).toBe("This thread's workspace is not available right now (UNHEALTHY). Mention me again later to retry.");
    expect(await confirmations.load(subject)).not.toHaveProperty("retiredAt");
    state = "READY";
    await processSlackRequest(slackMessage("EvGATE000013", "yes", { receivedAt: new Date(start + 70_000).toISOString() }), dependencies, { finalAttempt: false });
    expect(turns).toHaveLength(2);
    expect(posts.at(-1)).toBe("Closed TRK-9.");
    expect(await confirmations.load(subject)).toMatchObject({ confirmationId, usedBy: "EvGATE000013" });
  });

  it("runs nothing and prepares no workspace for a yes from a different member", async () => {
    const { posts, turns, ensureWorkspace, finish, dependencies, confirmations } = harness(async () => "unused");
    await confirmations.save(subject, {
      confirmationId: "44444444-4444-5444-8444-444444444444", requesterId: requester, postedAt: new Date(start - 1_000).toISOString(),
      expiresAt: new Date(start + CONFIRMATION_TTL_MS).toISOString(), calls: [{ tool: "tracker__close_item", argumentsHash: "a".repeat(64), summary: "close", kind: "destructive" }],
    });
    await processSlackRequest(slackMessage("EvGATE000021", "yes", { userId: "U0456789012" }), dependencies, { finalAttempt: false });
    expect(turns).toEqual([]);
    expect(ensureWorkspace).not.toHaveBeenCalled();
    expect(posts).toEqual([`Only <@${requester}> can confirm what they asked for. Nothing was run.`]);
    expect(finish).toHaveBeenCalledOnce();
  });

  it("says so, and still posts the reply, when the confirmation cannot be saved", async () => {
    const { posts, dependencies, db } = harness(async (input) => {
      input.gate!.asks.push({ toolCallId: "c1", tool: "tracker__close_item", argumentsHash: "a".repeat(64), summary: "close", kind: "destructive" });
      return "Waiting for your confirmation.";
    });
    const send = db.send;
    db.send = async (command) => {
      if (command.constructor.name === "PutCommand") throw Object.assign(new Error("throttled"), { name: "ProvisionedThroughputExceededException" });
      return send(command);
    };
    await processSlackRequest(slackMessage("EvGATE000031", "close TRK-9"), dependencies, { finalAttempt: false });
    expect(posts.slice(-2)).toEqual(["I couldn't save the confirmation request, so nothing it would list will run. Ask me again.", "Waiting for your confirmation."]);
  });

  it("says so when the confirmation cannot be posted, and leaves it unanswerable", async () => {
    const { posts, dependencies, confirmations, logs } = harness(closeTurn);
    dependencies.postConfirmation = async () => { throw new Error("Slack chat.postMessage failed: invalid_blocks"); };
    await processSlackRequest(slackMessage("EvGATE000032", "close TRK-9"), dependencies, { finalAttempt: false });
    expect(posts.slice(-2)).toEqual(["I couldn't save the confirmation request, so nothing it would list will run. Ask me again.", "I asked you to confirm closing TRK-9."]);
    expect(await confirmations.load(subject)).toMatchObject({ usedBy: UNPOSTED_MARK });
    expect(logs.map((entry) => entry.event)).toContain("gate.confirmation_failed");
  });

  it("tells the member and runs nothing when the confirmation was used between the check and the claim", async () => {
    const { posts, turns, dependencies, advance, confirmations, confirmationsPosted, finish } = harness(closeTurn);
    await processSlackRequest(slackMessage("EvGATE000041", "close TRK-9"), dependencies, { finalAttempt: false });
    const { confirmationId } = confirmationsPosted[0]!.confirmation;
    const claim = confirmations.claim.bind(confirmations);
    // Another event (a button press) claims it while this "yes" is still preparing its turn.
    confirmations.claim = async (claimSubject, id, eventId) => {
      await claim(claimSubject, id, "EvGATEOTHER01");
      return claim(claimSubject, id, eventId);
    };
    advance(60_000);
    finish.mockClear();
    await processSlackRequest(slackMessage("EvGATE000042", "yes", { receivedAt: new Date(start + 60_000).toISOString() }), dependencies, { finalAttempt: false });
    expect(turns).toHaveLength(1);
    expect(posts.at(-1)).toBe("That confirmation was already used, so nothing was run. Ask me again if you still want it.");
    expect(await confirmations.load(subject)).toMatchObject({ confirmationId, usedBy: "EvGATEOTHER01" });
    expect(finish).toHaveBeenCalledOnce();
  });

  it("tells the member and runs nothing when the confirmation expired between the check and the claim", async () => {
    const { posts, turns, dependencies, advance, confirmations } = harness(closeTurn);
    await processSlackRequest(slackMessage("EvGATE000051", "close TRK-9"), dependencies, { finalAttempt: false });
    const claim = confirmations.claim.bind(confirmations);
    advance(CONFIRMATION_TTL_MS - 1_000);
    confirmations.claim = async (...args) => {
      advance(2_000);
      return claim(...args);
    };
    await processSlackRequest(slackMessage("EvGATE000052", "yes", { receivedAt: new Date(start + CONFIRMATION_TTL_MS - 1_000).toISOString() }), dependencies, { finalAttempt: false });
    expect(turns).toHaveLength(1);
    expect(posts.at(-1)).toBe("That confirmation request expired after 24 hours, so nothing was run. Ask me again if you still want it.");
  });
});

describe("the reply of a turn that posted a confirmation", () => {
  const save = { tool: "tracker__save_item", input: { id: "TRK-5", title: "Refund" } };
  const ask = (input: TurnInput) => input.gate!.asks.push({ toolCallId: "c2", tool: save.tool, argumentsHash: argumentsHash(save.tool, save.input), summary: "tracker__save_item: id=TRK-5", kind: "admin" });

  it("posts only the confirmation when the asked call was the turn's only call", async () => {
    const { posts, confirmationsPosted, dependencies } = harness(async (input) => {
      ask(input);
      return "I have asked <@U0123456789> in the Slack thread to confirm saving TRK-5. Please wait for their confirmation.";
    });
    await processSlackRequest(slackMessage("EvQUIET00001", "rename TRK-5 to Refund"), dependencies, { finalAttempt: false, queuedBehind: 0 });
    expect(confirmationsPosted).toHaveLength(1);
    expect(posts).toEqual([]);
  });

  it("posts the confirmation and the model's reply when another call in the turn ran", async () => {
    const { posts, confirmationsPosted, dependencies } = harness(async (input) => {
      input.gate!.ran += 1;
      ask(input);
      return "TRK-5 is open and assigned to Priya.";
    });
    await processSlackRequest(slackMessage("EvQUIET00002", "check TRK-5 and rename it"), dependencies, { finalAttempt: false, queuedBehind: 0 });
    expect(confirmationsPosted).toHaveLength(1);
    expect(posts).toEqual(["TRK-5 is open and assigned to Priya."]);
  });

  it("posts only the confirmation when another call ran but the model had nothing to say", async () => {
    const { posts, confirmationsPosted, dependencies } = harness(async (input) => {
      input.gate!.ran += 1;
      ask(input);
      return "  ";
    });
    await processSlackRequest(slackMessage("EvQUIET00003", "rename TRK-5"), dependencies, { finalAttempt: false, queuedBehind: 0 });
    expect(confirmationsPosted).toHaveLength(1);
    expect(posts).toEqual([]);
  });

  for (const source of ["rule", "gate_error"] as const) {
    it(`posts the model's reply when the turn also had a ${source === "rule" ? "deny" : "gate failure"}, so the member hears why`, async () => {
      const { posts, confirmationsPosted, dependencies } = harness(async (input) => {
        input.gate!.decisions.push({ toolCallId: "c1", tool: "tracker__delete_item", actionClass: "change", outcome: "deny", source, reason: "blocked", argumentsHash: "d".repeat(64) });
        ask(input);
        return source === "rule" ? "An administrator's rule blocks deleting TRK-2." : "AgentX could not check deleting TRK-2.";
      });
      await processSlackRequest(slackMessage(`EvQUIET0001${source === "rule" ? "1" : "2"}`, "delete TRK-2 and rename TRK-5"), dependencies, { finalAttempt: false, queuedBehind: 0 });
      expect(confirmationsPosted).toHaveLength(1);
      expect(posts).toEqual([source === "rule" ? "An administrator's rule blocks deleting TRK-2." : "AgentX could not check deleting TRK-2."]);
    });
  }

  it("posts the model's reply when a confirmed call ran and failed, and the turn asked again", async () => {
    const { posts, confirmationsPosted, dependencies } = harness(async (input) => {
      // The approved call ran and returned an error; the model's retry with other arguments asked.
      input.gate!.ran += 1;
      ask(input);
      return "Renaming TRK-5 failed: the tracker is unavailable.";
    });
    await processSlackRequest(slackMessage("EvQUIET00013", "rename TRK-5"), dependencies, { finalAttempt: false, queuedBehind: 0 });
    expect(confirmationsPosted).toHaveLength(1);
    expect(posts).toEqual(["Renaming TRK-5 failed: the tracker is unavailable."]);
  });

  it("posts the reply unchanged when nothing asked, even when no call ran", async () => {
    const { posts, confirmationsPosted, dependencies } = harness(async () => "There are no open items.");
    await processSlackRequest(slackMessage("EvQUIET00004", "any open items?"), dependencies, { finalAttempt: false, queuedBehind: 0 });
    expect(confirmationsPosted).toEqual([]);
    expect(posts).toEqual(["There are no open items."]);
  });

  it("keeps the start notice and posts the failure when the turn failed after asking", async () => {
    const { posts, confirmationsPosted, dependencies } = harness(async (input) => {
      ask(input);
      throw new Error("model unavailable");
    });
    await processSlackRequest(slackMessage("EvQUIET00005", "rename TRK-5"), dependencies, { finalAttempt: false, queuedBehind: 2 });
    expect(confirmationsPosted).toHaveLength(1);
    expect(posts[0]).toBe("Working on it now. I'll post the result in this thread when it's done.");
    expect(posts).toHaveLength(2);
    expect(posts[1]).toContain("AgentX could not complete the request");
  });
});

describe("the compute signal the processor gives the gate (I1/D5)", () => {
  it("says compute is prepared for a READY workspace, and passes a lazy worker without that signal for an UNPREPARED one", async () => {
    let state: "READY" | "UNPREPARED" = "READY";
    const { turns, dependencies } = harness(async () => "Done.", () => state as "READY");
    await processSlackRequest(slackMessage("EvGATE000301", "run the tests"), dependencies, { finalAttempt: false });
    expect(turns[0]!.computePrepared).toBe(true);
    expect(turns[0]!.worker).toBeUndefined();
    state = "UNPREPARED";
    await processSlackRequest(slackMessage("EvGATE000302", "run the tests"), dependencies, { finalAttempt: false });
    expect(turns[1]!.computePrepared).toBeUndefined();
    expect(turns[1]!.worker?.prepared()).toBe(false);
  });
});

describe("a redelivered request that asked for a confirmation", () => {
  it("tells a redelivered yes that its earlier attempt already used the confirmation, and runs nothing again", async () => {
    const connectorCall = vi.fn();
    const { posts, dependencies, advance, confirmationsPosted, logs } = harness(async (input) => {
      if (input.gate!.approvals.length > 0) connectorCall();
      return closeTurn(input);
    });
    await processSlackRequest(slackMessage("EvGATE000101", "close TRK-9"), dependencies, { finalAttempt: false });
    expect(confirmationsPosted).toHaveLength(1);
    const post = dependencies.post;
    dependencies.post = async (thread, text) => {
      if (text === "Closed TRK-9.") throw new Error("Slack chat.postMessage failed: HTTP 500");
      return post(thread, text);
    };
    advance(60_000);
    const yes = slackMessage("EvGATE000102", "yes", { receivedAt: new Date(start + 60_000).toISOString() });
    await expect(processSlackRequest(yes, dependencies, { finalAttempt: false })).rejects.toThrow("HTTP 500");
    expect(connectorCall).toHaveBeenCalledOnce();
    dependencies.post = post;
    advance(60_000);
    await processSlackRequest(yes, dependencies, { finalAttempt: false, redelivered: true });
    expect(connectorCall).toHaveBeenCalledOnce();
    expect(posts.at(-1)).toBe("An earlier attempt of this request already used that confirmation, so I didn't run anything again. It may already have run; ask me to check, or ask again.");
    expect(logs).toContainEqual({ event: "gate.confirmation_refused", fields: { eventId: "EvGATE000102", reason: "already_used_by_this_request" } });
  });

  for (const via of ["typed yes", "click"] as const) {
    it(`I2: tells a redelivered ${via} whose turn also posted a new confirmation that its earlier attempt already used the confirmation`, async () => {
      const connectorCall = vi.fn();
      const reopen = { tool: "tracker__reopen_item", input: { id: "TRK-9" } };
      const { posts, turns, dependencies, advance, confirmationsPosted, confirmations, logs } = harness(async (input) => {
        if (input.gate!.approvals.length === 0) return closeTurn(input);
        connectorCall();
        input.gate!.ran += 1;
        // The confirmed call ran, and the model made another call that asks: settle posts a new confirmation.
        input.gate!.asks.push({ toolCallId: "c2", tool: reopen.tool, argumentsHash: argumentsHash(reopen.tool, reopen.input), summary: "tracker__reopen_item: id=TRK-9", kind: "destructive" });
        return "Closed TRK-9.";
      });
      await processSlackRequest(slackMessage("EvGATE000131", "close TRK-9"), dependencies, { finalAttempt: false });
      const { confirmationId } = confirmationsPosted[0]!.confirmation;
      const post = dependencies.post;
      dependencies.post = async (thread, text) => {
        if (text === "Closed TRK-9.") throw new Error("Slack chat.postMessage failed: HTTP 500");
        return post(thread, text);
      };
      advance(60_000);
      const eventId = via === "click" ? confirmationClickEventId(confirmationId, "approve") : "EvGATE000132";
      const approval = slackMessage(eventId, "yes", { receivedAt: new Date(start + 60_000).toISOString() });
      await expect(processSlackRequest(approval, dependencies, { finalAttempt: false })).rejects.toThrow("HTTP 500");
      expect(connectorCall).toHaveBeenCalledOnce();
      expect(confirmationsPosted).toHaveLength(2);
      expect(await confirmations.load(subject)).not.toMatchObject({ confirmationId });
      dependencies.post = post;
      advance(60_000);
      await processSlackRequest(approval, dependencies, { finalAttempt: false, redelivered: true });
      expect(connectorCall).toHaveBeenCalledOnce();
      expect(turns).toHaveLength(2);
      expect(posts.at(-1)).toBe("An earlier attempt of this request already used that confirmation, so I didn't run anything again. It may already have run; ask me to check, or ask again.");
      expect(logs).toContainEqual({ event: "gate.confirmation_refused", fields: { eventId, reason: "already_used_by_this_request" } });
      // The new confirmation stays pending and answerable.
      expect(await confirmations.load(subject)).not.toHaveProperty("retiredAt");
    });
  }

  it("says which calls the still-pending confirmation lists when the redelivered turn asked for different ones", async () => {
    let target = "TRK-9";
    const { posts, dependencies, advance, confirmationsPosted } = harness(async (input) => {
      const args = { id: target };
      input.gate!.asks.push({ toolCallId: "c1", tool: close.tool, argumentsHash: argumentsHash(close.tool, args), summary: `tracker__close_item: id=${target}`, kind: "destructive" });
      return "Waiting.";
    });
    const original = slackMessage("EvGATE000111", "close the old one");
    await processSlackRequest(original, dependencies, { finalAttempt: false });
    target = "<!channel>";
    advance(30_000);
    await processSlackRequest(original, dependencies, { finalAttempt: false, redelivered: true });
    expect(confirmationsPosted).toHaveLength(1);
    expect(posts).toContain("I didn't ask again: the pending confirmation still lists tracker__close_item: id=TRK-9. Ask me again for anything else.");
    expect(posts.join("\n")).not.toContain("<!channel>");
  });

  it("says nothing extra when the redelivered turn asked for the same calls", async () => {
    const { posts, dependencies, advance } = harness(closeTurn);
    const original = slackMessage("EvGATE000121", "close TRK-9");
    await processSlackRequest(original, dependencies, { finalAttempt: false });
    advance(30_000);
    await processSlackRequest(original, dependencies, { finalAttempt: false, redelivered: true });
    expect(posts.filter((text) => text.startsWith("I didn't ask again"))).toEqual([]);
  });

  it("does not reopen or re-post a confirmation that was already approved, and says why it did not ask again", async () => {
    const { posts, turns, dependencies, advance, confirmations, confirmationsPosted } = harness(closeTurn);
    const original = slackMessage("EvGATE000061", "close TRK-9");
    await processSlackRequest(original, dependencies, { finalAttempt: false });
    const { confirmationId } = confirmationsPosted[0]!.confirmation;
    const approve = confirmationClickEventId(confirmationId, "approve");
    advance(60_000);
    await processSlackRequest(slackMessage(approve, "yes", { receivedAt: new Date(start + 60_000).toISOString() }), dependencies, { finalAttempt: false });
    expect(posts.at(-1)).toBe("Closed TRK-9.");
    advance(60_000);
    // SQS redelivers the original request (its first attempt threw after settling).
    await processSlackRequest(original, dependencies, { finalAttempt: false, redelivered: true });
    expect(turns).toHaveLength(3);
    expect(confirmationsPosted).toHaveLength(1);
    expect(await confirmations.load(subject)).toMatchObject({ confirmationId, usedBy: approve });
    expect(posts).toContain("This request was retried after an interruption, and I had already asked you to confirm it and had my answer, so I didn't ask again. Ask me again if you still want it.");
    // The approval cannot be used a second time: a redelivery of the click that claimed it runs nothing.
    await processSlackRequest(slackMessage(approve, "yes", { receivedAt: new Date(start + 180_000).toISOString() }), dependencies, { finalAttempt: false, redelivered: true });
    expect(turns).toHaveLength(3);
    expect(posts.at(-1)).toBe("An earlier attempt of this request already used that confirmation, so I didn't run anything again. It may already have run; ask me to check, or ask again.");
  });

  it("does not reopen a confirmation that was cancelled", async () => {
    const { posts, dependencies, advance, confirmations, confirmationsPosted } = harness(closeTurn);
    const original = slackMessage("EvGATE000071", "close TRK-9");
    await processSlackRequest(original, dependencies, { finalAttempt: false });
    const { confirmationId } = confirmationsPosted[0]!.confirmation;
    advance(60_000);
    await processSlackRequest(slackMessage("EvGATE000072", "cancel", { receivedAt: new Date(start + 60_000).toISOString() }), dependencies, { finalAttempt: false });
    expect(posts.at(-1)).toBe("Cancelled. Nothing was run.");
    await processSlackRequest(original, dependencies, { finalAttempt: false, redelivered: true });
    expect(confirmationsPosted).toHaveLength(1);
    expect(await confirmations.load(subject)).toMatchObject({ confirmationId, usedBy: "EvGATE000072" });
  });

  it("leaves a still-pending confirmation pending, posts it once, and it can still be approved", async () => {
    const { posts, turns, dependencies, advance, confirmations, confirmationsPosted } = harness(closeTurn);
    const original = slackMessage("EvGATE000081", "close TRK-9");
    await processSlackRequest(original, dependencies, { finalAttempt: false });
    const { confirmationId } = confirmationsPosted[0]!.confirmation;
    advance(30_000);
    await processSlackRequest(original, dependencies, { finalAttempt: false, redelivered: true });
    expect(confirmationsPosted).toHaveLength(1);
    const stored = await confirmations.load(subject);
    expect(stored).toMatchObject({ confirmationId });
    expect(stored).not.toHaveProperty("retiredAt");
    advance(30_000);
    await processSlackRequest(slackMessage(confirmationClickEventId(confirmationId, "approve"), "yes", { receivedAt: new Date(start + 60_000).toISOString() }), dependencies, { finalAttempt: false });
    expect(turns).toHaveLength(3);
    expect(posts.at(-1)).toBe("Closed TRK-9.");
  });

  it("posts the confirmation on redelivery when the first attempt could not post it", async () => {
    const { dependencies, advance, confirmations, confirmationsPosted } = harness(closeTurn);
    const original = slackMessage("EvGATE000091", "close TRK-9");
    const postConfirmation = dependencies.postConfirmation!;
    dependencies.postConfirmation = async () => { throw new Error("Slack chat.postMessage failed: HTTP 500"); };
    await processSlackRequest(original, dependencies, { finalAttempt: false });
    expect(await confirmations.load(subject)).toMatchObject({ usedBy: UNPOSTED_MARK });
    dependencies.postConfirmation = postConfirmation;
    advance(30_000);
    await processSlackRequest(original, dependencies, { finalAttempt: false, redelivered: true });
    expect(confirmationsPosted).toHaveLength(1);
    expect(await confirmations.load(subject)).not.toHaveProperty("retiredAt");
  });
});

describe("the hosted Slack runtime", () => {
  it("always runs the action gate, asking on behalf of the message's author when no gate session is given", async () => {
    const { modelRuntime, faux } = await fauxModelRuntime();
    faux.setResponses([fauxAssistantMessage([fauxToolCall("tracker__close_item", { id: "TRK-9" })], { stopReason: "toolUse" }), fauxAssistantMessage("Waiting.")]);
    const catalog: ConnectorCatalog = { connector: "tracker", skipped: [], tools: [{ name: "tracker__close_item", upstreamName: "close_item", description: "Close.", access: "write",
      itemArguments: ["id"], scopes: [{ alias: "payments", schemaHash: "c".repeat(64) }], inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } }] };
    const callConnectorTool = vi.fn();
    const api = { discoverConnectorTools: vi.fn(async () => catalog), callConnectorTool, submitTask: vi.fn(), taskStatus: vi.fn(), taskResult: vi.fn(), followUp: vi.fn(),
      createPullRequest: vi.fn(), managePullRequest: vi.fn(), pullRequestResult: vi.fn() } satisfies OrchestrationApi;
    const decisions: unknown[] = [];
    const runtime = await createHostedSlackRuntime({
      message: slackMessage("EvGATE000041", "close TRK-9"), subject, workspaceId, conversationId: "33333333-3333-4333-8333-333333333333",
      orchestratorInstructions: "Delegate.", connectors: [{ name: "tracker", type: "tracker", label: "Tracker issues", scopes: ["payments"], connected: true }],
      requestId: () => "55555555-5555-4555-8555-555555555555",
    }, { stateDirectory: await createFixtureDirectory("agentx-hosted-gate-"), api, model: FAUX_MODEL, modelRuntime, onGateDecision: (decision) => decisions.push(decision) });
    try {
      await runOrchestratorTurn(runtime, "close TRK-9");
    } finally { await runtime.dispose(); }
    expect(callConnectorTool).not.toHaveBeenCalled();
    expect(decisions).toMatchObject([{ tool: "tracker__close_item", outcome: "ask", kind: "destructive" }]);
  });

  /** One hosted turn whose model submits coding work and follows it up; returns the gate's decisions and the classifier's calls. */
  async function codingTurn(extra: Partial<TurnInput>) {
    const { modelRuntime, faux } = await fauxModelRuntime();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("agentx_submit_task", { prompt: "now run the tests" }), fauxToolCall("agentx_follow_up", { prompt: "and fix any failure" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Started."),
    ]);
    const api = { discoverConnectorTools: vi.fn(), callConnectorTool: vi.fn(), submitTask: vi.fn(async () => { throw new Error("no worker in this test"); }), taskStatus: vi.fn(), taskResult: vi.fn(),
      followUp: vi.fn(async () => { throw new Error("no worker in this test"); }), createPullRequest: vi.fn(), managePullRequest: vi.fn(), pullRequestResult: vi.fn() } satisfies OrchestrationApi;
    const classifier = vi.fn(async () => ({ decision: "ask" as const, reason: "unsure" }));
    const decisions: Array<{ tool: string; outcome: string; actionClass: string; source: string }> = [];
    const runtime = await createHostedSlackRuntime({
      message: slackMessage("EvGATE000051", "now run the tests"), subject, workspaceId, conversationId: "33333333-3333-4333-8333-333333333333",
      orchestratorInstructions: "Delegate.", requestId: () => "55555555-5555-4555-8555-555555555555", ...extra,
    }, { stateDirectory: await createFixtureDirectory("agentx-hosted-coding-"), api, model: FAUX_MODEL, modelRuntime, classifier,
      onGateDecision: (decision) => decisions.push(decision) });
    try {
      await runOrchestratorTurn(runtime, "now run the tests");
    } finally { await runtime.dispose(); }
    return { decisions, classifier, api };
  }

  it("M4: passes the configured classifier timeout to the gate, so a 12 second setting is not cut at 8 seconds", async () => {
    const { modelRuntime, faux } = await fauxModelRuntime();
    faux.setResponses([fauxAssistantMessage([fauxToolCall("tracker__save_item", { id: "TRK-5", priority: 2 })], { stopReason: "toolUse" }), fauxAssistantMessage("Waiting.")]);
    const catalog: ConnectorCatalog = { connector: "tracker", skipped: [], tools: [{ name: "tracker__save_item", upstreamName: "save_item", description: "Save.", access: "write",
      itemArguments: ["id"], scopes: [{ alias: "payments", schemaHash: "c".repeat(64) }], inputSchema: { type: "object", properties: { id: { type: "string" }, priority: { type: "number" } } } }] };
    const api = { discoverConnectorTools: vi.fn(async () => catalog), callConnectorTool: vi.fn(), submitTask: vi.fn(), taskStatus: vi.fn(), taskResult: vi.fn(), followUp: vi.fn(),
      createPullRequest: vi.fn(), managePullRequest: vi.fn(), pullRequestResult: vi.fn() } satisfies OrchestrationApi;
    let asked!: () => void;
    const classifierStarted = new Promise<void>((resolve) => { asked = resolve; });
    const decisions: Array<{ reason: string; source: string }> = [];
    const runtime = await createHostedSlackRuntime({
      message: slackMessage("EvGATE000061", "set TRK-5 to high"), subject, workspaceId, conversationId: "33333333-3333-4333-8333-333333333333",
      orchestratorInstructions: "Delegate.", connectors: [{ name: "tracker", type: "tracker", label: "Tracker issues", scopes: ["payments"], connected: true }],
      requestId: () => "55555555-5555-4555-8555-555555555555",
    }, { stateDirectory: await createFixtureDirectory("agentx-hosted-timeout-"), api, model: FAUX_MODEL, modelRuntime, classifierTimeoutMs: 12_000,
      classifier: () => { asked(); return new Promise(() => undefined); }, onGateDecision: (decision) => decisions.push(decision) });
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const turn = runOrchestratorTurn(runtime, "set TRK-5 to high");
      let started = false;
      void classifierStarted.then(() => { started = true; });
      while (!started) await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(8_000);
      expect(decisions).toEqual([]);
      await vi.advanceTimersByTimeAsync(4_000);
      vi.useRealTimers();
      await turn;
    } finally { vi.useRealTimers(); await runtime.dispose(); }
    expect(decisions).toMatchObject([{ source: "classifier_unavailable", reason: "the classifier could not decide: it did not answer within 12000 ms" }]);
  });

  it("I1/D5: runs coding work in a thread whose compute is prepared without a classifier call", async () => {
    const { decisions, classifier, api } = await codingTurn({ computePrepared: true });
    expect(classifier).not.toHaveBeenCalled();
    expect(decisions).toMatchObject([
      { tool: "agentx_submit_task", outcome: "allow", actionClass: "read" },
      { tool: "agentx_follow_up", outcome: "allow", actionClass: "read" },
    ]);
    expect(api.submitTask).toHaveBeenCalledOnce();
    expect(api.followUp).toHaveBeenCalledOnce();
  });

  it("I1/D5: gates starting coding work once, as a write, in a thread whose compute is not prepared yet", async () => {
    const { decisions, classifier, api } = await codingTurn({ worker: { prepared: () => false, ensureReady: async () => undefined } });
    expect(classifier).toHaveBeenCalledOnce();
    expect(decisions).toMatchObject([
      { tool: "agentx_submit_task", outcome: "ask", actionClass: "change", source: "classifier" },
      { tool: "agentx_follow_up", outcome: "allow", actionClass: "read" },
    ]);
    expect(api.submitTask).not.toHaveBeenCalled();
  });

  it("I1/M3: fails closed as a change when the host gives no compute signal", async () => {
    const { decisions, classifier } = await codingTurn({});
    expect(classifier).toHaveBeenCalledTimes(2);
    expect(decisions).toMatchObject([
      { tool: "agentx_submit_task", outcome: "ask", actionClass: "change" },
      { tool: "agentx_follow_up", outcome: "ask", actionClass: "change" },
    ]);
  });

  it("asks the control plane for the action gate's fields with a header an older control plane ignores", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ catalog: { connector: "tracker", tools: [], skipped: [] } }));
    await new ControlPlaneApi("https://agentx.example.test", "slack-service", workspaceId, fetch).discoverConnectorTools({ workspaceId, connector: "tracker" });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`https://agentx.example.test/v1/workspaces/${workspaceId}/connectors/tracker/tools`);
    expect(new Headers(init?.headers).get("x-agentx-include")).toBe("gate");
  });
});

describe("the hosted classifier at startup", () => {
  const model = { provider: "amazon-bedrock", modelId: "amazon.nova-lite-v1:0" };
  const input: ClassifierInput = { memberMessages: ["close TRK-9"], call: { tool: "tracker__close_item", arguments: { id: "TRK-9" }, summary: "close" } };

  it("returns the configured model's classifier", async () => {
    const classifier = vi.fn(async () => ({ decision: "allow" as const, reason: "asked" }));
    const create = vi.fn(async () => classifier);
    const logs: string[] = [];
    const hosted = await createHostedClassifier({ model, timeoutMs: 8_000, log: (event) => logs.push(event), create });
    expect(create).toHaveBeenCalledWith({ model, timeoutMs: 8_000, failOnUnknownModel: true });
    expect(hosted.available).toBe(true);
    expect(hosted.classifier).toBe(classifier);
    expect(logs).toEqual([]);
  });

  it("falls back to a classifier that always fails, so every change asks, and logs it without crashing", async () => {
    const logs: Array<{ event: string; fields: Readonly<Record<string, string | number | boolean>> }> = [];
    const hosted = await createHostedClassifier({
      model, timeoutMs: 8_000, log: (event, fields) => logs.push({ event, fields }),
      create: async () => { throw Object.assign(new Error("secret-bearing detail"), { name: "CredentialsProviderError" }); },
    });
    expect(hosted.available).toBe(false);
    // The runtime module is built, so its ClassifierError is the built class: compare by name.
    await expect(hosted.classifier(input)).rejects.toMatchObject({ name: new ClassifierError("x").name, message: "the classifier is unavailable" });
    expect(logs).toEqual([{ event: "gate.classifier_unavailable", fields: { provider: "amazon-bedrock", model: "amazon.nova-lite-v1:0", errorName: "CredentialsProviderError" } }]);
  });

  it("treats a model the runtime does not know as unavailable at startup", async () => {
    const { modelRuntime } = await fauxModelRuntime();
    const logs: Array<{ event: string; fields: Readonly<Record<string, string | number | boolean>> }> = [];
    const hosted = await createHostedClassifier({ model: { provider: FAUX_MODEL.provider, modelId: "no-such-model" }, timeoutMs: 8_000, modelRuntime, log: (event, fields) => logs.push({ event, fields }) });
    expect(hosted.available).toBe(false);
    await expect(hosted.classifier(input)).rejects.toMatchObject({ message: "the classifier is unavailable" });
    expect(logs).toEqual([{ event: "gate.classifier_unavailable", fields: { provider: FAUX_MODEL.provider, model: "no-such-model", errorName: "ClassifierError" } }]);
  });

  it("is available for a model the runtime knows", async () => {
    const { modelRuntime } = await fauxModelRuntime();
    const logs: string[] = [];
    const hosted = await createHostedClassifier({ model: FAUX_MODEL, timeoutMs: 8_000, modelRuntime, log: (event) => logs.push(event) });
    expect(hosted.available).toBe(true);
    expect(logs).toEqual([]);
  });

  it("uses an 8 second timeout unless the setting is a positive whole number of milliseconds", () => {
    expect(classifierTimeoutMs(undefined)).toBe(8_000);
    for (const value of ["", "abc", "NaN", "0", "-5", "1.5", "12abc", " 12"]) expect(classifierTimeoutMs(value)).toBe(8_000);
    expect(classifierTimeoutMs("12000")).toBe(12_000);
    // At most 60 seconds: Node truncates a timer above 2^31-1 ms to 1 ms, which would ask at once.
    expect(classifierTimeoutMs("60000")).toBe(60_000);
    for (const value of ["60001", "2147483648", "3000000000"]) expect(classifierTimeoutMs(value), value).toBe(8_000);
  });
});

describe("the gate.decision log line (M1)", () => {
  const base = { toolCallId: "c1", tool: "tracker__save_item", connector: "tracker", actionClass: "change" as const, argumentsHash: "b".repeat(64) };

  it("never logs the classifier's own reason, which can echo argument values", () => {
    const fields = gateDecisionLogFields("EvGATE000401", { ...base, outcome: "ask", source: "classifier", kind: "classifier", reason: "renames TRK-5 to Secret launch plan" });
    expect(fields).toEqual({ eventId: "EvGATE000401", tool: "tracker__save_item", connector: "tracker", actionClass: "change", outcome: "ask", source: "classifier", kind: "classifier",
      argumentsHash: "b".repeat(16) });
    expect(JSON.stringify(fields)).not.toContain("Secret launch plan");
  });

  it("logs AgentX's and administrators' reasons redacted and capped", () => {
    const fields = gateDecisionLogFields("EvGATE000402", { ...base, outcome: "deny", source: "rule", kind: "admin", rule: 1, reason: `token xoxb-123456789012-abcdefghijkl ${"x".repeat(400)}` });
    expect(String(fields.reason)).not.toContain("xoxb-123456789012");
    expect(String(fields.reason).length).toBeLessThanOrEqual(200);
    expect(fields).toMatchObject({ source: "rule", rule: 1, kind: "admin" });
  });
});
