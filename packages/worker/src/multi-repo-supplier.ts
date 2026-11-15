import { AsyncLocalStorage } from "node:async_hooks";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { deriveRepositoryEdges, type RepositoryEdges } from "./multi-repo-edges.js";
import { withMultiRepoChecks, type MultiRepoChecks } from "./multi-repo-checks.js";
import type { CheckRunners } from "./verification/checks.js";
import { gitOriginalCode, type OriginalCodeRepository } from "./verification/original-code.js";

/** One supplier per invocation. Construction does not read manifests: the agent has not edited them yet. */
export function createRepositoryCheckSupplier(input: {
  rootPath: string; repositories: MultiRepoChecks["repositories"]; explicit?: Omit<MultiRepoChecks, "rootPath"> | undefined;
  nightly?: boolean; coveragePaths?: MultiRepoChecks["coveragePaths"];
}) {
  let derivation: Promise<RepositoryEdges> | undefined;
  let facts: RepositoryEdges | undefined;
  let recorded: RepositoryEdges | undefined;
  let notes: string[] = [];
  return {
    evidence: () => recorded,
    notes: () => notes,
    scope(base: CheckRunners): CheckRunners {
      const explicit = input.explicit;
      if (explicit !== undefined) {
        if (explicit.repositories.length !== input.repositories.length || input.repositories.some(repository => !explicit.repositories.some(selected => selected.repositoryId === repository.repositoryId && selected.path === repository.path && selected.baseCommit === repository.baseCommit))) throw new Error("multi-repository selection does not cover the prepared repositories");
        return withMultiRepoChecks({ ...explicit, rootPath: input.rootPath, coveragePaths: input.coveragePaths ?? explicit.coveragePaths }, base);
      }
      // Nightly remains single-repository; multi-repository nightly belongs to MR2b.
      if (input.nightly === true || input.repositories.length < 2) return base;
      if (base.kind !== "local") {
        notes = ["tested separately: multi-repository checks run only on the local runner for now"];
        return base;
      }
      let selected: CheckRunners | undefined;
      const phase = new AsyncLocalStorage<readonly OriginalCodeRepository[]>();
      const wrapper: CheckRunners = {
        ...base,
        originalCode: repositories => ({ run: work => {
          if (selected?.originalCode) return selected.originalCode(repositories).run(work);
          if (facts?.edges.length === 0) return gitOriginalCode(repositories).run(work);
          return phase.run(repositories, work);
        } }),
        async scopeRound(plan, signal, run, remainingMs) {
          recorded = undefined;
          if (derivation === undefined) {
            const contained = input.repositories.length <= 32 && input.repositories.every(repository => {
              if (typeof repository.path !== "string" || isAbsolute(repository.path)) return false;
              const path = relative(resolve(input.rootPath), resolve(input.rootPath, repository.path));
              return path !== "" && path !== ".." && !path.startsWith(`..${sep}`);
            });
            derivation = !contained
              ? Promise.resolve({ edges: [], notes: [input.repositories.length > 32 ? "too many repositories or dependencies; tested separately" : "dependency manifest unreadable"] })
              : deriveRepositoryEdges(input.repositories.map(repository => ({ name: repository.repositoryId, directory: resolve(input.rootPath, repository.path), baseCommit: repository.baseCommit })), { signal, remainingMs });
          }
          facts = await derivation; notes = facts.notes;
          if (signal.aborted || remainingMs() <= 0) throw new Error("aborted");
          const old = phase.getStore();
          if (facts.edges.length === 0) return old === undefined ? run(base) : gitOriginalCode(old).run(() => run(base));
          selected ??= withMultiRepoChecks({ rootPath: input.rootPath, repositories: input.repositories, dependencies: facts.edges, setup: [], coveragePaths: input.coveragePaths }, base);
          if (selected.reportRoot !== undefined) wrapper.reportRoot = selected.reportRoot.bind(selected);
          const execute = () => selected!.scopeRound!(plan, signal, run, remainingMs);
          const result = old === undefined ? await execute() : await selected.originalCode!(old).run(execute);
          recorded = facts;
          return result;
        },
      };
      return wrapper;
    },
  };
}
