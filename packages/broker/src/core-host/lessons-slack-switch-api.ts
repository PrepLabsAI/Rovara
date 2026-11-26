// The person's own "Don't learn from my Slack messages" switch (Lead 4 L4-SRC-SL, owner's privacy decision DEC 254zzz3): the one setting a PERSON owns about lessons.
//
//   GET /v1/dev/me/lessons-slack                          { optOut: boolean }   whether the signed-in person asked Rovara not to learn from their Slack replies
//   PUT /v1/dev/me/lessons-slack     { optOut: boolean }  { optOut: boolean }   sets it for the signed-in person themselves; true records the opt-out, false takes it back
//
// Rules (the lessons API's, `lessons-api.ts`, except where the privacy decision asks for more):
//   - It is the person's OWN switch: the person comes ONLY from the signed-in caller; no path, query or body names a person, so nobody can read or set another person's switch. A script token never reads or sets it.
//   - The company comes ONLY from live membership (`companyOf`); a reader that throws or answers something malformed is "sign in again". The row is under that company's partition (`slack-switch.ts`).
//   - It does NOT depend on the lessons switch: a person who wants their words left alone can say so whether lessons are on for the company or not (the row is read whenever a thread is, and by nothing else).
//   - Honoured at read time: the next task's Slack read drops the person (`slack-source.ts`). Nothing about the switch is shown to anyone else, and nothing but this person's own id and a time is stored.
//   - Personal preference, not an admin act: it is not audited (the row is the record, and the person's erase removes it). Refusals are fixed words; nothing a caller sent is echoed.
import { AgentXError, OrgIdSchema, agentXError, type DocumentStore, type OrgId } from "@agentx/contracts";
import { z } from "zod";
import { readSlackOptOut, writeSlackOptOut } from "../lessons/slack-switch.js";
import { rethrowMembershipReadFailure } from "../core/membership-read.js";

export const LESSONS_SLACK_PATH = "/v1/dev/me/lessons-slack";
/** Whether a path is this API's (the dev router asks before it hands a request here). */
export const isLessonsSlackSwitchPath = (path: string): boolean => path === LESSONS_SLACK_PATH;

export const NOT_FOR_SCRIPT_TOKENS_SLACK = "A script token cannot do that.";
const SIGN_IN_AGAIN = "Sign in again.";
const UNAVAILABLE = "That can't be read or saved right now. Try again.";
const Body = z.object({ optOut: z.boolean() }).strict();

type SwitchStore = Pick<DocumentStore, "get" | "put" | "delete">;
export interface LessonsSlackSwitchCaller { personId: string; scriptToken?: unknown }
export interface LessonsSlackSwitchOptions {
  /** The caller's company, from live membership. Undefined, malformed or a throw: sign in again. */
  companyOf(caller: LessonsSlackSwitchCaller): Promise<{ companyId: string } | undefined>;
  /** The document store, or a way to get it when it is made late (the deployment's registry). */
  store: SwitchStore | (() => Promise<SwitchStore>);
  now: () => number;
}
export interface LessonsSlackSwitchRequest { method: string; path: string; body?: string | undefined }
export interface LessonsSlackSwitchApi { answer(request: LessonsSlackSwitchRequest, caller: LessonsSlackSwitchCaller): Promise<{ optOut: boolean }> }

export function createLessonsSlackSwitchApi(options: LessonsSlackSwitchOptions): LessonsSlackSwitchApi {
  async function answer(request: LessonsSlackSwitchRequest, caller: LessonsSlackSwitchCaller): Promise<{ optOut: boolean }> {
    if (request.path !== LESSONS_SLACK_PATH || (request.method !== "GET" && request.method !== "PUT")) throw agentXError("NOT_FOUND", "route not found");
    if (caller.scriptToken !== undefined) throw agentXError("FORBIDDEN", NOT_FOR_SCRIPT_TOKENS_SLACK);
    let found: unknown;
    try { found = await options.companyOf(caller); } catch (error) { rethrowMembershipReadFailure(error); found = undefined; }
    const company = OrgIdSchema.safeParse((found as { companyId?: unknown } | undefined | null)?.companyId);
    if (!company.success) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
    const companyId: OrgId = company.data;
    let store: SwitchStore;
    try { store = typeof options.store === "function" ? await options.store() : options.store; } catch { throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE); }
    const personId = caller.personId;
    if (typeof personId !== "string") throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
    if (request.method === "GET") {
      try { return { optOut: await readSlackOptOut(store, companyId, personId) }; } catch { throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE); }
    }
    let raw: unknown;
    try { raw = request.body === undefined || request.body === "" ? undefined : JSON.parse(request.body); } catch { raw = undefined; }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) throw agentXError("CONFIG_INVALID", "the switch takes optOut: true or false");
    try { await writeSlackOptOut(store, companyId, personId, parsed.data.optOut, options.now()); } catch { throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE); }
    return { optOut: parsed.data.optOut };
  }
  return {
    async answer(request, caller) {
      try { return await answer(request, caller); }
      catch (error) {
        if (error instanceof AgentXError) throw error;
        throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE);
      }
    },
  };
}
