// Lessons replay (DECISIONS 50.5, 68): the files a replay copy's checkout is given for the FILE arm. The broker renders them at delivery from the copy's frozen snapshot (the lessons repo file's `.rovara/lessons.md` format and the one pointer line)
// and sends them to the worker as `evalFiles`; the worker writes them into the copy's checkout before the agent starts and keeps them out of any diff or commit. They are sent for a replay copy only (the broker's
// dispatch sets them from the copy's mark), and never stored or queued: the stored form holds ids and versions (`LearnedRefs`), so no lesson text sits in an outbox row, a queue message or a dead-letter copy.
import { z } from "zod";

/** The worker feature that lists `evalFiles`. A step that carries them is never sent to a worker that does not list it: the copy would run without the file the arm is about. */
export const EVAL_FILES_FEATURE = "task.evalFiles.v1" as const;
export const EVAL_FILES_LESSONS_PATH = ".rovara/lessons.md" as const;
export const EVAL_FILES_MAX_BYTES = 100_000;

export const EvalFilesPayloadSchema = z.object({
  /** The repository (its id in the checkout manifest) whose checkout gets the files. */
  repository: z.string().min(1).max(200),
  lessonsFile: z.object({ path: z.literal(EVAL_FILES_LESSONS_PATH), content: z.string().min(1).max(EVAL_FILES_MAX_BYTES) }).strict(),
  /** The one line that points an agent at the file; the worker adds it to AGENTS.md under a "Team lessons" heading unless that file already names the lessons file. */
  pointerLine: z.string().min(1).max(500),
}).strict().refine((files) => Buffer.byteLength(files.lessonsFile.content, "utf8") <= EVAL_FILES_MAX_BYTES, { message: "the lessons file is too large", path: ["lessonsFile"] });
export type EvalFilesPayload = z.infer<typeof EvalFilesPayloadSchema>;
