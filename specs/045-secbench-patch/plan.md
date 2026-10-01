# SEC-bench Patch Tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `@agentx eval secbench patch <id> [model X]` runs the AgentX coding agent on one SEC-bench patch task and posts the evaluator's verdict in the Slack thread.

**Architecture:** SEC-bench is a third family (`secbench`) of spec 043's eval runner, beside `swebench` and `pro`. The dataset table, command parser, row loader, prompt, prediction and grader branch on the family. The run record, lock, eval stack, state machine, callbacks, cost ceiling and `stop` are reused unchanged. New code goes in `packages/worker/src/swebench/secbench-*.ts` and `grade-secbench.ts`; shared files change only at their family seams, to keep conflicts with Pratik's ongoing work small.

**Tech Stack:** TypeScript (Node 22, ESM), zod, vitest, Docker CLI, uv and Python 3 for SEC-bench's evaluator, the Hugging Face datasets server.

**Spec:** `specs/045-secbench-patch/spec.md` (SC-002 passed 2026-10-01).

## Global Constraints

- Dataset `secbench-patch` = Hugging Face `SEC-bench/SEC-bench`, config `default`, split `eval`, 300 rows, family `secbench`.
- Instance ID pattern: `^[a-z0-9][a-z0-9_+-]*\.(?:cve-\d{4}-\d{4,}|ossfuzz-\d+)$`.
- Task image: `hwiwonlee/secb.eval.x86_64.<instance_id>:patch`, platform `linux/amd64`.
- Prompt: `src/smolagents/prompts/patch.j2` from `SEC-bench/smolagents` at `a945dba9d6f2594cd94eb00d77f6b41a92fea88b`, 2,572 bytes, SHA-256 `0ec4ffc90183fce6e5497b052146d8893b3bed90b8f311351dbd1cc70b766bab`, bundled in the code.
- Evaluator: `SEC-bench/SEC-bench` at `31eb43485a3de47da260be0f978528b1f2314415`, run as `python -m secb.evaluator.eval_instances --type patch --agent swea --mode all --split eval --input-dir … --output-dir …`.
- Evaluator packages: `datasets==5.0.1 docker==7.2.0 jinja2==3.1.6 loguru==0.7.3 rich==15.0.0 pydantic==2.13.5` (checked on Python 3.11 in SC-002). Never the repository's `requirements.txt`.
- Prediction file filter: `*.c *.cpp *.h *.hpp *.cc *.hh`.
- Agent: 60 minutes, 200 tool calls, `--network none`. Resolved = the evaluator's `medium` verdict.
- Never shown to the agent: the row's `patch`, `bug_report`, `exit_code`.
- The evaluator's `TMPDIR` and all grading files live in `<RUN_ROOT>/.secbench-grade/<run>/`, outside the run's root that the agent's container mounts, but inside `RUN_ROOT` (`/mnt/eval`), which the runner container mounts at the same path on the host.
- Every SEC-bench result says "sanitizer-verified, no regression tests".
- Release order: control plane (broker schema) before the runner image.
- No live AWS action (release, runner-image push, EC2) without Abhishek's go-ahead in the session.
- PR targets `mainline`; no stacked PRs. Commit trailer: `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

Inputs and conditions the spec implies but that are easy to miss, each pinned by a test in the task named:

1. **Grading files on the host's Docker.** The evaluator bind-mounts its temp folder into the grading container. If that folder is not under `RUN_ROOT`, the grading container sees an empty `/tmp` and every patch "fails to apply". Task 5 asserts the evaluator's `TMPDIR` is under the grade directory; Task 6 asserts the grade directory is under `RUN_ROOT` and outside the run's root.
2. **Evaluator setup failures reported as "not fixed".** No `Loaded <n> instances` line (dataset not loaded) or `exit_code: -1` with a `Failed to` reason (image or container failure) must fail the run. Task 5.
3. **Build outputs in the prediction.** The agent runs `secb build` inside the repository. Task 4 checks that object files, logs, generated sources in ignored folders and non-C files are left out, and a new header is kept.
4. **Hidden fields reaching the agent.** Task 3 renders a row whose `patch`, `bug_report` and `exit_code` hold marker values and checks none reach the prompt; a field containing `{{ … }}` is not expanded.
5. **A run that cannot be compared later.** Task 6 checks `result.json` records the template checksum, evaluator commit, dataset revision, thinking level and limits.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `packages/contracts/src/swebench.ts` | modify | dataset table (`split`, `secbench`), ID pattern, `eval secbench` parser, verdict schema |
| `packages/worker/src/swebench/dataset.ts` | modify | split from the table; SEC-bench row; dataset revision |
| `packages/worker/src/swebench/secbench-prompt.ts` | create | bundled template, checksum, rendering |
| `packages/worker/src/swebench/history.ts` | modify | optional source-extension filter on the prediction |
| `packages/worker/src/swebench/grade-secbench.ts` | create | fetch, install and run the evaluator; read its reports |
| `packages/worker/src/swebench/agent.ts` | modify | accept a ready-made prompt |
| `packages/worker/src/swebench/run.ts` | modify | the `secbench` branch |
| `packages/slack-service/src/swebench-command.ts` | modify | benchmark name and verdict lines |
| `tests/fixtures/secbench-eval-instance-ids.txt` | add | the 300 `eval` IDs, fetched 2026-10-01 |
| `tests/contract/secbench-command.test.ts` | create | command, IDs, schema |
| `tests/integration/secbench.test.ts` | create | loader, prompt, prediction, grader, runner, message |
| `docs/swebench-eval.md` | modify | SEC-bench section and install order |

Tasks 1 to 5 are independent of each other except through the interfaces listed in each; Task 6 wires them together; Task 7 is Slack and docs; Task 8 is verification and the PR.

---
### Task 1: Contracts — dataset, ID pattern, command, verdict

**Files:**
- Modify: `packages/contracts/src/swebench.ts`
- Create: `tests/contract/secbench-command.test.ts`
- Add: `tests/fixtures/secbench-eval-instance-ids.txt` (already on disk, one ID per line, 300 lines)

**Interfaces:**
- Produces: `SWEBENCH_DATASETS[d].split` (`"test"` or `"eval"`); dataset `"secbench-patch"`; `type SwebenchFamily = "swebench" | "pro" | "secbench"`; `swebenchFamily(dataset): SwebenchFamily`; `SecbenchVerdictSchema` and `type SecbenchVerdict = { strict: boolean; medium: boolean; generous: boolean; failedStep?: "apply" | "build" | "poc"; pocExitCode?: number; sanitizerReport: boolean; timedOut: boolean }`; `SwebenchGradedResultSchema` gains optional `secbench`; `parseSwebenchCommand("eval secbench patch <id> [model X]")` returns `{ kind: "run", dataset: "secbench-patch", instanceId, modelSelector? }`.

- [ ] **Step 1: Write the failing test** (`tests/contract/secbench-command.test.ts`)

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SWEBENCH_DATASETS, SwebenchRunResultSchema, parseSwebenchCommand, swebenchAgentLimits, swebenchFamily, swebenchInstanceIdFits } from "@agentx/contracts";

const IDS = readFileSync(new URL("../fixtures/secbench-eval-instance-ids.txt", import.meta.url), "utf8").trim().split("\n");
const USAGE = "eval secbench patch <instance-id> [model <name>]";

describe("the eval secbench command (spec 045 FR-001)", () => {
  it("reads the patch task, one instance and an optional model", () => {
    expect(parseSwebenchCommand("<@U123ABC> eval secbench patch njs.cve-2022-32414")).toEqual({ kind: "run", dataset: "secbench-patch", instanceId: "njs.cve-2022-32414" });
    expect(parseSwebenchCommand("eval SECBENCH Patch libxml2.ossfuzz-417247563 model Claude Sonnet 4.6.")).toEqual({
      kind: "run", dataset: "secbench-patch", instanceId: "libxml2.ossfuzz-417247563", modelSelector: "Claude Sonnet 4.6",
    });
  });

  it.each([
    ["eval secbench", /which task/],
    ["eval secbench poc njs.cve-2022-32414", /not available yet/],
    ["eval secbench njs.cve-2022-32414", /Unknown task/],
    ["eval secbench patch", /which instance/],
    ["eval secbench patch django__django-11099", /not a SEC-bench instance ID/],
    ["eval secbench patch njs.cve-2022-32414 njs.cve-2022-28049", /exactly one instance/],
    ["eval secbench patch njs.cve-2022-32414 model", /which model/],
  ])("explains what is wrong with %j", (text, message) => {
    const command = parseSwebenchCommand(text);
    expect(command?.kind).toBe("invalid");
    const reply = command?.kind === "invalid" ? command.message : "";
    expect(reply).toMatch(message);
    expect(reply).toContain(USAGE);
  });

  it("leaves eval swebench and other messages as they were", () => {
    expect(parseSwebenchCommand("eval swebench verified django__django-11099")).toMatchObject({ dataset: "verified" });
    expect(parseSwebenchCommand("eval swebench secbench-patch njs.cve-2022-32414")?.kind).toBe("invalid");
    expect(parseSwebenchCommand("eval secbenchmark results")).toBeUndefined();
  });

  it("accepts all 300 IDs of the eval split, for its own family only", () => {
    expect(IDS).toHaveLength(300);
    expect(IDS.filter((id) => !swebenchInstanceIdFits("secbench-patch", id))).toEqual([]);
    expect(swebenchInstanceIdFits("verified", IDS[0]!)).toBe(false);
    expect(swebenchInstanceIdFits("secbench-patch", "django__django-11099")).toBe(false);
  });

  it("reads the eval split with Verified's limits (FR-003, FR-006)", () => {
    expect(SWEBENCH_DATASETS["secbench-patch"]).toEqual({ name: "SEC-bench/SEC-bench", config: "default", split: "eval", family: "secbench" });
    expect(SWEBENCH_DATASETS.verified.split).toBe("test");
    expect(swebenchFamily("secbench-patch")).toBe("secbench");
    expect(swebenchAgentLimits("secbench-patch")).toEqual({ timeLimitSeconds: 3_600, toolCallLimit: 200 });
  });
});

describe("a graded SEC-bench result (FR-010)", () => {
  const graded = {
    outcome: "GRADED", resolved: true, stopReason: "finished", patchBytes: 120, agentSeconds: 300,
    imageDigest: `hwiwonlee/secb.eval.x86_64.njs.cve-2022-32414@sha256:${"a".repeat(64)}`,
    usage: {
      schemaVersion: 1, outcome: "SUCCEEDED", provider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet-4-6", cacheRetention: "short",
      tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 }, cacheReadRatio: 0, costUsd: 0.3,
    },
    artifactsPrefix: "evals/00000000-0000-0000-0000-000000000000/",
  };
  const verdict = { strict: true, medium: true, generous: true, pocExitCode: 0, sanitizerReport: false, timedOut: false };

  it("carries the verdict in place of test counts", () => {
    expect(SwebenchRunResultSchema.safeParse({ ...graded, secbench: verdict }).success).toBe(true);
  });

  it("refuses an unknown failed step or an extra field", () => {
    expect(SwebenchRunResultSchema.safeParse({ ...graded, secbench: { ...verdict, failedStep: "link" } }).success).toBe(false);
    expect(SwebenchRunResultSchema.safeParse({ ...graded, secbench: { ...verdict, extra: 1 } }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run tests/contract/secbench-command.test.ts`
