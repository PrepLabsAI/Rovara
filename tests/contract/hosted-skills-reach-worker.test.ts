// SKILLS-TO-WORKERS step 1: does a PUBLISHED Rovara skill (skill + version + two approvals, written straight into the store) reach a plan or build step on the HOSTED path?
// The hosted path is the dispatcher's own reader (`createDispatcherLearned`, the one `aws/dispatcher.ts` wires) feeding the step payload (`core/task-flow/dispatch.ts` adds `rovaraSkills` only when the reader answers
// them), then the worker's run (`runTaskInvocation`): the session's skills list and the `read_skill` tool. Each half is proved on its own first (the seed is a live skill; a worker sent that skill lists it and serves its
// body), so the last test fails only on the joint between them: the dispatcher's reader answers lessons and knowledge, never skills.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KNOWLEDGE_CONTEXT_FEATURE, LEARNED_CONTEXT_FEATURE, ROVARA_SKILLS_FEATURE, WORKER_INVOCATION_FEATURES, WorkerInvocationSchema, companyScoped, learningModeLockKey, lessonSetKey, orgProjectCatalogKey, projectRevisionKey, type JsonValue, type ProjectDefinition } from "../../packages/contracts/src/index.js";
import { hostedDispatcherFlow } from "../../packages/broker/src/aws/worker-machines/dispatcher-core.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { DocumentLessonStore } from "../../packages/broker/src/lessons/document-store.js";
import { setLearnedLessonsGate } from "../../packages/broker/src/lessons/policy.js";
import { writeLearningMode } from "../../packages/broker/src/lessons/document-settings.js";
import type { HostedLessonPeople } from "../../packages/broker/src/lessons/hosted-people.js";
import { liveSkillsForStep, renderSkill } from "../../packages/broker/src/lessons/skills.js";
import { taskKey, taskPointerKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { WorkerCancellationController } from "../../packages/worker/src/cancel.js";
import { WORKER_IMPLEMENTED_FEATURES } from "../../packages/worker/src/implemented-features.js";
import type { PiSessionAdapter, PiSessionInput } from "../../packages/worker/src/pi-session.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";
import { readSkillTool } from "../../packages/worker/src/read-skill-tool.js";
import { skillsPromptSection } from "../../packages/worker/src/agent-step.js";
import { lessonRecord } from "../unit/lessons/lesson-helpers.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa";
const WS = "11111111-1111-4111-8111-111111111111";
const TASK = "22222222-2222-4222-8222-222222222222";
const now = 1_800_000_000_000;
const PROJECT = "payments";
const definition: ProjectDefinition = { name: PROJECT, revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.", repositories: [{ name: "demo", url: "https://example.test/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }] };
const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
// What a worker lists (the dispatcher passes the worker's own list as `features`).
const WORKER_FEATURES = [LEARNED_CONTEXT_FEATURE, KNOWLEDGE_CONTEXT_FEATURE, ROVARA_SKILLS_FEATURE];

const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); setLearnedLessonsGate(undefined); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const SKILL_NAME = "add-a-retry";
const SKILL_TEXT = renderSkill({ name: SKILL_NAME, description: "Add retry handling to a network call", when: "A task adds retries to a network call.", steps: ["Wrap the call with withRetry.", "Add a test that fails twice then passes."] });
const SKILL_DESCRIPTION = "Add retry handling to a network call";

interface SkillSeed { company: string; project: string; name: string; text: string; description?: string; /** versions of the skill: default one, live, two approvals */ approvals?: number; live?: boolean; retired?: boolean; inSet?: boolean }
/** Writes a skill's rows straight into the store, as `approveSkill` leaves them: head, version 1, and (when live) the `set` member. `live: false` is a draft: version 1 exists, no active version, not in the set. */
async function seedSkill(store: MemoryDocumentStore, seed: SkillSeed): Promise<void> {
  const pk = companyScoped(seed.company, `SKILL#${seed.project}`);
  const live = seed.live !== false;
  const approvals = Array.from({ length: seed.approvals ?? 2 }, (_, index) => ({ by: `person-${String(index + 1)}`, at: now }));
  await store.put({ item: { pk, sk: `head#${seed.name}`, entityType: "SKILL_HEAD", name: seed.name, currentVersion: 1, ...(live ? { activeVersion: 1 } : {}), ...(seed.retired === true ? { retired: true } : { retired: false }), fromLessons: [], createdBy: "person-1", createdAt: now, updatedAt: now } });
  await store.put({ item: { pk, sk: `v#${seed.name}#000001`, entityType: "SKILL_VERSION", name: seed.name, version: 1, description: seed.description ?? "A skill", content: seed.text, digest: sha(seed.text), bytes: Buffer.byteLength(seed.text, "utf8"), approvals, createdBy: "person-1", createdAt: now, ...(live ? { activatedAt: now } : {}) } });
  if (seed.inSet ?? live) {
    const set = await store.get({ pk, sk: "set" });
    const members = { ...((set?.["members"] as Record<string, number> | undefined) ?? {}), [seed.name]: 1 };
    await store.put({ item: { pk, sk: "set", entityType: "SKILL_SET", members, updatedAt: now } });
  }
}
/** A skill text; `filler` adds that many steps of 3,900 characters each (the most one step may hold), so a skill can be made near its 32 KB limit. */
const skillText = (name: string, filler = 0): string => renderSkill({ name, description: `Skill ${name}`, when: "Always.", steps: ["Do the thing.", ...Array.from({ length: filler }, () => "x".repeat(3_900))] });
const ask = (w: { learned: (input: never) => Promise<{ rovaraSkills?: Array<{ name: string }> }> }, workflowMode: string, features: readonly string[] = WORKER_FEATURES) => w.learned({ workspaceId: WS, operationId: randomUUID(), workflowMode, features } as never);
const namesOf = (answer: { rovaraSkills?: Array<{ name: string }> }): string[] => (answer.rovaraSkills ?? []).map((skill) => skill.name);

/** The hosted world of `tests/unit/aws-dispatcher-lessons.test.ts`, plus one PUBLISHED skill written straight into the store: head (live version 1), version 1 with two approvals, and the `set` row. */
async function world(opts: { lessons?: boolean; skill?: boolean; /** the install's CoreLessons setting (default: on for company A) */ coreLessons?: string; /** the project's learning mode (default: none stored, which is Suggest) */ mode?: "Off" | "Collect" | "Suggest" | "On" } = {}) {
  setLearnedLessonsGate(() => true);
  const store = new MemoryDocumentStore();
  await store.put({ item: { ...projectRevisionKey(A, PROJECT, 1), definition: definition as unknown as JsonValue } });
  await store.put({ item: { ...orgProjectCatalogKey(A, PROJECT), latestRevision: 1 } });
  const lessons = new DocumentLessonStore(store, () => now);
  const withLessons = opts.lessons !== false;
  const lesson = lessonRecord({ id: "les_aaaa1111", workspaceId: A, project: PROJECT, title: "Retry network calls", body: "Retry network calls with withRetry.", type: "convention", tier: 1, approvals: [{ approvalId: "approved", by: "person-1", at: 1, mode: "one" }], citations: [], citationChecks: [], scope: {}, stages: ["PLAN", "IMPLEMENT"], provenance: { ...lessonRecord().provenance, supportTasks: [] } });
  if (withLessons) expect((await lessons.commit({ workspaceId: A, project: PROJECT }, 0, [lesson], now)).ok).toBe(true);
  await store.put({ item: { ...workspaceKey(A, WS), entityType: "WORKSPACE", companyId: A } });
  await store.put({ item: { pk: `WORKSPACE#${WS}`, sk: "META", entityType: "WORKSPACE_COMPANY_POINTER", companyId: A, workspaceId: WS } });
  await store.put({ item: { ...taskPointerKey(A, WS), taskId: TASK } });
  await store.put({ item: { ...taskKey(TASK), taskId: TASK, workspaceId: WS, companyId: A, project: PROJECT, title: "Retry network calls", developerId: "person-1", startingRevision: 1, workflow: { revision: 1 } } });
  if (opts.skill !== false) await seedSkill(store, { company: A, project: PROJECT, name: SKILL_NAME, text: SKILL_TEXT, description: SKILL_DESCRIPTION });
  const people: HostedLessonPeople = {
    approvers: async () => ({ complete: true, membershipVersion: 1, ownerIds: ["person-1"], eligibleIds: ["person-1", "person-2"], lastEligibleLossAtMs: null }),
    onProjectRoster: async (company) => company === A, linkedAccounts: async () => [], displayName: async () => "Person", isErased: async () => false,
  };
  const send = vi.fn(async (command: { input: { Key: { pk: string; sk: string } } }) => ({ Item: await store.get(command.input.Key) }));
  const options = { companyId: A, lessonsSwitch: { mode: "on" as const }, documentClient: { send } as never, tableName: "state", store, people, now: () => now };
  // The reader exactly as the deployed dispatcher builds it: `hostedDispatcherFlow` with the install's lessons switch on for this company.
  if (opts.mode !== undefined) await writeLearningMode(store, { workspaceId: A, project: PROJECT }, opts.mode, now);
  const flow = hostedDispatcherFlow(opts.coreLessons === undefined ? { ROVARA_CORE_LESSONS: `on:${A}` } : opts.coreLessons === "unset" ? {} : { ROVARA_CORE_LESSONS: opts.coreLessons }, options);
  if (flow === undefined || typeof flow.learned !== "function") throw new Error("the hosted dispatcher has no learned reader");
  return { store, learned: flow.learned };
}

async function preparedRoot(): Promise<string> {
  const rootPath = await mkdtemp(join(tmpdir(), "hosted-skills-"));
  roots.push(rootPath);
  await mkdir(join(rootPath, ".agentx"));
  await writeFile(join(rootPath, ".agentx/preparation-manifest.json"), JSON.stringify({ schemaVersion: 2, projectName: "x", projectRevision: 1, repositories: [], completedSetupSteps: [], readinessResults: [], creationIdentity: "fixture", complete: true, updatedAt: new Date().toISOString() }));
  return rootPath;
}

/** The worker's run of one step: the session input it built (its skills) and the skills list the model would see in its prompt. */
async function workerStep(mode: string, payload: Record<string, unknown>) {
  const inputs: PiSessionInput[] = [];
  const adapter: PiSessionAdapter = {
    async create(input) {
      inputs.push(input);
      const sessionFile = join(input.sessionDirectory, "fixture.jsonl");
      await writeFile(sessionFile, "");
      return {
        sessionFile, conversationId: "fixture", prompt: async () => undefined, abort: async () => undefined, getModel: () => ({ provider: "fixture", modelId: "fixture" }),
        getSessionStats: () => ({ sessionFile, sessionId: "fixture", userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 }),
        subscribe: () => () => undefined, dispose: () => undefined,
      };
    },
  };
  const invocation = WorkerInvocationSchema.parse({
    protocolVersion: 1, kind: "task", operationId: randomUUID(), workspaceId: randomUUID(), fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64),
    payload: { conversationId: randomUUID(), prompt: "Implement the approved plan.", workflowMode: mode, ...payload },
  });
  await runTaskInvocation(invocation, {
    rootPath: await preparedRoot(), model: { provider: "fixture", modelId: "fixture" }, piAdapter: adapter, eventSink: async () => undefined, artifactSink: async () => undefined,
    cancellationController: new WorkerCancellationController(), log: () => undefined,
  }).then(() => undefined, () => undefined);
  return inputs[0]?.skills ?? [];
}

