// The per-test report a check's own command wrote, in id form: ONE reader for the evidence file (`evidence-raw.ts`) and the flaky rerun (`flaky-rerun.ts`), so both see the same tests under the same ids.
// Read through the workspace-contained, link-refusing path (`reportSpecOf` names the file from the command's own arguments). With `notBeforeMs` the file must also have been written at or after that moment (a rerun
// whose command wrote nothing must not be read as a result): without it the file is read as it stands, as the evidence has always done.
import type { ProjectCommand } from "@agentx/contracts";
import { readContainedReport } from "./report-file.js";
import { readCheckReport, reportSpecOf } from "./test-proof.js";
import { TEST_REPORT_MAX_BYTES, parseTestReport, type ParsedTestReport } from "./test-report.js";
import { withTestIds } from "./test-ids.js";

export interface CheckTests {
  report: ParsedTestReport;
  /** The report file's own bytes and real path, kept so a caller that must put the file back as it was can (the rerun overwrites it). */
  file?: { path: string; bytes: Buffer };
}

/** The check's report in id form, or undefined when the command names none, it is missing, unsafe, too large, stale (with `notBeforeMs`) or not a report. Never throws. */
export async function readCheckTests(rootPath: string, command: ProjectCommand, options: { notBeforeMs?: number } = {}): Promise<CheckTests | undefined> {
  try {
    if (options.notBeforeMs === undefined) {
      const read = await readCheckReport(rootPath, command);
      const parsed = read === undefined ? undefined : parseTestReport(read.text, read.kind);
      return parsed === undefined ? undefined : { report: await withTestIds(parsed, { root: rootPath, cwd: command.cwd }) };
    }
    const spec = reportSpecOf(command);
    if (spec === undefined) return undefined;
    const read = await readContainedReport({ root: rootPath, cwd: command.cwd, argument: spec.argument, maxBytes: TEST_REPORT_MAX_BYTES, notBeforeMs: options.notBeforeMs });
    if (!read.ok) return undefined;
    const parsed = parseTestReport(read.bytes.toString("utf8"), spec.kind);
    return parsed === undefined ? undefined : { report: await withTestIds(parsed, { root: rootPath, cwd: command.cwd }), file: { path: read.path, bytes: read.bytes } };
  } catch {
    return undefined;
  }
}
