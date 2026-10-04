// Spec 051: what the agent ran. Fed Pi's extension `tool_call` and `tool_result` events, it keeps each test command the
// agent ran (contracts' scanTestCommands, #299), with its exit code and whether the workspace had changed first.
import { scanTestCommands, type TestCommandScan } from "@agentx/contracts";

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
  fingerprint: (signal?: AbortSignal) => Promise<string>;
  onDiagnostic?: (message: string) => void;
  /**
   * Maps a cd target for the test-command scan, for a shell whose paths differ from the workspace's (an eval's or a
   * devcontainer's): a workspace-relative path, "" for the root, or undefined to leave it. Only the scan's reading
   * changes; the stored command is the agent's own text.
   */
  cdTarget?: (target: string) => string | undefined;
}

const EXIT_MARKER = /Command exited with code (\d+)/g;

/**
 * An edit is a successful edit or write tool result (the fast path), or any change to the workspace fingerprint since
 * the agent's first tool call, so an edit made through bash (`sed -i`, `git apply`, a heredoc) counts too (Ruling E).
 * The fingerprint is read when a test command is called, before it runs, so what the command itself writes does not
 * count. A fingerprint that cannot be read counts as an edit, the safe side.
 *
 * Pi runs every call's tool_call hook in a batch first, then executes the calls together (Ruling G). So a test call
 * whose run overlaps any bash call that is not a test command, or any edit or write call, has no valid before: the
 * fingerprint read at its tool_call cannot see what the other call is about to change. Overlap is tracked by the
 * calls in flight, from tool_call to tool_result, which covers a batch in either order.
 */
export class CommandRecorder {
  readonly #options: CommandRecorderOptions;
  readonly #runs = new Map<string, RecordedCommand>();
  /** Per test-command call: whether the workspace had changed when it was called. */
  readonly #calls = new Map<string, Promise<boolean>>();
  /** Calls between their tool_call and tool_result, and whether each may change the workspace. */
  readonly #inFlight = new Map<string, { mayChange: boolean; test: boolean }>();
  /** Test calls that overlapped a call that may change the workspace. */
  readonly #overlapped = new Set<string>();
  #baseline: Promise<string | undefined> | undefined;
  #chain: Promise<void> = Promise.resolve();
  #edited = false;
  /** Sticky, as #edited: once the fingerprint has differed, later test calls need not read it. */
  #changed = false;
  #reportedFingerprintFailure = false;

  constructor(options: CommandRecorderOptions) {
    this.#options = options;
  }

  /**
   * Feed every Pi extension `tool_call` event, and await it before the tool runs: it reads the workspace state.
   * `signal` is the call's abort signal, passed to the fingerprint so a cancel does not wait for git.
   */
  async observeCall(event: RecorderToolCall, signal?: AbortSignal): Promise<void> {
    this.#baseline ??= this.#capture(signal);
    const scan = bashScan(event, this.#options.cdTarget);
    const test = scan !== undefined && scan.tests.length > 0;
    // #299: a chain that holds a test and anything else (sed -i … && pytest) may change files too.
    const mayChange = event.toolName === "edit" || event.toolName === "write" || (event.toolName === "bash" && (!test || scan.othersMayChange));
    if (mayChange) {
      for (const [id, call] of this.#inFlight) if (call.test) this.#overlapped.add(id);
    }
    if (test && [...this.#inFlight.values()].some((call) => call.mayChange)) this.#overlapped.add(event.toolCallId);
    this.#inFlight.set(event.toolCallId, { mayChange, test });
    if (!test) {
      await this.#baseline;
      return;
    }
    if (this.#edited || this.#changed) {
      this.#calls.set(event.toolCallId, Promise.resolve(true));
      return;
    }
    const baseline = this.#baseline;
    const changed = Promise.all([baseline, this.#capture(signal)]).then(([before, now]) => {
      const differs = before === undefined || now === undefined || before !== now;
      if (differs) this.#changed = true;
      return differs;
    });
    this.#calls.set(event.toolCallId, changed);
    await changed;
  }

  /**
   * Feed every Pi extension `tool_execution_end` event. A call that was blocked or aborted gets no tool_result, and
   * would otherwise stay in flight and void every later test's before (M-12).
   */
  observeExecutionEnd(toolCallId: string): void {
    // Its execution is over either way; a test call's overlap so far stays in #overlapped for its tool_result.
    this.#inFlight.delete(toolCallId);
  }

  /** Feed every Pi extension `turn_end` event: no call outlives its turn. */
  observeTurnEnd(): void {
    this.#inFlight.clear();
  }

  /** Feed every Pi extension `tool_result` event, in order. Read `firstRuns()` only after `settled()`. */
  observe(event: RecorderToolResult): void {
    this.#inFlight.delete(event.toolCallId);
    const overlapped = this.#overlapped.delete(event.toolCallId);
    if ((event.toolName === "edit" || event.toolName === "write") && event.isError === false) {
      this.#edited = true;
      return;
    }
    const tests = bashScan(event, this.#options.cdTarget)?.tests ?? [];
    if (tests.length === 0) return;
    const command = event.input.command as string;
    // A result whose call was never seen has an unknown before.
    const changed = this.#calls.get(event.toolCallId) ?? Promise.resolve(true);
    this.#calls.delete(event.toolCallId);
    const editedAtResult = this.#edited || overlapped;
    const output = event.content.flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : [])).join("");
    const exit = exitCode(event, output);
    this.#chain = this.#chain.then(async () => {
      const afterFirstEdit = editedAtResult || await changed;
      // #299: only a simple test command's exit code is the test's; any other run's before is measured (D-16).
      for (const { replay, ownRunIsBefore } of tests) {
        this.#record({ command, replay, exitCode: ownRunIsBefore ? exit : undefined, afterFirstEdit, output });
      }
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

  async #capture(signal?: AbortSignal): Promise<string | undefined> {
    try {
      return await this.#options.fingerprint(signal);
    } catch (error) {
      // Once per session: a fingerprint that keeps failing would otherwise repeat itself in the event log.
      if (this.#reportedFingerprintFailure) return undefined;
      this.#reportedFingerprintFailure = true;
      try {
        this.#options.onDiagnostic?.(
          `AgentX could not read the workspace state for its checks, so a test result may not count as the state before the change: ${error instanceof Error ? error.message : String(error)}`,
        );
      } catch { /* Reporting must not break a turn. */ }
      return undefined;
    }
  }
}

function bashScan(event: RecorderToolCall, cdTarget?: (target: string) => string | undefined): TestCommandScan | undefined {
  if (event.toolName !== "bash") return undefined;
  const command = event.input.command;
  return typeof command === "string" ? scanTestCommands(command, cdTarget === undefined ? {} : { cdTarget }) : undefined;
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
