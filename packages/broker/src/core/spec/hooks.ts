// The broker's spec steps, with the effects they need (the store, starting a run, publishing) passed in. The wiring (developer-tasks/spec-wiring.ts) supplies the real ones; the tests supply
// fakes. Every state change is conditional on the state's revision; the SPEC_WRITE run's start goes in ONE transaction with its state change, so there is never a run without its state or a state without its run.
import { AgentXError, agentXError, defaultSpecTarget, when, type SpecKind, type SpecTarget, type StoredDocument, type TransactItem } from "@agentx/contracts";
import { specIsDue } from "./due.js";
import { buildSpecWriteRequest, type SpecWriteRequest } from "./write-request.js";
import type { SpecDesignState } from "./approved-design.js";
import { specLinkLine } from "./link.js";
import { refreshSpecState, type SpecPullRequestFacts } from "./refresh.js";
import {
  SPEC_STATE_SK, SpecStateSchema, continueWithoutSpec, keepEdited, newSpecState, publishFailed, publishSucceeded, replanEdited, noteTransient, retry, SPEC_TRANSIENT_MAX, specBranchName, specGate, specGateForReview, specStateKey, startWriting, stepFailed, writeNotStarted,
  type SpecGate, type SpecPullRequest, type SpecState,
} from "./state.js";

export type { TransactItem };

/** A state as the document store holds it: plain JSON, with no member that is `undefined`. */
export const stateDocument = (state: SpecState): StoredDocument => JSON.parse(JSON.stringify(state)) as StoredDocument;

/** The conditional write of a state: the revision it replaces (none: the item must not exist yet). */
export function specStateItem(next: SpecState, replacesRevision: number | undefined): TransactItem {
  return { kind: "put", item: stateDocument(next), condition: replacesRevision === undefined ? when.absent() : when.eq("revision", replacesRevision) };
}

export interface SpecStore {
  /** `corrupt`: an item is there but is not a state this release reads. */
  load(taskId: string): Promise<{ state: SpecState | undefined; corrupt: boolean }>;
  /** Writes `next` over the revision `replaces`; false when another writer moved it first. */
  save(next: SpecState, replaces: number | undefined, extra?: readonly TransactItem[]): Promise<boolean>;
  /** Writes `next` over whatever is there (a record this release cannot read): only the owner's "continue without spec" uses it. */
  force(next: SpecState, extra?: readonly TransactItem[]): Promise<boolean>;
}

export interface SpecTaskRef {
  taskId: string;
  title: string;
  /** The task's `knowledgeCommit` (the meta repo commit its stages read), when it has one. */
  knowledgeCommit: string | undefined;
}

export type SpecPublishOutcome = { ok: true; pullRequest: SpecPullRequest } | { ok: false; transient: boolean };

export interface SpecWorld {
  now(): string;
  store: SpecStore;
  /** Starts the SPEC_WRITE run. `items(operationId)` are the items that must commit with it. "BUSY": the workspace is not free (nothing was written). "REFUSED": it cannot be started for this task (no base commit). */
  startWrite(input: { task: SpecTaskRef; request: SpecWriteRequest; /** Distinct for each attempt (the state's revision), so a repeat of one request is one run and a retry is another. */ attemptKey: string; items: (operationId: string) => TransactItem[] }): Promise<"STARTED" | "BUSY" | "REFUSED">;
  /**
   * Publishes the state's files to the meta repo on `branch`: the BROKER builds the commit (blobs, tree, commit, ref) through GitHub, opens the pull request, and checks that the commit adds exactly those
   * files. `transient`: it could not be tried now (no GitHub access from here), so nothing is recorded and the step waits.
   */
  publish(input: { task: SpecTaskRef; state: SpecState; branch: string }): Promise<SpecPublishOutcome>;
  /** Whether the state's SPEC_WRITE operation has ended (any way): a `writing` state whose run is over is stuck and is settled. Absent: not looked at. */
  operationEnded?: (state: SpecState) => Promise<boolean>;
  /** GitHub's view of the spec pull request now (D4); undefined where GitHub cannot say. Absent: the spec pull request is not looked at. */
  readPullRequest?: (state: SpecState) => Promise<SpecPullRequestFacts | undefined>;
  log(event: string, fields: Record<string, string | number | boolean>): void;
}

