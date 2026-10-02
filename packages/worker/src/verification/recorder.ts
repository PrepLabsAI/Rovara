// Spec 051: what the agent ran. Fed Pi's extension `tool_call` and `tool_result` events, it keeps each simple test
// command the agent ran (contracts' matchTestCommand), with its exit code and whether the workspace had changed first.
import { matchTestCommand } from "@agentx/contracts";

export interface RecordedCommand {
  order: number;
  command: string;
  replay: string;
  exitCode: number | undefined;
  /** True when the run's result cannot serve as the "before": an edit came first, or that could not be ruled out. */
  afterFirstEdit: boolean;
  output: string;
}

export interface RecorderToolCall {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface RecorderToolResult extends RecorderToolCall {
  structuredContent?: unknown;
  isError: boolean;
  content: { type: string; text?: string }[];
}

export interface CommandRecorderOptions {
  /** A digest of the workspace's repositories; equal digests mean nothing changed (Ruling E). */
  fingerprint: () => Promise<string>;
  onDiagnostic?: (message: string) => void;
}

const EXIT_MARKER = /Command exited with code (\d+)/g;

/**
 * An edit is a successful edit or write tool result (the fast path), or any change to the workspace fingerprint since
 * the agent's first tool call, so an edit made through bash (`sed -i`, `git apply`, a heredoc) counts too (Ruling E).
 * The fingerprint is read when a test command is called, before it runs, so what the command itself writes does not
 * count. A fingerprint that cannot be read counts as an edit, the safe side.
 *
 * Pi runs a batch of tool calls in parallel and reports results as they complete, so the edit fast path follows
 * completion order. That errs the same way: a test that finishes after an edit in its batch has no valid before.
 */
export class CommandRecorder {
  readonly #options: CommandRecorderOptions;
  readonly #runs = new Map<string, RecordedCommand>();
  /** Per test-command call: whether the workspace had changed when it was called. */
  readonly #calls = new Map<string, Promise<boolean>>();
  #baseline: Promise<string | undefined> | undefined;
  #chain: Promise<void> = Promise.resolve();
  #edited = false;

  constructor(options: CommandRecorderOptions) {
    this.#options = options;
  }

  /** Feed every Pi extension `tool_call` event, and await it before the tool runs: it reads the workspace state. */
  async observeCall(event: RecorderToolCall): Promise<void> {
    this.#baseline ??= this.#capture();
    const replay = bashReplay(event);
    if (replay === undefined) {
      await this.#baseline;
      return;
    }
    if (this.#edited) {
      this.#calls.set(event.toolCallId, Promise.resolve(true));
      return;
    }
    const baseline = this.#baseline;
    const changed = Promise.all([baseline, this.#capture()]).then(
      ([before, now]) => before === undefined || now === undefined || before !== now,
    );
    this.#calls.set(event.toolCallId, changed);
    await changed;
  }

  /** Feed every Pi extension `tool_result` event, in order. Read `firstRuns()` only after `settled()`. */
  observe(event: RecorderToolResult): void {
    if ((event.toolName === "edit" || event.toolName === "write") && event.isError === false) {
      this.#edited = true;
      return;
    }
    const replay = bashReplay(event);
    if (replay === undefined) return;
    const command = event.input.command as string;
    // A result whose call was never seen has an unknown before.
    const changed = this.#calls.get(event.toolCallId) ?? Promise.resolve(true);
    this.#calls.delete(event.toolCallId);
    const editedAtResult = this.#edited;
    const output = event.content.flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : [])).join("");
    const exit = exitCode(event, output);
    this.#chain = this.#chain.then(async () => {
      const afterFirstEdit = editedAtResult || await changed;
      this.#record({ command, replay, exitCode: exit, afterFirstEdit, output });
    });
  }

  /** Resolves once every observed result is recorded. */
  settled(): Promise<void> {
    return this.#chain;
  }

  /** The first run of each distinct replay string, in first-run order. */
  firstRuns(): RecordedCommand[] {
    return [...this.#runs.values()].map((run) => ({ ...run }));
  }

  /** True once an edit or write tool result succeeded. */
  get edited(): boolean {
    return this.#edited;
  }

  #record(run: Omit<RecordedCommand, "order">): void {
    const existing = this.#runs.get(run.replay);
    if (existing === undefined) {
      this.#runs.set(run.replay, { order: this.#runs.size, ...run });
      return;
    }
    // FR-003 "where possible": a first run with no known result yields to a later known one made before any edit.
    if (existing.exitCode === undefined && !existing.afterFirstEdit && run.exitCode !== undefined && !run.afterFirstEdit) {
      this.#runs.set(run.replay, { order: existing.order, ...run });
    }
  }

  async #capture(): Promise<string | undefined> {
    try {
      return await this.#options.fingerprint();
    } catch (error) {
      try {
        this.#options.onDiagnostic?.(
          `AgentX could not read the workspace state for its checks, so a test result may not count as the state before the change: ${error instanceof Error ? error.message : String(error)}`,
        );
      } catch { /* Reporting must not break a turn. */ }
      return undefined;
    }
  }
}

function bashReplay(event: RecorderToolCall): string | undefined {
  if (event.toolName !== "bash") return undefined;
  const command = event.input.command;
  return typeof command === "string" ? matchTestCommand(command) : undefined;
}

function exitCode(event: RecorderToolResult, output: string): number | undefined {
  const structured = event.structuredContent;
  if (structured && typeof structured === "object" && "exit_code" in structured) {
    const code = structured.exit_code;
    if (typeof code === "number" && Number.isInteger(code)) return code;
  }
  // Pi appends the real status last; the command's own output may print the same words earlier.
  const marker = [...output.matchAll(EXIT_MARKER)].at(-1);
  if (marker) return Number(marker[1]);
  return event.isError === false ? 0 : undefined;
}
