// Spec 051: what the agent ran. Fed Pi's extension `tool_result` events, in order, it keeps each simple test
// command the agent ran (contracts' matchTestCommand), with its exit code and whether a successful edit came first.
import { matchTestCommand } from "@agentx/contracts";

export interface RecordedCommand {
  order: number;
  command: string;
  replay: string;
  exitCode: number | undefined;
  afterFirstEdit: boolean;
  output: string;
}

export interface RecorderToolResult {
  toolName: string;
  input: Record<string, unknown>;
  structuredContent?: unknown;
  isError: boolean;
  content: { type: string; text?: string }[];
}

const EXIT_MARKER = /Command exited with code (\d+)/;

export class CommandRecorder {
  readonly #runs = new Map<string, RecordedCommand>();
  #edited = false;

  /** Feed every Pi extension `tool_result` event, in order. */
  observe(event: RecorderToolResult): void {
    if ((event.toolName === "edit" || event.toolName === "write") && event.isError === false) {
      this.#edited = true;
      return;
    }
    if (event.toolName !== "bash") return;
    const command = event.input.command;
    if (typeof command !== "string") return;
    const replay = matchTestCommand(command);
    if (replay === undefined || this.#runs.has(replay)) return;
    const output = event.content.flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : [])).join("");
    this.#runs.set(replay, {
      order: this.#runs.size,
      command,
      replay,
      exitCode: exitCode(event, output),
      afterFirstEdit: this.#edited,
      output,
    });
  }

  /** The first run of each distinct replay string, in first-run order. */
  firstRuns(): RecordedCommand[] {
    return [...this.#runs.values()].map((run) => ({ ...run }));
  }

  /** True once an edit or write tool result succeeded. */
  get edited(): boolean {
    return this.#edited;
  }
}

function exitCode(event: RecorderToolResult, output: string): number | undefined {
  const structured = event.structuredContent;
  if (structured && typeof structured === "object" && "exit_code" in structured) {
    const code = structured.exit_code;
    if (typeof code === "number" && Number.isInteger(code)) return code;
  }
  const marker = EXIT_MARKER.exec(output);
  if (marker) return Number(marker[1]);
  return event.isError === false ? 0 : undefined;
}
