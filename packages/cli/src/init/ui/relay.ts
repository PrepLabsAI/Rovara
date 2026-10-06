// The job's side of the install page in the cloud: what the local server does over its event
// stream and POST /answer, done through the setup table instead. The hub is the same hub; the
// relay writes its state to the store whenever it changes (at most every STATE_WRITE_MS), and
// polls the store for answers, handing each to the hub exactly as the local server does.
import type { SetupStore } from "./setup-store.js";
import type { WizardHub } from "./state.js";

/** The longest a state change waits before it is written: changes in between share one write. */
export const STATE_WRITE_MS = 500;
/** How often the job looks for answers and a close request. */
export const ANSWER_POLL_MS = 1_000;

export interface HubRelay {
  /** Writes the last state now, marked closed, and stops polling. Safe to call more than once. */
  stop(): Promise<void>;
}

export function startHubRelay(input: {
  hub: WizardHub;
  store: SetupStore;
  /** One line for the job's log when the store cannot be reached; the relay keeps trying. */
  warn: (line: string) => void;
  stateWriteMs?: number;
  pollMs?: number;
}): HubRelay {
  const { hub, store } = input;
  const writeDelay = input.stateWriteMs ?? STATE_WRITE_MS;
  let stopped = false;
  let closed = false;
  let writeTimer: NodeJS.Timeout | undefined;
  // One write at a time, in order: a slow write never lands after a newer one.
  let writing: Promise<void> = Promise.resolve();
  // Said once per outage, for writes and reads apart: a read that works says nothing about writes.
  const warned = { written: false, read: false };
  const failed = (what: keyof typeof warned) => (error: unknown) => {
    if (warned[what]) return;
    warned[what] = true;
    input.warn(`the install page's table could not be ${what} (${error instanceof Error ? error.name : "unknown error"}); retrying`);
  };
  const writeNow = () => {
    if (writeTimer !== undefined) clearTimeout(writeTimer);
    writeTimer = undefined;
    const snapshot = hub.snapshot();
    const wasClosed = closed;
    writing = writing.then(() => store.putState(snapshot, wasClosed)).then(() => { warned.written = false; }, failed("written"));
    return writing;
  };
  const scheduleWrite = () => {
    if (stopped || writeTimer !== undefined) return;
    writeTimer = setTimeout(() => { void writeNow(); }, writeDelay);
  };
  const unsubscribe = hub.subscribe({
    state: scheduleWrite,
    log: scheduleWrite,
    closed: () => {
      closed = true;
      void writeNow();
    },
  });
  void writeNow();

  const poll = async () => {
    try {
      for (const answer of await store.takeAnswers()) {
        const error = hub.answer(answer.id, answer.value);
        await store.putVerdict(answer.key, error === undefined ? { ok: true } : { ok: false, error });
      }
      if (await store.takeClose()) hub.requestClose();
      warned.read = false;
    } catch (error) {
      failed("read")(error);
    }
  };
  let pollTimer: NodeJS.Timeout | undefined;
  let polling: Promise<void> = Promise.resolve();
  const loop = () => {
    if (stopped) return;
    pollTimer = setTimeout(() => {
      polling = poll().finally(loop);
    }, input.pollMs ?? ANSWER_POLL_MS);
  };
  loop();

  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      if (pollTimer !== undefined) clearTimeout(pollTimer);
      await polling;
      unsubscribe();
      closed = true;
      await writeNow();
    },
  };
}
