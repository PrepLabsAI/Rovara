// Knowledge resolver (K1, C2): the session-side entry point. It turns the prepared repositories (and the meta repo, when the project has
// one) into the sources the resolver reads, runs it, and renders the result as the context files Pi is given.
//
// Which tree a repository is read from (design 3.3, trust rules):
// - judging stages (Understand, Plan check, Review) read each code repository at the broker's base commit, through the verified object
//   copy, and the working tree is compared only to tell the judge that the change edits a rule file (a notice, never the text);
// - Build reads its own checked-out files, as before;
// - the meta repo is always read at the pinned `knowledgeCommit`, hash-verified, and never from its folder's files.
// A base or knowledge commit that cannot be verified stops the stage with the existing fixed message: the working tree is never the fallback.
import { AgentXNameSchema, RelativeWorkspacePathSchema, agentXError } from "@agentx/contracts";
import { locateRepository, type RepositoryContextFile, type WorkspaceRepositoryReference } from "../repository-context.js";
import type { KnowledgeBudgets, KnowledgeItem, KnowledgeStage } from "./model.js";
import type { MetaRepoCheckout } from "./meta-contract.js";
import type { ReaderRegistry } from "./registry.js";
import { renderKnowledgeItems, type RenderRepository } from "./render.js";
import { resolveKnowledge, type FileInPlay, type KnowledgeSourceEntry, type ResolvedKnowledge } from "./resolve.js";
import { openBaseCommitSource, openWorkingTreeSource, type KnowledgeFileSource } from "./source.js";
import type { ReadOptions } from "../trusted-base-objects.js";
import type { AgentSkillFile } from "../agent-step.js";
import { createReaderRegistry } from "./registry.js";
import { loadMetaSkills } from "./skills.js";

export interface KnowledgeSessionInput {
  stage: KnowledgeStage;
  /** Where code repositories are read from; the meta repo is always read at its pinned commit. */
  at: "working-tree" | "base-commit";
  meta?: MetaRepoCheckout;
  /** Company, group and project rules ("How we work"), as items. */
  external?: readonly KnowledgeItem[];
  filesInPlay?: readonly FileInPlay[];
  manualNames?: ReadonlySet<string>;
  plannedAuto?: ReadonlySet<string>;
  registry?: ReaderRegistry;
  budgets?: KnowledgeBudgets;
  /** Test seam: options for the verified base reads (scratch placement, empty git directory). */
  baseReadOptions?: ReadOptions;
}

export interface LoadedKnowledgeContext {
  files: RepositoryContextFile[];
  diagnostics: string[];
  notices: string[];
  resolved: ResolvedKnowledge;
  rendering: RenderRepository[];
  /** The meta repo's skills for the session, read at the pinned commit. They grant no tools. */
  skills: AgentSkillFile[];
}

export const META_REPOSITORY_UNAVAILABLE_MESSAGE = "Rovara can't read the meta repo";

const INVALID_REPOSITORY_DIAGNOSTIC = "skipped a repository's rule files: its name or path is not valid";

interface OpenedKnowledge {
  sources: KnowledgeSourceEntry[];
  rendering: RenderRepository[];
  diagnostics: string[];
  close(): Promise<void>;
}

