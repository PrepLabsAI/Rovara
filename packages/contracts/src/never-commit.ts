// TE-B9 (O38): Rovara's own working files are never part of a customer's change, whatever the workspace layout (a repository at the workspace root, one folder down, a monorepo). This is the one list. The worker leaves
// every listed path out of each `git add` (candidate snapshot, publication, pull request maintenance), takes a force-added one out of the index, and checks the commit about to be pushed before it goes (worker/src/never-commit-guard.ts).
// The customer's own `.gitignore` is never edited: this is a safety net beside it, not a rule written into their repository.
//
// What is listed:
//   - `.agentx` and `.agentx-*` (the task store, the check history `.agentx/last-checks.json`, the preparation manifest, the sandbox's scratch folders), as a file or a folder, at any depth;
//   - Code's local store files if one is misplaced inside a checkout: `.rovara/state.db*` and `.rovara/audit.db*` (the database and its `-wal`, `-shm` and `-journal` files; O40). Only those: `.rovara/rules/`, `.rovara/project.yaml` and
//     `.rovara/lessons.md` are the customer's own files and stay committable (the lessons file has its own guard);
//   - the verifier's report and coverage folders, which it reads from a build's own output: Maven `target/surefire-reports`, `target/failsafe-reports`, `target/site/jacoco`; Gradle `build/test-results`, `build/reports/jacoco`.
//
// Each entry is a Git pathspec (`literal` or `glob`), so Git does the matching, in `git add` and in `git diff` alike, and the two cannot drift apart.

/** Pathspecs that select the listed paths (for `git diff`, `git ls-files`, `git rm --cached`). */
export const ROVARA_NEVER_COMMIT: readonly string[] = Object.freeze([
  ":(top,glob)**/.agentx",
  ":(top,glob)**/.agentx/**",
  ":(top,glob)**/.agentx-*",
  ":(top,glob)**/.agentx-*/**",
  ":(top,glob)**/.rovara/state.db*",
  ":(top,glob)**/.rovara/audit.db*",
  ":(top,glob)**/target/surefire-reports/**",
  ":(top,glob)**/target/failsafe-reports/**",
  ":(top,glob)**/target/site/jacoco/**",
  ":(top,glob)**/build/test-results/**",
  ":(top,glob)**/build/reports/jacoco/**",
]);

/** The same entries as exclusions, to put after `.` in `git add --all -- . <these>`. */
export const ROVARA_NEVER_COMMIT_EXCLUDE: readonly string[] = Object.freeze(ROVARA_NEVER_COMMIT.map((entry) => entry.replace(/^:\(top,/u, ":(top,exclude,")));

/** The most characters of a path the sentence shows. */
const SHOWN_PATH_MAX = 200;

/**
 * The sentence a publication fails with when its commit holds one of the listed paths. The words are fixed; only the path varies, and it is cut at a length, with control and format characters shown as `?`,
 * because a path is the repository's own text.
 */
export function neverCommitRefusal(path: string): string {
  const characters = [...path.replace(/[\p{Cc}\p{Cf}]/gu, "?")];
  const shown = characters.length > SHOWN_PATH_MAX ? `${characters.slice(0, SHOWN_PATH_MAX).join("")}...` : characters.join("");
  return `Rovara stopped: its own working files were about to be committed (${shown}). Not your code. Next: retrying without them`;
}
