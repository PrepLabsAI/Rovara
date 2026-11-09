import { z } from "zod";
import { DeveloperTaskViewSchema } from "./developer-tasks.js";
import { forwardReader } from "./forward-reader.js";
// Split from pending-api.ts: the web app's first JavaScript needs the pending-confirmation readers there, but not the task view (and everything it pulls in), which only the task screens read.

/** Existing task routes, including continue-as-task, answer this exact wrapper. */
export const TaskResponseSchema = z.object({ task: DeveloperTaskViewSchema }).strict();
export const TaskResponseReaderSchema = forwardReader(TaskResponseSchema);