const readSkillBody = async (skills: ReadonlyArray<{ name: string; description: string; digest: string; content: string }>, name: string): Promise<string> => {
  const tool = readSkillTool(skills) as unknown as { execute: (id: string, parameters: { name: string }) => Promise<{ content: Array<{ text: string }> }> };
  return (await tool.execute("call", { name })).content[0]!.text;
};

describe("a published Rovara skill on the hosted path (dispatcher -> worker step)", () => {
  it("control: the worker lists the feature, and the seeded rows ARE a live skill", async () => {
    expect(WORKER_INVOCATION_FEATURES as readonly string[]).toContain(ROVARA_SKILLS_FEATURE);
    expect(WORKER_IMPLEMENTED_FEATURES as readonly string[]).toContain(ROVARA_SKILLS_FEATURE);
    const w = await world();
    const live = await liveSkillsForStep(w.store, { workspaceId: A, project: PROJECT });
    expect(live.left).toBe(0);
    expect(live.skills.map((skill) => skill.name)).toEqual([SKILL_NAME]);
  });

  it("control: a plan or build step sent that skill lists it and read_skill returns its body (the worker half works)", async () => {
    const w = await world();
    const live = await liveSkillsForStep(w.store, { workspaceId: A, project: PROJECT });
    for (const mode of ["PLAN", "IMPLEMENT"]) {
      const skills = await workerStep(mode, { rovaraSkills: live.skills });
      expect(skillsPromptSection(skills), mode).toContain(`<name>${SKILL_NAME}</name>`);
      expect(await readSkillBody(skills, SKILL_NAME), mode).toBe(SKILL_TEXT);
    }
  });

  it("control: the same dispatcher reader does answer the project's lessons for the step (so the reader ran and a skill is the only thing missing)", async () => {
    const w = await world();
    // The seed is a "convention": a build step loads only a convention, a pitfall or a fact with a code citation (`lessons/load.ts` `stageAllows`), a plan step loads any but a review check.
    for (const workflowMode of ["PLAN", "IMPLEMENT"]) {
      const answer = await w.learned({ workspaceId: WS, operationId: randomUUID(), workflowMode, features: WORKER_FEATURES });
      expect(answer.learnedContext?.lessons.map((lesson) => lesson.id), workflowMode).toEqual(["les_aaaa1111"]);
    }
  });

  // THE GAP (step 1 proved it RED; fixed in step 2): the dispatcher's reader used to return `learnedContext` and `knowledgeContext` only, so `dispatch.ts` had no `rovaraSkills` to add to the payload and the hosted worker's step
  // never listed the skill. Now the reader answers them from the same selector the laptop path uses (`liveSkillsForStep`).
  it("the dispatcher's reader gives a plan or build step the project's published skill, and the worker lists it and read_skill returns its body", async () => {
    const w = await world();
    for (const workflowMode of ["PLAN", "IMPLEMENT"]) {
      const answer = await w.learned({ workspaceId: WS, operationId: randomUUID(), workflowMode, features: WORKER_FEATURES });
      expect(answer.rovaraSkills?.map((skill) => skill.name), `${workflowMode}: the reader's answer`).toEqual([SKILL_NAME]);
      // The payload the dispatcher builds from that answer (core/task-flow/dispatch.ts adds `rovaraSkills` from it only for a worker that lists the feature), run by the real worker.
      const skills = await workerStep(workflowMode, { ...(answer.rovaraSkills === undefined ? {} : { rovaraSkills: answer.rovaraSkills }) });
      expect(skillsPromptSection(skills), `${workflowMode}: the step's prompt`).toContain(`<name>${SKILL_NAME}</name>`);
      expect(await readSkillBody(skills, SKILL_NAME), `${workflowMode}: read_skill`).toBe(SKILL_TEXT);
    }
  });
});