Expected: FAIL, `swebenchFamily` is not exported.

- [ ] **Step 3: Dataset table, family and ID pattern** (`packages/contracts/src/swebench.ts`)

Replace the table and enum, and add the family helper:

```ts
/**
 * The datasets a run may name: the Hugging Face dataset, config and split each reads, and its family.
 * `swebench` tasks are graded by the swebench harness (spec 043), `pro` tasks by their own Harbor
 * verifier (spec 044), `secbench` tasks by SEC-bench's evaluator (spec 045).
 */
export const SWEBENCH_DATASETS = {
  verified: { name: "SWE-bench/SWE-bench_Verified", config: "default", split: "test", family: "swebench" },
  lite: { name: "SWE-bench/SWE-bench_Lite", config: "default", split: "test", family: "swebench" },
  full: { name: "SWE-bench/SWE-bench", config: "default", split: "test", family: "swebench" },
  pro: { name: "ScaleAI/SWE-bench_Pro", config: "default", split: "test", family: "pro" },
  "pro-hard": { name: "ScaleAI/SWE-bench_Pro", config: "hard", split: "test", family: "pro" },
  "secbench-patch": { name: "SEC-bench/SEC-bench", config: "default", split: "eval", family: "secbench" },
} as const;

export const SwebenchDatasetSchema = z.enum(["verified", "lite", "full", "pro", "pro-hard", "secbench-patch"]);

export type SwebenchFamily = (typeof SWEBENCH_DATASETS)[keyof typeof SWEBENCH_DATASETS]["family"];

export function swebenchFamily(dataset: SwebenchDataset): SwebenchFamily {
  return SWEBENCH_DATASETS[dataset].family;
}
```

Beside the two existing patterns:

```ts
/** `<project>.cve-<year>-<number>` or `<project>.ossfuzz-<number>`, as SEC-bench writes them (spec 045 FR-001). */
const SECBENCH_INSTANCE_ID = /^[a-z0-9][a-z0-9_+-]*\.(?:cve-\d{4}-\d{4,}|ossfuzz-\d+)$/;

const INSTANCE_IDS: Record<SwebenchFamily, RegExp> = { swebench: SWEBENCH_INSTANCE_ID, pro: SWEBENCH_PRO_INSTANCE_ID, secbench: SECBENCH_INSTANCE_ID };
```

Change `SwebenchInstanceIdSchema`'s refine to `(value) => Object.values(INSTANCE_IDS).some((pattern) => pattern.test(value))`, `swebenchInstanceIdFits` to `return INSTANCE_IDS[swebenchFamily(dataset)].test(instanceId);`, and the condition in `swebenchAgentLimits` to `swebenchFamily(dataset) === "pro"`. `INSTANCE_IDS` must be declared after the two existing regex constants and before `SwebenchInstanceIdSchema`.

- [ ] **Step 4: Verdict schema** (same file, above `SwebenchGradedResultSchema`)

```ts
/** SEC-bench's evaluator verdict (spec 045 FR-009): its three modes, and what the proof of concept did. */
export const SecbenchVerdictSchema = z.object({
  strict: z.boolean(),
  medium: z.boolean(),
  generous: z.boolean(),
  /** The step that failed; absent when all three ran. */
  failedStep: z.enum(["apply", "build", "poc"]).optional(),
  pocExitCode: z.number().int().optional(),
  sanitizerReport: z.boolean(),
  timedOut: z.boolean(),
}).strict();
```

Inside `SwebenchGradedResultSchema`, after `passToPass`:

```ts
  /** SEC-bench runs (spec 045): the evaluator's verdict, in place of test counts. */
  secbench: SecbenchVerdictSchema.optional(),
```

With the other types at the end: `export type SecbenchVerdict = z.infer<typeof SecbenchVerdictSchema>;`

- [ ] **Step 5: Parser** (same file; replaces `COMMAND` and `parseSwebenchCommand`)

```ts
const COMMAND = /^eval\s+swebench\b(.*)$/isu;
const SECBENCH_COMMAND = /^eval\s+secbench\b(.*)$/isu;
const SWEBENCH_USAGE = "Use `eval swebench <verified|lite|full|pro|pro-hard> <instance-id> [model <name>]`.";
const SECBENCH_USAGE = "Use `eval secbench patch <instance-id> [model <name>]`.";

const EXPECTED_ID: Record<SwebenchFamily, string> = {
  swebench: "a SWE-bench instance ID (`<owner>__<repo>-<number>`)",
  pro: "a SWE-Bench Pro instance ID (`instance_<owner>__<repo>-<commit>-v<suffix>`)",
  secbench: "a SEC-bench instance ID (`<project>.cve-<year>-<number>` or `<project>.ossfuzz-<number>`)",
};

export function parseSwebenchCommand(text: string): SwebenchCommand | undefined {
  const command = text.replace(/^\s*<@[A-Z0-9]+>\s*/iu, "").trim().replace(/[.!?]+$/u, "");
  const secbench = SECBENCH_COMMAND.exec(command);
  if (secbench) return parseSecbenchWords(words(secbench[1]));
  const match = COMMAND.exec(command);
  if (!match) return undefined;
  const rest = words(match[1]);
  const dataset = SwebenchDatasetSchema.safeParse(rest[0]?.toLowerCase());
  // One spelling per benchmark: SEC-bench is `eval secbench`, not a swebench dataset.
  if (!dataset.success || swebenchFamily(dataset.data) === "secbench") {
    return { kind: "invalid", message: rest[0] === undefined ? `Tell me which dataset and instance to run. ${SWEBENCH_USAGE}` : `Unknown dataset “${rest[0]}”. ${SWEBENCH_USAGE}` };
  }
  return instanceAndModel(dataset.data, rest.slice(1), SWEBENCH_USAGE);
}

function parseSecbenchWords(rest: string[]): SwebenchCommand {
  const task = rest[0]?.toLowerCase();
  if (task === undefined) return { kind: "invalid", message: `Tell me which task and instance to run. ${SECBENCH_USAGE}` };
  if (task === "poc") return { kind: "invalid", message: `SEC-bench's PoC task is not available yet. ${SECBENCH_USAGE}` };
  if (task !== "patch") return { kind: "invalid", message: `Unknown task “${rest[0]}”. ${SECBENCH_USAGE}` };
  return instanceAndModel("secbench-patch", rest.slice(1), SECBENCH_USAGE);
}

function instanceAndModel(dataset: SwebenchDataset, rest: string[], usage: string): SwebenchCommand {
  const instanceId = rest[0];
  if (instanceId === undefined) return { kind: "invalid", message: `Tell me which instance to run. ${usage}` };
  if (!SwebenchInstanceIdSchema.safeParse(instanceId).success || !swebenchInstanceIdFits(dataset, instanceId)) {
    return { kind: "invalid", message: `“${instanceId}” is not ${EXPECTED_ID[swebenchFamily(dataset)]}. ${usage}` };
  }
  const after = rest.slice(1);
  if (after.length === 0) return { kind: "run", dataset, instanceId };
  if (after[0]?.toLowerCase() !== "model") return { kind: "invalid", message: `A run takes exactly one instance for now. ${usage}` };
  const modelSelector = after.slice(1).join(" ");
  if (modelSelector.length === 0) return { kind: "invalid", message: `Tell me which model after \`model\`. ${usage}` };
  return { kind: "run", dataset, instanceId, modelSelector };
}

function words(value: string | undefined): string[] {
  return (value ?? "").trim().split(/\s+/u).filter((word) => word.length > 0);
}
```

Every existing reply for `eval swebench` keeps its exact wording.

- [ ] **Step 6: Run the new and existing tests**

Run: `npx vitest run tests/contract/secbench-command.test.ts tests/contract/swebench-command.test.ts tests/integration/swebench-pro.test.ts tests/contract/swebench-broker.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/swebench.ts tests/contract/secbench-command.test.ts tests/fixtures/secbench-eval-instance-ids.txt
git commit -m "feat(contracts): eval secbench patch command, dataset and verdict (spec 045)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Loader — split, SEC-bench rows, dataset revision

**Files:**
- Modify: `packages/worker/src/swebench/dataset.ts`
- Create: `tests/integration/secbench.test.ts`

**Interfaces:**
- Consumes: `SWEBENCH_DATASETS[d].split` and `.family` (Task 1).
- Produces: `loadSwebenchInstance("secbench-patch", id)` returns a `SwebenchInstance` with `image = "hwiwonlee/secb.eval.x86_64.<id>:patch"`, string fields `work_dir`, `bug_description`, `sanitizer_report`, and `problem_statement` set to `bug_description`; `SECBENCH_IMAGE_PREFIX`; `datasetRevision(name: string, options?: { fetch?: typeof fetch }): Promise<string | undefined>`.

