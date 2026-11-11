// A chain run's event log. Every state change of a run carries its event in its own transaction, together with `eventSeq` and `version` on the run's META, so a crash can't lose an event or leave a gap: the
// numbers run 1, 2, 3 with nothing missing. Event text is shown to people and may come from a task's failure, so it is neutralised before it is written: control, invisible and direction characters become
// `[U+XXXX]` markers, and the text is cut.
import { chainRunKey, runEventSk, type ChainRunEventType, type ChainRunId, type OrgId, type TransactItem } from "@agentx/contracts";
import { putRow } from "../automation/kit.js";

export type RunEventType = ChainRunEventType;
export interface RunEventInput { type: RunEventType; stepSeq?: number; text: string }

/** The most an event's text may be, in characters. */
export const RUN_EVENT_TEXT_MAX = 500;

/** Characters a person must not be shown as they are: controls, format characters (direction marks, zero-width), private use, unassigned, surrogates and line separators. */
const UNSAFE = /[\p{C}\p{Zl}\p{Zp}]/gu;

/** The text made safe to print: each unsafe character is replaced by its code point as `[U+XXXX]`, then the text is cut to `max` characters (code points), ending in an ellipsis when it was cut. */
export function neutralText(text: string, max: number = RUN_EVENT_TEXT_MAX): string {
  const marked = text.replace(UNSAFE, (char) => `[U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}]`);
  const characters = [...marked];
  return characters.length <= max ? marked : `${characters.slice(0, max - 1).join("")}…`;
}

export interface EventRun { orgId: OrgId; runId: ChainRunId; eventSeq: number }

/** Several events in a row, numbered after the run's last one: the rows, and the number the run's `eventSeq` becomes. */
export function runEventItems(run: EventRun, events: readonly RunEventInput[], at: string): { items: TransactItem[]; eventSeq: number } {
  const items = events.map((event, index) => {
    const seq = run.eventSeq + index + 1;
    return putRow(chainRunKey(run.orgId, run.runId, runEventSk(seq)), "CHAIN_RUN_EVENT", {
      orgId: run.orgId, runId: run.runId, seq, at, type: event.type, ...(event.stepSeq === undefined ? {} : { stepSeq: event.stepSeq }), text: neutralText(event.text),
    });
  });
  return { items, eventSeq: run.eventSeq + events.length };
}
