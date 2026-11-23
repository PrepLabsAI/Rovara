import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { agentSessionKey, change } from "@agentx/contracts";
import { closeRecoveryHarness as fixture, textField } from "../support/close-recovery-harness.js";
import { flushBeforeClose } from "../../packages/broker/src/core/task-flow/money-stop.js";
import { readWorkspace } from "../../packages/broker/src/core/task-flow/stage-machine.js";
import { CAPABILITY_HEADER, createCallbackHandler } from "../../packages/broker/src/services/callbacks.js";
import { CallbackCapabilities } from "../../packages/broker/src/callbacks.js";
import { operationKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { acceptedCloseForRun } from "../../packages/broker/src/core/task-flow/close-recovery-state.js";
import { readOperation } from "../../packages/broker/src/core/task-flow/results.js";
import { readWikiBuildPointer, wikiBuildPointerItem } from "../../packages/broker/src/core/wiki-build/run.js";

// Missing consumer, early ack, any unreceipted effect, recomputed money or workflow output must fail these cases.
describe("accepted close recovery", () => {
  it.each(["wiki_build", "setup_agent"] as const)("leaves a closing %s task unchanged when another already-ended run replays", async (purpose) => {
    const w = await fixture();
    // Reproduce a crash after the terminal run was persisted, before its task follow-up.
    // The retained live run belongs to Close; this older terminal run does not.
    await w.h.store.update({ key: w.tk, ops: [change.set("purpose", purpose)] });
    const replayId = randomUUID(), replayKey = operationKey(w.h.deps.companyId, w.task.workspaceId, replayId);
    await w.h.store.put({ item: {
      ...(await w.h.store.get(w.runKey))!, ...replayKey, id: replayId, status: "SUCCEEDED",
      createdAt: new Date(w.h.clock.now - 1_000).toISOString(),
      workflowMode: purpose === "wiki_build" ? "WIKI_BUILD" : "SETUP_AGENT",
    } });
    if (purpose === "wiki_build") {
      expect((await w.h.store.transact([wikiBuildPointerItem({
        orgId: w.h.deps.companyId, project: w.task.project, taskId: w.task.taskId,
        requestId: randomUUID(), requestedBy: w.h.owner.principal.personId, startedAt: w.task.createdAt,
        limits: { pages: 1, budgetCents: 100, wallClockMin: 10, pageReserveCents: 10 },
        pins: [{ repo: "demo", commit: "a".repeat(40) }], plan: [], keptFromEarlier: [], doneIds: [],
        pagesWritten: 0, claimsKept: 0, claimsDropped: 0, spentCents: 0, spentEarlierCents: 0,
        payer: { kind: "project", project: w.task.project }, buildKind: "first",
      }, undefined)])).applied).toBe(true);
    }
    const wikiEnded = vi.fn(async () => {});
    w.h.deps.wikiBuildEnded = wikiEnded;
    w.h.deps.resumeAcceptedClose = async () => {};
    await w.h.flow.close(w.h.owner, w.task.taskId, w.input);
    const claim = (await w.accepted())!;
    expect(claim.closeAcceptance?.original.run?.id).toBe(w.run.id);
    expect(claim.closeAcceptance?.original.run?.id).not.toBe(replayId);
    const replay = (await readOperation(w.h.deps, w.task.workspaceId, replayId))!;
    expect(replay.status).toBe("SUCCEEDED");
    expect(await acceptedCloseForRun(w.h.deps, replay)).toBeUndefined();
    const snapshot = async () => Promise.all([
      w.h.store.get(w.tk), w.h.store.get(w.wk), w.h.store.get(replayKey),
      readWikiBuildPointer(w.h.store, w.h.deps.companyId, w.task.project), w.accepted(),
    ]);
    const before = await snapshot();
    expect(before[0]).toMatchObject({ purpose, closeOperationId: claim.id });
    expect(before[0]?.closedAt).toBeUndefined();
    expect(before[1]).toMatchObject({ status: "CLOSING", activeOperationId: claim.id });
    w.h.clock.advance(1);
    await expect(w.h.flow.recordResult({
      workspaceId: replay.workspaceId, operationId: replay.id, fence: replay.fence, status: "SUCCEEDED",
    })).resolves.toEqual({ duplicate: true });
    expect(await snapshot()).toEqual(before);
    expect(wikiEnded).not.toHaveBeenCalled();
    expect(w.destroyed.size).toBe(0);
    expect(w.terminated.size).toBe(0);
    expect(w.cleaned.size).toBe(0);
  });

  it("resumes after acceptance without another POST using the existing relay and consumer", async () => {
    const w = await fixture({ session: true });
    w.h.deps.resumeAcceptedClose = async () => { throw new Error("process lost after acceptance"); };
    await expect(w.h.flow.close(w.h.owner, w.task.taskId, w.input)).resolves.toMatchObject({ closing: true });
    w.restart(); await w.pump();
    expect(typeof (await w.h.store.get(w.tk))!.closedAt).toBe("string");
    expect(typeof (await w.h.store.get(w.tk))!.releasedAt).toBe("string");
    expect(await w.h.store.get(w.wk)).toMatchObject({ status: "CLOSED", activeOperationId: null });
    expect((await w.accepted())?.closeAcceptance?.phase).toBe("complete");
    expect(await w.h.store.get(agentSessionKey(w.h.deps.companyId, w.sessionId, "META"))).toMatchObject({ summary: { status: "cancelled" } });
    expect(typeof (await w.h.store.get(agentSessionKey(w.h.deps.companyId, w.sessionId, "META")))!.endedAt).toBe("string");
  });
  it("waits for a live run's usage inside a non-zero flush window and charges exactly the legacy close", async () => {
    const charge = async (guarded: boolean) => {
      const w = await fixture({ money: true, flushWaitMs: 15_000, deferUsage: true });
      const queue = await w.h.queues.queue("task-dispatch"), enqueue = queue.enqueue.bind(queue);
      let cancelled = false;
      queue.enqueue = async (message) => {
        const result = await enqueue(message);
        if ((message.body as { cancel?: string }).cancel !== undefined) cancelled = true;
        return result;
      };
      const reportUsage = async () => {
        expect(cancelled).toBe(true);
        await w.booking.bookOperationEvents(w.run, w.usage.map((e) => ({ ...e, payload: { ...e.payload, checkpoint: false } })));
        await w.h.store.update({ key: w.runKey, ops: [change.set("status", "CANCELLED")] });
      };
      if (guarded) {
        await w.h.flow.close(w.h.owner, w.task.taskId, w.input);
        // The POST itself must relay cancel and resume, without a stream or timed relay pass.
        expect(cancelled).toBe(true);
        expect((await queue.receive({ maxMessages: 10 })).some((m) => (m.body as { resumeClose?: boolean }).resumeClose)).toBe(true);
        expect((await w.accepted())?.closeAcceptance?.accounting).toBeUndefined();
        expect(await w.money()).toMatchObject({ micros: 0, hold: "open" });
        expect((await w.money()).estimated ?? 0).toBe(0);
        w.h.clock.advance(0.25); await reportUsage();
        await w.h.deps.resumeAcceptedClose!((await w.accepted())!);
        expect((await w.accepted())?.closeAcceptance?.accounting).toEqual({ mode: "flushed" });
        expect(w.destroyed.size).toBe(1);
      } else {
        w.h.deps.moneyStop!.sleep = async (ms) => { w.h.clock.advance(ms / 1000); await reportUsage(); };
        const workspace = (await readWorkspace(w.h.deps, w.task.workspaceId))!;
        await flushBeforeClose(w.h.deps, { ...workspace, activeOperationId: w.run.id });
        await w.h.deps.admission.release(textField((await w.h.store.get(w.tk))!, "admissionReservationId"));
      }
      const money = await w.money();
      expect(money).toMatchObject({ micros: 1_000_000, unpriced: 0, reserved: 0 });
      expect(money.estimated ?? 0).toBe(0);
      return money;
    };
    expect(await charge(true)).toEqual(await charge(false));
  });
  it("checks the broker claim after accounting and immediately before destruction", async () => {
    const w = await fixture(); w.h.deps.resumeAcceptedClose = async () => {};
    await w.h.flow.close(w.h.owner, w.task.taskId, w.input);
    const transact = w.h.store.transact.bind(w.h.store); let changed = false;
    w.h.store.transact = async (items) => {
      const result = await transact(items);
      if (!changed && result.applied && (await w.accepted())?.closeAcceptance?.receipts["account"] !== undefined) {
        changed = true;
        await w.h.store.update({ key: w.wk, ops: [change.set("fence", 999)] });
      }
      return result;
    };
    w.restart(); await w.pump();
    expect(changed).toBe(true);
    expect((await w.accepted())?.closeAcceptance?.receipts["account"]).toEqual(expect.any(String));
    expect((await w.accepted())?.closeAcceptance?.receipts["terminate"]).toBeUndefined();
    expect(w.destroyed.size).toBe(0); expect(w.terminated.size).toBe(0);
    expect((await w.h.store.get(w.tk))!.closedAt).toBeUndefined();
  });
  it("bounds held-close redrive by age and leaves one final delivery in the existing alarmed DLQ", async () => {
    const w = await fixture(); w.h.deps.resumeAcceptedClose = async () => {};
    await w.h.flow.close(w.h.owner, w.task.taskId, w.input);
    await w.h.flow.relayOnce();
    for (let i = 0; i < 5; i++) { await w.h.flow.dispatchOnce({ maxMessages: 10 }); w.h.clock.advance(31); }
    const queue = await w.h.queues.queue("task-dispatch");
    expect((await queue.listDeadLetters()).items).toHaveLength(1);
    w.h.clock.advance(24 * 3600); await w.h.flow.relayOnce();
    for (let i = 0; i < 5; i++) { await w.h.flow.dispatchOnce({ maxMessages: 10 }); w.h.clock.advance(31); }
    const op = (await w.accepted())!;
    const outbox = await w.h.store.get({ pk: `ORG#${w.h.deps.companyId}#OUTBOX#${op.id}`, sk: "OUTBOX" });
    expect(outbox).toMatchObject({ status: "DEAD" }); expect(outbox!.outboxState).toBeUndefined();
    const dead = (await queue.listDeadLetters()).items;
    expect(dead).toHaveLength(2); expect(dead[1]).toMatchObject({ reason: "accepted_close_pending" });
    for (let i = 0; i < 3; i++) { w.h.clock.advance(24 * 3600); await w.pump(); }
    expect((await queue.listDeadLetters()).items).toHaveLength(2);
    expect((await w.accepted())?.closeAcceptance?.phase).toBe("accepted");
    expect((await w.h.store.get(w.tk))!.closedAt).toBeUndefined(); expect(w.destroyed.size).toBe(0);
  });
  it("holds accepted work across restart when retained exclusivity is lost", async () => {
    const w = await fixture(); w.h.deps.resumeAcceptedClose = async () => {};
    await w.h.flow.close(w.h.owner, w.task.taskId, w.input);
    w.loseProof(); w.restart(); await w.pump();
    expect((await w.h.store.get(w.tk))!.closedAt).toBeUndefined();
    expect((await w.h.store.get(w.wk))!.status).toBe("CLOSING"); expect(w.terminated.size).toBe(0);
  });
  for (const flushed of [false, true]) it(`matches existing ${flushed ? "flushed" : "estimated"} charges after a crash at EVERY effect and receipt`, async () => {
    const baseline = await fixture({ money: true, flushed });
    const ws = (await readWorkspace(baseline.h.deps, baseline.task.workspaceId))!;
    await flushBeforeClose(baseline.h.deps, { ...ws, activeOperationId: baseline.run.id });
    await baseline.h.deps.admission.release(textField((await baseline.h.store.get(baseline.tk))!, "admissionReservationId"));
    const expected = await baseline.money();
    // Enumerate real committed writes and external effects from a complete run, then crash after each one.
    const once = async (crashAt: number) => {
      const w = await fixture({ money: true, flushed, session: true }); let index = 0, crashed = false;
      const after = () => { index++; if (index === crashAt) { crashed = true; throw new Error("power lost"); } };
      const transact = w.h.store.transact.bind(w.h.store), update = w.h.store.update.bind(w.h.store), put = w.h.store.put.bind(w.h.store);
      w.h.store.transact = async (items) => { const r = await transact(items); if (r.applied && items.some((i) => i.kind !== "check")) after(); return r; };
      w.h.store.update = async (request) => { const r = await update(request); if (r.applied) after(); return r; };
      w.h.store.put = async (request) => { const r = await put(request); if (r.applied) after(); return r; };
      const terminate = w.h.machines.terminate.bind(w.h.machines), release = w.h.deps.admission.release.bind(w.h.deps.admission), ended = w.h.deps.taskEnded!;
      w.h.machines.terminate = async (id) => { await terminate(id); after(); };
      w.h.deps.admission.release = async (id) => { await release(id); after(); };
      w.h.deps.taskEnded = async (event) => { await ended(event); after(); };
      const provider = w.h.deps.closeInspection!;
      const destroy = provider.destroyRetained!.bind(provider);
      w.h.deps.closeInspection!.destroyRetained = async (input) => { const r = await destroy(input); if (r) after(); return r; };
      const queue = await w.h.queues.queue("task-dispatch"), ack = queue.ack.bind(queue), enqueue = queue.enqueue.bind(queue);
      queue.enqueue = async (message) => { const r = await enqueue(message); after(); return r; };
      queue.ack = async (receipt) => { const r = await ack(receipt); after(); return r; };
      await w.h.flow.close(w.h.owner, w.task.taskId, w.input).catch(() => undefined);
      await w.pump().catch(() => undefined);
      const count = index;
      // Disable crash, rebuild only the flow; the durable backend/provider survive process replacement.
      index = -10000; w.restart();
      // An ack may have committed just before power loss. Allow the durable timed
      // outbox's five-minute resend/dedup window to expire before expecting its receipt.
      w.h.clock.advance(301);
      for (let retry = 0; retry < 4; retry++) await w.pump();
      expect((await w.accepted())?.closeAcceptance?.phase, `boundary ${crashAt}`).toBe("complete");
      expect(await w.money(), `amount parity at boundary ${crashAt}`).toEqual(expected);
      expect(w.terminated.size).toBe(1); expect(w.destroyed.size).toBe(1); expect(w.cleaned.size).toBe(1);
      expect((await w.accepted())?.closeAcceptance?.receipts["delivery"]).toEqual(expect.any(String));
      const task = (await w.h.store.get(w.tk))!;
      expect(task).toHaveProperty("releasedAt");
      expect((await w.h.store.get((task.charge as { organization: { pk: string; sk: string } }).organization))!.count).toBe(0);
      if (crashAt > 0) expect(crashed, `unreached boundary ${crashAt}`).toBe(true);
      return count;
    };
    const boundaries = await once(0);
    expect(boundaries).toBeGreaterThan(12);
    for (let boundary = 1; boundary <= boundaries; boundary++) await once(boundary);
    console.log(`P4 ${flushed ? "flushed" : "estimated"}: ${boundaries} crash boundaries, exact amount parity`);
  });
  it.each(["SUCCEEDED", "FAILED", "CANCELLED"] as const)("takes original-fence %s callbacks for accounting only, without events, model, workflow or follower effects", async status => {
    const w = await fixture({ money: true }); w.h.deps.resumeAcceptedClose = async () => {};
    await w.h.flow.close(w.h.owner, w.task.taskId, w.input);
    let follower = 0;
    const exchange = vi.fn(async () => ({ token: "fixture" }));
    const handler = createCallbackHandler({ flow: w.h.deps, blobs: {} as never, grants: { exchange, inspect: () => { throw new Error("unused"); } }, bookUsage: (op, events) => w.booking.bookOperationEvents(op, events), async onEvents() { follower++; } });
    const token = new CallbackCapabilities(Buffer.from(w.h.deps.callbackSigningKey)).issue({ workspaceId: w.task.workspaceId, operationId: w.run.id, fence: w.run.fence, actions: ["events", "result", "artifacts"], expiresInSeconds: 600 });
    const post = (action: string, body: unknown) => handler({ method: "POST", path: `/v1/internal/workspaces/${w.task.workspaceId}/operations/${w.run.id}/${action}`, headers: { [CAPABILITY_HEADER]: token }, body: JSON.stringify(body) });
    expect((await post("events", { events: w.usage })).statusCode).toBe(200);
    expect((await post("events", { events: [{ type: "progress", timestamp: "2026-11-09T10:00:00Z", payload: {} }] })).statusCode).toBe(409);
    expect((await post("result", { status: "RUNNING" })).statusCode).toBe(400);
    expect((await handler({ method: "POST", path: `/v1/internal/workspaces/${w.task.workspaceId}/operations/${w.run.id}/repository-credentials`, headers: { "x-agentx-repository-grant": "fixture-grant" }, body: JSON.stringify({ credentialRef: "host-app", repositoryUrl: "https://example.com/repo", access: "clone" }) })).statusCode).toBe(403);
    expect(exchange).not.toHaveBeenCalled();
    expect((await post("result", { status, result: { artifactId: "must-not-read" } })).statusCode).toBe(200);
    expect((await w.h.store.get(w.wk))!.status).toBe("CLOSING"); expect(follower).toBe(0);
    expect((await w.h.store.get(w.runKey))!.eventSequence).toBe(0);
    expect((await w.ledger.taskCost(w.h.deps.companyId, w.task.taskId)).micros).toBe(1_000_000);
  });
  it("refuses a replaced workspace claim before destruction even on a resumed accepted operation", async () => {
    const w = await fixture(); w.h.deps.resumeAcceptedClose = async () => {};
    await w.h.flow.close(w.h.owner, w.task.taskId, w.input);
    await w.h.store.update({ key: w.wk, ops: [change.set("status", "READY")] });
    w.restart(); await w.pump(); expect(w.terminated.size).toBe(0); expect((await w.h.store.get(w.tk))!.closedAt).toBeUndefined();
  });
  it("never destroys same-label changed inspection content, a replacement machine, or an unproven provider", async () => {
    for (const drift of ["content", "machine", "adapter"] as const) {
      const w = await fixture(); w.h.deps.resumeAcceptedClose = async () => {};
      await w.h.flow.close(w.h.owner, w.task.taskId, w.input);
      if (drift === "content") await w.h.store.update({ key: w.inspected, ops: [change.set("result.closeInspection.contentDigest", "b".repeat(64))] });
      if (drift === "machine") await w.h.store.update({ key: w.wk, ops: [change.set("machine", { machineId: "newer-machine", machineKey: "new" })] });
      if (drift === "adapter") delete w.h.deps.closeInspection!.destroyRetained;
      w.restart(); await w.pump(); expect(w.terminated.size).toBe(0);
      expect((await w.h.store.get(w.tk))!.closedAt).toBeUndefined();
    }
  });
  it("concurrent restarts and exact replay complete one claim, charge, slot release and cleanup", async () => {
    const w = await fixture({ money: true }); w.h.deps.resumeAcceptedClose = async () => {};
    await w.h.flow.close(w.h.owner, w.task.taskId, w.input);
    w.restart(); const accepted = (await w.accepted())!;
    await Promise.all([w.h.deps.resumeAcceptedClose(accepted), w.h.deps.resumeAcceptedClose(accepted)]);
    for (let i = 0; i < 3; i++) await w.pump();
    const before = await w.money();
    await w.h.flow.close(w.h.owner, w.task.taskId, w.input); await w.pump();
    expect(await w.money()).toEqual(before); expect(w.terminated.size).toBe(1); expect(w.cleaned.size).toBe(1);
    expect((await w.accepted())?.closeAcceptance?.phase).toBe("complete");
  });

  it("dead-letters a repeatedly held resume delivery while the durable outbox recovers later", async () => {
    const w = await fixture(); w.h.deps.resumeAcceptedClose = async () => {};
    await w.h.flow.close(w.h.owner, w.task.taskId, w.input);
    await w.h.flow.relayOnce();
    const queue = await w.h.queues.queue("task-dispatch");
    for (let attempt = 0; attempt < 6; attempt++) {
      await w.h.flow.dispatchOnce({ maxMessages: 10 }); w.h.clock.advance(31);
    }
    expect((await queue.listDeadLetters()).items).toMatchObject([{ reason: "accepted_close_pending", receiveCount: 5 }]);
    expect((await queue.receive({ maxMessages: 10 }))).toEqual([]);
    expect((await w.accepted())?.closeAcceptance?.phase).toBe("accepted");
    w.restart(); w.h.clock.advance(301); await w.pump();
    expect((await w.accepted())?.closeAcceptance?.receipts["delivery"]).toEqual(expect.any(String));
    expect(w.destroyed.size).toBe(1);
  });

  it("the timed relay survives repeated queue failure and a lost delivery without another POST", async () => {
    const w = await fixture(); w.h.deps.resumeAcceptedClose = async () => {};
    await w.h.flow.close(w.h.owner, w.task.taskId, w.input);
    const queue = await w.h.queues.queue("task-dispatch"), enqueue = queue.enqueue.bind(queue);
    queue.enqueue = async () => { throw new Error("queue unavailable"); };
    for (let i = 0; i < 12; i++) await w.h.flow.relayOnce();
    queue.enqueue = enqueue; await w.h.flow.relayOnce();
    for (const message of await queue.receive({ maxMessages: 10 })) await queue.ack(message.receiptHandle);
    // Past queue deduplication: the pending outbox reconstructs a delivery even if its earlier copy was lost/redriven.
    w.h.clock.advance(301); w.restart(); await w.pump();
    expect((await w.accepted())?.closeAcceptance?.receipts["delivery"]).toEqual(expect.any(String));
    expect(w.terminated.size).toBe(1);
  });

});
