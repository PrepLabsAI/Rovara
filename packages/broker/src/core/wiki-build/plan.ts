// Wiki W3: which pages a build writes, and in what order. Pure: no model, no read. Built from the free file map (W0) and the run's pinned repositories.
//
// Stages (plan section 3.2, the brief): (1) the overview and one page per repository; (2) module pages, most active first; (3) "How the repos connect", only with two or more
// repositories. The page limit cuts module pages, never stage 1 or the connections page (their slots are held first).
//
// What can change the order, and what cannot:
//   - the file map's own activity rank (busiest first), then size for areas with no rank;
//   - a person's "write first" chips, and folders the "Tell Rovara what matters" notes name exactly (as `repo/path` or a folder path that is a whole token of the notes), go first;
//   - "skip" chips (generated folders, on by default; old folders, off by default) leave folders out.
// The notes are only ever matched as text against the map's own folder names: nothing in them adds a page, a path or a repository, and they never become wiki text.
import { createHash } from "node:crypto";
import { AGENTX_NAME_PATTERN, WikiPageIdSchema, type WikiFileMap, type WikiPagePlan } from "@agentx/contracts";

/** The store's page id of a repository's page. */
export const repoPageId = (repo: string): string => `repo-${repo}`;
/**
 * The store's page id of a module page: `m-<repo>-<folder as a slug>-<8 hex>`, at most 120 characters. The hash covers the exact repository and folder, so two folders whose slugs agree
 * (`src/a_b` and `src/a-b`) still get different pages.
 */
export function modulePageId(repo: string, path: string): string {
  const hash = createHash("sha256").update(`${repo}\0${path}`, "utf8").digest("hex").slice(0, 8);
  const slug = path.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
  const head = `m-${repo}-${slug}`.slice(0, 120 - 9).replace(/-+$/u, "");
  return `${head}-${hash}`;
}

/** The kinds of area a module page is written for. Tests, docs and config are read for other pages but get no page of their own. */
const MODULE_AREA_KINDS: ReadonlySet<string> = new Set(["source", "other"]);

export interface WikiPlanInput {
  map: WikiFileMap;
  /** The repositories the run reads (pinned at start). A map repository not in it gets no page. */
  repositories: readonly string[];
  /** Page limit of the run. */
  pages: number;
  /** The chip ids a person turned on, or undefined for the map's defaults (`defaultOn`). */
  chipsOn?: readonly string[] | undefined;
  notes?: string | undefined;
}

export interface WikiPlan {
  pages: WikiPagePlan[];
  /** Module pages that did not fit the page limit (or the map's per-repository cap). */
  modulesLeftOut: number;
  /** Areas left out by a skip chip. */
  skipped: number;
}

const isWholeToken = (text: string, token: string): boolean => {
  if (token === "") return false;
  for (let from = text.indexOf(token); from !== -1; from = text.indexOf(token, from + 1)) {
    const before = from === 0 ? "" : text[from - 1]!;
    const after = text[from + token.length] ?? "";
    const afterNext = text[from + token.length + 1] ?? "";
    // "src/api" in the notes names src/api, not src: a "/" after the token counts only when nothing name-like follows it ("src/" at a sentence end).
    const endsHere = !/[A-Za-z0-9_-]/u.test(after) && !(after === "/" && /[A-Za-z0-9_.-]/u.test(afterNext));
    if (!/[A-Za-z0-9_./-]/u.test(before) && endsHere) return true;
  }
  return false;
};

const underFolder = (path: string, folder: string): boolean => path === folder || path.startsWith(`${folder}/`);

/** The plan. Never throws; a map area whose name cannot be a page id is left out. */
export function planWikiPages(input: WikiPlanInput): WikiPlan {
  const pinned = new Set(input.repositories);
  const repos = input.map.repositories.filter((repo) => repo.status !== "unavailable" && pinned.has(repo.name) && AGENTX_NAME_PATTERN.test(repo.name));
  const chipsOn = input.chipsOn === undefined ? new Set(input.map.chips.filter((chip) => chip.defaultOn).map((chip) => chip.id)) : new Set(input.chipsOn);
  const activeChips = input.map.chips.filter((chip) => chipsOn.has(chip.id));
  const skips = activeChips.filter((chip) => chip.kind !== "write_first");
  const firsts = activeChips.filter((chip) => chip.kind === "write_first");
  const notes = (input.notes ?? "").normalize("NFKC");

  const stage1: WikiPagePlan[] = [
    { id: "overview", kind: "overview", stage: 1, position: 0, order: "fixed" },
    ...repos.map((repo, index): WikiPagePlan => ({ id: repoPageId(repo.name), kind: "repo", stage: 1, repo: repo.name, position: index + 1, order: "fixed" })),
  ];
  const connections: WikiPagePlan[] = repos.length >= 2 ? [{ id: "connections", kind: "connections", stage: 3, position: repos.length + 1, order: "fixed" }] : [];

  type Candidate = { page: WikiPagePlan; first: number; rank: number; files: number; commits: number };
  const candidates: Candidate[] = [];
  let skipped = 0;
  let overRepoCap = 0;
  const perRepoCap = Math.max(0, input.map.limits.modulePagesPerRepository);
  for (const repo of repos) {
    let taken = 0;
    for (const area of repo.areas) {
      if (!MODULE_AREA_KINDS.has(area.kind)) continue;
      const id = modulePageId(repo.name, area.path);
      if (!WikiPageIdSchema.safeParse(id).success) continue;
      if (skips.some((chip) => chip.repo === repo.name && underFolder(area.path, chip.path))) { skipped += 1; continue; }
      if (taken >= perRepoCap) { overRepoCap += 1; continue; }
      taken += 1;
      const chipFirst = firsts.findIndex((chip) => chip.repo === repo.name && underFolder(area.path, chip.path));
      const named = isWholeToken(notes, `${repo.name}/${area.path}`) || isWholeToken(notes, area.path);
      const first = chipFirst !== -1 ? chipFirst : named ? firsts.length : Number.POSITIVE_INFINITY;
      const order: WikiPagePlan["order"] = Number.isFinite(first) ? "write_first" : area.rank !== undefined ? "activity" : "size";
      candidates.push({ page: { id, kind: "module", stage: 2, repo: repo.name, path: area.path, parentId: repoPageId(repo.name), position: 0, order }, first, rank: area.rank ?? Number.POSITIVE_INFINITY, files: area.files, commits: area.commits ?? 0 });
    }
  }
  candidates.sort((a, b) => a.first - b.first || a.rank - b.rank || b.commits - a.commits || b.files - a.files || (a.page.id < b.page.id ? -1 : a.page.id > b.page.id ? 1 : 0));
  const room = Math.max(0, Math.floor(input.pages) - stage1.length - connections.length);
  const modules = candidates.slice(0, room).map((candidate, index) => ({ ...candidate.page, position: index }));
  const fixed = [...stage1, ...connections].slice(0, Math.max(0, Math.floor(input.pages)));
  const pages = [...fixed.filter((page) => page.stage === 1), ...modules, ...fixed.filter((page) => page.stage === 3)];
  return { pages, modulesLeftOut: Math.max(0, candidates.length - modules.length) + overRepoCap, skipped };
}
