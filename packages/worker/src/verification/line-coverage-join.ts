// Proof and evidence (S-2): a Go cover profile or a JaCoCo XML report named by a check (the approved `coveragePath`) is placed in its repository and handed to the changed-line intersection like a Cobertura or LCOV
// report. The text has already come through `readContainedReport` (contained, plain file, fresh, size-capped); here it is only parsed. The repository is the one the check runs in; its Go modules (go.mod, go.work) and
// Java source roots come from its own files, so a report can only ever name files of that repository, and each name is made absolute from the repository's directory, so the intersection matches it exactly.
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ParsedCoverage, RepositoryChanges } from "./cobertura-lcov-coverage.js";
import { LINE_COVERAGE_TOTAL_LINES_MAX, javaSourceRoots, lineCoverageReportLines, parseLineCoverage, type GoModuleRoot } from "./changed-coverage.js";

/** What the join needs from a repository: its files and a bounded read (the setup detectors' reader, lent by the caller so this module opens no file itself). */
export interface RepositoryFiles {
  paths: readonly string[];
  goModules(): Promise<GoModuleRoot[]>;
}

/** The repository the check runs in: the one whose directory holds the check's working directory. */
export function repositoryOfCheck(rootPath: string, cwd: string, repositories: readonly RepositoryChanges[]): RepositoryChanges | undefined {
  const place = resolve(rootPath, cwd);
  return repositories.find((repository) => {
    const inside = relative(resolve(repository.directory), place);
    return inside === "" || (!inside.startsWith("..") && !isAbsolute(inside));
  });
}

/** A Go cover profile or a JaCoCo report as the intersection's input, or undefined when it is neither (or cannot be placed). */
export async function lineCoverageAsParsed(text: string, repository: RepositoryChanges, files: RepositoryFiles): Promise<ParsedCoverage | undefined> {
  const goModules = await files.goModules();
  const read = parseLineCoverage(text, { goModules, javaSourceRoots: javaSourceRoots(files.paths), repoPaths: new Set(files.paths) });
  if (read === undefined) return undefined;
  const parsedFiles = new Map<string, Map<number, boolean>>();
  let total = 0;
  for (const [path, lines] of read.coverage.files) {
    const expanded = lineCoverageReportLines(lines);
    if (expanded === undefined) continue;
    total += expanded.size;
    if (total > LINE_COVERAGE_TOTAL_LINES_MAX) return undefined;
    // An absolute name inside the repository: the intersection matches it exactly and never by suffix.
    parsedFiles.set(join(resolve(repository.directory), ...path.split("/")), expanded);
  }
  return parsedFiles.size === 0 ? undefined : { format: "line", sources: [], files: parsedFiles };
}
