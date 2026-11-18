// Lead 4 L4-LP3W: which code area a wiki page is about, so the page can show the team's lessons for it. Pure; no store, no model.
//   - A repository page (`repo-<name>`) is about the whole repository.
//   - A module page's id is `m-<repo>-<slug>-<8 hex>`, a hash of the exact repository and folder (`core/wiki-build/plan.ts` `modulePageId`), so the folder is found by trying every folder the page could be about
//     (the folders the project's lessons are anchored in and the folders of the files the page cites, with each parent) and keeping the one that hashes to this page's id. A folder that cannot be found is no area (the
//     page shows no lessons section), never a guess.
//   - Any other page (overview, connections, glossary, how to run...) is about no single area.
import { modulePageId, repoPageId } from "../core/wiki-build/plan.js";
import { areaPlacesOf } from "./area-index.js";
import type { LessonScope } from "./types.js";

export interface WikiPageAreaInput {
  pageId: string;
  kind: string;
  /** The repositories the page is about. */
  repos: readonly string[];
  /** The paths the page's claims cite (they all lie in the page's folder for a module page). */
  citedPaths: readonly string[];
  /** The scopes of the project's lessons whose folders could be this page's. */
  lessonScopes: readonly Pick<LessonScope, "repos" | "paths">[];
}

/** The folder and each parent of it (`a/b/c` -> `a/b/c`, `a/b`, `a`). */
function chain(folder: string): string[] {
  const parts = folder.split("/").filter((part) => part !== "");
  return parts.map((_, index) => parts.slice(0, parts.length - index).join("/"));
}

export function wikiPageArea(input: WikiPageAreaInput): { repo: string; folder: string } | undefined {
  if (input.kind === "repo") {
    const repo = input.repos.find((candidate) => repoPageId(candidate) === input.pageId);
    return repo === undefined ? undefined : { repo, folder: "" };
  }
  if (input.kind !== "module" || input.repos.length !== 1) return undefined;
  const repo = input.repos[0]!;
  const folders = new Set<string>();
  for (const path of input.citedPaths) for (const folder of chain(path.split("/").slice(0, -1).join("/"))) folders.add(folder);
  for (const scope of input.lessonScopes) {
    for (const place of areaPlacesOf(scope)) {
      if (place.repo !== undefined && place.repo !== repo) continue;
      for (const folder of chain(place.folder)) folders.add(folder);
    }
  }
  for (const folder of folders) if (modulePageId(repo, folder) === input.pageId) return { repo, folder };
  return undefined;
}
