// Lessons in the repo (owner decisions 50, 50a, 50b): what the Lessons tab, the API and the CLI (`lessons repo status|on|off|resume`) read and send for the
// Rovara-owned `.rovara/lessons.md` and its weekly batched pull request.
// Browser-safe: nothing here imports a Node module. Request bodies are strict; the answer has a forward reader. Every text is a FIXED sentence chosen by a code: no lesson text, no person and no host text ever rides here.
import { z } from "zod";
import { forwardReader } from "./forward-reader.js";

/** The file is capped at this many lessons and this many bytes: adds stop at a cap, removals never do. */
export const LESSON_FILE_MAX_LESSONS = 300;
export const LESSON_FILE_MAX_BYTES = 64 * 1024;
/** After this many weekly pull requests in a row that nobody merged, Rovara stops proposing additions and edits (removals still go out). */
export const LESSON_FILE_UNMERGED_LIMIT = 3;

/** Why Rovara cannot work on a repository's file right now: a fixed code, never host text. */
export const LESSON_FILE_PROBLEMS = [
  "host_cannot_write", "repository_unreadable", "file_unreadable", "file_too_big", "file_is_link", "pointer_unreadable", "audit_down", "names_unreadable", "conflict", "write_refused", "repository_gone", "state_unreadable",
] as const;
export type LessonFileProblem = (typeof LESSON_FILE_PROBLEMS)[number];
export const LESSON_FILE_PROBLEM_TEXT: Record<LessonFileProblem, string> = {
  host_cannot_write: "Rovara cannot write to this repository's code host, so it proposes nothing here",
  repository_unreadable: "Rovara could not read the repository",
  file_unreadable: "Rovara could not read .rovara/lessons.md",
  file_too_big: ".rovara/lessons.md is over 64 KB, so Rovara left it alone",
  file_is_link: ".rovara/lessons.md is a link or a folder, so Rovara left it alone",
  pointer_unreadable: "Rovara could not read an agent instructions file to add the pointer",
  audit_down: "The audit log is not reachable, so this week's pull request waits",
  names_unreadable: "Rovara could not read the project's people, so this week's pull request waits",
  conflict: "The repository changed while Rovara was writing; it tries again next time",
  write_refused: "The code host refused the write; it tries again next time",
  repository_gone: "This repository is no longer part of the project",
  state_unreadable: "Rovara's record for this repository is full or unreadable, so it did nothing here; ask for support",
};

/** The fixed sentences for the two lists above. */
export const unreachableRepoText = (repo: string, lessons: number): string => lessons > 0
  ? `Rovara can't reach ${repo} to remove ${String(lessons)} deleted ${lessons === 1 ? "lesson" : "lessons"}; it tries again every week`
  : `Rovara can't reach ${repo} to check it for deleted lessons; it tries again every week`;
export const closesHeldText = (repo: string, count: number): string =>
  `Rovara did not close ${String(count)} of its pull ${count === 1 ? "request" : "requests"} in ${repo} because the code host could not show ${count === 1 ? "it" : "them"} or did not say Rovara made ${count === 1 ? "it" : "them"}; it tries again`;
export const strayBranchesText = (repo: string, branches: number): string =>
  `${String(branches)} ${branches === 1 ? "branch" : "branches"} Rovara made in ${repo} cannot be matched to a pull request on this code host, so they are not checked for deleted lessons`;

/** Why a switched-on repository does nothing yet: lessons are off for the whole installation, or only for this project. The choice is recorded either way, so the file starts later with nothing lost. */
export const LESSON_FILE_WAITING_FOR = ["install", "project"] as const;
export type LessonFileWaitingFor = (typeof LESSON_FILE_WAITING_FOR)[number];
export const LESSON_FILE_WAITING_TEXT: Record<LessonFileWaitingFor, string> = {
  install: "The lessons file starts when lessons are switched on for this installation.",
  project: "The lessons file starts when lessons are switched on for this project.",
};
/** The sentence for a row's `waitingFor`; a value this reader does not know (a newer server) shows nothing. */
export const lessonFileWaitingText = (waitingFor: string | undefined): string | undefined => waitingFor === "install" || waitingFor === "project" ? LESSON_FILE_WAITING_TEXT[waitingFor] : undefined;

export const LESSON_FILE_POINTER_STATES = ["not_yet", "added", "missing", "declined"] as const;
export type LessonFilePointerState = (typeof LESSON_FILE_POINTER_STATES)[number];

