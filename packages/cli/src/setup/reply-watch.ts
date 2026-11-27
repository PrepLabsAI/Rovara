// FR-018 step 11 and FR-041's check (owner decision 7): a person mentions the bot (the ingress
// never answers a bot, so the CLI cannot post the test itself), and the CLI watches turn records
// for an answered turn in that channel. No Slack history scope is needed.
import { agentXError, SLACK_MODEL_WORDS } from "@agentx/contracts";
import { exportTurns } from "../admin/turns.js";
import type { AdminSession } from "./services.js";

export const REPLY_WAIT_MS = 10 * 60_000;
const POLL_MS = 15_000;
/** Turns received a little before the prompt still count: the person may type fast. */
const EARLY_MS = 5_000;

interface WatchedTurn { eventId: string; subject: string; receivedAt: string; disposition: string; durationMs: number; error?: { name: string }; responseText?: string }

/** #1586: the Slack service's fixed refusals (no model call was made) are recorded as answered turns; they are not the bot's first reply. */
const REFUSAL_WORDS: ReadonlySet<string> = new Set(Object.values(SLACK_MODEL_WORDS));
const isRefusal = (entry: WatchedTurn): boolean => typeof entry.responseText === "string" && REFUSAL_WORDS.has(entry.responseText.trim());

type SettleInput = { env: string; channelName: string; rerun: string; write: (line: string) => void; reported?: Set<string> };

/** This round's outcome: the first real reply, or a throw for a refusal or an unanswered turn (each one reported, so a second watch waits for a new mention); undefined while nothing came back yet. */
function settledReply(mine: WatchedTurn[], input: SettleInput): { eventId: string; seconds: number } | undefined {
  const answered = mine.find((entry) => entry.disposition === "answered" && !isRefusal(entry));
  if (answered !== undefined) {
    const seconds = Math.round(answered.durationMs / 1000);
    input.write(`AgentX replied in #${input.channelName} in ${seconds} seconds.`);
    return { eventId: answered.eventId, seconds };
  }
  const other = mine[0];
  if (other === undefined) return undefined;
  // Every turn seen here ended without a real reply, so a second watch skips them all, not just the first.
  for (const entry of mine) input.reported?.add(entry.eventId);
  const refused = mine.find((entry) => entry.disposition === "answered");
  if (refused !== undefined) {
    throw agentXError("RUNTIME_UNAVAILABLE", `AgentX answered in #${input.channelName}, but only with its fixed refusal "${(refused.responseText ?? "").trim()}": it made no model call. See agentx --env ${input.env} admin turns export --since 15m and the Slack service's log (model_access), fix it, then run ${input.rerun} again`);
  }
  throw agentXError("RUNTIME_UNAVAILABLE", `AgentX replied in #${input.channelName}, but the turn ended as ${other.disposition}${other.error === undefined ? "" : ` (${other.error.name})`}; see agentx --env ${input.env} admin turns export --since 15m, fix it, then run ${input.rerun} again`);
}

export async function waitForThreadedReply(input: {
  /** The environment, named in every command the errors suggest (the default one is production). */
  env: string;
  session: AdminSession; fetch: typeof fetch; teamId: string; channelId: string; channelName: string; botUserId: string;
  /** The command to run again after fixing a problem, such as "agentx init" (as sign-in's `rerun`). */
  rerun: string;
  write: (line: string) => void; sleep: (ms: number) => Promise<void>; now: () => number; timeoutMs?: number;
  /** Event ids of turns an earlier watch already reported as failed: skipped here, so a second
   * watch waits for a new mention (spec 040 FR-051). Every newly failed turn is added before the throw. */
  reported?: Set<string>;
}): Promise<{ eventId: string; seconds: number }> {
  const timeout = input.timeoutMs ?? REPLY_WAIT_MS;
  const count = Math.round(timeout / 60_000);
  const minutes = `${count} ${count === 1 ? "minute" : "minutes"}`;
  const started = input.now();
  const since = new Date(started - EARLY_MS).toISOString();
  const prefix = `${input.teamId}/${input.channelId}/`;
  // Live check L2: a workspace that had an older AgentX app shows two bots with similar names.
  input.write(`In #${input.channelName}, post a message that mentions the bot, for example "@<the bot> what can you do?". Type @ and pick the bot from Slack's mention list: a workspace that had an older AgentX app shows two bots with similar names, and this one's member ID is ${input.botUserId}. Waiting up to ${minutes} for AgentX to reply in its thread.`);
  for (;;) {
    const turns: WatchedTurn[] = [];
    await exportTurns({ ...input.session, since, write: (line) => { turns.push(JSON.parse(line) as WatchedTurn); } }, input.fetch);
    const mine = turns.filter((entry) => entry.subject.startsWith(prefix) && Date.parse(entry.receivedAt) >= started - EARLY_MS && input.reported?.has(entry.eventId) !== true);
    const reply = settledReply(mine, input);
    if (reply !== undefined) return reply;
    if (input.now() - started >= timeout) {
      throw agentXError("RUNTIME_UNAVAILABLE", `no AgentX reply in #${input.channelName} within ${minutes}; check that the message mentioned the bot, that Slack shows the Request URL as Verified, and agentx --env ${input.env} admin turns export --since 15m, then run ${input.rerun} again`);
    }
    await input.sleep(POLL_MS);
  }
}
