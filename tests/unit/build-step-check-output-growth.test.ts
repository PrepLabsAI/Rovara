// The build step reads a failed check's output to tell "the check's own Python could not run" from "the change broke the code". The output is shaped by
// the customer's own tests, so a hostile repository controls it: the traceback-file pattern must stay linear, and must still name the same file.
import { describe, expect, it } from "vitest";
import { expectLinearScaling } from "../support/scaling.js";
import { checkCommandCouldNotRun } from "../../packages/broker/src/core/build-step/check-results.js";

const python = (args: string[]) => ({ executable: "/usr/bin/python3", args, cwd: "/work/repo" });

describe("which file a Python traceback blames", () => {
  it("blames the check's own -c code when the last file before the error is <string>", () => {
    expect(checkCommandCouldNotRun(python(["-c", "x ="]), 1, 'Traceback (most recent call last):\n  File "<string>", line 1\n    x =\nSyntaxError: invalid syntax\n')).toBe(true);
  });
  it("reads the file line after tabs, Windows line ends, blank lines and non-breaking spaces, as before", () => {
    for (const lead of ["\t", "\r\n  ", "\n\n\n  ", " ", "﻿  "]) {
      expect(checkCommandCouldNotRun(python(["check.py"]), 1, `Traceback:\n${lead}File "check.py", line 2\nIndentationError: unexpected indent\n`), JSON.stringify(lead)).toBe(true);
    }
  });
});

// A regex blocks the thread, so no timeout can stop a slow one: the same scan runs at 32 KiB and at 256 KiB and its time may grow about eight times, not
// sixty-four (the old `^\s*File` pattern took about 3 s at 64 KiB of blank lines). A scaling check, not a wall-clock bound, so a slow CI runner cannot fail it.
describe("a hostile check output cannot make the traceback scan slow", () => {
  const FILLERS: Record<string, string> = { newlines: "\n", "space-newline": " \n", "tab-newline": "\t\n", "crlf": "\r\n", spaces: " ", "open-file": "File \"", "file-lines": "  File \"a.py\", line 1\n", "unclosed-file-lines": "File \"aaaa\n" };
  const outputOf = (unit: string, size: number) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size) + "\nSyntaxError: invalid syntax\n";
  for (const [label, unit] of Object.entries(FILLERS)) {
    it(label, () => {
      let last: boolean | undefined;
      expectLinearScaling((size) => {
        const output = outputOf(unit, size);
        return () => { last = checkCommandCouldNotRun(python(["-c", "x"]), 1, output); };
      }, { n: 32_768, label });
      expect(typeof last).toBe("boolean");
    }, 60_000);
  }
});
