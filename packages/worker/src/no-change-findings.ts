// What a coding run did, kept only to answer for it when the run ends with no code change: the commands the agent ran, what they printed, and the agent's last words. It reads the session's own
// tool events (nothing else is stored or asked of a model). The block it builds is redacted and bounded (`buildNoChangeFindings`) before it leaves the worker.
import { NO_CHANGE_FINDINGS_COMMANDS_MAX, NO_CHANGE_FINDINGS_CONCLUSION_MAX, NO_CHANGE_FINDINGS_OMITTED_MAX, buildNoChangeFindings, type NoChangeFindings } from "@rovara-code/contracts";

/** The tools whose calls are told as "commands the agent ran": the shell and the tools that only read. A tool that writes is never listed. */
const LISTED_TOOLS: ReadonlySet<string> = new Set(["bash", "grep", "find", "ls", "read"]);
/** A read's text is the file itself, which is not a finding. */
const NO_OUTPUT_TOOLS: ReadonlySet<string> = new Set(["read"]);
/** The most calls held at once (the last ones); older ones are counted, not kept. */
const KEPT_CALLS = 60;
/** The most of one call's text held: a tool's output is already cut by the tool; this bounds a hostile one. */
const HELD_TEXT = 20_000;
/** The most parts whose words a combined conclusion tells; the rest are counted. */
const PARTS_TOLD = 20;
const MARKER = /^AgentX result: (?:not )?done$/u;

interface Call { command: string; output: string; failed: boolean }

export class FindingsRecorder {
  private readonly calls: Call[] = [];
  private readonly open = new Map<string, Call>();
  private dropped = 0;
  private conclusion: string | undefined;

  /** Feed every session event. */
  observe(event: unknown): void {
    if (event === null || typeof event !== "object") return;
    const value = event as { type?: unknown; toolCallId?: unknown; toolName?: unknown; args?: unknown; isError?: unknown; result?: unknown };
    const tool = typeof value.toolName === "string" ? value.toolName : undefined;
    const id = typeof value.toolCallId === "string" ? value.toolCallId : undefined;
    if (tool === undefined || !LISTED_TOOLS.has(tool)) return;
    if (value.type === "tool_execution_start") {
      const call: Call = { command: describe(tool, value.args), output: "", failed: false };
      this.calls.push(call);
      if (id !== undefined) this.open.set(id, call);
      if (this.calls.length > KEPT_CALLS) { this.calls.shift(); this.dropped += 1; }
      return;
    }
    if (value.type !== "tool_execution_end" || id === undefined) return;
    const call = this.open.get(id);
    if (call === undefined) return;
    this.open.delete(id);
    call.failed = value.isError === true;
    if (!NO_OUTPUT_TOOLS.has(tool)) call.output = resultText(value.result).slice(0, HELD_TEXT);
  }

  /** The agent's last message text, as each assistant message ends (the last one is its conclusion; a message with no text clears it). */
  concludeWith(text: string | undefined): void {
    this.conclusion = text;
  }

  /** What this session held, for the block (here, or combined with the other parts'): its calls, the count of earlier ones it dropped, and its last words without the result marker. */
  held(): { calls: readonly Call[]; dropped: number; conclusion: string } {
    const lines = (this.conclusion ?? "").split("\n");
    while (lines.length > 0 && (lines.at(-1)!.trim() === "" || MARKER.test(lines.at(-1)!.trim()))) lines.pop();
    return { calls: this.calls, dropped: this.dropped, conclusion: lines.join("\n") };
  }

  /** The block for the run's result: bounded and redacted. */
  build(): NoChangeFindings {
    const { calls, dropped, conclusion } = this.held();
    return finish(calls, dropped, conclusion);
  }
}

function finish(calls: readonly Call[], dropped: number, conclusion: string): NoChangeFindings {
  const built = buildNoChangeFindings({ commands: calls, conclusion });
  const omitted = Math.min((built.omitted ?? 0) + dropped, NO_CHANGE_FINDINGS_OMITTED_MAX);
  return { ...built, ...(omitted > 0 ? { omitted } : {}) };
}

/**
 * What a whole run did. A run split into parts (parallel or ordered) has a session for each part, and each part's session has a recorder of its own, so two parts' commands never mix and
 * the same tool-call id in two sessions never collides. When the run ends with no change the parts are combined in the plan's order (`setOrder`); a run with one session reads as that
 * session's recorder does.
 */
export class RunFindings {
  /** The recorder of the run's own session, for a run that is not split into parts. */
  readonly main = new FindingsRecorder();
  private order: readonly string[] = [];
  private readonly parts = new Map<string, FindingsRecorder>();

  /** The plan's order of the parts (their ids); a part not named here follows the named ones, in the order its session began. */
  setOrder(partIds: readonly string[]): void {
    this.order = [...partIds];
  }

