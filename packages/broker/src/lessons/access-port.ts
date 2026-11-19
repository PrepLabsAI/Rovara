// The ONE access-check seam of the lessons library, for the readers of lessons (the loader, the weekly digest and the panel). A lesson's own audience is a frozen snapshot taken when
// it was learned; this seam asks NOW, for the places the lesson was learned from, so a person who lost access to a place stops getting that place's lessons. A restricted place needs an
// answer of its own: where nothing can say, the answer is no. A record that cannot be read throws RUNTIME_UNAVAILABLE (the caller must not read that as "visible", nor as "hidden").
//
// Code runs as one person on their own machine (`createLocalAccessCheck`): that person reads every place their own tools could read; a reader that is nobody in particular (a pull
// request description that everyone with access to the repository reads) reads only places nothing restricts. A hosted install fills the seam with its own permission records.
import type { OrgId } from "@agentx/contracts";

/** What may see a task: everyone in the project, the owner alone, or the owner and named people. */
export type TaskVisibility =
  | { kind: "shared" }
  | { kind: "private"; ownerDeveloperId: string }
  | { kind: "shared_with"; developerIds: readonly string[] };

/** The live visibility of tasks. A task missing from the answer, or mapped to `undefined`, is unreadable. May throw: that reads as unreadable for every task asked about. */
export interface TaskVisibilityPort {
  /** `signal` aborts when the caller stops waiting (a timeout): the port should stop starting new reads then (the answers are no longer used). */
  read(orgId: OrgId, taskIds: readonly string[], options?: { signal?: AbortSignal }): Promise<ReadonlyMap<string, TaskVisibility | undefined>>;
}

/** The places one thing (a lesson) was learned from. */
export interface AccessPlaces {
  /** Every place it came from, restricted or not (the places above each are checked too). */
  scopes: readonly string[];
  /** Of those, the places whose own access record it requires: a missing record denies. */
  restrictedScopes: readonly string[];
  /** When the snapshot it carries was read (used only for a place whose member list was never seeded). */
  capturedAt?: string | undefined;
}

export interface AccessViewerLists {
  principals: readonly string[];
  groups: readonly string[];
}

export interface AccessCheckPort {
  /**
   * One answer per entry of `places`: whether the viewer may read every place in it right now. A viewer of `undefined` is a shared task (nobody in particular): it may read only
   * places no record restricts. Throws RUNTIME_UNAVAILABLE when a record cannot be read.
   */
  mayRead(orgId: OrgId, viewer: AccessViewerLists | undefined, places: readonly AccessPlaces[]): Promise<boolean[]>;
  /** The strict reader of tasks' LIVE visibility. `readVisible` also asks it about every task a lesson was learned from (`live-visibility.ts`); without it such a lesson is withheld. */
  readonly taskVisibility: TaskVisibilityPort;
}

/**
 * The access check of one person on one machine. The person (any viewer: there is only one) may read every place a lesson was learned from: the lessons were captured by their own tools
 * with their own access. Nobody in particular may read only the places that nothing restricts, so a place the capture marked as restricted (a private repository, an unknown source)
 * never reaches a pull request description. The tasks' visibility is the owner's alone and shared project-wide: all of them exist for the one person.
 */
export function createLocalAccessCheck(options: { taskVisibility?: TaskVisibilityPort } = {}): AccessCheckPort {
  return {
    taskVisibility: options.taskVisibility ?? { async read(_orgId, taskIds) { return new Map(taskIds.map((id) => [id, { kind: "shared" as const }])); } },
    async mayRead(_orgId, viewer, places) {
      return places.map((place) => viewer !== undefined || place.restrictedScopes.length === 0);
    },
  };
}
