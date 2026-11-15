import { AsyncLocalStorage } from "node:async_hooks";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { deriveRepositoryEdges, type RepositoryEdges } from "./multi-repo-edges.js";
import { MultiRepoUnavailableError, withMultiRepoChecks, type MultiRepoChecks } from "./multi-repo-checks.js";
import type { MultiRepoFallbackNote } from "@agentx/contracts";
import type { CheckRunners } from "./verification/checks.js";
import { gitOriginalCode, type OriginalCodeRepository } from "./verification/original-code.js";

/**
 * Whether a local multi-repository task with derived edges runs its check rounds in MR1's candidate-bound check root (multi-repo-checks.ts).
 * ON (MR1-LIVE): the check root carries the workspace's installed dependency folders (multi-repo-dependencies.ts), and any refusal before a check runs, or a
 * failed dependency wiring setup, falls back to today's per-repository path with a fixed "multi-repo check not run: <reason>" note in the evidence.
 * Off (tests only, `live: false`): checks run exactly as before on every path and the derived edges are only recorded in the evidence.
 */
export const MULTI_REPO_CHECKS_LIVE: boolean = true;

/** The most an evidence-time derivation may take, whatever the round has left (it is informational and never changes a check). */
export const EVIDENCE_EDGES_MAX_MS = 15_000;

