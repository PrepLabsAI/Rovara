// #1548: `rovara session watch <session-id>`: what the task's agent is doing, as it does it. It polls `GET /v1/app/sessions/<id>/activity` with the cursor it got back and prints each new
// item the shared formatter (contracts session-activity.ts) makes of the new events: the step, the agent's messages, each tool call and how it ended, retries, notes and errors.
// It stops when the session has ended (or at once with --no-follow). Everything it prints came from the agent or the broker, so every line goes through `clean` first: nothing it prints
// can move, recolour or reorder the terminal. With --json it prints each event as one line of JSON instead.
import { SessionActivityPageSchema, SessionIdSchema, agentXError, sessionActivityView, type SessionActivityItem, type SessionActivityPage } from "@agentx/contracts";
import type { DeveloperSessionDeps } from "../developer/session.js";
import { appRequest, clean, jsonSafe } from "./app-request.js";

/** How long to wait between polls: soon after something happened, then less often while nothing does. */
export const WATCH_POLL_MIN_MS = 1_000;
export const WATCH_POLL_MAX_MS = 5_000;
/** The most lines one message prints; the rest are counted. */
const MESSAGE_LINES_MAX = 40;
const PAGE_LIMIT = 200;
/** How many polls in a row may fail to reach the server before the watch gives up. */
const UNREACHABLE_MAX = 5;

export interface WatchOptions { follow: boolean; json: boolean; write: (text: string) => void }

const realSleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });
/** The time of an event in the person's own time zone. */
function clock(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? "--:--:--" : [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, "0")).join(":");
}

/** Each line of a message, cleaned, at most MESSAGE_LINES_MAX of them. */
function block(prefix: string, text: string): string[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  const shown = lines.slice(0, MESSAGE_LINES_MAX).map((line, index) => `${index === 0 ? prefix : " ".repeat(prefix.length)}${clean(line)}`);
  return lines.length > MESSAGE_LINES_MAX ? [...shown, `${" ".repeat(prefix.length)}... (${lines.length - MESSAGE_LINES_MAX} more lines)`] : shown;
}

const firstLine = (text: string | undefined): string => clean((text ?? "").split(/\r?\n/).find((line) => line.trim() !== "") ?? "");

function toolLines(item: Extract<SessionActivityItem, { kind: "tool" }>, started: boolean): string[] {
  const lines = started ? [] : [`${clock(item.at)}  → ${clean(item.name)} ${clean(item.args)}`.trimEnd()];
  if (item.status === "running") return lines;
  const took = item.durationMs === undefined ? "" : ` (${item.durationMs} ms)`;
  return [...lines, `          ${item.status === "failed" ? "✗" : "✓"} ${clean(item.name)}${took}${item.result === undefined ? "" : `: ${firstLine(item.result)}`}`];
}

const MARKS: Record<"note" | "retry" | "compaction" | "error" | "status", string> = { note: "·", status: "·", retry: "!", compaction: "!", error: "✗" };

/** The lines for one item. `started` is whether this tool call's start was printed already (its end then prints alone). */
export function watchLines(item: SessionActivityItem, started = false): string[] {
  switch (item.kind) {
    case "step": return ["", `── ${clean(item.label)}${item.status === undefined ? "" : ` (${clean(item.status.toLowerCase())})`} ──`];
    case "message": return [
      ...(item.thinking === undefined ? [] : [`${clock(item.at)}  (thinking) ${firstLine(item.thinking)}`]),
      ...(item.text === "" ? [] : item.role === "assistant" ? block(`${clock(item.at)}  agent: `, item.text) : [`${clock(item.at)}  given: ${firstLine(item.text)}`]),
    ];
    case "tool": return toolLines(item, started);
    default: return [`${clock(item.at)}  ${MARKS[item.kind]} ${clean(item.text)}`];
  }
}

/** Remembers what was printed across polls: the step last shown, and the tool calls whose start was. */
class Printer {
  private step: string | undefined;
  private readonly started = new Set<string>();
  constructor(private readonly write: (text: string) => void) {}

  print(page: SessionActivityPage): void {
    for (const item of sessionActivityView(page.events, page.operations)) {
      if (item.kind === "step") {
        if (item.operationId === this.step) continue;
        this.step = item.operationId;
      }
      const key = item.kind === "tool" ? `${item.operationId}\u0000${item.toolCallId}` : undefined;
      const lines = watchLines(item, key !== undefined && this.started.has(key));
      if (key !== undefined) this.started.add(key);
      if (lines.length > 0) this.write(`${lines.join("\n")}\n`);
    }
  }
}

async function readPage(deps: DeveloperSessionDeps, env: string | undefined, id: string, cursor: string | undefined): Promise<SessionActivityPage> {
  const query = new URLSearchParams({ limit: String(PAGE_LIMIT), ...(cursor === undefined ? {} : { after: cursor }) });
  const answer = await appRequest(deps, env, `/v1/app/sessions/${encodeURIComponent(id)}/activity?${query.toString()}`);
  const parsed = SessionActivityPageSchema.safeParse(answer.body);
  if (!parsed.success) throw agentXError("RUNTIME_UNAVAILABLE", "the server sent activity this version of rovara cannot read; update rovara and try again");
  return parsed.data;
}

/** A page, asking again a few times when the server cannot be reached for a moment (only while following: a one-off read fails at once). */
async function readPageRetrying(deps: DeveloperSessionDeps, env: string | undefined, id: string, cursor: string | undefined, follow: boolean, sleep: (ms: number) => Promise<void>): Promise<SessionActivityPage> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await readPage(deps, env, id, cursor);
    } catch (error) {
      const unreachable = (error as { code?: unknown }).code === "RUNTIME_UNAVAILABLE";
      if (!follow || !unreachable || attempt >= UNREACHABLE_MAX) throw error;
      await sleep(WATCH_POLL_MAX_MS);
    }
  }
}

/** Watches the session until it ends (or prints what there is, with `follow: false`). */
export async function sessionWatch(deps: DeveloperSessionDeps, env: string | undefined, id: string, options: WatchOptions): Promise<void> {
  if (!SessionIdSchema.safeParse(id).success) throw agentXError("CONFIG_INVALID", "that is not a session ID; run rovara sessions to see yours");
  const sleep = deps.sleep ?? realSleep;
  const printer = new Printer(options.write);
  let cursor: string | undefined;
  let wait = WATCH_POLL_MIN_MS;
  for (;;) {
    const page = await readPageRetrying(deps, env, id, cursor, options.follow, sleep);
    if (options.json) for (const event of page.events) options.write(`${JSON.stringify(jsonSafe(event))}\n`);
    else printer.print(page);
    cursor = page.cursor ?? cursor;
    // A full page means more is waiting: ask again at once.
    if (page.events.length >= PAGE_LIMIT) continue;
    if (!page.active || !options.follow) break;
    wait = page.events.length > 0 ? WATCH_POLL_MIN_MS : Math.min(WATCH_POLL_MAX_MS, Math.round(wait * 1.5));
    await sleep(wait);
  }
  if (!options.json && options.follow) options.write("\nThe session has ended.\n");
}
