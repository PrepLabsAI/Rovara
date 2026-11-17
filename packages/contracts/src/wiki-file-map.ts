// Wiki W0 (DEC 254zh, 254zi): the free file map and forecast of a project. NO model call, nothing stored, no dollar figure.
//
// Read through the code host at ONE fixed commit per repository (the default branch's head when the map was made). Honesty rules, held by the code that builds a map and by this schema:
//   - A map that is not whole says so: `status: "partial"` names why in `partial` (a short plain sentence). A map is never presented as complete when the code host cut a listing or Rovara ran out of its own bounds.
//   - Secret-shaped files (`.env`, key files and the like) are never listed: not by name, not by path. Only a count (`skipped.secret`) is kept.
//   - Everything is per company AND project. A map is read by project role (any), made by project administrators and company owners and admins.
//   - The forecast gives page counts. `price` is a fixed "not priced yet" word: the contract carries NO dollar amount, so no screen can show one until a later lane adds it on purpose.
import { z } from "zod";

/** The window the activity ranking looks at, in days. */
export const WIKI_MAP_ACTIVITY_DAYS = 90;
/** Bounds (all shown in the map's `limits`): repositories mapped, areas listed per repository, commit-count request budget per project, module pages per repository and pages per project. */
export const WIKI_MAP_LIMITS = { repositories: 20, areasPerRepository: 40, activityRequests: 160, modulePagesPerRepository: 40, pagesPerProject: 300, directoryWalkRequests: 80, directoryWalkDepth: 6, treeEntries: 200_000 } as const;

const line = (max: number) => z.string().min(1).max(max).regex(/^[^\p{Cc}\p{Cf}]*$/u, "one plain line");
const count = z.number().int().min(0).max(10_000_000);

export const WIKI_MAP_AREA_KINDS = ["source", "tests", "docs", "config", "other"] as const;
export const WikiMapAreaSchema = z.object({
  /** A folder from the repository root (`/` between names). Never a secret-shaped name. */
  path: line(300),
  files: count,
  kind: z.enum(WIKI_MAP_AREA_KINDS),
  /** Commits that touched the area in the window (at most 100: see `commitsCapped`). Absent: not measured (the activity part says why). */
  commits: z.number().int().min(0).max(100).optional(),
  commitsCapped: z.boolean().optional(),
  /** When the area last changed (an ISO time), when the code host said. */
  lastChangeAt: z.string().max(40).optional(),
  /** 1 = the busiest. Absent when activity was not measured for this area. */
  rank: z.number().int().min(1).max(1000).optional(),
}).strict();
export type WikiMapArea = z.infer<typeof WikiMapAreaSchema>;

export const WikiMapLanguageSchema = z.object({ language: line(40), files: count, percent: z.number().min(0).max(100) }).strict();

export const WIKI_MAP_REPO_STATUSES = ["ok", "partial", "unavailable"] as const;
export const WikiMapRepoSchema = z.object({
  /** The repository's name in the project and its address (never a token or a query). */
  name: line(100),
  url: line(300),
  status: z.enum(WIKI_MAP_REPO_STATUSES),
  /** Why the map is not whole: "partial: <reason>". Present exactly when `status` is "partial". */
  partial: line(300).optional(),
  /** Present exactly when `status` is "unavailable": a fixed plain sentence (no cause is echoed). */
  unavailable: line(200).optional(),
  branch: line(200).optional(),
  /** The commit the map was read at (40 hex). */
  commit: z.string().regex(/^[a-f0-9]{40}$/u).optional(),
  /** Files counted: everything not skipped. */
  files: count,
  /** Files not counted, by why. `assets`: images, fonts, archives and other binary files. `secret`: a count only, never a name. */
  skipped: z.object({ generated: count, vendored: count, lockfiles: count, assets: count, secret: count }).strict(),
  languages: z.array(WikiMapLanguageSchema).max(9),
  /** The biggest areas (folders) by file count, at most `limits.areasPerRepository`. Module pages are made for the source ones, in this order of activity. */
  areas: z.array(WikiMapAreaSchema).max(WIKI_MAP_LIMITS.areasPerRepository),
  testFolders: z.array(line(300)).max(10),
  /** Generated and vendored folders that were skipped (paths only, never secret-shaped ones). */
  skippedFolders: z.array(line(300)).max(20),
  /** How the activity ranking went: "ok", or "partial"/"unavailable" with the reason. */
  activity: z.object({ status: z.enum(["ok", "partial", "unavailable"]), reason: line(200).optional(), days: z.literal(WIKI_MAP_ACTIVITY_DAYS) }).strict(),
  /** Pages a wiki would write for this repository: the repository page plus module pages. */
  pages: z.object({ repository: z.literal(1), modules: count, modulesCapped: z.boolean() }).strict(),
}).strict();
export type WikiMapRepo = z.infer<typeof WikiMapRepoSchema>;

/** The chips under "Tell Rovara what matters". `defaultOn`: generated and vendored folders are skipped unless the person turns that off; the other two are suggestions that start off. */
export const WIKI_MAP_CHIP_KINDS = ["write_first", "skip_old", "skip_generated"] as const;
export const WikiMapChipSchema = z.object({
  id: line(80),
  kind: z.enum(WIKI_MAP_CHIP_KINDS),
  repo: line(100),
  path: line(300),
  /** "Write these first?" or "Skip?" followed by the folder, as a person reads it. */
  label: line(200),
  defaultOn: z.boolean(),
}).strict();
export type WikiMapChip = z.infer<typeof WikiMapChipSchema>;

export const WikiFileMapSchema = z.object({
  version: z.literal(1),
  project: line(100),
  /** An ISO time. */
  computedAt: z.string().max(40),
  repositories: z.array(WikiMapRepoSchema).max(WIKI_MAP_LIMITS.repositories),
  /** False when any repository is partial or unavailable, or the project has more repositories than `limits.repositories`. */
  complete: z.boolean(),
  /** Set when the project has more repositories than were mapped. */
  repositoriesOmitted: count,
  chips: z.array(WikiMapChipSchema).max(200),
  forecast: z.object({
    repositories: count,
    files: count,
    /** Pages a build would write: a start page, the repository pages, module pages (capped per repository and per project), a cross-repository page when there are two or more repositories, and three fixed project pages. */
    pages: count,
    pagesCapped: z.boolean(),
    /** No dollar amount is carried. */
    price: z.literal("not_priced_yet"),
  }).strict(),
  limits: z.object({ activityDays: z.literal(WIKI_MAP_ACTIVITY_DAYS), modulePagesPerRepository: z.number().int(), pagesPerProject: z.number().int(), areasPerRepository: z.number().int() }).strict(),
}).strict();
export type WikiFileMap = z.infer<typeof WikiFileMapSchema>;

/** `GET /v1/app/projects/{project}/wiki-map`: the map last made for this project (kept a short while), or none. `canManage`: this person may make one (`POST`). */
export const WikiFileMapViewSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("none"), canManage: z.boolean() }).strict(),
  z.object({ status: z.literal("ready"), canManage: z.boolean(), map: WikiFileMapSchema }).strict(),
]);
export type WikiFileMapView = z.infer<typeof WikiFileMapViewSchema>;

/** Fixed words for a refusal (nothing from the cause is echoed). */
export const WIKI_MAP_NOT_ALLOWED = "Only company owners and admins, or this project's admins, can map a project's files.";
export const WIKI_MAP_PROJECT_NOT_FOUND = "project not found";
export const WIKI_MAP_UNAVAILABLE = "The project's files could not be mapped just now. Try again.";
