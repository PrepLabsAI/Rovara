// Fix with agent's words are a seam: a laptop's are the default (they name `rovara up --check` and `rovara open`), and a host with other screens and commands passes its own whole set to `createDiagnosis`.
// With a host's set, every sentence a person can read from a diagnosis is the host's, and no laptop command appears anywhere.
/* eslint-disable @typescript-eslint/no-unsafe-assignment -- vitest's expect.* matchers are typed any */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DIAGNOSIS_RATE, ErrorRefSchema, IMPLICIT_COMPANY_ID, workflowBlockErrorRef,
  type DiagnosisFailureReason, type ErrorRef, type OrgId,
} from "@rovara-code/contracts";
import {
  DIAGNOSIS_LAPTOP_FAILURE_WORDS, DIAGNOSIS_LAPTOP_REFUSALS, DIAGNOSIS_LAPTOP_WORDS, DiagnosisModelProblem, createDiagnosis, diagnosisWordsChecked,
  type DiagnosisAnswerer, type DiagnosisTaskView, type DiagnosisWords,
} from "../../packages/core/src/core/diagnosis/index.js";
import type { TaskRecord } from "../../packages/core/src/core/task-flow/records.js";
import { MemoryDocumentStore } from "../../packages/core/src/ports/memory-document-store.js";
import { createNoopAuditSink, localOwnerPrincipal } from "../../packages/core/src/ports/policy-defaults.js";

const ORG = IMPLICIT_COMPANY_ID as OrgId;
const OWNER = localOwnerPrincipal();
const AT = "2026-11-10T10:00:00.000Z";
const clock = { ms: Date.parse("2026-11-10T10:05:00.000Z") };
const blocked = (taskId: string, code = "WORKFLOW_BLOCKED"): ErrorRef => ErrorRefSchema.parse({ kind: "workflow_block", code, subject: { taskId }, at: AT });

/** A complete set of another host's words: each sentence says which one it is and points at that host's own screen, never a laptop command. */
const HOST_REFUSAL_NAMES = Object.keys(DIAGNOSIS_LAPTOP_REFUSALS) as Array<keyof typeof DIAGNOSIS_LAPTOP_REFUSALS>;
const HOST_FAILURE_NAMES = Object.keys(DIAGNOSIS_LAPTOP_FAILURE_WORDS) as DiagnosisFailureReason[];
const hostWords = (): DiagnosisWords => ({
  refusals: Object.fromEntries(HOST_REFUSAL_NAMES.map((name) => [name, `Host refusal ${name}: see the Host console.`])) as DiagnosisWords["refusals"],
  failure: Object.fromEntries(HOST_FAILURE_NAMES.map((name) => [name, `Host failure ${name}: see the Host console.`])) as DiagnosisWords["failure"],
});
const allSentences = (words: DiagnosisWords): string[] => [...Object.values(words.refusals), ...Object.values(words.failure)];

type Prepare = DiagnosisAnswerer["prepare"];
function world(options: { words?: DiagnosisWords; answerer?: DiagnosisAnswerer | null; prepare?: Prepare; answer?: () => Promise<never> } = {}) {
  const store = new MemoryDocumentStore();
  const tasks = new Map<string, TaskRecord>();
  const addTask = (): string => { const taskId = randomUUID(); tasks.set(taskId, { taskId, project: "web", closedAt: undefined } as unknown as TaskRecord); return taskId; };
  const first = addTask();
  const answerer: DiagnosisAnswerer | undefined = options.answerer === null ? undefined : options.answerer ?? {
    prepare: options.prepare ?? (async () => ({ ok: true })),
    answer: options.answer ?? (async () => ({ text: JSON.stringify({ summary: "ok", needsCode: false, proposals: [] }), model: "m" })),
  };
  const diagnosis = createDiagnosis({
    store, audit: createNoopAuditSink(), companyId: ORG, answerer, ...(options.words === undefined ? {} : { words: options.words }),
    context: {
      tagKey: "k".repeat(32),
      async taskView(task): Promise<DiagnosisTaskView> {
        return { title: "Add retry", status: "BLOCKED", errorRef: workflowBlockErrorRef({ taskId: task.taskId, blockReason: undefined, at: AT }), workflow: { stage: "PLAN", state: "BLOCKED", blockReason: "planning ended" }, events: [] };
      },
      async projectFacts(_org, project) { return { name: project, mergeMethod: "squash", allowSelfApproval: true, reviewers: 0, repositories: ["demo"], allowedWebsites: 0 }; },
    },
    taskOf: async (principal, taskId) => (principal.personId === OWNER.personId ? tasks.get(taskId) : undefined),
    now: () => clock.ms,
  });
  return { diagnosis, task: first, addTask };
}