- [ ] **Step 1: Write the failing test** (new file `tests/integration/secbench.test.ts`; later tasks add `describe` blocks to it and imports at its top, merging any that repeat a module already imported)

```ts
import { describe, expect, it } from "vitest";
import { datasetRevision, loadSwebenchInstance } from "../../packages/worker/src/swebench/dataset.js";

/** A SEC-bench row; the hidden fields hold markers that must never reach the agent. */
const SECBENCH_ROW = {
  instance_id: "njs.cve-2022-32414",
  repo: "nginx/njs",
  project_name: "njs",
  lang: "c++",
  work_dir: "/src/njs",
  sanitizer: "address",
  bug_description: "A crash in njs_vmcode_interpreter when running a crafted script.",
  base_commit: "f65981b0b8fcf02d69a40bc934803c25c9f607ab",
  build_sh: "#!/bin/bash\n",
  secb_sh: "#!/bin/bash\n",
  dockerfile: "FROM base\n",
  patch: "MARKER-GOLD-PATCH",
  exit_code: 987654,
  sanitizer_report: "==1==ERROR: AddressSanitizer: SEGV on unknown address",
  bug_report: "MARKER-BUG-REPORT",
};

function fakeServer(rows: Array<Record<string, unknown>>, requested: string[] = []): typeof fetch {
  return (async (url: string) => {
    requested.push(url);
    return new Response(JSON.stringify({ rows: rows.map((row) => ({ row })), num_rows_total: rows.length }));
  }) as unknown as typeof fetch;
}

describe("loading a SEC-bench instance (spec 045 FR-003)", () => {
  it("reads the eval split and names the :patch image", async () => {
    const requested: string[] = [];
    const instance = await loadSwebenchInstance("secbench-patch", "njs.cve-2022-32414", { fetch: fakeServer([SECBENCH_ROW], requested) });
    expect(requested[0]).toContain("dataset=SEC-bench%2FSEC-bench");
    expect(requested[0]).toContain("split=eval");
    expect(instance).toMatchObject({ image: "hwiwonlee/secb.eval.x86_64.njs.cve-2022-32414:patch", work_dir: "/src/njs", problem_statement: SECBENCH_ROW.bug_description });
  });

  it.each(["/etc", "/src/../etc", "src/njs", "/src/", "/src/njs/./x"])("refuses the work_dir %j", async (work_dir) => {
    await expect(loadSwebenchInstance("secbench-patch", "njs.cve-2022-32414", { fetch: fakeServer([{ ...SECBENCH_ROW, work_dir }]) })).rejects.toThrow(/work_dir/);
  });

  it("refuses a row without its sanitizer report", async () => {
    await expect(loadSwebenchInstance("secbench-patch", "njs.cve-2022-32414", { fetch: fakeServer([{ ...SECBENCH_ROW, sanitizer_report: "" }]) })).rejects.toThrow(/sanitizer_report/);
  });

  it("keeps reading SWE-bench's test split", async () => {
    const requested: string[] = [];
    await loadSwebenchInstance("verified", "django__django-11099", {
      fetch: fakeServer([{ instance_id: "django__django-11099", repo: "django/django", base_commit: "a".repeat(40), problem_statement: "p", image: "swebench/x" }], requested),
    });
    expect(requested[0]).toContain("split=test");
  });

  it("reads the dataset revision, or none when Hugging Face does not answer", async () => {
    const ok = (async () => new Response(JSON.stringify({ sha: "11422e774857272b8f5460c699dca7a64046308b" }))) as unknown as typeof fetch;
    const down = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    expect(await datasetRevision("SEC-bench/SEC-bench", { fetch: ok })).toBe("11422e774857272b8f5460c699dca7a64046308b");
    expect(await datasetRevision("SEC-bench/SEC-bench", { fetch: down })).toBeUndefined();
  });
});

```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run tests/integration/secbench.test.ts`
Expected: FAIL, `datasetRevision` is not exported.

- [ ] **Step 3: Implement** (`packages/worker/src/swebench/dataset.ts`)

In `loadSwebenchInstance`: `const { name, config, split, family } = SWEBENCH_DATASETS[dataset];`, use `split` instead of the literal `"test"` in the page URL, and replace `instanceRow` with:

```ts
  const instanceRow = (row: Record<string, unknown>) => {
    if (family === "secbench") return secbenchRow(row, instanceId);
    return normalizedRow(family === "pro" && row.image === undefined ? { ...row, image: row.docker_image } : row, instanceId);
  };
```

Update the doc comment's "the test split's pages" to "the dataset's split, page by page". Below `normalizedRow`, add:

```ts
/** SEC-bench publishes one image per instance and task; the patch task's holds the PoC (spec 045 D-2). */
export const SECBENCH_IMAGE_PREFIX = "hwiwonlee/secb.eval.x86_64";
const SECBENCH_WORK_DIR = /^\/src\/[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)*$/;

/**
 * A SEC-bench row names no image and has no problem statement: the image follows from the instance
 * ID, and `problem_statement` carries the bug description so the shared fields stay filled. The
 * prompt is built from `bug_description` and `sanitizer_report` (secbench-prompt.ts).
 */
function secbenchRow(row: Record<string, unknown>, instanceId: string): SwebenchInstance {
  for (const field of ["work_dir", "bug_description", "sanitizer_report"] as const) {
    if (typeof row[field] !== "string" || row[field] === "") throw new Error(`${instanceId}'s row has no ${field}`);
  }
  const workDir = row.work_dir as string;
  if (!SECBENCH_WORK_DIR.test(workDir) || workDir.split("/").some((part) => part === "." || part === "..")) {
    throw new Error(`${instanceId}'s work_dir ${workDir} is not a folder under /src`);
  }
  return normalizedRow({ ...row, image: `${SECBENCH_IMAGE_PREFIX}.${instanceId}:patch`, problem_statement: row.bug_description }, instanceId);
}

/** The dataset's current Hugging Face revision, recorded with the result; undefined when it cannot be read. */
export async function datasetRevision(name: string, options: { fetch?: typeof fetch } = {}): Promise<string | undefined> {
  try {
    const response = await (options.fetch ?? fetch)(`https://huggingface.co/api/datasets/${name}`, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) return undefined;
    const body = await response.json() as { sha?: unknown };
    return typeof body.sha === "string" && /^[0-9a-f]{40}$/.test(body.sha) ? body.sha : undefined;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/integration/secbench.test.ts tests/integration/swebench-runner.test.ts tests/integration/swebench-pro.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/swebench/dataset.ts tests/integration/secbench.test.ts
git commit -m "feat(worker): load SEC-bench rows from the eval split (spec 045 FR-003)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The bundled patch prompt

**Files:**
- Create: `packages/worker/src/swebench/secbench-prompt.ts`
- Modify: `tests/integration/secbench.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `SECBENCH_SMOLAGENTS_COMMIT`, `SECBENCH_PATCH_TEMPLATE`, `SECBENCH_PATCH_TEMPLATE_SHA256`, `secbenchPatchPrompt(row: { work_dir: string; bug_description: string; sanitizer_report: string }, hostFolder: string): string`.

- [ ] **Step 1: Produce the template literal from the pinned file**

The template contains backticks, so it is stored as a JSON string literal rather than a template literal:

```bash
curl -fsSL https://raw.githubusercontent.com/SEC-bench/smolagents/a945dba9d6f2594cd94eb00d77f6b41a92fea88b/src/smolagents/prompts/patch.j2 -o /tmp/patch.j2
shasum -a 256 /tmp/patch.j2   # must print 0ec4ffc90183fce6e5497b052146d8893b3bed90b8f311351dbd1cc70b766bab
node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync("/tmp/patch.j2", "utf8")))' > /tmp/patch.j2.json
```

- [ ] **Step 2: Write the failing test** (append to `tests/integration/secbench.test.ts`; add the import at the top)

```ts
import { createHash } from "node:crypto";
import { SECBENCH_PATCH_TEMPLATE, SECBENCH_PATCH_TEMPLATE_SHA256, secbenchPatchPrompt } from "../../packages/worker/src/swebench/secbench-prompt.js";

describe("the SEC-bench patch prompt (spec 045 FR-005)", () => {
  it("bundles SEC-bench's template byte for byte", () => {
    expect(SECBENCH_PATCH_TEMPLATE_SHA256).toBe("0ec4ffc90183fce6e5497b052146d8893b3bed90b8f311351dbd1cc70b766bab");
    expect(createHash("sha256").update(SECBENCH_PATCH_TEMPLATE, "utf8").digest("hex")).toBe(SECBENCH_PATCH_TEMPLATE_SHA256);
  });

  it("puts the bug description and sanitizer report after AgentX's preamble", () => {
    const prompt = secbenchPatchPrompt(SECBENCH_ROW, "/mnt/eval/r1/testbed");
    expect(prompt.startsWith("You are working in the repository at /mnt/eval/r1/testbed (also /src/njs in the shell).")).toBe(true);
    expect(prompt).toContain("no network access");
    expect(prompt).toContain(`<issue_description>\n${SECBENCH_ROW.bug_description}\n---\n${SECBENCH_ROW.sanitizer_report}\n</issue_description>`);
    expect(prompt).not.toMatch(/\{\{|\}\}/);
  });

  it("never passes the gold patch, the bug report or the expected exit code", () => {
    const prompt = secbenchPatchPrompt(SECBENCH_ROW, "/mnt/eval/r1/testbed");
    for (const hidden of ["MARKER-GOLD-PATCH", "MARKER-BUG-REPORT", "987654"]) expect(prompt).not.toContain(hidden);
  });

  it("does not expand template syntax that appears in the row's text", () => {
    const prompt = secbenchPatchPrompt({ ...SECBENCH_ROW, bug_description: "parser fails on {{ work_dir }}" }, "/h");
    expect(prompt).toContain("parser fails on {{ work_dir }}");
  });
});
```

- [ ] **Step 3: Run it and see it fail**

Run: `npx vitest run tests/integration/secbench.test.ts -t "patch prompt"`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement** (`packages/worker/src/swebench/secbench-prompt.ts`)

Paste the single line in `/tmp/patch.j2.json` as the value of `SECBENCH_PATCH_TEMPLATE`. Until it is pasted, the checksum test fails, which is the check that the paste is exact.

```ts
/**
 * SEC-bench's own patch-task prompt (spec 045 FR-005), bundled so a run fetches nothing: the agent
 * sees what the paper's agents saw, after AgentX's fixed preamble.
 */
