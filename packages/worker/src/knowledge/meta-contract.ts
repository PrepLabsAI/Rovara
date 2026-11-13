// Knowledge resolver (K1, C2): the project/meta-repo contract this lane consumes from Lane A (project model, branch feat/mr-lane1).
//
// STUB. Lane A (tasks A1 and A3) adds `role: "meta"` to a project's repositories, the `knowledge` paths of `MetaProjectConfig`, and the
// broker's `knowledgeCommit` (the meta repo's default-branch head at task start) on the task record and the worker invocation. None of that
// is merged yet, so the resolver depends only on this small interface. When Lane A lands, one function, `metaRepoCheckoutOf`, changes:
// it reads the invocation's `knowledgeCommit` and the prepared meta repository instead of returning nothing. Nothing else in this lane moves.

import type { MetaSkillPin } from "@rovara-code/contracts";

/** The meta repo as the worker has it: a read-only, sparse checkout and the commit every stage reads it at. */
export interface MetaRepoCheckout {
  /** The repository's name in the project. */
  name: string;
  /** Its checkout folder, relative to the workspace root. */
  path: string;
  /** The default-branch head the broker pinned at task start. Rule files are read at this commit and hash-verified, never from the folder's files. */
  knowledgeCommit: string;
  /** `MetaProjectConfig.knowledge`: where the meta repo keeps its knowledge. Absent means the defaults of the readers. */
  knowledge?: {
    steering?: readonly string[];
    skills?: readonly string[];
    specs?: readonly string[];
    runbooks?: readonly string[];
    keyDocs?: readonly string[];
  };
  /** Skill digests the broker pinned at task start (optional): a skill whose text does not hash to its pin is left out. */
  skillPins?: readonly MetaSkillPin[];
}

/** What the worker knows about the task when it asks for the meta repo. Lane A will add the pinned commit here. */
export interface MetaRepoTaskContext {
  /** The prepared repositories (name and checkout folder), as the preparation manifest lists them. */
  repositories: readonly { name: string; path: string }[];
  /** `knowledgeCommit` from the invocation, once Lane A (A3) sends it. */
  knowledgeCommit?: string;
  /** The meta repository's name, once the project model (A1) marks one. */
  metaRepositoryName?: string;
  knowledge?: MetaRepoCheckout["knowledge"];
}

/**
 * The meta repo of this task, or undefined for a project that has none (every project until Lane A lands, and one-repo projects whose code
 * repo acts as its own meta repo, which the resolver reads as an ordinary repository).
 */
export function metaRepoCheckoutOf(context: MetaRepoTaskContext): MetaRepoCheckout | undefined {
  if (context.metaRepositoryName === undefined || context.knowledgeCommit === undefined) return undefined;
  const repository = context.repositories.find((candidate) => candidate.name === context.metaRepositoryName);
  if (repository === undefined) return undefined;
  return {
    name: repository.name,
    path: repository.path,
    knowledgeCommit: context.knowledgeCommit,
    ...(context.knowledge === undefined ? {} : { knowledge: context.knowledge }),
  };
}
