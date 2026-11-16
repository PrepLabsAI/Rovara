// TE-MR2b: cross-repository test selection, the wire shapes. The nightly's repository-less coverage map cannot say which repository a path or a test belongs to, so with changes in two repositories nothing could be
// selected. This map names a repository for EVERY path and for EVERY test: "this file of `lib` is touched by that test of `service`". The worker (verification/multi-repo-selection.ts) reads it only for a plan that
// carries it, only on a worker that lists `TEST_ENV_MULTI_REPO_FEATURE`, and only while the selection is switched on there; every other case runs the whole check, as before. Nothing here imports a Node module.
import { z } from "zod";
import { COVERAGE_MAP_BYTES_MAX, COVERAGE_MAP_FILES_MAX } from "./test-env-nightly.js";
import { TestIdSchema } from "./test-id.js";

/** A worker lists this when it reads `repositoryCoverageMap` and `checks[].repositoryId` of the task plan. A plan that carries either goes only to such a worker (its strict parse would refuse the field). */
export const TEST_ENV_MULTI_REPO_FEATURE = "task.testEnvMultiRepo.v1" as const;

/** The characters a repository id holds (the worker's own rule for the ids it derives edges for): no space, control or format character, none of the separators the selection builds keys from. */
export const REPOSITORY_ID_PATTERN = /^[A-Za-z0-9@/._~-]{1,200}$/u;
export const RepositoryIdSchema = z.string().regex(REPOSITORY_ID_PATTERN, "a repository id is 1 to 200 plain characters");

export const REPOSITORY_MAP_TESTS_MAX = 5_000;
/** One test of one repository. The same id can exist in two repositories: the repository tells them apart. */
export const RepositoryTestSchema = z.object({ repositoryId: RepositoryIdSchema, id: TestIdSchema }).strict();

/**
 * Which tests touch each source file, across repositories, from a run Rovara trusts. `entries[i]` is a file of `repositoryId` at `path` (a path of that repository, never of the workspace), touched by the listed tests,
 * each of a repository of its own. At most one entry per (repository, path). It is only ever as old as its `builtAt`.
 */
export const RepositoryCoverageMapSchema = z
  .object({
    builtAt: z.string().datetime(),
    entries: z.array(z.object({ repositoryId: RepositoryIdSchema, path: z.string().min(1).max(500), tests: z.array(RepositoryTestSchema).max(REPOSITORY_MAP_TESTS_MAX) }).strict()).max(COVERAGE_MAP_FILES_MAX),
  })
  .strict()
  .superRefine((map, context) => {
    const seen = new Set<string>();
    for (const [index, entry] of map.entries.entries()) {
      const key = JSON.stringify([entry.repositoryId, entry.path]);
      if (seen.has(key)) context.addIssue({ code: "custom", path: ["entries", index], message: "a path of a repository appears once" });
      seen.add(key);
    }
  })
  .refine((map) => JSON.stringify(map).length <= COVERAGE_MAP_BYTES_MAX, "a map is at most 8 MiB");
export type RepositoryCoverageMap = z.infer<typeof RepositoryCoverageMapSchema>;