export const SECBENCH_SMOLAGENTS_COMMIT = "a945dba9d6f2594cd94eb00d77f6b41a92fea88b";
/** src/smolagents/prompts/patch.j2 at that commit, verbatim. */
export const SECBENCH_PATCH_TEMPLATE = "<contents of /tmp/patch.j2.json>";
export const SECBENCH_PATCH_TEMPLATE_SHA256 = "0ec4ffc90183fce6e5497b052146d8893b3bed90b8f311351dbd1cc70b766bab";

type PromptFields = { work_dir: string; bug_description: string; sanitizer_report: string };

/** The prompt for one row. Only the three fields the template names reach the agent. */
export function secbenchPatchPrompt(row: PromptFields, hostFolder: string): string {
  // One pass, so text inside a field that looks like {{ … }} is not expanded again.
  const rendered = SECBENCH_PATCH_TEMPLATE.replace(
    /\{\{ (work_dir|bug_description|sanitizer_report) \}\}/g,
    (_, field: keyof PromptFields) => row[field],
  );
  return [
    `You are working in the repository at ${hostFolder} (also ${row.work_dir} in the shell).`,
    "Shell commands run in the project's build image, with no network access.",
    "When the crash is resolved, stop and summarize the change in one paragraph.",
    "",
    rendered.trim(),
  ].join("\n");
}
```

- [ ] **Step 5: Run the tests and commit**

Run: `npx vitest run tests/integration/secbench.test.ts` and expect PASS.

```bash
git add packages/worker/src/swebench/secbench-prompt.ts tests/integration/secbench.test.ts
git commit -m "feat(worker): bundle SEC-bench's patch prompt with its checksum (spec 045 FR-005)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Source-only prediction

**Files:**
- Modify: `packages/worker/src/swebench/history.ts`
- Modify: `tests/integration/secbench.test.ts`

**Interfaces:**
- Produces: `SECBENCH_SOURCE_EXTENSIONS = [".c", ".cpp", ".h", ".hpp", ".cc", ".hh"] as const`; `predictionPatch(git, imageHead, untrackedBefore, sourceExtensions?: readonly string[]): Promise<string>` (existing callers pass three arguments and are unchanged).

- [ ] **Step 1: Write the failing test** (append; add imports at the top)

```ts
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createGitRunner, predictionPatch, SECBENCH_SOURCE_EXTENSIONS, untrackedFiles } from "../../packages/worker/src/swebench/history.js";

const exec = promisify(execFile);

describe("the SEC-bench prediction (spec 045 FR-007)", () => {
  it("keeps changed and new C and C++ sources, and leaves build outputs out", async () => {
    const path = await mkdtemp(join(tmpdir(), "agentx-secbench-"));
    const git = (...args: string[]) => exec("git", args, { cwd: path }).then((result) => result.stdout.trim());
    await git("init", "--quiet");
    await git("config", "user.email", "t@example.com");
    await git("config", "user.name", "Test");
    await mkdir(join(path, "src"));
    await writeFile(join(path, "src/vm.c"), "int f(void) { return 0; }\n");
    await writeFile(join(path, "Makefile"), "all:\n");
    await writeFile(join(path, ".gitignore"), "gen/\n");
    await git("add", ".");
    await git("commit", "--quiet", "-m", "base");
    const head = await git("rev-parse", "HEAD");
    const runner = createGitRunner(path);
    const before = await untrackedFiles(runner);
    await writeFile(join(path, "src/vm.c"), "int f(void) { return 1; }\n");
    await writeFile(join(path, "src/guard.h"), "#define GUARD 1\n");
    await writeFile(join(path, "Makefile"), "all: changed\n");
    await mkdir(join(path, "build"));
    await writeFile(join(path, "build/vm.o"), "object");
    await writeFile(join(path, "config.log"), "log");
    await mkdir(join(path, "gen"));
    await writeFile(join(path, "gen/parser.c"), "generated");
    const patch = await predictionPatch(runner, head, before, SECBENCH_SOURCE_EXTENSIONS);
    expect(patch).toContain("src/vm.c");
    expect(patch).toContain("src/guard.h");
    for (const excluded of ["Makefile", "build/vm.o", "config.log", "gen/parser.c"]) expect(patch).not.toContain(excluded);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run tests/integration/secbench.test.ts -t "SEC-bench prediction"`
Expected: FAIL, `SECBENCH_SOURCE_EXTENSIONS` is not exported.

- [ ] **Step 3: Implement** (`history.ts`; replaces `predictionPatch`)

```ts
/** The files SEC-bench's agents put in a prediction (spec 045 FR-007). */
export const SECBENCH_SOURCE_EXTENSIONS = [".c", ".cpp", ".h", ".hpp", ".cc", ".hh"] as const;

/**
 * The prediction: every change to tracked files since the image's HEAD (the tree the harness applies
 * it to), plus the files the agent created (untracked, not ignored, absent before it started), as
 * one patch `git apply` takes. With `sourceExtensions`, only files with those extensions, as
 * SEC-bench's agents collect theirs, so what the agent's builds leave in the repository stays out.
 */
export async function predictionPatch(git: GitRunner, imageHead: string, untrackedBefore: ReadonlySet<string>, sourceExtensions?: readonly string[]): Promise<string> {
  const kept = (path: string) => sourceExtensions === undefined || sourceExtensions.some((extension) => path.endsWith(extension));
  const created = [...await untrackedFiles(git)].filter((path) => !untrackedBefore.has(path) && kept(path));
  if (created.length > 0) await git(["add", "--intent-to-add", "--", ...created]);
  const pathspecs = sourceExtensions === undefined ? [] : ["--", ...sourceExtensions.map((extension) => `*${extension}`)];
  return git(["diff", "--binary", imageHead, ...pathspecs]);
}
```

- [ ] **Step 4: Run the new and existing prediction tests**

Run: `npx vitest run tests/integration/secbench.test.ts tests/integration/swebench-runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/swebench/history.ts tests/integration/secbench.test.ts
git commit -m "feat(worker): limit a SEC-bench prediction to C and C++ sources (spec 045 FR-007)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Grade with SEC-bench's evaluator

**Files:**
- Create: `packages/worker/src/swebench/grade-secbench.ts`
- Modify: `tests/integration/secbench.test.ts`

**Interfaces:**
- Consumes: `ProcessRunner` from `grade.ts`; `SecbenchVerdict` (Task 1).
- Produces: `SECBENCH_EVALUATOR_COMMIT`, `SECBENCH_EVALUATOR_PACKAGES`; `interface SecbenchReportLine { instance_id: string; success: boolean; reason: string; exit_code: number; logs: string }`; `interface SecbenchGradeReport { resolved: boolean; secbench: SecbenchVerdict; files: Array<{ name: string; path: string }> }`; `gradeSecbenchPrediction(input: { directory: string; instanceId: string; patch: string }, run?: ProcessRunner): Promise<SecbenchGradeReport>`; `secbenchVerdict(reports: Record<"strict" | "medium" | "generous", SecbenchReportLine>): SecbenchVerdict`.

The evaluator writes `report_<mode>.jsonl` files into `--output-dir`, one JSON line per instance with `instance_id`, `success`, `reason`, `exit_code` and `logs` (the grading container's output). Its grading script prints `FAIL_STEP: Git apply`, `FAIL_STEP: Compile` and `Run PoC exit code: <n>` lines; `-1` with a `Failed to …` reason means it could not pull the image or create the container. SC-002 showed it logs `Loaded 300 instances` when the dataset loads.

- [ ] **Step 1: Write the failing tests** (append; add imports at the top)

```ts
import { readFile } from "node:fs/promises";
import { gradeSecbenchPrediction, SECBENCH_EVALUATOR_COMMIT, SECBENCH_EVALUATOR_PACKAGES } from "../../packages/worker/src/swebench/grade-secbench.js";
import type { ProcessRunner } from "../../packages/worker/src/swebench/grade.js";

const STEP_LOGS = {
  fixed: "Step 1: Git apply\nSUCCESS: Git apply passed; exit code=0\nStep 2: Compile\nSUCCESS: Compile passed; exit code=0\nStep 3: Run PoC\nRun PoC exit code: 0\nSUCCESS: Run PoC passed; exit code=0\n",
  stillReported: "Step 3: Run PoC\n==12==ERROR: AddressSanitizer: SEGV on unknown address\n==12==ABORTING\nRun PoC exit code: 1\nTENTATIVE: Run PoC; exit code=1\n",
  noBuild: "Step 2: Compile\nFAIL_STEP: Compile; exit code=2\n",
  noApply: "Step 1: Git apply\nFAIL_STEP: Git apply; exit code=1\n",
  timeout: "Step 3: Run PoC\nRun PoC exit code: 124\nTENTATIVE: Run PoC; exit code=124\n",
};

type Outcome = { logs: string; exitCode: number; success: Record<"strict" | "medium" | "generous", boolean>; reason?: string };