  /** The recorder of one part's session (made the first time it is asked for). */
  forPart(partId: string): FindingsRecorder {
    let recorder = this.parts.get(partId);
    if (recorder === undefined) { recorder = new FindingsRecorder(); this.parts.set(partId, recorder); }
    return recorder;
  }

  /**
   * The block for the run's result: bounded and redacted. With more than one part:
   * - commands: one list in the plan's order. Each part's last command is kept first (so a part is never told without a command), then the most recent ones overall, ten in all; `omitted` counts the rest.
   *   With more than ten parts the floor goes to the ten latest parts that ran a command.
   * - conclusion: each part's own words under a "Part N:" line (N is the part's place in the plan), sharing the conclusion's one limit so a long part does not crowd out the others. At most
   *   `PARTS_TOLD` parts are told; "…and N more parts" counts the rest. The label has its own line so a part's first line is still read as a line of its own by the Slack masking.
   */
  build(): NoChangeFindings {
    if (this.parts.size === 0) return this.main.build();
    const known = this.order.filter((id) => this.parts.has(id));
    const keys = [...known, ...[...this.parts.keys()].filter((id) => !known.includes(id))];
    if (keys.length === 1) return this.parts.get(keys[0]!)!.build();
    const held = keys.map((id) => ({ id, ...this.parts.get(id)!.held() }));
    const told = held.flatMap((part) => {
      // Redacted and cut here to the conclusion's limit first, so that cutting it again to the part's share only ever cuts text that is already safe.
      const text = buildNoChangeFindings({ commands: [], conclusion: part.conclusion }).conclusion;
      const place = this.order.indexOf(part.id);
      return text === undefined ? [] : [{ label: `Part ${String(place >= 0 ? place + 1 : this.order.length + keys.indexOf(part.id) + 1)}:\n`, text }];
    });
    const shown = told.slice(0, PARTS_TOLD);
    const tail = told.length > shown.length ? `…and ${String(told.length - shown.length)} more parts` : "";
    const separator = "\n\n";
    let room = NO_CHANGE_FINDINGS_CONCLUSION_MAX - shown.reduce((sum, part) => sum + part.label.length, 0) - separator.length * Math.max(0, shown.length - (tail === "" ? 1 : 0)) - tail.length;
    // Each part gets an equal share of the room, and what a short part does not use goes to the longer ones.
    const shares = new Array<number>(shown.length).fill(0);
    const bySize = shown.map((part, index) => index).sort((x, y) => Array.from(shown[x]!.text).length - Array.from(shown[y]!.text).length);
    bySize.forEach((index, rank) => {
      const share = Math.max(0, Math.floor(room / (bySize.length - rank)));
      shares[index] = Math.min(Array.from(shown[index]!.text).length, share);
      room -= shares[index];
    });
    const conclusion = [...shown.map((part, index) => `${part.label}${cutText(part.text, shares[index]!)}`), ...(tail === "" ? [] : [tail])].join(separator);
    const { kept, skipped } = chooseCalls(held.map((part) => part.calls));
    return finish(kept, held.reduce((sum, part) => sum + part.dropped, 0) + skipped, conclusion);
  }
}

/** The calls the block lists, in order: each part's last call first (the latest ten parts' when there are more than ten), then the most recent of the rest, NO_CHANGE_FINDINGS_COMMANDS_MAX in all. */
function chooseCalls(perPart: ReadonlyArray<readonly Call[]>): { kept: Call[]; skipped: number } {
  const all = perPart.flatMap((calls) => calls.filter((call) => call.command.trim() !== ""));
  const chosen = new Set<number>();
  let end = 0;
  const lasts: number[] = [];
  for (const calls of perPart) {
    const count = calls.filter((call) => call.command.trim() !== "").length;
    end += count;
    if (count > 0) lasts.push(end - 1);
  }
  
  for (const index of lasts.slice(-NO_CHANGE_FINDINGS_COMMANDS_MAX)) chosen.add(index);
  for (let index = all.length - 1; index >= 0 && chosen.size < NO_CHANGE_FINDINGS_COMMANDS_MAX; index -= 1) chosen.add(index);
  const kept = [...chosen].sort((x, y) => x - y).map((index) => all[index]!);
  return { kept, skipped: all.length - kept.length };
}

function cutText(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : max < 2 ? "" : `${points.slice(0, max - 1).join("").trimEnd()}…`;
}

function describe(tool: string, args: unknown): string {
  const given = args !== null && typeof args === "object" ? args as Record<string, unknown> : {};
  if (tool === "bash") return typeof given.command === "string" ? given.command : "";
  const subject = [given.pattern, given.path].filter((part): part is string => typeof part === "string" && part !== "").join(" ");
  return `${tool} ${subject}`.trim();
}

function resultText(result: unknown): string {
  const content = (result as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part !== null && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join("\n");
}
