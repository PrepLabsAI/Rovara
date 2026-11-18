// L4-EVS: why a customer's eval could not run, in fixed words. The fresh eval sandbox used to drop the command's output (`--log-driver none`), so a missing package read
// as a generic "Not run". Now the worker reads a BOUNDED tail of the output, redacts it (worker/verification/eval-run-diagnostic.ts), names one fixed code and, for the code
// that needs one, ONE name (a package, a file, a command) that passed a strict allow-list shape. This file holds only the wire shape and the fixed sentences; it never
// echoes free text. Browser-safe and pure.
import { z } from "zod";
import { inertEvidenceText } from "./evidence-inert.js";

/** The fixed causes. `exited` is the catch-all: the command ended with a failing code and wrote no readable result. */
export const EVAL_RUN_FAILURE_CODES = ["missing_package", "missing_file", "command_not_found", "install_failed", "install_timed_out", "run_timed_out", "exited"] as const;
export type EvalRunFailureCode = (typeof EVAL_RUN_FAILURE_CODES)[number];
/** The phase the cause was seen in: the project's install step (network allowed to package registries only) or the sealed eval run. */
export const EVAL_RUN_FAILURE_PHASES = ["install", "run"] as const;

/** The most output characters kept after redaction (the last 4 KB the sandbox read). */
export const EVAL_RUN_TAIL_MAX_CHARS = 4_096;
/** One name: a module, package, file or command. A plain word shape only; anything else is dropped and the sentence says no name. */
export const EVAL_RUN_FAILURE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.+/-]{0,79}$/u;

export const EvalRunDiagnosticSchema = z.object({
  code: z.enum(EVAL_RUN_FAILURE_CODES),
  phase: z.enum(EVAL_RUN_FAILURE_PHASES),
  name: z.string().regex(EVAL_RUN_FAILURE_NAME).optional(),
  exitCode: z.number().int().min(-1).max(255).optional(),
  /** The redacted tail of the command's own output. Untrusted text: it is shown only through `inertEvidenceText`. */
  tail: z.string().max(EVAL_RUN_TAIL_MAX_CHARS),
}).strict().refine(d => (d.code === "missing_package" || d.code === "missing_file" || d.code === "command_not_found") || d.name === undefined, "a name belongs to the codes that name something");
export type EvalRunDiagnostic = z.infer<typeof EvalRunDiagnosticSchema>;

/**
 * The fixed sentence for a cause, WITHOUT the "Not run: " lead. `named: false` is the public wording (counts-only views carry no name). A name is quoted only when it matches the allow-list shape.
 */
export function evalRunFailureSentence(diagnostic: Pick<EvalRunDiagnostic, "code" | "exitCode" | "name">, options: { named?: boolean } = {}): string {
  // The name is also made inert (belt and braces: the shape has no `@`, `[`, `<` or `:`).
  const name = options.named !== false && diagnostic.name !== undefined && EVAL_RUN_FAILURE_NAME.test(diagnostic.name) ? inertEvidenceText(diagnostic.name, 80) : undefined;
  const exit = diagnostic.exitCode !== undefined && Number.isInteger(diagnostic.exitCode) && diagnostic.exitCode >= -1 && diagnostic.exitCode <= 255 ? diagnostic.exitCode : undefined;
  switch (diagnostic.code) {
    case "missing_package": return name === undefined ? "the eval couldn't import a package that is not installed (missing package)" : `the eval couldn't import '${name}' (missing package)`;
    case "missing_file": return name === undefined ? "the eval couldn't find a file it needs (missing file)" : `the eval couldn't find the file '${name}' (missing file)`;
    case "command_not_found": return name === undefined ? "the eval command was not found in the sandbox" : `the eval command '${name}' was not found in the sandbox`;
    case "install_failed": return exit === undefined ? "the project's install step failed before the eval ran" : `the project's install step failed (exit ${String(exit)}) before the eval ran`;
    case "install_timed_out": return "the project's install step ran out of time before the eval ran";
    case "run_timed_out": return "the eval ran out of time";
    case "exited": return exit === undefined ? "the eval command stopped before it wrote results" : `the eval command stopped with exit code ${String(exit)} before it wrote results`;
  }
}
