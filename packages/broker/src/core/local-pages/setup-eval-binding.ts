// DEC 253q: what the setup page's eval Confirm form token binds: the project and the suite (subject), the setup run and the report digest the page showed (taskId, artifactDigest) and the suite's exact question
// files (requestId: a hash of the files in order). The page signs it and the form route checks it, so a form of one suite cannot confirm another suite, a subset or another report.
import { createHash } from "node:crypto";

export function evalConfirmBinding(project: string, taskId: string, reportDigest: string, selection: string, paths: readonly string[]): { action: string; taskId: string; subject: string; requestId: string; artifactDigest: string } {
  const files = createHash("sha256").update(JSON.stringify(paths), "utf8").digest("hex");
  return { action: "setup.eval-confirm", taskId, subject: JSON.stringify([project, selection]), requestId: `eval-files-${files.slice(0, 40)}`, artifactDigest: reportDigest };
}
