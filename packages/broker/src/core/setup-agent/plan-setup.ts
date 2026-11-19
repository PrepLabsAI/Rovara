// L4-SC (DEC 254z c, DEC 254zw): what a task does with the setup changes its approved plan carries. Three pure rules, one place:
//
//   1. A plan-approved mock applies to THAT TASK ONLY. `fakesFor` builds the general-fakes payload a task's checks and coding run are sent: the project's own setting, plus the mocks of the task's approved plan
//      (and nothing else). It never writes the project's setting: the project's setup changes only through a setup candidate and an approval (plan-update.ts). A task mock never replaces a project mock for the
//      same variable, and if the two do not fit in one payload NONE of the task's mocks is sent (all or nothing): the checks then say a fake was not available, in fixed words, instead of using some of them.
//   2. The coding agent never writes its own mock. `flagUnplannedMocks` marks every changed file that is a mock SOURCE (an OpenAPI or Swagger description, a spec the project's fakes read, a spec the plan names)
//      and was not named by the approved plan; the risk rule reads the mark (core/proof/risk.ts) and makes the pull request high risk, whatever the agent or the model said. It runs only where mocks are in play (the
//      project's fakes are on, or the plan approved a mock), so a project that uses neither is exactly as it was.
//   3. What the plan approved is read from the plan's stored document, by digest (`build-step/plan-input.ts` leaves the list out unless a person's approval is recorded for that digest). This file reads nothing else.
import {
  GENERAL_FAKES_MAX_SERVICES, generalFakesPayloadOf, setupMockPrLine,
  type GeneralFakeService, type GeneralFakesPayload, type GeneralFakesSetting, type PlanMockItem, type PlanSetupChangeItem, type PlanSetupChanges,
} from "@agentx/contracts";

const isMock = (item: PlanSetupChangeItem): item is PlanMockItem => item.kind === "mock";

/** The mocks of an approved plan's setup changes (none when the plan has none or was not approved: `changes` is undefined then). */
export const plannedMocksOf = (changes: PlanSetupChanges | undefined): PlanMockItem[] => (changes ?? []).filter(isMock);

/**
 * The payload of Rovara-made fakes a task's CHECKS round or coding run is sent: the project's setting (when on), then the task's approved mocks. Undefined when there is nothing to serve (the run goes out as it did).
 * A task mock whose variable the project already fakes is not added (a task never changes what the project approved); more than `GENERAL_FAKES_MAX_SERVICES` in all sends none of the task's.
 */
export function fakesFor(project: unknown, changes: PlanSetupChanges | undefined): GeneralFakesPayload | undefined {
  const own = generalFakesPayloadOf(project);
  const planned = plannedMocksOf(changes);
  if (planned.length === 0) return own;
  const taken = new Set((own?.services ?? []).map((service) => service.variable));
  const added: GeneralFakeService[] = planned.filter((item) => !taken.has(item.variable)).map((item) => ({ variable: item.variable, spec: item.spec }));
  if ((own?.services.length ?? 0) + added.length > GENERAL_FAKES_MAX_SERVICES) return own;
  if (added.length === 0) return own;
  return { services: [...(own?.services ?? []), ...added] };
}

/** An OpenAPI or Swagger description by its file name, the same names the worker's discovery picks up (`worker/src/general-fakes-round.ts`): what a Rovara-made fake is built from when the setting names no file. */
const SPEC_NAME = /(?:^|\/)(?:(?:openapi|swagger)\.(?:ya?ml|json)|[^/]*\.openapi\.(?:ya?ml|json))$/iu;
const normal = (path: string): string => path.replaceAll("\\", "/").replace(/^(?:\.\/)+/u, "");

export interface MockSourceFacts {
  /** The project's fakes setting as stored (read only). */
  setting: GeneralFakesSetting | undefined;
  /** The approved plan's setup changes, when a person approved them. */
  changes: PlanSetupChanges | undefined;
  /** Each repository's folder in the workspace, by name: a spec is named relative to the workspace, a changed file relative to its repository. */
  repositoryPaths?: Readonly<Record<string, string>> | undefined;
}

/** The facts the guard reads, from the task's project revision (its fakes setting and its repositories' folders) and the approved plan's setup changes. */
export function mockFactsOf(definition: { generalFakes?: GeneralFakesSetting | undefined; repositories: ReadonlyArray<{ name: string; path: string }> } | undefined, changes: PlanSetupChanges | undefined): MockSourceFacts {
  return { setting: definition?.generalFakes, changes, repositoryPaths: Object.fromEntries((definition?.repositories ?? []).map((entry) => [entry.name, entry.path])) };
}

/** Whether mocks are in play for this task: the project's fakes are on, or the approved plan approved a mock. Otherwise nothing is flagged. */
export const mocksInPlay = (facts: MockSourceFacts): boolean => facts.setting?.enabled === true || plannedMocksOf(facts.changes).length > 0;

/** A path as the workspace names it, beside the repository-relative name: the two forms a spec may be written in. Exact paths only, never a suffix. */
function forms(path: string, repository: string, facts: MockSourceFacts): string[] {
  const own = facts.repositoryPaths !== undefined && Object.hasOwn(facts.repositoryPaths, repository) ? normal(facts.repositoryPaths[repository]!) : undefined;
  const name = normal(path);
  return own === undefined ? [name] : [name, `${own}/${name}`];
}

/**
 * Whether a changed file adds, changes, moves or removes a mock source the approved plan did not name. A mock source is an OpenAPI or Swagger description by name, a spec the project's setting names, or a spec the
 * plan names; it is "named" only when the approved plan names that exact path. A rename has two names and each side is judged: moving a mock source out of or into a path the plan does not name is flagged. Always false
 * where no mock is in play.
 */
export function isUnplannedMock(file: { repository: string; path: string; renamedFrom?: string | undefined }, facts: MockSourceFacts): boolean {
  if (!mocksInPlay(facts)) return false;
  const configured = new Set((facts.setting?.services ?? []).flatMap((service) => (service.spec === undefined ? [] : [normal(service.spec)])));
  const planned = new Set(plannedMocksOf(facts.changes).map((item) => normal(item.spec)));
  const isSource = (name: string): boolean => SPEC_NAME.test(name) || configured.has(name) || planned.has(name);
  const sideFlagged = (path: string): boolean => {
    const names = forms(path, file.repository, facts);
    return names.some(isSource) && !names.some((name) => planned.has(name));
  };
  return sideFlagged(file.path) || (file.renamedFrom !== undefined && sideFlagged(file.renamedFrom));
}

/** The files with `mockUnplanned: true` on each one `isUnplannedMock` says is. Pure; returns new objects only for the flagged files. */
export function flagUnplannedMocks<T extends { repository: string; path: string; renamedFrom?: string | undefined }>(files: readonly T[], facts: MockSourceFacts): Array<T & { mockUnplanned?: true }> {
  if (!mocksInPlay(facts)) return [...files];
  return files.map((file) => (isUnplannedMock(file, facts) ? { ...file, mockUnplanned: true as const } : file));
}

/** The one pull request line per approved mock (DEC 254z c: task-only, made by Rovara, not yet the project's setup). */
export const mockPrLines = (changes: PlanSetupChanges | undefined): string[] => plannedMocksOf(changes).map((item) => setupMockPrLine(item.service, undefined));