/** Answers git, uv and the evaluator as the real ones do, writing the three reports the evaluator writes. */
function fakeEvaluator(outcome: Outcome | undefined, options: { loaded?: string; evaluatorExit?: number } = {}) {
  const calls: Array<{ executable: string; args: readonly string[]; env?: NodeJS.ProcessEnv; cwd?: string }> = [];
  const run: ProcessRunner = async (executable, args, processOptions) => {
    calls.push({ executable, args, ...(processOptions?.env === undefined ? {} : { env: processOptions.env }), ...(processOptions?.cwd === undefined ? {} : { cwd: processOptions.cwd }) });
    if (executable === "git" && args.includes("rev-parse")) return { exitCode: 0, stdout: `${SECBENCH_EVALUATOR_COMMIT}\n`, stderr: "" };
    const output = args.indexOf("--output-dir");
    if (output < 0) return { exitCode: 0, stdout: "", stderr: "" };
    if (outcome !== undefined) {
      await mkdir(args[output + 1]!, { recursive: true });
      for (const mode of ["strict", "medium", "generous"] as const) {
        const line = { instance_id: "njs.cve-2022-32414", success: outcome.success[mode], reason: outcome.reason ?? "", git_patch: "", exit_code: outcome.exitCode, logs: outcome.logs, model_name: "unknown_model" };
        await writeFile(join(args[output + 1]!, `report_${mode}.jsonl`), `${JSON.stringify(line)}\n`);
      }
    }
    return { exitCode: options.evaluatorExit ?? 0, stdout: "", stderr: options.loaded ?? "INFO | Loaded 300 instances from SEC-bench/SEC-bench\n" };
  };
  return { run, calls };
}

const ALL = (value: boolean) => ({ strict: value, medium: value, generous: value });