export const LessonsRepoFilePrSchema = z.object({
  number: z.string().min(1).max(40),
  /** The pull request's address as the code host gave it (https only; empty when it gave none). */
  url: z.string().max(2_048),
  removals: z.number().int().min(0), edits: z.number().int().min(0), adds: z.number().int().min(0),
  openedAt: z.number(),
}).strict();

export const LessonsRepoFileRowSchema = z.object({
  /** The project's name for the repository. */
  repo: z.string().min(1).max(200),
  enabled: z.boolean(),
  /** The team deleted the file: Rovara stopped until someone resumes it. */
  fileDeleted: z.boolean(),
  /** Pull requests in a row that nobody merged; at 3, new lessons and edits are paused. */
  unmerged: z.number().int().min(0),
  additionsPaused: z.boolean(),
  /** Removals waiting in the open pull request. */
  removalsWaiting: z.number().int().min(0),
  /** Lessons the team edited in the file: Rovara leaves them exactly as written. */
  held: z.number().int().min(0),
  pointer: z.enum(LESSON_FILE_POINTER_STATES),
  /** Pull requests that remove deleted lessons (opened by the erasure sweep) and are waiting for the team to merge. */
  erasurePrs: z.number().int().min(0).optional(),
  /** Present on a switched-on repository while lessons are off: the choice is recorded and the file starts when lessons are switched on for the installation or for the project. The text is `LESSON_FILE_WAITING_TEXT`. */
  waitingFor: z.enum(LESSON_FILE_WAITING_FOR).optional(),
  pr: LessonsRepoFilePrSchema.optional(),
  lastPassAt: z.number().optional(),
  problem: z.enum(LESSON_FILE_PROBLEMS).optional(),
  /** The fixed sentences to show for this row, in order (the same lines the pull request body and the CLI print). */
  notices: z.array(z.string().max(300)).max(10),
}).strict();
export type LessonsRepoFileRow = z.infer<typeof LessonsRepoFileRowSchema>;
export const LessonsRepoFileRowReaderSchema = forwardReader(LessonsRepoFileRowSchema);

export const LessonsRepoFileStatusSchema = z.object({
  /** Lessons are switched off or not allowed to load for this project: no pull request is opened while that holds. */
  lessonsOff: z.boolean(),
  /** True when the code host of at least one repository can write, so the switch can be offered. */
  canEnable: z.boolean(),
  repos: z.array(LessonsRepoFileRowSchema).max(100),
  /** Repositories Rovara cannot reach (the app is uninstalled, the repository is gone or was removed from the project) while deleted lessons may still be in them: recorded once, tried again weekly. */
  unreachable: z.array(z.object({ repo: z.string().min(1).max(200), lessons: z.number().int().min(0) }).strict()).max(100).optional(),
  /** Open Rovara pull requests that were NOT closed (or taken down) because the code host could not show them or did not say Rovara made them: counted, tried again. */
  closesHeld: z.array(z.object({ repo: z.string().min(1).max(200), count: z.number().int().min(1) }).strict()).max(100).optional(),
  /** Branches Rovara made that the code host cannot match to a pull request, so Rovara cannot check them for deleted lessons. */
  strayBranches: z.array(z.object({ repo: z.string().min(1).max(200), branches: z.number().int().min(1) }).strict()).max(100).optional(),
  /** The repositories of the project with no row yet (not switched on), so a person can pick them. */
  available: z.array(z.string().min(1).max(200)).max(100),
}).strict();
export type LessonsRepoFileStatus = z.infer<typeof LessonsRepoFileStatusSchema>;
export const LessonsRepoFileStatusReaderSchema = forwardReader(LessonsRepoFileStatusSchema);

/** What a maintainer sends: switch a repository on or off, resume it after the team deleted the file, or answer the pointer. `pointers` are the agent files the person ticked (default: the ones Rovara finds). */
export const LESSON_FILE_ACTIONS = ["on", "off", "resume", "pointer_add", "pointer_decline"] as const;
export const LessonsRepoFileBodySchema = z.object({
  action: z.enum(LESSON_FILE_ACTIONS),
  repo: z.string().min(1).max(200),
  pointers: z.array(z.enum(["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md"])).max(3).optional(),
}).strict();
export type LessonsRepoFileBody = z.infer<typeof LessonsRepoFileBodySchema>;
