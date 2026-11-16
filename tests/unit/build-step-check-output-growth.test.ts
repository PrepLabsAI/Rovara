// The build step reads a failed check's output to tell "the check's own Python could not run" from "the change broke the code". The output is shaped by
// the customer's own tests, so a hostile repository controls it: the traceback-file pattern must stay linear, and must still name the same file.
import { describe, expect, it } from "vitest";
import { checkCommandCouldNotRun } from "../../packages/broker/src/core/build-step/check-results.js";

const python = (args: string[]) => ({ executable: "/usr/bin/python3", args, cwd: "/work/repo" });

describe("which file a Python traceback blames", () => {
  it("blames the check's own -c code when the last file before the error is <string>", () => {
    expect(checkCommandCouldNotRun(python(["-c", "x ="]), 1, 'Traceback (most recent call last):\n  File "<string>", line 1\n    x =\nSyntaxError: invalid syntax\n')).toBe(true);
  });
  it("blames the change when the last file is a module the check imports", () => {
    const output = 'Traceback (most recent call last):\n  File "<string>", line 1, in <module>\n  File "/work/repo/app/mod.py", line 3\nSyntaxError: invalid syntax\n';
    expect(checkCommandCouldNotRun(python(["-c", "import app.mod"]), 1, output)).toBe(false);
  });
  it("reads the file line after tabs, Windows line ends, blank lines and non-breaking spaces, as before", () => {
    for (const lead of ["\t", "\r\n  ", "\n\n\n  ", " ", "﻿  "]) {
      expect(checkCommandCouldNotRun(python(["check.py"]), 1, `Traceback:\n${lead}File "check.py", line 2\nIndentationError: unexpected indent\n`), JSON.stringify(lead)).toBe(true);
    }
  });
});

// A regex blocks the thread, so no timeout can stop a slow one: sizes grow and the first over the bar fails, in seconds. Linear work at 256 KiB takes
// a few ms; the old `^\s*File` pattern took about 3 s at 64 KiB of blank lines.
describe("a hostile check output cannot make the traceback scan slow", () => {
  const BAR_MS = process.env["CI"] !== undefined && process.env["CI"] !== "" && process.env["CI"] !== "false" ? 1_000 : 250;
  const FILLERS: Record<string, string> = { newlines: "\n", "space-newline": " \n", "tab-newline": "\t\n", "crlf": "\r\n", spaces: " ", "open-file": "File \"", "file-lines": "  File \"a.py\", line 1\n", "unclosed-file-lines": "File \"aaaa\n" };
  for (const [label, unit] of Object.entries(FILLERS)) {
    it(label, () => {
      for (const size of [4_096, 16_384, 65_536, 262_144]) {
        const output = unit.repeat(Math.ceil(size / unit.length)).slice(0, size) + "\nSyntaxError: invalid syntax\n";
        const started = performance.now();
        checkCommandCouldNotRun(python(["-c", "x"]), 1, output);
        const took = performance.now() - started;
        expect(took, `${label} at ${String(size)} bytes`).toBeLessThan(BAR_MS);
      }
    }, 60_000);
  }
});