/** One supplier per invocation. Construction does not read manifests: the agent has not edited them yet. */
export function createRepositoryCheckSupplier(input: {
  rootPath: string; repositories: MultiRepoChecks["repositories"]; explicit?: Omit<MultiRepoChecks, "rootPath"> | undefined;
  nightly?: boolean; coveragePaths?: MultiRepoChecks["coveragePaths"];
  /** Tests only; production always takes MULTI_REPO_CHECKS_LIVE. */
  live?: boolean;
}) {
  const live = input.live ?? MULTI_REPO_CHECKS_LIVE;
  let derivation: Promise<RepositoryEdges> | undefined;
  let facts: RepositoryEdges | undefined;
  let recorded: RepositoryEdges | undefined;
  let notes: string[] = [];
  const automatic = (kind: CheckRunners["kind"]) => input.explicit === undefined && input.nightly !== true && input.repositories.length >= 2 && (kind ?? "local") === "local";
  const contained = () => input.repositories.length <= 32 && input.repositories.every(repository => {
    if (typeof repository.path !== "string" || isAbsolute(repository.path)) return false;
    const path = relative(resolve(input.rootPath), resolve(input.rootPath, repository.path));
    return path !== "" && path !== ".." && !path.startsWith(`..${sep}`);
  });
  const derive = (signal: AbortSignal, remainingMs: () => number): Promise<RepositoryEdges> => !contained()
    ? Promise.resolve({ edges: [], notes: [input.repositories.length > 32 ? "too many repositories or dependencies; tested separately" : "dependency manifest unreadable"] })
    : deriveRepositoryEdges(input.repositories.map(repository => ({ name: repository.repositoryId, directory: resolve(input.rootPath, repository.path), baseCommit: repository.baseCommit })), { signal, remainingMs });
  return {
    /**
     * The repository edges for this round's evidence. Live: the edges the round's check scope used. Off: derived now, from the base and the candidate
     * as they stand after the round, within the given budget; nothing when there is no edge, the derivation is refused, or the budget runs out.
     */
    async evidence(round: { kind: CheckRunners["kind"]; signal: AbortSignal; budgetMs: number }): Promise<RepositoryEdges | undefined> {
      if (live) return recorded;
      if (!automatic(round.kind) || round.signal.aborted || round.budgetMs <= 0) return undefined;
      const deadline = Date.now() + Math.min(round.budgetMs, EVIDENCE_EDGES_MAX_MS);
      const derived = await derive(round.signal, () => deadline - Date.now()).catch(() => undefined);
      return derived !== undefined && derived.edges.length > 0 ? derived : undefined;
    },
    notes: () => notes,
    scope(base: CheckRunners): CheckRunners {
      const explicit = input.explicit;
      if (explicit !== undefined) {
        if (explicit.repositories.length !== input.repositories.length || input.repositories.some(repository => !explicit.repositories.some(selected => selected.repositoryId === repository.repositoryId && selected.path === repository.path && selected.baseCommit === repository.baseCommit))) throw new Error("multi-repository selection does not cover the prepared repositories");
        return withMultiRepoChecks({ ...explicit, rootPath: input.rootPath, coveragePaths: input.coveragePaths ?? explicit.coveragePaths }, base);
      }
      // Off: the exact runners on every automatic path; the edges are recorded at evidence time only.
      if (!live) return base;
      // Nightly remains single-repository; multi-repository nightly belongs to MR2b.
      if (input.nightly === true || input.repositories.length < 2) return base;
      if (base.kind !== "local") {
        notes = ["tested separately: multi-repository checks run only on the local runner for now"];
        return base;
      }
      let selected: CheckRunners | undefined;
      // MR1-LIVE: once a round falls back (a refusal before any check, or a failed dependency wiring setup), every later round of this invocation takes today's
      // per-repository path too, so a candidate round and its original-code rounds are never measured in two different places.
      let fallback: MultiRepoFallbackNote | undefined;
      // `pending`: an original-code phase nothing has applied yet (this round decides where). `inSelected`: one MR1's check root is applying in its copies;
      // the workspace itself is still the candidate, so a fallback inside it must apply the original code itself.
      const pending = new AsyncLocalStorage<readonly OriginalCodeRepository[]>();
      const inSelected = new AsyncLocalStorage<readonly OriginalCodeRepository[]>();
      const ordinaryOriginalCode = base.originalCode ?? gitOriginalCode;
      const ordinaryReports = () => { if (base.reportRoot === undefined) delete wrapper.reportRoot; else wrapper.reportRoot = base.reportRoot.bind(base); };
      const wrapper: CheckRunners = {
        ...base,
        originalCode: repositories => ({ run: work => {
          if (fallback !== undefined) return ordinaryOriginalCode(repositories).run(work);
          if (selected?.originalCode) { const own = selected.originalCode(repositories); return inSelected.run(repositories, () => own.run(work)); }
          if (facts?.edges.length === 0) return ordinaryOriginalCode(repositories).run(work);
          return pending.run(repositories, work);
        } }),
        async scopeRound(plan, signal, run, remainingMs) {
          recorded = undefined;
          derivation ??= derive(signal, remainingMs);
          // Only a finished derivation is kept: one that ran out of this round's budget is derived again by the next round, under its own budget.
          try { facts = await derivation; } catch (error) { derivation = undefined; throw error; }
          notes = facts.notes;
          if (signal.aborted || remainingMs() <= 0) throw new Error("aborted");
          const old = pending.getStore();
          if (facts.edges.length === 0) return old === undefined ? run(base) : ordinaryOriginalCode(old).run(() => run(base));
          if (fallback === undefined) {
            selected ??= withMultiRepoChecks({ rootPath: input.rootPath, repositories: input.repositories, dependencies: facts.edges, setup: [], coveragePaths: input.coveragePaths }, base, { fallBack: true });
            if (selected.reportRoot !== undefined) wrapper.reportRoot = selected.reportRoot.bind(selected);
            const execute = () => selected!.scopeRound!(plan, signal, run, remainingMs);
            try {
              const result = old === undefined ? await execute() : await selected.originalCode!(old).run(execute);
              recorded = facts;
              return result;
            } catch (error) {
              if (!(error instanceof MultiRepoUnavailableError)) throw error;
              fallback = error.reason;
            }
          }
          // Today's path: the ordinary runners in the shared workspace, its ordinary reports, and the reason in the evidence and progress notes.
          ordinaryReports();
          const found = facts;
          const fallbackNotes = [...new Set<RepositoryEdges["notes"][number]>([...found.notes, fallback])].slice(0, 8);
          notes = fallbackNotes;
          const selection = old ?? inSelected.getStore();
          const result = selection === undefined ? await run(base) : await ordinaryOriginalCode(selection).run(() => run(base));
          recorded = { edges: found.edges, notes: fallbackNotes };
          return result;
        },
      };
      return wrapper;
    },
  };
}
