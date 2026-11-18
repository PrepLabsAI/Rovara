// L4-EVW2 (DEC 254zzz20 D2): how the setup run says what the customer's eval WRITES, so Rovara knows whether it can read the result as it is, or whether the setup agent should propose a small wrapper file as a pull
// request on the customer's repository (never an adapter the customer writes). Pure, browser-safe, no model and no host.
//
//   readable as it is   `junit` (pytest `--junitxml`, DeepEval through pytest, Jest and Vitest reports, TRX), `promptfoo` (its JSON results file) and `measures` (Rovara's own file). No wrapper.
//   needs a wrapper     `rows` (a JSON, JSONL or CSV file with one row per case: which field is the id, which says it passed) and `custom` (the setup agent wrote the wrapper itself, because the output fits no known
//                       shape). A `rows` wrapper comes from a code template (no AI at task time); a `custom` one is part of the setup run, under the setup run's own spend.
//
// The wrapper runs the customer's command UNCHANGED, reads what it wrote and writes a JUnit report (one test case per question) at a fixed path Rovara reads. It sits at ONE of two fixed paths in the repository
// (`EVAL_WRAPPER_WRITE_PATHS`); the adapters refuse any other path, so nothing else in the repository can ever be written.
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import { EVAL_WRAPPER_NODE_PATH, EVAL_WRAPPER_PYTHON_PATH } from "./plugins/code-host.js";
import { sha256HexOf } from "./service-catalog-verify.js";

/** A column or key of a row: a plain word (dots allowed for a nested key, `result.passed`). */
const fieldName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,63}(?:\.[A-Za-z_][A-Za-z0-9_-]{0,63}){0,3}$/u);

/** How a row says it passed: a field that equals one value (`passed` is `true`, `verdict` is `"pass"`), or a score at or above a line (taken from the project's own gate). */
export const EvalRowPassSchema = z.union([
  z.object({ field: fieldName, equals: z.union([z.boolean(), z.string().min(1).max(64), z.number().finite()]) }).strict(),
  z.object({ field: fieldName, atLeast: z.number().finite().min(-1_000_000).max(1_000_000) }).strict(),
]);
export type EvalRowPass = z.infer<typeof EvalRowPassSchema>;

export const EVAL_WRAPPER_LANGUAGES = ["python", "node"] as const;
export const EvalWrapperLanguageSchema = z.enum(EVAL_WRAPPER_LANGUAGES);
export type EvalWrapperLanguage = z.infer<typeof EvalWrapperLanguageSchema>;
/** The largest wrapper the setup agent may write itself (UTF-8 bytes). */
export const EVAL_WRAPPER_CUSTOM_MAX_BYTES = 12_000;

export const EvalOutputShapeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("junit") }).strict(),
  z.object({ kind: z.literal("promptfoo") }).strict(),
  z.object({ kind: z.literal("measures") }).strict(),
  z.object({
    kind: z.literal("rows"),
    format: z.enum(["jsonl", "json", "csv"]),
    language: EvalWrapperLanguageSchema,
    idField: fieldName,
    pass: EvalRowPassSchema,
    /** A `json` file whose rows sit under one key (`{"results": [...]}`); absent: the file is the array. */
    rowsKey: fieldName.optional(),
  }).strict().refine(shape => shape.format === "json" || shape.rowsKey === undefined, "a rows key belongs to a JSON file"),
  z.object({
    kind: z.literal("custom"),
    language: EvalWrapperLanguageSchema,
    /** One plain sentence on what the wrapper reads (shown on the pull request and the setup card). */
    summary: z.string().min(1).max(300).regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u),
    source: z.string().min(1).refine(text => new TextEncoder().encode(text).length <= EVAL_WRAPPER_CUSTOM_MAX_BYTES, "the wrapper is too long").refine(text => !text.includes("\u0000"), "no NUL").refine(text => !/[\u202A-\u202E\u2066-\u2069]/u.test(text), "no direction controls"),
  }).strict(),
]);
export type EvalOutputShape = z.infer<typeof EvalOutputShapeSchema>;

/** Whether Rovara cannot read the eval's output as it is: only a `rows` or `custom` output needs a wrapper. Absent (a report from before this) reads as readable, exactly as before. */
export function evalOutputNeedsWrapper(output: EvalOutputShape | undefined): output is Extract<EvalOutputShape, { kind: "rows" | "custom" }> {
  return output !== undefined && (output.kind === "rows" || output.kind === "custom");
}

/** The fixed words on the setup card and the refusals. */
export const EVAL_OUTPUT_UNREADABLE_MESSAGE = "Rovara can't read this eval's results yet. It needs a small file in your repository: the pull request Rovara opens for it is shown here. Review and merge it, then set up again.";

/** Where a wrapper of this language lives in the repository (one of the two fixed paths). */
export const evalWrapperPathOf = (language: EvalWrapperLanguage): string => (language === "python" ? EVAL_WRAPPER_PYTHON_PATH : EVAL_WRAPPER_NODE_PATH);
/** The JUnit report the wrapper writes, a fixed path in the repository (the re-discovered suite's report). */
export const EVAL_WRAPPER_REPORT_PATH = "rovara/eval-wrapper-results.xml";
/** The command a repository's re-discovered suite runs once the wrapper is merged. */
export const evalWrapperCommandOf = (language: EvalWrapperLanguage): { executable: string; args: string[]; cwd: "." } =>
  ({ executable: language === "python" ? "python3" : "node", args: [evalWrapperPathOf(language)], cwd: "." });

/** The digest of what a wrapper is made from: the shape and the command and report it wraps. The same suite and shape give the same digest, so the same proposal is made once. */
export function evalWrapperDigestOf(input: { output: EvalOutputShape; command: unknown; report: unknown }): string {
  return sha256HexOf(new TextEncoder().encode(`rovara-eval-wrapper/v1\n${canonicalJson({ output: input.output, command: input.command, report: input.report })}`));
}