export interface PlanApproval {
  task: SpecTaskRef;
  planDigest: string;
  kind: SpecKind;
  size?: "small" | "medium" | "large" | undefined;
  requested?: boolean | undefined;
  /** The project's spec target as of the approval (its pinned revision). */
  target: SpecTarget | undefined;
}

type Hold = Extract<SpecGate, { action: "hold" }>;
const hold = (reason: Hold["reason"], message: string, ownerActions: Hold["ownerActions"]): Hold => ({ action: "hold", reason, message, ownerActions });
const unavailable = (): Hold => hold("failed", "The spec could not be checked just now.", ["retry", "continue_without_spec"]);

export function createSpecHooks(world: SpecWorld) {
  async function record(approval: PlanApproval): Promise<"recorded" | "not_due" | "exists"> {
    const existing = await world.store.load(approval.task.taskId);
    if (!specIsDue(approval.target, approval)) {
      // A plan that is no longer due a spec leaves no obligation of an older plan behind: that state is stored as skipped, so nothing waits on it.
      if (existing.state !== undefined && existing.state.planDigest !== approval.planDigest && existing.state.status !== "skipped") {
        const skipped = SpecStateSchema.parse({ ...existing.state, planDigest: approval.planDigest, status: "skipped", revision: existing.state.revision + 1, updatedAt: world.now(), failure: undefined, editPrompt: undefined });
        await world.store.save(skipped, existing.state.revision);
      }
      return "not_due";
    }
    const target = approval.target ?? defaultSpecTarget();
    // A re-approval after a revise: the same plan keeps its state; a different plan starts a new obligation (the older state is replaced, at its revision).
    if (existing.state !== undefined && existing.state.planDigest === approval.planDigest) return "exists";
    const base = approval.task.knowledgeCommit;
    const fresh = newSpecState({ taskId: approval.task.taskId, planDigest: approval.planDigest, kind: approval.kind, target, knowledgeCommit: base ?? "0".repeat(40), now: world.now() });
    const unsupported = target.where !== "meta_repo" || base === undefined;
    const state = SpecStateSchema.parse({
      ...fresh, revision: (existing.state?.revision ?? 0) + 1,
      ...(unsupported ? { status: "failed", failure: { code: "unsupported", at: world.now() } } : {}),
    });
    if (existing.corrupt) { await world.store.force(state); return "recorded"; }
    const saved = await world.store.save(state, existing.state?.revision);
    world.log("spec.obligation_recorded", { taskId: approval.task.taskId, recorded: saved });
    return saved ? "recorded" : "exists";
  }

  return {
    /**
     * The plan is approved by a person: when a spec is due, its obligation is recorded now, with the target as it is now. Nothing is run here. A task with no `knowledgeCommit` (no meta repo) and a target that
     * writes to the meta repo cannot be given a spec: the state is a failure the owner can continue past, never a silent skip.
     */
    onPlanApproved: record,

    /**
     * What the code pull request (or, for `purpose: "review"`, the code review) does now. Starts the next step itself (write, then publish) and says "hold" while it runs.
     * - `derive` finds the obligation again when there is no state (a record that failed to be written at the approval): the spec is never skipped because a write failed; an error while looking is a hold.
     * - A `writing` state whose run has ended (failed delivery, cancel, anything) is settled as failed, so a hold always has a way out.
     * - `planMarkdown` is read only when a write starts, from the plan whose digest the caller has already checked is the approved one.
     */
    async gate(input: {
      task: SpecTaskRef; approvedPlanDigest: string; planMarkdown: () => string | undefined; metaRepositoryUrl: string | undefined;
      /** "review": the code review needs the spec published but not approved. */
      purpose?: "review";
      derive?: () => Promise<PlanApproval | undefined>;
      /** Design review: whether the spec waits for an approved design. Read only before a write starts; "wait" holds, nothing is written. Absent: no design review in this step. */
      design?: () => Promise<SpecDesignState>;
    }): Promise<{ proceed: true; linkLine?: string } | { proceed: false; hold: Hold }> {
      const taskId = input.task.taskId;
      // What people did to the spec pull request since (an edit, an approval) is read from GitHub before the decision, so a missed delivery never leaves the code pull request waiting on something already done.
      if (input.purpose !== "review" && world.readPullRequest !== undefined) await refreshSpecState({ store: world.store, now: () => world.now(), read: (state) => world.readPullRequest!(state) }, taskId).catch(() => undefined);
      let { state, corrupt } = await world.store.load(taskId);
      if (state === undefined && !corrupt && input.derive !== undefined) {
        try {
          const approval = await input.derive();
          if (approval !== undefined) { await record(approval); ({ state, corrupt } = await world.store.load(taskId)); }
        } catch (error) {
          world.log("spec.derive_failed", { taskId, error: error instanceof Error ? error.name : "unknown" });
          return { proceed: false, hold: unavailable() };
        }
      }
      const decide = (given: SpecState | undefined) => (input.purpose === "review" ? specGateForReview(given, corrupt, world.now()) : specGate(given, corrupt, world.now()));
      let decision = decide(state);
      // A write whose run is over, and that left no result behind, is settled.
      if (state !== undefined && state.status === "writing" && world.operationEnded !== undefined && await world.operationEnded(state).catch(() => false)) {
        const failed = stepFailed(state, { operationId: state.writeOperationId!, code: "write_failed" }, world.now());
        if (failed !== undefined && await world.store.save(failed, state.revision)) { state = failed; decision = decide(state); }
      }
      if (decision.action === "proceed") return proceedWith(decision.link, input.metaRepositoryUrl);
      if (decision.action === "hold") return { proceed: false, hold: decision };
      let current = state!;
      if (decision.action === "start_write") {
        if (current.planDigest !== input.approvedPlanDigest) return { proceed: false, hold: hold("failed", "The approved plan changed since the spec was planned.", ["continue_without_spec"]) };
        if (input.design !== undefined) {
          // the approved design is written with the spec, so a spec is not written before the design is approved.
          let designState: SpecDesignState;
          try { designState = await input.design(); } catch { return { proceed: false, hold: unavailable() }; }
          if (designState.kind === "wait") return { proceed: false, hold: hold("waiting_approval", "The spec waits for the design to be approved.", ["continue_without_spec"]) };
        }
        const markdown = input.planMarkdown();
        let request: SpecWriteRequest | undefined;
        try {
          if (markdown === undefined) throw agentXError("CONFIG_INVALID", "no plan");
          request = buildSpecWriteRequest({ format: current.target.format, kind: current.kind, planDigest: current.planDigest, planMarkdown: markdown, taskTitle: input.task.title });
        } catch { request = undefined; }
        if (request === undefined) return failWrite(current);
        let started: "STARTED" | "BUSY" | "REFUSED" | "ERROR";
        try {
          started = await world.startWrite({
            task: input.task, request, attemptKey: String(current.revision),
            items: (operationId) => {
              const next = startWriting(current, operationId, world.now());
              if (next === undefined) throw agentXError("CONFIG_INVALID", "the spec has no write left to start");
              return [specStateItem(next, current.revision)];
            },
          });
        } catch (error) {
          // The creator guard refusing the launch is not a transient start error: the owner is told the removal, not that the spec is being written.
          if (error instanceof AgentXError && error.code === "TASK_ACCESS_DENIED") throw error;
          world.log("spec.write_not_started", { taskId, error: error instanceof Error ? error.name : "unknown" });
          started = "ERROR";
        }
        if (started === "REFUSED") return failWrite(current);
        // A start that errors counts: it waits, and after the cap the write fails and the owner chooses. A busy workspace is not an error: it is the normal wait.
        if (started === "ERROR") {
          if ((current.transient ?? 0) + 1 >= SPEC_TRANSIENT_MAX) return failWrite(current);
          await world.store.save(noteTransient(current, world.now()), current.revision);
        }
        return { proceed: false, hold: hold("writing", "Rovara is writing the spec from the approved plan.", ["continue_without_spec"]) };
      }
      // start_publish: the broker builds and opens it now.
      const outcome = await world.publish({ task: input.task, state: current, branch: specBranchName(taskId, current.attempt) }).catch((): SpecPublishOutcome => ({ ok: false, transient: true }));
      const waitHold = hold("publishing", "Rovara is opening the spec pull request.", ["continue_without_spec"]);
      // A refusal that will not pass (GitHub 403, 404, 422, no credential) fails the step now; a failure that may pass waits, with a back-off, and fails after the cap.
      const giveUp = !outcome.ok && (!outcome.transient || (current.transient ?? 0) + 1 >= SPEC_TRANSIENT_MAX);
      const next = outcome.ok ? publishSucceeded(current, { pullRequest: outcome.pullRequest }, world.now()) : giveUp ? publishFailed(current, world.now()) : noteTransient(current, world.now());
      if (next === undefined || !(await world.store.save(next, current.revision))) return { proceed: false, hold: waitHold };
      if (!outcome.ok && !giveUp) return { proceed: false, hold: waitHold };
      current = next;
      decision = decide(current);
      if (decision.action === "proceed") return proceedWith(decision.link, input.metaRepositoryUrl);
      return { proceed: false, hold: decision.action === "hold" ? decision : waitHold };
    },

    /**
     * The task owner's choice on a held spec. Returns the new state, or undefined when the state was not where the choice expects (nothing changes). "Continue without spec" always works: on a record that cannot
     * be read it replaces it, and with no record at all (the obligation could not be found) it writes one that says the owner went on without.
     */
    async ownerChoice(input: { taskId: string; action: "retry" | "continue_without_spec" | "keep" | "replan"; by: string }): Promise<SpecState | undefined> {
      const { state, corrupt } = await world.store.load(input.taskId);
      const now = world.now();
      if (input.action === "continue_without_spec" && (corrupt || state === undefined)) {
        const base = SpecStateSchema.parse({ ...newSpecState({ taskId: input.taskId, planDigest: "0".repeat(64), kind: "feature", target: defaultSpecTarget(), knowledgeCommit: "0".repeat(40), now }), status: "skipped" });
        const continued = continueWithoutSpec(base, input.by, now)!;
        if (corrupt) { if (!(await world.store.force(continued))) return undefined; }
        else if (!(await world.store.save(continued, undefined))) return undefined;
        return continued;
      }
      if (state === undefined) return undefined;
      const next = input.action === "retry" ? retry(state, now) : input.action === "keep" ? keepEdited(state, input.by, now) : input.action === "replan" ? replanEdited(state, input.by, now) : continueWithoutSpec(state, input.by, now);
      if (next === undefined) return undefined;
      return (await world.store.save(next, state.revision)) ? next : undefined;
    },
  };

  async function failWrite(current: SpecState): Promise<{ proceed: false; hold: Hold }> {
    const failed = writeNotStarted(current, world.now());
    await world.store.save(failed, current.revision);
    return { proceed: false, hold: specGate(failed) as Hold };
  }

  function proceedWith(link: SpecPullRequest | undefined, metaRepositoryUrl: string | undefined): { proceed: true; linkLine?: string } | { proceed: false; hold: Hold } {
    const line = link === undefined || metaRepositoryUrl === undefined ? undefined : specLinkLine(link, metaRepositoryUrl);
    // A published spec whose link cannot be verified against the meta repo is not described: the code pull request waits for the owner rather than opening with a link nobody checked.
    if (link !== undefined && line === undefined) return { proceed: false, hold: hold("failed", "The spec pull request is not in the project's meta repository.", ["continue_without_spec"]) };
    return { proceed: true, ...(line === undefined ? {} : { linkLine: line }) };
  }
}

export { SPEC_STATE_SK, specStateKey };
