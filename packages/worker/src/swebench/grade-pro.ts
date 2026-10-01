import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TASK_PLATFORM, removeContainer, type DockerCli } from "./containers.js";
import type { GradeReport } from "./grade.js";

/** Applied as Scale's own re-grader (v2/tooling/patch_replay.py) applies a model's patch. */
const APPLY = "git apply --verbose /tmp/replay.patch || git apply --3way /tmp/replay.patch || patch --fuzz=3 -p1 -i /tmp/replay.patch";

/**
 * Grades a prediction with the task's own Harbor verifier (spec 044 FR-006, FR-007): a fresh
 * container from the pristine task image, with network, the patch applied in the repository, the
 * task's `tests/` at /tests, and `bash /tests/test.sh`, which applies the hidden tests, runs them and
 * writes `/logs/verifier/reward.txt` (1 when every FAIL_TO_PASS and PASS_TO_PASS test passed) and
 * `output.json`. A patch that does not apply, a missing reward or a timeout is unresolved.
 */
export async function gradeProPrediction(
  input: { directory: string; image: string; testsDirectory: string; patch: string; verifierTimeoutSeconds: number },
  docker: DockerCli,
): Promise<GradeReport> {
  const logs = resolve(input.directory, "verifier");
  await mkdir(logs, { recursive: true });
  const patchFile = resolve(input.directory, "prediction.patch");
  await writeFile(patchFile, input.patch);
  const name = `agentx-swebench-grade-${randomUUID()}`;
  let timedOut: boolean;
  try {
    const result = await docker.run([
      "run", "--rm", "--name", name,
      "--platform", TASK_PLATFORM,
      "--volume", `${input.testsDirectory}:/tests:ro`,
      "--volume", `${patchFile}:/tmp/replay.patch:ro`,
      "--volume", `${logs}:/logs/verifier`,
      "--entrypoint", "bash",
      input.image,
      "-c",
      [
        "cd /app 2>/dev/null || cd /testbed",
        // An empty prediction applies nothing, as Scale's re-grader does, and the verifier still runs.
        `if [ -s /tmp/replay.patch ]; then { ${APPLY}; } > /logs/verifier/apply.log 2>&1 || { echo 0 > /logs/verifier/reward.txt; echo "the patch did not apply" >> /logs/verifier/apply.log; exit 3; }; fi`,
        "bash /tests/test.sh > /logs/verifier/test-sh.log 2>&1",
      ].join("\n"),
    ], { timeoutMs: (input.verifierTimeoutSeconds + 10 * 60) * 1_000 });
    timedOut = result.timedOut === true;
  } finally {
    await removeContainer(docker, name);
  }
  const reward = (await readFile(resolve(logs, "reward.txt"), "utf8").catch(() => "")).trim();
  const config = JSON.parse(await readFile(resolve(input.testsDirectory, "config.json"), "utf8")) as Record<string, unknown>;
  const output = await readFile(resolve(logs, "output.json"), "utf8").then((text) => JSON.parse(text) as unknown).catch(() => undefined);
  const counts = proTestCounts(config, output);
  return {
    resolved: !timedOut && reward === "1",
    ...counts,
    files: [
      ["harness/output.json", "output.json"],
      ["harness/run-script-stdout.txt", "run-script-stdout.txt"],
      ["harness/run-script-stderr.txt", "run-script-stderr.txt"],
      ["harness/test-sh.log", "test-sh.log"],
      ["harness/apply.log", "apply.log"],
      ["harness/reward.txt", "reward.txt"],
    ].map(([name, file]) => ({ name: name!, path: resolve(logs, file!) })),
  };
}

/**
 * FAIL_TO_PASS and PASS_TO_PASS counts as the verifier judges them: the tests `config.json` lists
 * that `output.json` reports PASSED. The lists may be JSON or Python-literal strings.
 */
export function proTestCounts(config: Record<string, unknown>, output: unknown): Pick<GradeReport, "failToPass" | "passToPass"> {
  const tests = output && typeof output === "object" ? (output as { tests?: unknown }).tests : undefined;
  const passed = new Set((Array.isArray(tests) ? tests : []).flatMap((test: unknown) => {
    const value = test as { name?: unknown; status?: unknown } | null;
    return value && value.status === "PASSED" && typeof value.name === "string" ? [value.name] : [];
  }));
  const count = (list: string[]) => ({ passed: list.filter((name) => passed.has(name)).length, total: list.length });
  return { failToPass: count(testNames(config.fail_to_pass)), passToPass: count(testNames(config.pass_to_pass)) };
}

function testNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string" || value.trim() === "") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // Some lists are Python literals: ['a', 'b'].
  }
  return [...value.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)].map((match) => (match[1] ?? match[2] ?? "").replace(/\\(.)/g, "$1"));
}
