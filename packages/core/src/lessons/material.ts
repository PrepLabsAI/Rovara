// Gathers what the renderer may rely on (render.ts VerifiedMaterial) through the facts port. The port reads the repository at the CITED commit, never
// a working tree. Any failure is "nothing verified", which means no lesson goes to tier 0.
import { pathsToVerify, type VerifiedMaterial } from "./render.js";
import type { CodeFacts } from "./ports.js";
import type { Lesson } from "./types.js";

export async function gatherMaterial(facts: CodeFacts, lesson: Lesson): Promise<VerifiedMaterial | undefined> {
  try {
    const identifiers = new Set<string>();
    for (const [index, citation] of lesson.citations.entries()) {
      if (citation.kind !== "code") continue;
      // Only a citation whose anchor was checked valid supplies identifiers.
      if (lesson.citationChecks?.some((c) => c.index === index && c.result === "valid") !== true) continue;
      const found = await facts.identifiers({ workspaceId: lesson.workspaceId, project: lesson.project, repo: citation.repo, commit: citation.commit, path: citation.path, startLine: citation.startLine, endLine: citation.endLine });
      for (const id of found ?? []) identifiers.add(id);
    }
    const commit = lesson.citations.find((c) => c.kind === "code")?.commit;
    const repo = lesson.citations.find((c) => c.kind === "code")?.repo;
    const paths = new Set<string>();
    if (commit !== undefined && repo !== undefined) {
      for (const path of pathsToVerify(lesson)) if ((await facts.pathExists({ workspaceId: lesson.workspaceId, project: lesson.project, repo, commit, path })) === true) paths.add(path);
    }
    const known = new Set(await facts.repositories(lesson.workspaceId, lesson.project));
    const repos = new Set((lesson.scope.repos ?? []).filter((r) => known.has(r)));
    return { identifiers, paths, repos };
  } catch {
    return undefined;
  }
}
