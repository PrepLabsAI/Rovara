// Opus review of N1 (DEC 254zzz495): the journal stores a command flattened to one line (`oneLineText`), and every reader but the worker classifies that flattened text. The real beta command, in the forms a model
// writes it (one line, or one step per line), must stay "failed" after the journal flattens it.
import { describe, expect, it } from "vitest";
import { oneLineText, setupResultOf } from "../../packages/contracts/src/index.js";

const asJournal = (command: string) => ({ command: oneLineText(command, 2_000), exitCode: 1, timedOut: false, tail: "" });
const asWorker = (command: string) => ({ command, exitCode: 1, timedOut: false, tail: "" });

describe("the beta case after the journal flattens it", () => {
  const forms = [
    'cd repo/x && source .venv/bin/activate && find . -name "*test*" | grep -v node_modules',
    'cd repo/x\nsource .venv/bin/activate\nfind . -name "*test*" | grep -v node_modules',
    'cd repo/x &&\n  source .venv/bin/activate &&\n  find . -name "*test*" |\n  grep -v node_modules',
    'source .venv/bin/activate\nfind . -name "*test*" | grep -v node_modules',
  ];
  it.each(forms)("%j stays failed for the worker and for every journal reader", (command) => {
    expect(setupResultOf(asWorker(command))).toBe("failed");
    expect(setupResultOf(asJournal(command))).toBe("failed");
  });
});
