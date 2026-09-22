import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { agentXError } from "@agentx/contracts";
import type { PiSessionAdapter, PiSessionHandle } from "@agentx/worker";

/**
 * Which behaviour the deterministic session performs.
 *
 * Both arms run the identical trusted check plan later; the difference is only in the
 * source they produce, which is what lets one plan distinguish a correct frozen output
 * from a defective one.
 */
export type FixtureMode = "correct" | "defective";

export interface FixtureEdit {
  /** Repository-relative path, written for the `correct` arm. */
  path: string;
  correct: string;
  defective: string;
}

export interface FixtureSessionOptions {
  mode: FixtureMode;
  edits: readonly FixtureEdit[];
  /** Repository directory the edits are applied to, inside the prepared workspace. */
  repositoryPath: string;
}

/**
 * A deterministic session that really edits source, with no model anywhere.
 *
 * This is a `PiSessionAdapter`, so the host drives it through the **real**
 * `runTaskInvocation`: the actual freezer, artifact upload, receipt verification and
 * callback path all run. It writes files and nothing else. It cannot mark an operation
 * complete, mint a candidate manifest or fabricate a bundle, because it never touches
 * any of those — the real worker code produces them from the bytes this session wrote.
 *
 * It makes no vendor or model call of any kind.
 */
export function createFixtureSessionAdapter(options: FixtureSessionOptions): PiSessionAdapter {
  for (const edit of options.edits) assertRepositoryRelative(edit.path);
  return {
    async create({ sessionDirectory }): Promise<PiSessionHandle> {
      await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
      const sessionFile = join(sessionDirectory, `fixture-${options.mode}.jsonl`);
      await writeFile(sessionFile, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
      let listener: (event: unknown) => void = () => undefined;
      return {
        conversationId: `00000000-0000-4000-8000-${options.mode === "correct" ? "000000000001" : "000000000002"}`,
        sessionFile,
        async prompt(text: string) {
          await writeFile(sessionFile, `${JSON.stringify({ role: "user", text })}\n`, { flag: "a" });
          for (const edit of options.edits) {
            listener({ type: "tool_execution_start", toolName: "edit" });
            const target = resolve(options.repositoryPath, edit.path);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, options.mode === "correct" ? edit.correct : edit.defective);
            listener({ type: "tool_execution_end", toolName: "edit", result: edit.path });
          }
        },
        async abort() {},
        subscribe(next) {
          listener = next;
          return () => {
            listener = () => undefined;
          };
        },
        dispose() {},
      };
    },
  };
}

export interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

/**
 * One trusted check plan, run identically against whatever source is presented.
 *
 * It is deliberately given only a directory of reconstructed candidate bytes: it never
 * consults the operation, the fixture mode or anything the executor said about itself.
 * That is what makes a failure attributable to the code rather than to the runner.
 */
export async function runTrustedCheckPlan(
  sourcePath: string,
  expectations: readonly { name: string; path: string; mustEqual: string }[],
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const expectation of expectations) {
    assertRepositoryRelative(expectation.path);
    const target = resolve(sourcePath, expectation.path);
    const actual = await readFile(target, "utf8").catch(() => undefined);
    results.push(
      actual === expectation.mustEqual
        ? { name: expectation.name, passed: true, detail: "matched" }
        : {
            name: expectation.name,
            passed: false,
            detail: actual === undefined ? "file is missing" : "content did not match",
          },
    );
  }
  return results;
}

function assertRepositoryRelative(path: string): void {
  if (isAbsolute(path) || path.split(/[\\/]/).some((part) => part === ".." || part === "" || part === ".")) {
    throw agentXError("CONFIG_INVALID", `fixture path must be repository-relative: ${path}`);
  }
  if (path.includes(`..${sep}`)) throw agentXError("CONFIG_INVALID", "fixture path escapes the repository");
}
