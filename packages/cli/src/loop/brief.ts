// rovara loop (#359): a brief's parts, read without I/O so the runtime can check them. The Contribute loop needs a goal
// and success criteria before it starts, and holds the agent to those criteria: kept as given when it plans, and each
// ticked with its evidence before its change is accepted.

/** The text under each `## ` heading, by heading in lower case. */
function sections(text: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of text.replace(/\r\n/gu, "\n").split("\n")) {
    const heading = /^##\s+(.+?)\s*$/u.exec(line);
    if (heading !== null) { current = []; found.set((heading[1] ?? "").toLowerCase(), current); continue; }
    current?.push(line);
  }
  return found;
}

/** The required sections `text` lacks, or leaves empty, in order. */
export function missingBriefSections(text: string, required: readonly string[]): string[] {
  const found = sections(text);
  return required.filter((section) => (found.get(section.toLowerCase()) ?? []).every((line) => line.trim() === ""));
}

/** A criterion as it is compared: no checkbox, no evidence, lower case, single spaces. */
export function normalizeCriterion(text: string): string {
  return text.replace(/^\s*\[[ xX]\]\s*/u, "").split(/\s+(?:—|--|-)\s+evidence:|\s+evidence:/iu)[0]!.trim().replace(/\s+/gu, " ").replace(/[.;]$/u, "").toLowerCase();
}

/** One list item under `## Success criteria`: its criterion, whether it is ticked, and its evidence. */
export interface CriterionLine { criterion: string; ticked: boolean; evidence: string }

/** The list items under a text's `## Success criteria`, in order. */
export function criterionLines(text: string): CriterionLine[] {
  const lines = sections(text).get("success criteria") ?? [];
  return lines.flatMap((line) => {
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/u.exec(line);
    if (item === null) return [];
    const body = item[1] ?? "";
    const ticked = /^\[[xX]\]/u.test(body);
    const evidence = /evidence:\s*(.*\S)/iu.exec(body)?.[1] ?? "";
    return [{ criterion: normalizeCriterion(body), ticked, evidence }];
  });
}

/** The success criteria a brief sets, as they are compared. */
export function briefCriteria(text: string): string[] {
  return [...new Set(criterionLines(text).map((line) => line.criterion).filter((criterion) => criterion !== ""))];
}

/**
 * How a document's success criteria differ from the brief's: criteria it lost, or changed, and (when `proved` is
 * asked for) criteria not ticked with their evidence. Each is a sentence the agent can act on; none means it holds.
 */
export function criteriaProblems(text: string, criteria: readonly string[], proved: boolean): string[] {
  const lines = criterionLines(text);
  const problems: string[] = [];
  const missing = criteria.filter((criterion) => !lines.some((line) => line.criterion === criterion));
  const added = lines.filter((line) => !criteria.includes(line.criterion));
  if (missing.length > 0) problems.push(`these success criteria are not in it as given: ${missing.map((criterion) => `"${criterion}"`).join(", ")}`);
  if (added.length > 0) problems.push(`these are not the brief's success criteria; keep exactly those: ${added.map((line) => `"${line.criterion}"`).join(", ")}`);
  if (proved) {
    const open = lines.filter((line) => criteria.includes(line.criterion) && (!line.ticked || line.evidence === ""));
    if (open.length > 0) problems.push(`these success criteria are not proved yet; tick each as \`- [x] <criterion> — Evidence: <how you proved it>\`: ${open.map((line) => `"${line.criterion}"`).join(", ")}`);
  }
  return problems;
}