describe("grading with SEC-bench's evaluator (spec 045 FR-008, FR-008a, FR-009)", () => {
  const grade = async (outcome: Outcome | undefined, options?: Parameters<typeof fakeEvaluator>[1]) => {
    const directory = await mkdtemp(join(tmpdir(), "agentx-secbench-grade-"));
    const fake = fakeEvaluator(outcome, options);
    const report = gradeSecbenchPrediction({ directory, instanceId: "njs.cve-2022-32414", patch: "diff --git a/src/vm.c b/src/vm.c\n" }, fake.run);
    return { directory, report, calls: fake.calls };
  };

  it("fetches the pinned evaluator, installs only the pinned packages, and writes the prediction as preds.json", async () => {
    const { directory, report, calls } = await grade({ logs: STEP_LOGS.fixed, exitCode: 0, success: ALL(true) });
    await report;
    expect(calls.some((call) => call.executable === "git" && call.args.includes("fetch") && call.args.includes(SECBENCH_EVALUATOR_COMMIT))).toBe(true);
    const install = calls.find((call) => call.executable === "uv" && call.args.includes("install"));
    expect(install?.args.slice(-SECBENCH_EVALUATOR_PACKAGES.length)).toEqual([...SECBENCH_EVALUATOR_PACKAGES]);
    expect(install?.args.some((arg) => arg.includes("requirements"))).toBe(false);
    const preds = JSON.parse(await readFile(join(directory, "input/preds.json"), "utf8")) as unknown;
    expect(preds).toEqual({ "njs.cve-2022-32414": { model_patch: "diff --git a/src/vm.c b/src/vm.c\n" } });
  });

  it("runs the evaluator with TMPDIR inside its own directory, so the host's Docker can mount it", async () => {
    const { directory, report, calls } = await grade({ logs: STEP_LOGS.fixed, exitCode: 0, success: ALL(true) });
    await report;
    const evaluator = calls.find((call) => call.args.includes("secb.evaluator.eval_instances"));
    expect(evaluator?.args).toEqual(expect.arrayContaining(["--type", "patch", "--agent", "swea", "--mode", "all", "--split", "eval"]));
    expect(evaluator?.env?.TMPDIR?.startsWith(`${directory}/`)).toBe(true);
  });

  it.each([
    ["fixed", { logs: STEP_LOGS.fixed, exitCode: 0, success: ALL(true) }, { resolved: true, secbench: { ...ALL(true), pocExitCode: 0, sanitizerReport: false, timedOut: false } }],
    ["still reported", { logs: STEP_LOGS.stillReported, exitCode: 1, success: ALL(false) }, { resolved: false, secbench: { ...ALL(false), failedStep: "poc", pocExitCode: 1, sanitizerReport: true, timedOut: false } }],
    ["no build", { logs: STEP_LOGS.noBuild, exitCode: 2, success: ALL(false) }, { resolved: false, secbench: { ...ALL(false), failedStep: "build", sanitizerReport: false, timedOut: false } }],
    ["no apply", { logs: STEP_LOGS.noApply, exitCode: 1, success: ALL(false) }, { resolved: false, secbench: { ...ALL(false), failedStep: "apply", sanitizerReport: false, timedOut: false } }],
    ["timeout", { logs: STEP_LOGS.timeout, exitCode: 124, success: ALL(false) }, { resolved: false, secbench: { ...ALL(false), failedStep: "poc", pocExitCode: 124, sanitizerReport: false, timedOut: true } }],
  ] as const)("reads the verdict when the patch is %s", async (_, outcome, expected) => {
    const { report } = await grade(outcome);
    expect(await report).toMatchObject(expected);
  });

  it("takes medium as resolved when only strict fails", async () => {
    const { report } = await grade({ logs: STEP_LOGS.fixed.replace("Run PoC exit code: 0", "Run PoC exit code: 1"), exitCode: 1, success: { strict: false, medium: true, generous: true } });
    expect(await report).toMatchObject({ resolved: true, secbench: { strict: false, medium: true, pocExitCode: 1 } });
  });

  it("fails, rather than reporting unresolved, when the dataset did not load", async () => {
    const { report } = await grade({ logs: STEP_LOGS.fixed, exitCode: 0, success: ALL(true) }, { loaded: "ERROR | Failed to load dataset SEC-bench/SEC-bench\n" });
    await expect(report).rejects.toThrow(/did not load the dataset/);
  });

  it("fails when the evaluator could not start the grading container", async () => {
    const { report } = await grade({ logs: "", exitCode: -1, success: ALL(false), reason: "Failed to pull image hwiwonlee/secb.eval.x86_64.njs.cve-2022-32414:patch" });
    await expect(report).rejects.toThrow(/could not grade.*Failed to pull/);
  });

  it("fails when a report is missing or the evaluator exits non-zero", async () => {
    await expect((await grade(undefined)).report).rejects.toThrow(/report_strict.jsonl/);
    await expect((await grade({ logs: STEP_LOGS.fixed, exitCode: 0, success: ALL(true) }, { evaluatorExit: 1 })).report).rejects.toThrow(/exited 1/);
  });

  it("keeps the reports, the evaluator's log and the container log for the artifacts (FR-011)", async () => {
    const { report } = await grade({ logs: STEP_LOGS.fixed, exitCode: 0, success: ALL(true) });
    expect((await report).files.map((file) => file.name)).toEqual([
      "harness/report_strict.jsonl", "harness/report_medium.jsonl", "harness/report_generous.jsonl", "harness/evaluator.log", "harness/container.log",
    ]);
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/integration/secbench.test.ts -t "SEC-bench's evaluator"`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** (`packages/worker/src/swebench/grade-secbench.ts`)

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { SecbenchVerdict } from "@agentx/contracts";
import { runCollected, type CollectedProcess } from "../collected-process.js";
import type { ProcessRunner } from "./grade.js";

/** SEC-bench's evaluator, pinned (spec 045 FR-008). It is not a Python package, so it runs from a checkout. */
export const SECBENCH_EVALUATOR_REPOSITORY = "https://github.com/SEC-bench/SEC-bench";
export const SECBENCH_EVALUATOR_COMMIT = "31eb43485a3de47da260be0f978528b1f2314415";
/** What the evaluator imports, pinned; its requirements.txt pulls smolagents@main unpinned. Checked in SC-002. */
export const SECBENCH_EVALUATOR_PACKAGES = ["datasets==5.0.1", "docker==7.2.0", "jinja2==3.1.6", "loguru==0.7.3", "rich==15.0.0", "pydantic==2.13.5"] as const;

const MODES = ["strict", "medium", "generous"] as const;
type Mode = (typeof MODES)[number];
/** The evaluator waits up to 600 s for the grading container; this covers that, the image pull and the install. */
const EVALUATOR_TIMEOUT_MS = 40 * 60_000;

export interface SecbenchReportLine { instance_id: string; success: boolean; reason: string; exit_code: number; logs: string }

export interface SecbenchGradeReport {
  resolved: boolean;
  secbench: SecbenchVerdict;
  files: Array<{ name: string; path: string }>;
}

/**
 * Grades one prediction with SEC-bench's own evaluator: a fresh container from the task's :patch
 * image applies the patch, builds, and runs the proof of concept. `medium` (the published default)
 * decides resolved; all three modes are recorded. Failures the evaluator would report as an
 * unresolved patch, but that say nothing about the patch, throw (FR-008a).
 *
 * The evaluator bind-mounts a Python temporary folder into its grading container through the host's
 * Docker, so TMPDIR is under `directory`, which the caller keeps under the runner's RUN_ROOT,
 * mounted at the same path on the host.
 */
export async function gradeSecbenchPrediction(
  input: { directory: string; instanceId: string; patch: string },
  run: ProcessRunner = (executable, args, options) => runCollected(executable, args, options ?? {}),
): Promise<SecbenchGradeReport> {
  const { directory, instanceId } = input;
  const evaluator = resolve(directory, "evaluator");
  const venv = resolve(directory, "venv");
  const inputDirectory = resolve(directory, "input");
  const outputDirectory = resolve(directory, "output");
  const temporary = resolve(directory, "tmp");
  for (const folder of [evaluator, inputDirectory, temporary]) await mkdir(folder, { recursive: true });

  await required(run("git", ["init", "--quiet", evaluator]), "prepare the evaluator's checkout");
  await required(run("git", ["-C", evaluator, "fetch", "--quiet", "--depth", "1", SECBENCH_EVALUATOR_REPOSITORY, SECBENCH_EVALUATOR_COMMIT], { timeoutMs: 5 * 60_000 }), "fetch SEC-bench's evaluator");
  await required(run("git", ["-C", evaluator, "checkout", "--quiet", "--detach", "FETCH_HEAD"]), "check out SEC-bench's evaluator");
  const head = (await required(run("git", ["-C", evaluator, "rev-parse", "HEAD"]), "read the evaluator's commit")).stdout.trim();
  if (head !== SECBENCH_EVALUATOR_COMMIT) throw new Error(`SEC-bench's evaluator is at ${head}, not the pinned ${SECBENCH_EVALUATOR_COMMIT}`);
  await required(run("uv", ["venv", "--quiet", "--python", "python3", venv], { timeoutMs: 5 * 60_000 }), "create the evaluator's virtualenv");
  await required(run("uv", ["pip", "install", "--quiet", "--python", resolve(venv, "bin/python"), ...SECBENCH_EVALUATOR_PACKAGES], { timeoutMs: 10 * 60_000 }), "install the evaluator's packages");

  await writeFile(resolve(inputDirectory, "preds.json"), JSON.stringify({ [instanceId]: { model_patch: input.patch } }));
  const evaluation = await run(resolve(venv, "bin/python"), [
    "-m", "secb.evaluator.eval_instances",
    "--type", "patch", "--agent", "swea", "--mode", "all", "--split", "eval",
    "--input-dir", inputDirectory, "--output-dir", outputDirectory,
  ], { cwd: evaluator, env: { ...process.env, TMPDIR: temporary, PYTHONPATH: evaluator }, timeoutMs: EVALUATOR_TIMEOUT_MS });
  const evaluatorLog = resolve(directory, "evaluator.log");
  await writeFile(evaluatorLog, `${evaluation.stdout}\n${evaluation.stderr}`);
  if (evaluation.exitCode !== 0) throw new Error(`SEC-bench's evaluator exited ${String(evaluation.exitCode)}${evaluation.timedOut === true ? " (timed out)" : ""}`);
  const loaded = /Loaded (\d+) instances/.exec(`${evaluation.stdout}\n${evaluation.stderr}`);
  if (loaded === null || Number(loaded[1]) === 0) {
    throw new Error("SEC-bench's evaluator did not load the dataset, so its medium verdict would be strict's");
  }

  const reports = {} as Record<Mode, SecbenchReportLine>;
  for (const mode of MODES) reports[mode] = await reportLine(resolve(outputDirectory, `report_${mode}.jsonl`), instanceId);
  if (reports.medium.exit_code === -1) throw new Error(`SEC-bench's evaluator could not grade the patch: ${reports.medium.reason.slice(0, 300)}`);
  const containerLog = resolve(directory, "container.log");
  await writeFile(containerLog, reports.medium.logs);
  return {
    resolved: reports.medium.success,
    secbench: secbenchVerdict(reports),
    files: [
      ...MODES.map((mode) => ({ name: `harness/report_${mode}.jsonl`, path: resolve(outputDirectory, `report_${mode}.jsonl`) })),
      { name: "harness/evaluator.log", path: evaluatorLog },
      { name: "harness/container.log", path: containerLog },
    ],
  };
}

/** What the three reports say, and what the grading container's log shows (FR-009). */
export function secbenchVerdict(reports: Record<Mode, SecbenchReportLine>): SecbenchVerdict {
  const logs = reports.medium.logs;
  const failed = /^FAIL_STEP: (Git apply|Compile)/m.exec(logs);
  const poc = /^Run PoC exit code: (-?\d+)/m.exec(logs);
  const failedStep = failed !== null ? (failed[1] === "Git apply" ? "apply" : "build") : !reports.medium.success && poc !== null ? "poc" : undefined;
  return {
    strict: reports.strict.success,
    medium: reports.medium.success,
    generous: reports.generous.success,
    ...(failedStep === undefined ? {} : { failedStep }),
    ...(poc === null ? {} : { pocExitCode: Number(poc[1]) }),
    sanitizerReport: /==\d+==(?:ERROR|WARNING): \w+Sanitizer:/.test(logs),
    timedOut: [124, 137].includes(reports.medium.exit_code) || /^Run PoC exit code: (?:124|137)$/m.test(logs),
  };
}

async function reportLine(path: string, instanceId: string): Promise<SecbenchReportLine> {
  const text = await readFile(path, "utf8").catch(() => {
    throw new Error(`SEC-bench's evaluator wrote no ${path.split("/").pop()!}`);
  });
  const line = text.split("\n").filter((entry) => entry.trim().length > 0).map((entry) => JSON.parse(entry) as SecbenchReportLine).find((entry) => entry.instance_id === instanceId);
  if (line === undefined) throw new Error(`SEC-bench's evaluator reported nothing for ${instanceId} in ${path.split("/").pop()!}`);
  return line;
}

async function required(result: Promise<CollectedProcess>, what: string): Promise<CollectedProcess> {
  const completed = await result;
  if (completed.exitCode !== 0) {
    throw new Error(`could not ${what}: ${(completed.stderr || completed.stdout).trim().split("\n").slice(-5).join(" ").slice(0, 800)}`);
  }
  return completed;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/integration/secbench.test.ts`
Expected: PASS. In "still reported", `failedStep` is `"poc"` because the medium verdict failed after the PoC ran.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/swebench/grade-secbench.ts tests/integration/secbench.test.ts
git commit -m "feat(worker): grade SEC-bench patches with SEC-bench's own evaluator (spec 045 FR-008 to FR-011)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Wire the `secbench` family into the runner

**Files:**
- Modify: `packages/worker/src/swebench/agent.ts`
- Modify: `packages/worker/src/swebench/run.ts`
- Modify: `tests/integration/secbench.test.ts`

**Interfaces:**
- Consumes: `swebenchFamily` (Task 1); `datasetRevision`, the SEC-bench row fields (Task 2); `secbenchPatchPrompt`, `SECBENCH_PATCH_TEMPLATE_SHA256`, `SECBENCH_SMOLAGENTS_COMMIT` (Task 3); `SECBENCH_SOURCE_EXTENSIONS` (Task 4); `gradeSecbenchPrediction`, `SecbenchGradeReport`, `SECBENCH_EVALUATOR_COMMIT` (Task 5).
- Produces: `AgentRunInput.prompt?: string` (used verbatim when present); `SwebenchRunDependencies.gradeSecbench?: typeof gradeSecbenchPrediction`; a GRADED result with `secbench` for SEC-bench runs; `result.json` gains `limits`, `thinkingLevel` (all families) and, for SEC-bench, `secbench: { promptTemplateSha256, smolagentsCommit, evaluatorCommit, datasetRevision? }`.

- [ ] **Step 1: Write the failing test** (append; add imports at the top)

The test runs `runSwebench` end to end with a fake Docker CLI (it copies a real git repository where the image's `/src/njs` would be), a fake Pi session that edits a source file and writes a build output, a fake dataset server, and an injected grader that records its input.

```ts
import { cp, rm } from "node:fs/promises";
import type { SwebenchRunResult } from "@agentx/contracts";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";
import { runSwebench, type RunReporter } from "../../packages/worker/src/swebench/run.js";
import type { PiSessionAdapter, PiSessionHandle } from "../../packages/worker/src/pi-session.js";

const RUN_ID = "11111111-2222-4333-8444-555555555555";

async function templateRepository(): Promise<{ path: string; head: string }> {
  const path = await mkdtemp(join(tmpdir(), "agentx-secbench-image-"));
  const git = (...args: string[]) => exec("git", args, { cwd: path }).then((result) => result.stdout.trim());
  await git("init", "--quiet");
  await git("config", "user.email", "t@example.com");
  await git("config", "user.name", "Test");
  await writeFile(join(path, "vm.c"), "int f(void) { return 0; }\n");
  await git("add", ".");
  await git("commit", "--quiet", "-m", "base");
  return { path, head: await git("rev-parse", "HEAD") };
}

function fakeDocker(template: string, calls: string[][]): DockerCli {
  const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
  return {
    async run(args) {
      calls.push([...args]);
      if (args[0] === "image") return ok(JSON.stringify([`hwiwonlee/secb.eval.x86_64.njs.cve-2022-32414@sha256:${"b".repeat(64)}`]));
      if (args[0] === "cp") await cp(template, args[2]!, { recursive: true });
      return ok();
    },
  };
}

/** A Pi session that fixes vm.c, leaves a build output, and finishes. */
function editingAdapter(testbed: string, observed: { prompt?: string }): PiSessionAdapter {
  return {
    async create({ sessionDirectory }) {
      const sessionFile = join(sessionDirectory, "fake.jsonl");
      await writeFile(sessionFile, "{\"type\":\"session\"}\n");
      const listeners = new Set<(event: unknown) => void>();
      const handle: PiSessionHandle = {
        conversationId: "fake",
        sessionFile,
        async prompt(text) {
          observed.prompt = text;
          await writeFile(join(testbed, "vm.c"), "int f(void) { return 1; }\n");
          await writeFile(join(testbed, "vm.o"), "object");
          for (const listener of listeners) listener({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
        },
        async steer() {},
        async abort() {},
        getModel: () => ({ provider: "amazon-bedrock", modelId: "fixture-model" }),
        getSessionStats: () => ({
          sessionFile, sessionId: "fake", userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2,
          tokens: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, total: 100 }, cost: 0.05,
        }),
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        dispose() {},
      };
      return handle;
    },
  };
}

describe("a SEC-bench run (spec 045 FR-004 to FR-011)", () => {
  it("runs the agent in the project's folder, grades only sources outside the agent's mounts, and records the configuration", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "agentx-secbench-run-"));
    const template = await templateRepository();
    const calls: string[][] = [];
    const artifacts = new Map<string, string>();
    let reported: SwebenchRunResult | undefined;
    const reporter: RunReporter = {
      async started() {},
      async artifact(name, body) { artifacts.set(name, body.toString()); },
      async result(result) { reported = result; },
    };
    const row = { ...SECBENCH_ROW, base_commit: template.head };
    const fetchImplementation = (async (url: string) => url.includes("/api/datasets/")
      ? new Response(JSON.stringify({ sha: "11422e774857272b8f5460c699dca7a64046308b" }))
      : new Response(JSON.stringify({ rows: [{ row }], num_rows_total: 1 }))) as unknown as typeof fetch;
    const graded: Array<{ directory: string; instanceId: string; patch: string }> = [];
    const observed: { prompt?: string } = {};
    const result = await runSwebench({
      runId: RUN_ID, dataset: "secbench-patch", instanceId: "njs.cve-2022-32414",
      model: { provider: "amazon-bedrock", modelId: "fixture-model" }, maxCostUsd: 10,
      controlPlaneUrl: "https://control.example.com", capability: "cap", artifactBucket: "bucket",
      artifactsPrefix: `evals/${RUN_ID}/`,
    }, {
      rootPath,
      model: { provider: "amazon-bedrock", modelId: "fixture-model", thinkingLevel: "medium" },
      docker: fakeDocker(template.path, calls),
      reporter,
      log: () => {},
      dataset: { fetch: fetchImplementation },
      piAdapter: editingAdapter(join(rootPath, RUN_ID, "testbed"), observed),
      gradeSecbench: async (input) => {
        graded.push(input);
        return { resolved: true, secbench: { strict: true, medium: true, generous: true, pocExitCode: 0, sanitizerReport: false, timedOut: false }, files: [] };
      },
    });

    expect(result).toMatchObject({ outcome: "GRADED", resolved: true, secbench: { medium: true } });
    expect(reported).toEqual(result);
    expect(result.outcome === "GRADED" ? result.failToPass : "x").toBeUndefined();
    // The task container mounts the copy where the image keeps the project, with no network.
    const started = calls.find((args) => args[0] === "run" && args.includes("--detach"))!;
    expect(started).toEqual(expect.arrayContaining(["--network", "none", "--volume", `${join(rootPath, RUN_ID, "testbed")}:/src/njs`, "--workdir", "/src/njs"]));
    expect(observed.prompt).toContain(SECBENCH_ROW.bug_description);
    // The prediction holds the source change and not the build output.
    expect(graded[0]!.patch).toContain("vm.c");
    expect(graded[0]!.patch).not.toContain("vm.o");
    // Grading happens under RUN_ROOT, outside the run's root that the agent's container mounts.
    expect(graded[0]!.directory.startsWith(`${rootPath}/`)).toBe(true);
    expect(graded[0]!.directory.startsWith(`${join(rootPath, RUN_ID)}/`)).toBe(false);
    const saved = JSON.parse(artifacts.get("result.json")!) as Record<string, unknown>;
    expect(saved).toMatchObject({
      dataset: "secbench-patch",
      thinkingLevel: "medium",
      limits: { timeLimitSeconds: 3_600, toolCallLimit: 200 },
      secbench: {
        promptTemplateSha256: "0ec4ffc90183fce6e5497b052146d8893b3bed90b8f311351dbd1cc70b766bab",
        smolagentsCommit: "a945dba9d6f2594cd94eb00d77f6b41a92fea88b",
        evaluatorCommit: "31eb43485a3de47da260be0f978528b1f2314415",
        datasetRevision: "11422e774857272b8f5460c699dca7a64046308b",
      },
    });
    await rm(rootPath, { recursive: true, force: true });
  });
});
```

If `runSwebench`'s config type needs fields this literal lacks, copy them from `SwebenchRunnerConfigSchema` in `packages/contracts/src/swebench.ts`; the schema there is the source of truth.

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run tests/integration/secbench.test.ts -t "a SEC-bench run"`
Expected: FAIL. The type check rejects `gradeSecbench`, or at run time the container is mounted at `/testbed`.

- [ ] **Step 3: Let the agent take a ready-made prompt** (`agent.ts`)

Add to `AgentRunInput`:

```ts
  /** The whole prompt, when the family builds its own (spec 045 FR-005); otherwise swebenchPrompt's. */
  prompt?: string;
```

and in `runSwebenchAgent` change the prompt call to:

```ts
    await session.prompt(input.prompt ?? swebenchPrompt(input.problemStatement, input.paths.hostFolder, input.paths.containerFolder));
```

- [ ] **Step 4: The runner's `secbench` branch** (`run.ts`)

Imports to add:

```ts
import { swebenchFamily } from "@agentx/contracts";
import { datasetRevision, loadSwebenchInstance, type DatasetOptions } from "./dataset.js";
import { gradeSecbenchPrediction, SECBENCH_EVALUATOR_COMMIT, type SecbenchGradeReport } from "./grade-secbench.js";
import { createGitRunner, predictionPatch, SECBENCH_SOURCE_EXTENSIONS, stripHistory, untrackedFiles } from "./history.js";
import { SECBENCH_PATCH_TEMPLATE_SHA256, SECBENCH_SMOLAGENTS_COMMIT, secbenchPatchPrompt } from "./secbench-prompt.js";
```

(merge them into the existing import lines rather than duplicating `dataset.js` and `history.js`). Add `gradeSecbench?: typeof gradeSecbenchPrediction;` to `SwebenchRunDependencies`, and mention spec 045 in `runSwebench`'s doc comment: "SEC-bench patch tasks (spec 045) run in the project's `work_dir` with SEC-bench's own prompt, and are graded by SEC-bench's evaluator."

In `runSwebench`, next to the other `let` declarations:

```ts
  let secbenchRun: { datasetRevision?: string } | undefined;
  const secbenchGrade = resolve(dirname(root), ".secbench-grade", config.runId);
```

Replace `const pro = SWEBENCH_DATASETS[config.dataset].family === "pro";` with:

```ts
    const family = swebenchFamily(config.dataset);
    const pro = family === "pro";
    const secbench = family === "secbench";
```

After `loadSwebenchInstance`:

```ts
    if (secbench) {
      const revision = await datasetRevision(SWEBENCH_DATASETS[config.dataset].name, dependencies.dataset);
      secbenchRun = revision === undefined ? {} : { datasetRevision: revision };
    }
```

Replace the repository line:

```ts
    // SEC-bench keeps each project at its row's work_dir under /src (spec 045 FR-004).
    const repository = pro ? await findRepository(docker, instance.image) : secbench ? String(instance.work_dir) : TESTBED;
```

In the `runSwebenchAgent` call, after `toolCallLimit`:

```ts
      ...(secbench ? { prompt: secbenchPatchPrompt(instance as unknown as { work_dir: string; bug_description: string; sanitizer_report: string }, testbed) } : {}),
```

The prediction:

```ts
    const patch = await predictionPatch(git, imageHead, untrackedBefore, secbench ? SECBENCH_SOURCE_EXTENSIONS : undefined);
```

The grade, replacing the existing `let grade` declaration and its assignment inside `if (patch.trim().length > 0)`:

```ts
    let grade: GradeReport | SecbenchGradeReport | undefined;
    if (patch.trim().length > 0) {
      log("grading", { patchBytes: Buffer.byteLength(patch) });
      if (secbench) {
        // Outside the run's root, which the agent's container mounts; inside RUN_ROOT, which the
        // runner container mounts at its own path, so the evaluator's bind mounts resolve on the host.
        grade = await (dependencies.gradeSecbench ?? gradeSecbenchPrediction)({ directory: secbenchGrade, instanceId: config.instanceId, patch });
      } else if (proTask === undefined) {
        grade = await (dependencies.grade ?? gradePrediction)({ directory: resolve(root, "grade"), runId: config.runId, instance, patch });
      } else {
        grade = await (dependencies.gradePro ?? gradeProPrediction)({
          directory: resolve(dirname(root), ".pro-tasks", config.runId, "grade"),
          image: instance.image,
          testsDirectory: proTask.testsDirectory,
          patch,
          verifierTimeoutSeconds: proTask.verifierTimeoutSeconds,
        }, docker);
      }
      // (the existing loop that saves grade.files stays here unchanged)
    }
```

In the GRADED result, replace the `failToPass`/`passToPass` spread with:

```ts
      ...(grade === undefined ? {} : "secbench" in grade ? { secbench: grade.secbench } : { failToPass: grade.failToPass, passToPass: grade.passToPass }),
```

In `finally`, beside the `.pro-tasks` cleanup:

```ts
    await rm(secbenchGrade, { recursive: true, force: true }).catch(() => undefined);
```

In the `result.json` artifact, after `offlineSettings`:

```ts
    // What a later comparison needs to know about how the run was set up (pilot lesson, 2026-10-01).
    limits: swebenchAgentLimits(config.dataset),
    thinkingLevel: dependencies.model.thinkingLevel ?? "default",
    ...(secbenchRun === undefined ? {} : {
      secbench: {
        promptTemplateSha256: SECBENCH_PATCH_TEMPLATE_SHA256,
        smolagentsCommit: SECBENCH_SMOLAGENTS_COMMIT,
        evaluatorCommit: SECBENCH_EVALUATOR_COMMIT,
        ...secbenchRun,
      },
    }),
```

`limits` and `thinkingLevel` go in every family's `result.json`, because the pilot's GLM-versus-Sonnet comparison was confounded by an unrecorded thinking level. They stay out of the broker's strict schema, as `offlineSettings` does.

- [ ] **Step 5: Run the worker tests and typecheck**

Run: `npx vitest run tests/integration/secbench.test.ts tests/integration/swebench-runner.test.ts tests/integration/swebench-pro.test.ts && npm run typecheck`
Expected: PASS, and typecheck clean. If `npm run typecheck` reports errors also present on `mainline`, compare with `npm run typecheck:all` (it checks against the baseline) before changing anything.

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/swebench/agent.ts packages/worker/src/swebench/run.ts tests/integration/secbench.test.ts
git commit -m "feat(worker): run SEC-bench patch tasks in the eval runner (spec 045)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Slack result message and docs

**Files:**
- Modify: `packages/slack-service/src/swebench-command.ts`
- Modify: `docs/swebench-eval.md`
- Modify: `tests/integration/secbench.test.ts`

**Interfaces:**
- Consumes: `SecbenchVerdict`, `swebenchFamily` (Task 1).
- Produces: `resultMessage(run)` with SEC-bench lines; the start, cancel and failure messages name the benchmark ("SEC-bench" or "SWE-bench").

- [ ] **Step 1: Write the failing test** (append; add the import at the top)

```ts
import type { SecbenchVerdict, SwebenchRun } from "@agentx/contracts";
import { resultMessage } from "../../packages/slack-service/src/swebench-command.js";

describe("the SEC-bench result in the thread (spec 045 FR-010)", () => {
  const run = (secbench: SecbenchVerdict | undefined, resolved: boolean): SwebenchRun => ({
    runId: RUN_ID, dataset: "secbench-patch", instanceId: "njs.cve-2022-32414",
    model: { provider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet-4-6" }, maxCostUsd: 10,
    thread: { teamId: "T0BSHLLUGBD", channelId: "C0C5NCSC3K7", threadTs: "1790817668.039179" },
    requestedBy: { teamId: "T0BSHLLUGBD", userId: "U0BSRRRADC1" },
    status: "SUCCEEDED", createdAt: "2026-10-01T12:00:00.000Z", updatedAt: "2026-10-01T12:10:00.000Z",
    result: {
      outcome: "GRADED", resolved, stopReason: "finished", patchBytes: 120, agentSeconds: 245,
      imageDigest: `hwiwonlee/secb.eval.x86_64.njs.cve-2022-32414@sha256:${"a".repeat(64)}`,
      usage: { schemaVersion: 1, outcome: "SUCCEEDED", provider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet-4-6", cacheRetention: "short", tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 }, cacheReadRatio: 0, costUsd: 0.31 },
      artifactsPrefix: `evals/${RUN_ID}/`,
      ...(secbench === undefined ? {} : { secbench }),
    },
  });
  const verdict = { strict: true, medium: true, generous: true, pocExitCode: 0, sanitizerReport: false, timedOut: false };

  it("says what a pass means", () => {
    const message = resultMessage(run(verdict, true));
    expect(message).toContain("*Resolved* `njs.cve-2022-32414` (SEC-bench patch task).");
    expect(message).toContain("• Check: the PoC no longer triggers the sanitizer and the patched project builds (sanitizer-verified, no regression tests)");
    expect(message).toContain("• Modes: strict pass, medium pass, generous pass");
    expect(message).not.toContain("FAIL_TO_PASS");
  });

  it.each([
    [{ ...verdict, strict: false, medium: false, generous: false, failedStep: "apply" as const }, "• Check: the patch did not apply"],
    [{ ...verdict, strict: false, medium: false, generous: false, failedStep: "build" as const }, "• Check: the patched project did not build"],
    [{ ...verdict, strict: false, medium: false, generous: false, failedStep: "poc" as const, pocExitCode: 1, sanitizerReport: true }, "• Check: the PoC still triggers the sanitizer"],
    [{ ...verdict, strict: false, medium: false, generous: false, failedStep: "poc" as const, pocExitCode: 124, timedOut: true }, "• Check: the PoC timed out"],
    [{ ...verdict, strict: false, medium: false, generous: true, failedStep: "poc" as const, pocExitCode: 3 }, "• Check: the PoC exited with 3, not the expected code"],
  ])("explains an unresolved patch", (secbench, line) => {
    expect(resultMessage(run(secbench, false))).toContain(line);
  });

  it("names SEC-bench when nothing was graded, and leaves SWE-bench's wording alone", () => {
    expect(resultMessage(run(undefined, false))).toContain("• Check: not run, because the agent changed nothing");
    expect(resultMessage({ ...run(verdict, true), status: "CANCELLED" })).toBe("The SEC-bench run of `njs.cve-2022-32414` was cancelled and its instance terminated.");
    expect(resultMessage({ ...run(verdict, true), dataset: "verified", instanceId: "django__django-11099", status: "CANCELLED" })).toBe("The SWE-bench run of `django__django-11099` was cancelled and its instance terminated.");
  });
});
```

If the `SwebenchRun` thread or requester objects need other fields, copy them from `SlackThreadSchema` and `SlackRequesterSchema` in `packages/contracts/src/slack.ts`.

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run tests/integration/secbench.test.ts -t "result in the thread"`
Expected: FAIL. `DATASET_NAMES` has no `secbench-patch`, and the message shows the test-count line.

- [ ] **Step 3: Implement** (`packages/slack-service/src/swebench-command.ts`)

Add `swebenchFamily` and `type SecbenchVerdict` to the `@agentx/contracts` import, then:

```ts
const DATASET_NAMES: Record<SwebenchDataset, string> = {
  verified: "SWE-bench Verified", lite: "SWE-bench Lite", full: "SWE-bench",
  pro: "SWE-Bench Pro", "pro-hard": "SWE-Bench Pro HARD-51",
  "secbench-patch": "SEC-bench patch task",
};

function benchmark(dataset: SwebenchDataset): string {
  return swebenchFamily(dataset) === "secbench" ? "SEC-bench" : "SWE-bench";
}
```

Use `${benchmark(run.dataset)}` instead of the literal "SWE-bench" in the start message, the wait-timeout error, and the cancelled and failed lines of `resultMessage`. Replace the tests block of `resultMessage`:

```ts
  if (result.secbench !== undefined) {
    lines.push(...secbenchLines(result.secbench, result.resolved));
  } else if (result.failToPass !== undefined && result.passToPass !== undefined) {
    lines.push(`• Tests: FAIL_TO_PASS ${result.failToPass.passed}/${result.failToPass.total}, PASS_TO_PASS ${result.passToPass.passed}/${result.passToPass.total}`);
  } else {
    lines.push(swebenchFamily(run.dataset) === "secbench" ? "• Check: not run, because the agent changed nothing" : "• Tests: not run, because the agent changed nothing");
  }
```

and add:

```ts
/** SEC-bench's verdict in words (spec 045 FR-010); a pass always says what SEC-bench does not check. */
function secbenchLines(verdict: SecbenchVerdict, resolved: boolean): string[] {
  const check = resolved
    ? "the PoC no longer triggers the sanitizer and the patched project builds (sanitizer-verified, no regression tests)"
    : verdict.failedStep === "apply" ? "the patch did not apply"
    : verdict.failedStep === "build" ? "the patched project did not build"
    : verdict.timedOut ? "the PoC timed out"
    : verdict.sanitizerReport ? "the PoC still triggers the sanitizer"
    : `the PoC exited with ${verdict.pocExitCode ?? "an unknown code"}, not the expected code`;
  const mode = (passed: boolean) => (passed ? "pass" : "fail");
  return [`• Check: ${check}`, `• Modes: strict ${mode(verdict.strict)}, medium ${mode(verdict.medium)}, generous ${mode(verdict.generous)}`];
}
```

The artifacts line ("Patch, transcript and harness logs") is unchanged.

- [ ] **Step 4: Docs** (`docs/swebench-eval.md`)

After the "SWE-Bench Pro (spec 044)" section, add:

````markdown
### SEC-bench patch tasks (spec 045)

`eval secbench patch <id>` runs one of SEC-bench's 300 C/C++ vulnerabilities (200 CVEs, 100 OSS-Fuzz
bugs). IDs look like `njs.cve-2022-32414` or `libxml2.ossfuzz-417247563`; the `instance_id` column of
`SEC-bench/SEC-bench` (split `eval`) lists them.

```
@agentx eval secbench patch njs.cve-2022-32414 model Claude Sonnet 4.6
```

The agent gets SEC-bench's own patch prompt (bug description and sanitizer report) in the task's
`:patch` image, offline, with the original PoC in `/testcase` so it can run `secb build` and
`secb repro`. SEC-bench's evaluator, pinned to a commit, grades the C/C++ source changes in a fresh
container: the patch applies, the project builds, and the PoC no longer triggers the sanitizer.
Resolved is its `medium` verdict; `strict` and `generous` are shown too. SEC-bench runs no
regression tests, so a pass is "sanitizer-verified, no regression tests"; say so wherever a number
is shown. Its reports and the grading container's log are under the run's `harness/` artifacts.

Ship order: the control plane release (its result schema knows the SEC-bench verdict) before
`npm run swebench:runner-image`.
````

and in the Artifacts table add a row: `| harness/report_<mode>.jsonl, harness/evaluator.log, harness/container.log | SEC-bench's reports and logs (spec 045) |`.

- [ ] **Step 5: Run the Slack tests and commit**

Run: `npx vitest run tests/integration/secbench.test.ts tests/integration/slack-swebench.test.ts tests/contract/swebench-command.test.ts`
Expected: PASS; existing SWE-bench messages are unchanged.

```bash
git add packages/slack-service/src/swebench-command.ts docs/swebench-eval.md tests/integration/secbench.test.ts
git commit -m "feat(slack): post SEC-bench verdicts in the eval thread (spec 045 FR-010)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Verify, open the PR, ship in order

**Files:**
- Modify: `specs/045-secbench-patch/spec.md` (status line)

- [ ] **Step 1: The whole suite**

Run: `npm run typecheck:all && npm run lint && npm test`
Expected: all pass. Paste failures with output; do not weaken an assertion to make one pass.

- [ ] **Step 2: Review the branch**

Request a whole-branch review (superpowers:requesting-code-review) against `spec.md` and this plan's Review Focus list. Fix every finding that is cheap or concerns a silent failure before the PR.

- [ ] **Step 3: Status and PR**

Set the spec's status line to `Implemented; awaiting release (SC-003)`, commit, then, after Abhishek confirms:

```bash
git push -u origin feat/045-secbench-patch
gh pr create --repo PrepLabsAI/AgentX --base mainline --title "feat: run SEC-bench patch tasks from Slack (spec 045)" --body-file /tmp/pr-045.md
```

The PR body says: what the command does; that SEC-bench is a third family touching shared files only at their seams (`swebench.ts`, `dataset.ts`, `history.ts`, `agent.ts`, `run.ts`, `swebench-command.ts`); the SC-002 results; the ship order; that `result.json` now records limits and thinking level for every family; and @-mentions Pratik as reviewer. It ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

- [ ] **Step 4: Ship (each step needs Abhishek's go-ahead; production writes)**

1. After merge: `npm run release:prod` (control plane, so the broker accepts `secbench` verdicts).
2. Then: `npm run swebench:runner-image`.
3. SC-003: in the eval channel, `@agentx eval secbench patch njs.cve-2022-32414 model Claude Sonnet 4.6`. Check the thread result, the `harness/` artifacts in S3 (in particular that `report_medium.jsonl` shows the patch applied, which proves the `TMPDIR` arrangement), and that the instance terminated. Record the result in the spec's SC-003.