describe("what the hosted dispatcher's reader may give a step as skills (scoping, publication, step kinds, caps)", () => {
  it("a skill never crosses a project: another project's published skill (same company) is not given", async () => {
    const w = await world();
    await seedSkill(w.store, { company: A, project: "billing", name: "billing-only", text: skillText("billing-only") });
    expect(namesOf(await ask(w, "PLAN"))).toEqual([SKILL_NAME]);
    expect(namesOf(await ask(w, "IMPLEMENT"))).toEqual([SKILL_NAME]);
  });

  it("a skill never crosses a company: another company's skill of the SAME project name and the same skill name is not given", async () => {
    const w = await world();
    const B = "org_bbbbbbbbbbbbbbbbbbbb";
    const other = skillText(SKILL_NAME, 1);
    await seedSkill(w.store, { company: B, project: PROJECT, name: SKILL_NAME, text: other });
    await seedSkill(w.store, { company: B, project: PROJECT, name: "company-b-only", text: skillText("company-b-only") });
    const answer = await ask(w, "PLAN");
    expect(namesOf(answer)).toEqual([SKILL_NAME]);
    expect((answer.rovaraSkills as unknown as Array<{ content: string }>)[0]!.content).toBe(SKILL_TEXT);
  });

  it("a workspace of another company is refused (the dispatcher of company A reads nothing of company B's, skills included)", async () => {
    const w = await world({ skill: false });
    const B = "org_bbbbbbbbbbbbbbbbbbbb";
    const WS_B = "33333333-3333-4333-8333-333333333333";
    await seedSkill(w.store, { company: B, project: PROJECT, name: "company-b-only", text: skillText("company-b-only") });
    await w.store.put({ item: { pk: `WORKSPACE#${WS_B}`, sk: "META", entityType: "WORKSPACE_COMPANY_POINTER", companyId: B, workspaceId: WS_B } });
    await expect(w.learned({ workspaceId: WS_B, operationId: randomUUID(), workflowMode: "PLAN", features: WORKER_FEATURES })).rejects.toThrow();
  });

  it("only PUBLISHED versions: a draft (no live version), a skill with one approval, a retired skill and a stale set member are never given", async () => {
    const w = await world();
    await seedSkill(w.store, { company: A, project: PROJECT, name: "draft-skill", text: skillText("draft-skill"), live: false, approvals: 0 });
    await seedSkill(w.store, { company: A, project: PROJECT, name: "draft-in-set", text: skillText("draft-in-set"), live: false, approvals: 0, inSet: true });
    await seedSkill(w.store, { company: A, project: PROJECT, name: "one-approval", text: skillText("one-approval"), approvals: 1 });
    await seedSkill(w.store, { company: A, project: PROJECT, name: "retired-skill", text: skillText("retired-skill"), retired: true });
    // A new version with no approvals does not replace the live one: the head still says version 1 is live.
    const pk = companyScoped(A, `SKILL#${PROJECT}`);
    const head = await w.store.get({ pk, sk: `head#${SKILL_NAME}` });
    await w.store.put({ item: { ...head!, currentVersion: 2 } });
    const unapproved = skillText(SKILL_NAME, 2);
    await w.store.put({ item: { pk, sk: `v#${SKILL_NAME}#000002`, entityType: "SKILL_VERSION", name: SKILL_NAME, version: 2, description: "Edited", content: unapproved, digest: sha(unapproved), bytes: Buffer.byteLength(unapproved, "utf8"), approvals: [], createdBy: "person-1", createdAt: now } });
    for (const mode of ["PLAN", "IMPLEMENT"]) {
      const answer = await ask(w, mode);
      expect(namesOf(answer), mode).toEqual([SKILL_NAME]);
      expect((answer.rovaraSkills as unknown as Array<{ content: string; version: number }>)[0], mode).toMatchObject({ content: SKILL_TEXT, version: 1 });
    }
  });

  it("plan and build steps only: UNDERSTAND, PLAN_CRITIQUE and REVIEW get no skills; a worker that does not list the feature gets none", async () => {
    const w = await world();
    for (const mode of ["UNDERSTAND", "PLAN_CRITIQUE", "REVIEW", "CHECKS", "SPEC_WRITE"]) expect((await ask(w, mode)).rovaraSkills, mode).toBeUndefined();
    for (const mode of ["PLAN", "IMPLEMENT"]) expect((await ask(w, mode, [LEARNED_CONTEXT_FEATURE, KNOWLEDGE_CONTEXT_FEATURE])).rovaraSkills, mode).toBeUndefined();
  });

  it("the caps: at most 8 skills in a step, and never more than 96 KB of skill text (a skill past either is left out whole)", async () => {
    const w = await world({ skill: false });
    for (let index = 0; index < 11; index += 1) await seedSkill(w.store, { company: A, project: PROJECT, name: `skill-${String(index).padStart(2, "0")}`, text: skillText(`skill-${String(index).padStart(2, "0")}`) });
    const many = namesOf(await ask(w, "PLAN"));
    expect(many).toHaveLength(8);
    expect(many).toEqual(Array.from({ length: 8 }, (_, index) => `skill-${String(index).padStart(2, "0")}`));
    const big = await world({ skill: false });
    for (let index = 0; index < 5; index += 1) await seedSkill(big.store, { company: A, project: PROJECT, name: `big-${String(index)}`, text: skillText(`big-${String(index)}`, 8) });
    const sent = (await ask(big, "IMPLEMENT")).rovaraSkills as unknown as Array<{ content: string }>;
    const total = sent.reduce((sum, skill) => sum + Buffer.byteLength(skill.content, "utf8"), 0);
    expect(Buffer.byteLength(skillText("big-0", 8), "utf8")).toBeGreaterThan(30_000);
    expect(sent.map((skill) => Buffer.byteLength(skill.content, "utf8")).every((size) => size <= 32_768)).toBe(true);
    // Five skills of about 31 KB each: three fit in 96 KB, the rest are left out whole.
    expect(sent).toHaveLength(3);
    expect(total).toBeLessThanOrEqual(98_304);
  });

  it("a project with skills and NO lesson set still gets its skills (the reader no longer ends early on a missing lesson set)", async () => {
    const w = await world({ lessons: false });
    expect(await w.store.get(lessonSetKey(A, PROJECT))).toBeUndefined();
    for (const mode of ["PLAN", "IMPLEMENT"]) {
      const answer = await w.learned({ workspaceId: WS, operationId: randomUUID(), workflowMode: mode, features: WORKER_FEATURES });
      expect(answer.learnedContext, mode).toBeUndefined();
      expect(namesOf(answer), mode).toEqual([SKILL_NAME]);
    }
    // And a worker that lists the skills feature but not the lessons feature is still given them.
    expect(namesOf(await ask(w, "PLAN", [ROVARA_SKILLS_FEATURE]))).toEqual([SKILL_NAME]);
  });

  it("a project with no skills and no lessons gets nothing", async () => {
    const w = await world({ lessons: false, skill: false });
    expect(await ask(w, "PLAN")).toEqual({});
  });

  it("read_skill on the worker serves only what was delivered: a skill the reader left out (another project's) is not readable", async () => {
    const w = await world();
    await seedSkill(w.store, { company: A, project: "billing", name: "billing-only", text: skillText("billing-only") });
    const answer = await ask(w, "IMPLEMENT");
    const skills = await workerStep("IMPLEMENT", { rovaraSkills: answer.rovaraSkills });
    expect(await readSkillBody(skills, SKILL_NAME)).toBe(SKILL_TEXT);
    expect(await readSkillBody(skills, "billing-only")).toBe("No skill called billing-only in this agent.");
  });
});

