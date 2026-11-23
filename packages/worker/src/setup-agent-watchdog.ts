// The setup run's watchdog (setup-run-hang, prod P1): a model call that stops answering, or a session that does not obey an abort, must never hold the run for ever.
//
// Before this module the run awaited `session.prompt(...)` and trusted Pi: the governor's deadline timer only asked the session to abort, and the run waited on the prompt to return. A model call that never
// ended (a provider error after which nothing more came, a retry that never started its stream) kept the prompt pending, so the wall clock "stopped" the run in the governor and nothing moved on.
//
// Two bounds, both run from timers OUTSIDE the session's own code path:
//   - STALL: while a prompt is in flight and no command is running, no session event for `stallMs` means the model stopped answering: the run is ended (`onStall`), with words the owner sees;
//   - ABORT CONFIRM: once the governor has stopped the run (a limit, a person's Stop, the stall) the session is asked to abort; if the prompt has not returned `abortConfirmMs` later, the run
//     stops waiting for it and goes on to its end (the sandbox is removed, the partial proposal read, the usage reported). The session is disposed in the run's `finally`.
// A late value or failure of an abandoned prompt is ignored.

/** How long a model call may go without any session event, with no command running, before the run ends (a slow model streams: this is far above any gap between two events). */
export const SETUP_MODEL_STALL_MS = 300_000;
/** After a stop, how long the run waits for the session to confirm its abort before it stops waiting. */
export const SETUP_ABORT_CONFIRM_MS = 30_000;
const TICK_MS = 5_000;

/** What the live view says when the model, not a limit, ended the run: fixed words, never the provider's. */
export const SETUP_HANG_WORDS = {
  stalled: "Rovara ended the setup run: the AI model stopped answering.",
  notStopped: "Rovara ended the setup run: the AI model did not stop when asked, so Rovara stopped waiting for it.",
  modelFailed: "Rovara ended the setup run: a call to the AI model failed and could not be retried.",
} as const;

export interface SetupWatchdogInput {
  now: () => number;
  stallMs?: number | undefined;
  abortConfirmMs?: number | undefined;
  tickMs?: number | undefined;
  /** Called once, from the timer, when a model call in flight has been silent for `stallMs`. Must not throw (a throw is swallowed). */
  onStall(): void;
}

export interface SetupWatchdog {
  /** Feed every session event: any event is activity, and a command's start and end bracket the time no model event is expected. */
  observe(event: unknown): void;
  /** The governor stopped the run (called from its `onStop`): the abort-confirm clock starts. */
  noteStop(): void;
  /** Runs one prompt: resolves "done" when it returned, "abandoned" when the stop was not confirmed in time. Rejects with the prompt's own error. */
  prompt(run: () => Promise<void>): Promise<"done" | "abandoned">;
  /** Whether the stall bound ended the run. */
  stalled(): boolean;
  /** Clears the timers. Safe to call again. */
  dispose(): void;
}

export function createSetupWatchdog(input: SetupWatchdogInput): SetupWatchdog {
  const stallMs = input.stallMs ?? SETUP_MODEL_STALL_MS;
  const confirmMs = input.abortConfirmMs ?? SETUP_ABORT_CONFIRM_MS;
  let lastActivityAt = input.now();
  let commandsRunning = 0;
  let prompting = 0;
  let stalledOut = false;
  let giveUp: () => void = () => undefined;
  const gaveUp = new Promise<"abandoned">((resolve) => { giveUp = () => { resolve("abandoned"); }; });
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;
  const tick = setInterval(() => {
    if (stalledOut || prompting === 0 || commandsRunning > 0 || input.now() - lastActivityAt < stallMs) return;
    stalledOut = true;
    try { input.onStall(); } catch { /* the caller owns the stop; a throw must not escape a timer */ }
  }, input.tickMs ?? TICK_MS);
  tick.unref?.();
  const dispose = (): void => {
    clearInterval(tick);
    if (confirmTimer !== undefined) clearTimeout(confirmTimer);
    confirmTimer = undefined;
  };
  return {
    observe(event) {
      lastActivityAt = input.now();
      const type = typeof event === "object" && event !== null ? (event as { type?: unknown }).type : undefined;
      if (type === "tool_execution_start") commandsRunning += 1;
      else if (type === "tool_execution_end") commandsRunning = Math.max(0, commandsRunning - 1);
    },
    noteStop() {
      if (confirmTimer !== undefined) return;
      confirmTimer = setTimeout(giveUp, confirmMs);
      confirmTimer.unref?.();
    },
    async prompt(run) {
      prompting += 1;
      lastActivityAt = input.now();
      const running = run();
      // A prompt that is given up on may still fail later: that is not the run's concern.
      running.catch(() => undefined);
      try {
        return await Promise.race([running.then((): "done" => "done"), gaveUp]);
      } finally {
        prompting -= 1;
      }
    },
    stalled: () => stalledOut,
    dispose,
  };
}
