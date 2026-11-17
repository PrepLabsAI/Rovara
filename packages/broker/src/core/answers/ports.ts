// The seams of the answer service (lead 4, J1). The service is channel-neutral and holds no provider, no key and no code host: the model, the code and the person's standing come in through these.
import type { CitationFileReader } from "../citations/citation-check.js";

// ---- The model ------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * Why a model could not be used: `not_set_up` (no model or no key here, or the hosted gateway's answers purpose is not wired yet), `over_budget` (this answer's own ceiling), `paused` (the company's monthly
 * answers limit or budget has no room: the gateway's `answers_paused`), `unavailable` (a fault). Fixed words only.
 */
export type AnswerModelRefusal = "not_set_up" | "over_budget" | "paused" | "unavailable";
export class AnswerModelRefused extends Error {
  constructor(readonly reason: AnswerModelRefusal) {
    super(reason);
    this.name = "AnswerModelRefused";
  }
}

export interface AnswerModelTurn {
  /** The fixed rules. Never holds wiki, code or the person's words. */
  system: string;
  /** Everything else the model reads this turn: the question, earlier turns and tool results, each framed as data. */
  transcript: string;
  maxOutputTokens: number;
  signal: AbortSignal;
  /** What this answer may still spend, in cents. A model that prices its calls refuses (`over_budget`) a turn whose worst case is over it. */
  remainingCents: number;
}

export interface AnswerModelReply {
  text: string;
  model: string;
  /** Tokens the call used, when the provider said. */
  tokens?: { input: number; output: number } | undefined;
  /** What the call cost, in cents, when it can be told (the price is known); absent: unknown, and the token ceiling stands in. */
  costCents?: number | undefined;
}

/** One answer's use of the model: opened once (hosted: the dollar ceiling is reserved with the gateway here), used for each turn, and finished once whatever happened. */
export interface AnswerModelSession {
  complete(turn: AnswerModelTurn): Promise<AnswerModelReply>;
  finish(spent: { costCents?: number | undefined; tokens: number }): Promise<void>;
}

export interface AnswerModel {
  /** Whether a model is set up now. Asked before anything is counted, so "not set up" spends nothing. */
  available(): Promise<boolean>;
  /** Throws `AnswerModelRefused`. `ceilingCents` is the most this answer may cost. */
  open(input: { companyId: string; project: string; personId: string; answerId: string; ceilingCents: number }): Promise<AnswerModelSession>;
}

// ---- The code -------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** One project's code as the answer sees it. Built per request, for that project of that company only. */
export interface AnswerCodeSource {
  /** The repositories this answer can read (names): the project's code repositories whose code host answered for a handle. */
  readonly repositories: readonly string[];
  /** EVERY repository the project has now (names), readable or not. Only this list may be used to decide that a repository left the project: a repository whose host is unavailable here is still the project's. */
  readonly projectRepositories: readonly string[];
  /** The default-branch head of each repository the code host could answer for, at this moment: the commit every code read and every citation of this answer is bound to. A repository the host could not answer for is absent. */
  heads(): Promise<ReadonlyMap<string, string>>;
  /** The file at a commit (`undefined` when it is not there); refuses a repository that is not the project's. Throws when the host cannot answer. */
  read: CitationFileReader;
}

// ---- Who -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface AnswerAccess {
  /** Whether the person has a role on the project now (read live: a company owner or admin, or a project grant, a viewer too). Throws when it cannot be read; the service then answers "unavailable". */
  mayAsk(personId: string, project: string): Promise<boolean>;
}