// DEC 254zzz577 option (a): an APPROVED (published) skill ALWAYS reaches a plan or build step, whatever the project's learning mode and the install's CoreLessons setting; the lessons stay gated by both, as before.
describe("skills are not behind the learning mode or the CoreLessons switch (lessons still are)", () => {
  it.each(["Off", "Collect", "Suggest", "On"] as const)("project learning mode %s: plan and build steps get the published skill", async (mode) => {
    const w = await world({ mode });
    for (const workflowMode of ["PLAN", "IMPLEMENT"]) expect(namesOf(await ask(w, workflowMode)), `${mode} ${workflowMode}`).toEqual([SKILL_NAME]);
  });

  it("lessons stay gated by the mode: Off and Collect give no lesson (and no knowledge), Suggest and On give it", async () => {
    for (const mode of ["Off", "Collect"] as const) {
      const w = await world({ mode });
      for (const workflowMode of ["PLAN", "IMPLEMENT"]) {
        const answer = await w.learned({ workspaceId: WS, operationId: randomUUID(), workflowMode, features: WORKER_FEATURES });
        expect(answer.learnedContext, `${mode} ${workflowMode}`).toBeUndefined();
        expect(answer.knowledgeContext, `${mode} ${workflowMode}`).toBeUndefined();
        expect(namesOf(answer), `${mode} ${workflowMode}`).toEqual([SKILL_NAME]);
      }
    }
    for (const mode of ["Suggest", "On"] as const) {
      const w = await world({ mode });
      const answer = await w.learned({ workspaceId: WS, operationId: randomUUID(), workflowMode: "PLAN", features: WORKER_FEATURES });
      expect(answer.learnedContext?.lessons.map((lesson) => lesson.id), mode).toEqual(["les_aaaa1111"]);
      expect(namesOf(answer), mode).toEqual([SKILL_NAME]);
    }
  });

  it("the company's lock on the mode (Off) does not take the skills away either", async () => {
    const w = await world();
    await w.store.put({ item: { ...learningModeLockKey(A), entityType: "LESSON_MODE_LOCK", mode: "off", updatedAt: now } });
    const answer = await w.learned({ workspaceId: WS, operationId: randomUUID(), workflowMode: "PLAN", features: WORKER_FEATURES });
    expect(answer.learnedContext).toBeUndefined();
    expect(namesOf(answer)).toEqual([SKILL_NAME]);
  });

  it("the install's CoreLessons switch off (unset, 'off', or naming only another company): plan and build steps still get the skill, and no lesson", async () => {
    for (const coreLessons of ["unset", "off", "on:org_bbbbbbbbbbbbbbbbbbbb"]) {
      const w = await world({ coreLessons });
      for (const workflowMode of ["PLAN", "IMPLEMENT"]) {
        const answer = await w.learned({ workspaceId: WS, operationId: randomUUID(), workflowMode, features: WORKER_FEATURES });
        expect(answer.learnedContext, `${coreLessons} ${workflowMode}`).toBeUndefined();
        expect(answer.knowledgeContext, `${coreLessons} ${workflowMode}`).toBeUndefined();
        expect(namesOf(answer), `${coreLessons} ${workflowMode}`).toEqual([SKILL_NAME]);
      }
      // The other scoping rules hold with the switch off: no skill for a step that is not plan or build, nor for a worker without the feature.
      expect((await ask(w, "REVIEW")).rovaraSkills, coreLessons).toBeUndefined();
      expect((await ask(w, "PLAN", [LEARNED_CONTEXT_FEATURE, KNOWLEDGE_CONTEXT_FEATURE])).rovaraSkills, coreLessons).toBeUndefined();
    }
  });

  it("with the switch off, a worker that lists only the lessons feature costs the store nothing (no read at all), and a foreign workspace is still refused", async () => {
    const w = await world({ coreLessons: "unset" });
    const asked = vi.spyOn(w.store, "get");
    expect(await w.learned({ workspaceId: WS, operationId: randomUUID(), workflowMode: "PLAN", features: [LEARNED_CONTEXT_FEATURE, KNOWLEDGE_CONTEXT_FEATURE] })).toEqual({});
    expect(asked).not.toHaveBeenCalled();
    await expect(w.learned({ workspaceId: "33333333-3333-4333-8333-333333333333", operationId: randomUUID(), workflowMode: "PLAN", features: WORKER_FEATURES })).rejects.toThrow();
  });
});