/** Opens every source the stage reads (the meta repo at its pinned commit first, then each code repository). The caller must `close()`. */
export async function openKnowledgeSources(
  repositories: readonly WorkspaceRepositoryReference[],
  input: Pick<KnowledgeSessionInput, "at" | "meta" | "baseReadOptions" | "registry">,
  canonicalRoot: string,
): Promise<OpenedKnowledge> {
  const diagnostics: string[] = [];
  const opened: KnowledgeFileSource[] = [];
  const sources: KnowledgeSourceEntry[] = [];
  const rendering: RenderRepository[] = [];
  const close = async (): Promise<void> => { await Promise.all(opened.map((source) => source.close().catch(() => undefined))); };
  const baseOptions: ReadOptions = { workspaceRoot: canonicalRoot, ...(input.baseReadOptions ?? {}) };
  const registry = input.registry ?? createReaderRegistry();
  try {
    // The meta repo first: a project that has one never runs without it.
    if (input.meta !== undefined) {
      const located = AgentXNameSchema.safeParse(input.meta.name).success && RelativeWorkspacePathSchema.safeParse(input.meta.path).success
        ? await locateRepository(canonicalRoot, { name: input.meta.name, path: input.meta.path })
        : { diagnostic: INVALID_REPOSITORY_DIAGNOSTIC };
      if (located.directory === undefined) throw agentXError("CONFIG_INVALID", `${META_REPOSITORY_UNAVAILABLE_MESSAGE} ${AgentXNameSchema.safeParse(input.meta.name).success ? input.meta.name : ""}`.trim());
      const source = await openBaseCommitSource(located.directory, input.meta.knowledgeCommit, "knowledgeCommit", baseOptions);
      opened.push(source);
      const defaults = new Set(registry.directories());
      const custom = (input.meta.knowledge?.steering ?? []).map((path) => path.replace(/\/+$/u, "")).filter((path) => path !== "" && !defaults.has(path));
      sources.push({ name: input.meta.name, path: input.meta.path, layer: "meta", source, extraRuleDirectories: custom });
      rendering.push({ name: input.meta.name, path: input.meta.path, meta: { knowledgeCommit: input.meta.knowledgeCommit } });
    }
    for (const repository of repositories) {
      if (input.meta !== undefined && repository.name === input.meta.name) continue;
      // The name and path reach the model (labels); an entry settings would refuse reaches nothing.
      if (!AgentXNameSchema.safeParse(repository.name).success || !RelativeWorkspacePathSchema.safeParse(repository.path).success) {
        diagnostics.push(INVALID_REPOSITORY_DIAGNOSTIC);
        continue;
      }
      const located = await locateRepository(canonicalRoot, repository);
      if (located.diagnostic) { diagnostics.push(located.diagnostic); continue; }
      if (located.directory === undefined) continue;
      if (input.at === "base-commit") {
        if (repository.baseCommit === undefined) {
          diagnostics.push(`skipped the context file of ${repository.name}: no usable base commit`);
          continue;
        }
        const source = await openBaseCommitSource(located.directory, repository.baseCommit, "base", baseOptions);
        opened.push(source);
        sources.push({ name: repository.name, path: repository.path, layer: "repo", source, compareWith: openWorkingTreeSource(located.directory) });
      } else {
        const source = openWorkingTreeSource(located.directory);
        opened.push(source);
        sources.push({ name: repository.name, path: repository.path, layer: "repo", source });
      }
      rendering.push({ name: repository.name, path: repository.path });
    }
    return { sources, rendering, diagnostics, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function loadKnowledgeContext(
  rootPath: string,
  repositories: readonly WorkspaceRepositoryReference[],
  input: KnowledgeSessionInput,
  canonicalRoot: string,
): Promise<LoadedKnowledgeContext> {
  const opened = await openKnowledgeSources(repositories, input, canonicalRoot);
  try {
    const resolved = await resolveKnowledge({
      stage: input.stage,
      sources: opened.sources,
      ...(input.external === undefined ? {} : { external: input.external }),
      ...(input.filesInPlay === undefined ? {} : { filesInPlay: input.filesInPlay }),
      ...(input.manualNames === undefined ? {} : { manualNames: input.manualNames }),
      ...(input.plannedAuto === undefined ? {} : { plannedAuto: input.plannedAuto }),
      ...(input.registry === undefined ? {} : { registry: input.registry }),
      ...(input.budgets === undefined ? {} : { budgets: input.budgets }),
    });
    const diagnostics = [...opened.diagnostics, ...resolved.diagnostics];
    let skills: AgentSkillFile[] = [];
    const metaEntry = input.meta === undefined ? undefined : opened.sources.find((entry) => entry.layer === "meta");
    if (input.meta !== undefined && metaEntry !== undefined) {
      const found = await loadMetaSkills({
        source: metaEntry.source, repo: input.meta.name, commit: input.meta.knowledgeCommit,
        ...(input.meta.knowledge?.skills === undefined ? {} : { directories: input.meta.knowledge.skills }),
        ...(input.meta.skillPins === undefined ? {} : { pins: input.meta.skillPins }),
        ...(input.registry === undefined ? {} : { registry: input.registry }),
      });
      skills = found.skills;
      resolved.skills = found.snapshots;
      resolved.skippedSkills = found.skipped;
    }
    return { skills, files: renderKnowledgeItems(resolved.items, opened.rendering, rootPath), diagnostics, notices: resolved.notices, resolved, rendering: opened.rendering };
  } finally {
    await opened.close();
  }
}
