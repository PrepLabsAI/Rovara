// Lead 4 W4 (DEC 254zh, 254zi): the wiki build CONTROLS on a project's setup page: Build, Stop, Continue, Refresh now, "Give the wiki to agents", Delete wiki. Browser-safe: no Node import.
//
// What the schemas guarantee: every body is strict (a request id and the one choice the person made; limits, payer, commits and goal never come from a client), and every sentence a person is
// told is fixed here (never a model's, a worker's or a repository's words). The answers are built from the build run's own view (`WikiBuildView`) plus what the setup page also shows.
import { z } from "zod";
import { WIKI_BUILD_WORDS } from "./wiki-build.js";

/** "Give the wiki to agents": a person's choice, on or off. Off until a person turns it on. */
export const WikiAgentSwitchBodySchema = z.object({ requestId: z.string().uuid(), on: z.boolean() }).strict();
export type WikiAgentSwitchBody = z.infer<typeof WikiAgentSwitchBodySchema>;
/** "Refresh now": a new build run over the pages whose cited files changed, the pages people marked wrong, and planned pages that have no page yet. */
export const WikiRefreshBodySchema = z.object({ requestId: z.string().uuid() }).strict();
export type WikiRefreshBody = z.infer<typeof WikiRefreshBodySchema>;
/** "Delete wiki": removes the pages, notes, flags, build records, saved answers, the agents switch and the build's own rows. */
export const WikiDeleteBodySchema = z.object({ requestId: z.string().uuid() }).strict();
export type WikiDeleteBody = z.infer<typeof WikiDeleteBodySchema>;

/** Whether the company has an AI key connected, as far as this install can tell. `unknown`: the gateway says at the first call (a run then ends "needs an AI key"). */
export const WIKI_AI_KEY_STATES = ["connected", "missing", "unknown"] as const;
export type WikiAiKeyState = (typeof WIKI_AI_KEY_STATES)[number];

/** The words of the controls that are not the build run's own (`WIKI_BUILD_WORDS`). */
export const WIKI_CONTROLS_WORDS = {
  notAllowed: WIKI_BUILD_WORDS.notAllowed,
  projectNotFound: "project not found",
  unreadable: "The project's wiki could not be read just now. Try again.",
  unavailable: "Building the wiki isn't available for this company yet.",
  auditUnavailable: "The record of this change could not be written, so nothing was done. Try again.",
  nothingToRefresh: "Every page is up to date, so there is nothing to refresh.",
  buildFirst: "Build the wiki first, then refresh it.",
  deleteWhileRunning: "Stop the wiki build, then delete the wiki.",
  deleted: "The wiki was deleted.",
} as const satisfies Record<string, string>;

/** What the controls show beside the build's own state. `refreshPages`: pages Refresh now would rewrite for sure (changed files or marked wrong); planned pages with no page yet are found when it starts. */
export const WikiControlsExtraSchema = z.object({
  canManage: z.boolean(),
  aiKey: z.enum(WIKI_AI_KEY_STATES),
  /** The fixed sentence shown with Build when no AI key is connected. */
  connectKey: z.string().optional(),
  agents: z.object({ on: z.boolean() }).strict(),
  wiki: z.object({ pages: z.number().int().min(0).max(10_000), refreshPages: z.number().int().min(0).max(10_000) }).strict(),
}).strict();
export type WikiControlsExtra = z.infer<typeof WikiControlsExtraSchema>;
