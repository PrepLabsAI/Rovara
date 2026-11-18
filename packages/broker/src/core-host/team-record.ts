// Engine host (lane LM7, DEC 226): the Team record on the core engine, for one company, riding on that company's lessons (it is on exactly where `ROVARA_CORE_LESSONS` covers the company).
//   capture   a merged or closed task of the company adds its people's decisions, review feedback and the task itself (`team-record/capture.ts`); no model call;
//   search    the context sources' "search team knowledge" tool gets the record as its `teamSearch` (keyword search over the project's rows, no infrastructure);
//   erase     `erasePersonTeamRecord` removes every row a person wrote, whatever the switch says (the person erase calls it with the lessons erase).
// Wiring (the deployment, after `createCoreLessons`): `const record = attachCoreTeamRecord(lessons)`, then give `record.search` to the context sources as `teamSearch`.
import { OrgIdSchema, type AuditSink, type DocumentStore, type OrgId } from "@agentx/contracts";
import type { TeamRecordSearch } from "../context-sources/team-record.js";
import { readTask } from "../core/task-flow/reads.js";
import { pausedKindsFor } from "../lessons/paused-kinds.js";
import { recordEndedTask, teamRecordSearchOver } from "../team-record/capture.js";
import { createTeamRecord, type TeamRecord } from "../team-record/record.js";
import { companyProjects, erasePersonLessons, type CoreLessons, type ErasePersonLessonsReport } from "./lessons.js";

export interface CoreTeamRecord {
  readonly record: TeamRecord;
  readonly search: TeamRecordSearch;
}

/** The record for a company whose lessons are built. Registers its capture on the lessons' milestones (call before the first task of the company ends). */
export function attachCoreTeamRecord(lessons: CoreLessons, input: { store: DocumentStore; now: () => number; log?: (entry: Record<string, unknown>) => void }): CoreTeamRecord {
  const record = createTeamRecord({ store: input.store, companyId: lessons.companyId, now: input.now });
  lessons.milestones.register({
    name: "team_record",
    async on(event) {
      if (event.kind !== "merged" && event.kind !== "closed") return;
      // Only a task of this company (the subject source checks it again).
      if (await lessons.readTask(event.taskId) === undefined) return;
      try {
        const task = await readTask({ store: input.store }, event.taskId);
        await recordEndedTask({ record, source: lessons.sources.source, rows: lessons.sources.rows, companyId: lessons.companyId, taskId: event.taskId, now: input.now,
          // A kind of evidence a person stopped on "Where Rovara learns from" is not read for the record either.
          paused: (project, life) => pausedKindsFor(lessons.runtime.store, { workspaceId: lessons.companyId, project }, life), projectOf: async (taskId) => (await lessons.readTask(taskId))?.project, origin: task?.companyId === lessons.companyId ? task.origin : undefined });
      } catch (error) {
        input.log?.({ component: "core-team-record", companyId: lessons.companyId, event: "capture_failed", error: error instanceof Error ? error.name : "unknown" });
        throw error;
      }
    },
  });
  return { record, search: teamRecordSearchOver({ record, readTask: (taskId) => lessons.readTask(taskId) }) };
}

/** The Team record part of erasing one person of a company: every project of the catalog. Runs whatever the switch says. Returns the rows removed. */
export async function erasePersonTeamRecord(input: { store: DocumentStore; companyId: OrgId; personId: string; now: () => number }): Promise<{ rows: number }> {
  const projects = await companyProjects(input.store, input.companyId);
  return { rows: await createTeamRecord({ store: input.store, companyId: input.companyId, now: input.now }).erasePerson(projects, input.personId) };
}

/**
 * The person erase's learning step on a deployed install (`PersonEraseDeps.eraseLearning`): the person's lessons (`erasePersonLessons`) and their Team record rows (`erasePersonTeamRecord`),
 * in every project of the company, whatever the lessons switch says (data that exists must be erased). Rejects when either could not finish (the erase is then repeated or resumed).
 */
export function hostedEraseLearning(input: { store: DocumentStore; audit: AuditSink; now: () => number; log?: (entry: Record<string, unknown>) => void }): (companyId: string, personId: string) => Promise<{ lessons: ErasePersonLessonsReport; teamRecordRows: number }> {
  return async (companyId, personId) => {
    const company = OrgIdSchema.parse(companyId);
    const lessons = await erasePersonLessons({ store: input.store, audit: input.audit, companyId: company, personId, now: input.now, ...(input.log === undefined ? {} : { log: input.log }) });
    const team = await erasePersonTeamRecord({ store: input.store, companyId: company, personId, now: input.now });
    return { lessons, teamRecordRows: team.rows };
  };
}