/** The message of the refusal a call ends in (the error's own text carries the sentence). */
const refusalOf = async (call: Promise<unknown>): Promise<string> => {
  try { await call; } catch (error) { return error instanceof Error ? error.message : String(error); }
  throw new Error("expected a refusal");
};

describe("the laptop's words (the default)", () => {
  it("are what a diagnosis says when no words are given, and still name the laptop's commands", async () => {
    expect(DIAGNOSIS_LAPTOP_WORDS.refusals).toBe(DIAGNOSIS_LAPTOP_REFUSALS);
    expect(DIAGNOSIS_LAPTOP_WORDS.failure).toBe(DIAGNOSIS_LAPTOP_FAILURE_WORDS);
    expect(DIAGNOSIS_LAPTOP_REFUSALS.noProvider).toContain("`rovara up --check`");
    expect(DIAGNOSIS_LAPTOP_REFUSALS.startOnThePage).toContain("`rovara open <task>`");
    expect(DIAGNOSIS_LAPTOP_FAILURE_WORDS.key_invalid).toContain("`rovara up --check`");
    const none = world({ answerer: null });
    expect(none.diagnosis.words).toBe(DIAGNOSIS_LAPTOP_WORDS);
    expect(await refusalOf(none.diagnosis.start(OWNER, { requestId: randomUUID(), errorRef: blocked(none.task) }))).toContain(DIAGNOSIS_LAPTOP_REFUSALS.noProvider);
    expect(await none.diagnosis.forTask(OWNER, none.task)).toMatchObject({ offered: false, why: DIAGNOSIS_LAPTOP_REFUSALS.noProvider });
  });

  it("say the laptop's failure words for each reason a diagnosis can fail", async () => {
    for (const reason of HOST_FAILURE_NAMES) {
      const w = world({ answer: async () => { throw new DiagnosisModelProblem(reason, false); } });
      const queued = await w.diagnosis.start(OWNER, { requestId: randomUUID(), errorRef: blocked(w.task) });
      await w.diagnosis.idle();
      expect(await w.diagnosis.status(OWNER, queued.diagnosisId)).toMatchObject({ state: "failed", failure: DIAGNOSIS_LAPTOP_FAILURE_WORDS[reason] });
    }
  });
});