// SKILLS-TO-WORKERS pre-review S2 and S3: the skills' read has its own time, reads and bytes (`DISPATCHER_SKILLS_LIMITS`: 129 reads, 64 x 32 KB + 256 KB, 700 ms), runs beside the lessons, and can never take
// anything from them; a slow, oversized, over-long or throwing skills read is "no skills", and the lessons are delivered as they would be.
describe("the skills' read has a share of its own (time, reads, bytes) and can never cost the lessons anything", () => {
  type World = Awaited<ReturnType<typeof world>>;
  const isSkillKey = (key: { pk: string }): boolean => key.pk.includes("SKILL#");
  /** Delays every store read by `delay(key)` ms (the lessons' reads, the workspace and task reads and the skills' reads all go through `store.get`), on the test's fake clock. */
  const slow = (w: World, delay: (key: { pk: string; sk: string }) => number): void => {
    const original = w.store.get.bind(w.store);
    vi.spyOn(w.store, "get").mockImplementation(async (key) => { const ms = delay(key); if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms)); return original(key); });
  };
  /** One reader call on the fake clock: what it answered (or that it refused) and how many ms it took. */
  async function timed(w: World, workflowMode = "PLAN") {
    vi.useFakeTimers();
    const started = Date.now();
    let settled: { value?: Awaited<ReturnType<typeof ask>> & { learnedContext?: { lessons: Array<{ id: string }> } }; refused?: unknown; at: number } | undefined;
    w.learned({ workspaceId: WS, operationId: randomUUID(), workflowMode, features: WORKER_FEATURES }).then((value) => { settled = { value, at: Date.now() - started }; }, (refused: unknown) => { settled = { refused, at: Date.now() - started }; });
    for (let step = 0; settled === undefined && step < 1_000; step += 1) await vi.advanceTimersByTimeAsync(10);
    vi.useRealTimers();
    if (settled === undefined) throw new Error("the reader never answered");
    return settled;
  }
  const lessonIds = (answer: { learnedContext?: { lessons: Array<{ id: string }> } } | undefined): string[] => answer?.learnedContext?.lessons.map((lesson) => lesson.id) ?? [];

  it("S2: a skills read that runs out its whole clock leaves the lessons their own time (they need ~2 s here; the run clock is 2.5 s)", async () => {
    // Control: every non-skill read takes 250 ms (8 serial reads, about 2 s), skills reads are instant.
    const control = await world();
    slow(control, (key) => (isSkillKey(key) ? 0 : 250));
    const baseline = await timed(control);
    expect(lessonIds(baseline.value), "control: lessons delivered").toEqual(["les_aaaa1111"]);
    expect(namesOf(baseline.value ?? {}), "control: skills delivered").toEqual([SKILL_NAME]);
    expect(baseline.at).toBeGreaterThan(1_800);
    expect(baseline.at).toBeLessThan(2_500);
    // Each skills read takes 400 ms: the third read passes the skills' own 700 ms, so there are no skills. The lessons still take their 2 s and are delivered: the skills' 700 ms was not taken from them.
    const w = await world();
    slow(w, (key) => (isSkillKey(key) ? 400 : 250));
    const run = await timed(w);
    expect(run.refused, "the lessons are not refused for lack of time").toBeUndefined();
    expect(lessonIds(run.value)).toEqual(["les_aaaa1111"]);
    expect(run.value?.rovaraSkills, "no skills: their read was cut at its own clock").toBeUndefined();
    expect(run.at, "the answer is no later than the lessons need").toBeLessThan(2_500);
  });

  it("S2: a skills-only answer (no lesson set) waits for a slow skills read no longer than the skills' own clock", async () => {
    const w = await world({ lessons: false });
    slow(w, (key) => (isSkillKey(key) ? 5_000 : 0));
    const run = await timed(w);
    expect(run.refused).toBeUndefined();
    expect(run.value).toEqual({});
    expect(run.at).toBeGreaterThanOrEqual(700);
    expect(run.at).toBeLessThan(900);
  });

  it("S3 (time): three skills reads of 200 ms fit the 700 ms; three of 300 ms do not (no skills, the lessons stand)", async () => {
    const fits = await world();
    slow(fits, (key) => (isSkillKey(key) ? 200 : 0));
    const ok = await timed(fits);
    expect(namesOf(ok.value ?? {})).toEqual([SKILL_NAME]);
    expect(lessonIds(ok.value)).toEqual(["les_aaaa1111"]);
    const late = await world();
    slow(late, (key) => (isSkillKey(key) ? 300 : 0));
    const cut = await timed(late);
    expect(cut.refused).toBeUndefined();
    expect(cut.value?.rovaraSkills).toBeUndefined();
    expect(lessonIds(cut.value)).toEqual(["les_aaaa1111"]);
    expect(cut.at).toBeLessThan(900);
  });

  it("S3 (reads): a project with more members than the selector reads (80) costs exactly 129 skills reads (the set row, then a head and a version for each of 64), and the cap does not cut that", async () => {
    const w = await world({ skill: false });
    for (let index = 0; index < 80; index += 1) await seedSkill(w.store, { company: A, project: PROJECT, name: `skill-${String(index).padStart(2, "0")}`, text: skillText(`skill-${String(index).padStart(2, "0")}`) });
    const asked = vi.spyOn(w.store, "get");
    const answer = await ask(w, "PLAN");
    expect(asked.mock.calls.filter(([key]) => isSkillKey(key))).toHaveLength(129);
    expect(namesOf(answer)).toEqual(Array.from({ length: 8 }, (_, index) => `skill-${String(index).padStart(2, "0")}`));
  });

  it("S3 (bytes): skill rows that add up past the byte share (64 x 32 KB + 256 KB) end the read: no skills at all (not even the good one), and the lessons stand", async () => {
    const build = async (junk: number) => {
      const w = await world({ skill: false });
      await seedSkill(w.store, { company: A, project: PROJECT, name: "aaa-good", text: skillText("aaa-good") });
      // Rows of 100 KB (a skill is at most 32 KB: these are never delivered, but they are read and counted).
      for (let index = 0; index < junk; index += 1) await seedSkill(w.store, { company: A, project: PROJECT, name: `junk-${String(index).padStart(2, "0")}`, text: "x".repeat(100_000) });
      return w;
    };
    // Control: 10 such rows (1 MB) are under the share, so the good skill is delivered.
    const under = await build(10);
    expect(namesOf(await ask(under, "PLAN"))).toEqual(["aaa-good"]);
    // 30 rows (3 MB) pass the share of 2.3 MB.
    const over = await build(30);
    const answer = await over.learned({ workspaceId: WS, operationId: randomUUID(), workflowMode: "PLAN", features: WORKER_FEATURES });
    expect(answer.rovaraSkills).toBeUndefined();
    expect(lessonIds(answer)).toEqual(["les_aaaa1111"]);
  });

  it("S3 (fault): a store whose skills reads throw (or reject) gives no skills, and the lessons are delivered, nothing refused", async () => {
    for (const fail of [() => { throw new Error("skills store down"); }, async () => { throw new Error("skills store down"); }]) {
      const w = await world();
      const original = w.store.get.bind(w.store);
      vi.spyOn(w.store, "get").mockImplementation(async (key) => { if (isSkillKey(key)) return fail() as never; return original(key); });
      const answer = await w.learned({ workspaceId: WS, operationId: randomUUID(), workflowMode: "IMPLEMENT", features: WORKER_FEATURES });
      expect(answer.rovaraSkills).toBeUndefined();
      expect(lessonIds(answer)).toEqual(["les_aaaa1111"]);
    }
  });

  it("S3 (lessons counters): the skills' reads are not counted in the lessons' read budget (a project with 64 skills still gets its lessons)", async () => {
    const w = await world({ skill: false });
    for (let index = 0; index < 64; index += 1) await seedSkill(w.store, { company: A, project: PROJECT, name: `skill-${String(index).padStart(2, "0")}`, text: skillText(`skill-${String(index).padStart(2, "0")}`) });
    const answer = await w.learned({ workspaceId: WS, operationId: randomUUID(), workflowMode: "PLAN", features: WORKER_FEATURES });
    expect(lessonIds(answer)).toEqual(["les_aaaa1111"]);
    expect(namesOf(answer)).toHaveLength(8);
  });
});
