// Knowledge resolver (K1, C2): resolved items as the context files Pi puts in the prompt.
//
// A root AGENTS.md or CLAUDE.md of a code repository renders exactly as the single-file loader did (same label, same path), so what a
// repository's authors already see does not move. Every other item says which file it is, where its guidance applies and, for a
// pattern rule, which patterns select it. Names and paths from the repository are inert text (no hidden characters, no angle brackets).
import { join } from "node:path";
import { inertLabel } from "../context-text.js";
import type { RepositoryContextFile } from "../repository-context.js";
import type { KnowledgeItem } from "./model.js";

export interface RenderRepository {
  name: string;
  path: string;
  /** A meta repo is labelled as the project's, with the commit it is pinned at. */
  meta?: { knowledgeCommit: string };
}

const LAYER_NAMES: Readonly<Record<string, string>> = { company: "company", group: "group", project: "project" };

export function renderKnowledgeItem(item: KnowledgeItem, repositories: ReadonlyMap<string, RenderRepository>, rootPath: string): RepositoryContextFile {
  const repository = item.repo === undefined ? undefined : repositories.get(item.repo);
  if (repository === undefined || item.path === undefined) {
    const layer = LAYER_NAMES[item.layer] ?? "team";
    const label = item.locked === true ? `Required ${layer} rule` : `${layer[0]!.toUpperCase()}${layer.slice(1)} rule`;
    const name = item.name === undefined ? "" : ` "${inertLabel(item.name)}"`;
    return { path: `Rovara ${layer} rule${item.name === undefined ? "" : `: ${inertLabel(item.name)}`}`, content: `${label}${name}, from your team's "How we work" settings.\n\n${item.text}` };
  }
  const repoName = inertLabel(repository.name);
  const repoPath = inertLabel(repository.path);
  const file = inertLabel(item.path);
  const scope = item.scopeDir === "" ? repoPath : `${repoPath}/${inertLabel(item.scopeDir)}`;
  const absolute = join(rootPath, repository.path, item.path);
  if (repository.meta !== undefined) {
    const commit = repository.meta.knowledgeCommit.slice(0, 12);
    const applies = item.activation === "fileMatch" && item.patterns !== undefined && item.scopeDir === ""
      ? `Its guidance applies to files matching ${item.patterns.map((pattern) => `"${inertLabel(pattern)}"`).join(", ")} in any of the project's repositories.`
      : item.scopeDir === "" ? "Its guidance applies to the whole project." : `Its guidance applies to the files under ${inertLabel(item.scopeDir)} of the meta repository.`;
    return { path: absolute, content: `${file} of the project's meta repository "${repoName}" (pinned at ${commit}). ${applies}\n\n${item.text}` };
  }
  const applies = item.activation === "fileMatch" && item.patterns !== undefined && item.scopeDir === ""
    ? `Its guidance applies to files matching ${item.patterns.map((pattern) => `"${inertLabel(pattern)}"`).join(", ")} in this repository.`
    : `Its guidance applies to the files under ${scope}.`;
  return { path: absolute, content: `${file} of the "${repoName}" repository, checked out at ${repoPath} in this workspace. ${applies}\n\n${item.text}` };
}

export function renderKnowledgeItems(items: readonly KnowledgeItem[], repositories: readonly RenderRepository[], rootPath: string): RepositoryContextFile[] {
  const byName = new Map(repositories.map((repository) => [repository.name, repository] as const));
  return items.map((item) => renderKnowledgeItem(item, byName, rootPath));
}