describe("a host's own words", () => {
  const words = hostWords();
  const own = new Set(allSentences(words));
  /** What a person can read: it is one of the host's sentences, contains no laptop command and names no `rovara` at all. */
  const hostOnly = (text: string | undefined): void => {
    expect(text).toBeDefined();
    expect([...own].some((sentence) => text!.includes(sentence)), text).toBe(true);
    expect(text).not.toMatch(/rovara|up --check/iu);
  };

  it("are complete: the check names a sentence that is missing, empty or too long, and accepts a whole set", () => {
    expect(diagnosisWordsChecked(words)).toBe(words);
    expect(() => diagnosisWordsChecked({ ...words, refusals: { ...words.refusals, noProvider: "" } })).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID", message: expect.stringContaining("noProvider") }));
    const partial = Object.fromEntries(Object.entries(words.refusals).filter(([name]) => name !== "startOnThePage"));
    expect(() => diagnosisWordsChecked({ ...words, refusals: partial as DiagnosisWords["refusals"] })).toThrowError(expect.objectContaining({ message: expect.stringContaining("startOnThePage") }));
    expect(() => diagnosisWordsChecked({ ...words, failure: { ...words.failure, key_invalid: "x".repeat(201) } })).toThrowError(expect.objectContaining({ message: expect.stringContaining("key_invalid") }));
    expect(() => diagnosisWordsChecked({ ...words, failure: undefined } as unknown as DiagnosisWords)).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
    // A host cannot start a diagnosis with a gap: the laptop's sentence would show in its place.
    expect(() => world({ words: { ...words, refusals: partial as DiagnosisWords["refusals"] } })).toThrowError(expect.objectContaining({ message: expect.stringContaining("startOnThePage") }));
  });

  it("are said when no model key is set, a model's price is unknown or the call is too dear, at the start and on the task page", async () => {
    for (const [prepare, name] of [
      [async () => ({ ok: false as const, reason: "no_model" as const }), "noProvider"],
      [async () => ({ ok: false as const, reason: "not_priced" as const }), "notPriced"],
      [async (request?: unknown) => (request === undefined ? { ok: true as const } : { ok: false as const, reason: "too_dear" as const }), "tooDear"],
    ] as Array<[Prepare, keyof DiagnosisWords["refusals"]]>) {
      const w = world({ words, prepare });
      const message = await refusalOf(w.diagnosis.start(OWNER, { requestId: randomUUID(), errorRef: blocked(w.task) }));
      expect(message).toContain(words.refusals[name]);
      hostOnly(message);
      const page = await w.diagnosis.forTask(OWNER, w.task);
      expect(page).toMatchObject({ offered: false, why: words.refusals[name] });
      hostOnly(page?.why);
    }
    const none = world({ words, answerer: null });
    hostOnly(await refusalOf(none.diagnosis.start(OWNER, { requestId: randomUUID(), errorRef: blocked(none.task) })));
    hostOnly((await none.diagnosis.forTask(OWNER, none.task))?.why);
  });

  it("are said when the person may not ask, the error is not the one shown, or it is not a kind a diagnosis reads", async () => {
    const w = world({ words });
    const stranger = { ...OWNER, personId: "someone-else" };
    const notAllowed = await refusalOf(w.diagnosis.start(stranger, { requestId: randomUUID(), errorRef: blocked(w.task) }));
    expect(notAllowed).toContain(words.refusals.notAllowed);
    const notCurrent = await refusalOf(w.diagnosis.start(OWNER, { requestId: randomUUID(), errorRef: blocked(w.task, "SOMETHING_ELSE") }));
    expect(notCurrent).toContain(words.refusals.notCurrent);
    const connector = ErrorRefSchema.parse({ kind: "connector_health", code: "CONNECTOR_EXPIRED", subject: { connectorId: "linear" }, at: AT });
    const notAvailable = await refusalOf(w.diagnosis.start(OWNER, { requestId: randomUUID(), errorRef: connector }));
    expect(notAvailable).toContain(words.refusals.notAvailable);
    // The page's own form says the same.
    expect(await refusalOf(w.diagnosis.startForTask(stranger, w.task, { requestId: randomUUID(), errorKey: "x" }))).toContain(words.refusals.notAllowed);
    expect(await refusalOf(w.diagnosis.startForTask(OWNER, w.task, { requestId: randomUUID(), errorKey: "not-the-key" }))).toContain(words.refusals.notCurrent);
    for (const message of [notAllowed, notCurrent, notAvailable]) hostOnly(message);
  });

  it("are said when the model's answer cannot be asked for, and when the rates are full", async () => {
    const down = world({ words, prepare: async () => { throw new Error("socket closed"); } });
    const message = await refusalOf(down.diagnosis.start(OWNER, { requestId: randomUUID(), errorRef: blocked(down.task) }));
    expect(message).toContain(words.refusals.couldNot);
    hostOnly(message);
    hostOnly((await down.diagnosis.forTask(OWNER, down.task))?.why);
    const busy = world({ words });
    let refused: string | undefined;
    for (let n = 0; n <= DIAGNOSIS_RATE.lightPerPersonPerHour && refused === undefined; n += 1) {
      const taskId = n === 0 ? busy.task : busy.addTask();
      refused = await busy.diagnosis.start(OWNER, { requestId: randomUUID(), errorRef: blocked(taskId) }).then(() => undefined, (error: unknown) => (error instanceof Error ? error.message : String(error)));
    }
    expect(refused).toContain(words.refusals.rateLimited);
    hostOnly(refused);
  });

  it("are said for each reason a diagnosis fails, and for a failure with no known reason", async () => {
    for (const reason of HOST_FAILURE_NAMES) {
      const w = world({ words, answer: async () => { throw new DiagnosisModelProblem(reason, false); } });
      const queued = await w.diagnosis.start(OWNER, { requestId: randomUUID(), errorRef: blocked(w.task) });
      await w.diagnosis.idle();
      const status = await w.diagnosis.status(OWNER, queued.diagnosisId);
      expect(status).toMatchObject({ state: "failed", failure: words.failure[reason] });
      hostOnly(status.failure);
    }
    const unknown = world({ words, answer: async () => { throw new Error("provider said no"); } });
    const queued = await unknown.diagnosis.start(OWNER, { requestId: randomUUID(), errorRef: blocked(unknown.task) });
    await unknown.diagnosis.idle();
    const status = await unknown.diagnosis.status(OWNER, queued.diagnosisId);
    expect(status).toMatchObject({ state: "failed", failure: words.refusals.couldNot });
    hostOnly(status.failure);
  });

  it("are the words the diagnosis shows its host's routes and pages, so the routes of a host say the same", () => {
    expect(world({ words }).diagnosis.words).toBe(words);
    expect(world({ words }).diagnosis.words.refusals.startOnThePage).toBe(words.refusals.startOnThePage);
  });
});
