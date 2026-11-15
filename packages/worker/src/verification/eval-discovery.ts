import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import { inertEvidenceText } from "@agentx/contracts";
import { readReportPartsFile } from "./report-file.js";
export interface EvalCandidate { path: string; label: string; tool: string; perQuestion?: boolean; questions?: number }
export interface EvalDiscovery { status: "found" | "none" | "incomplete"; candidates: EvalCandidate[]; omitted: string[]; message: string }
const NO_EVAL = "No eval found. Prompt changes will show old vs new answers but can't be scored. Add an eval, or let Rovara help start one.";
const tools: Readonly<Record<string, string>> = { "promptfooconfig.yaml": "promptfoo", "promptfooconfig.yml": "promptfoo", "promptfooconfig.json": "promptfoo", "deepeval.json": "deepeval", ".deepeval": "deepeval", "evals.yaml": "evals" };
/** Discovery never executes config. Paths are selection data; only the inert label is display text.
 * Reports are evidence of shape, not fresh scores. A4 still validates every measured run separately. */
export async function discoverEvals(root: string, options: { maxEntries?: number } = {}): Promise<EvalDiscovery> {
  const byRoot = new Map<string, EvalCandidate>(); const omitted: string[] = [];
  const max = options.maxEntries ?? 2_000;
  let visited = 0;
  const omit = (path: string, reason: string): void => { omitted.push(`${inertEvidenceText(path, 160)}: ${reason}`); };
  const add = (path: string, tool: string, extra: { perQuestion?: boolean; questions?: number } = {}): void => {
    // An eval container's direct children are suites; deeper folders/configs/reports
    // describe that same suite, rather than additional choices at setup.
    const folders = path.split("/");
    if (tool !== "eval folder") folders.pop();
    const container = folders.findIndex(part => /^(?:evals?|evaluations)$/u.test(part));
    const rootPath = container < 0 ? path : folders.slice(0, container + 2).join("/");
    const previous = byRoot.get(rootPath);
    const rank = (name: string): number => name === "eval folder" ? 0 : ["JUnit", "measures"].includes(name) ? 1 : 2;
    const selectedTool = previous !== undefined && rank(previous.tool) >= rank(tool) ? previous.tool : tool;
    const details = extra.perQuestion === true || previous?.perQuestion === undefined ? extra : { perQuestion: previous.perQuestion, ...(previous.questions === undefined ? {} : { questions: previous.questions }) };
    byRoot.set(rootPath, { path: rootPath, tool: selectedTool, ...details, label: `Found: ${inertEvidenceText(rootPath, 300)} (${details.questions === undefined ? "question count unknown" : `${details.questions} questions`}, ${selectedTool})` });
  };
  const walk = async (relative: string, depth: number): Promise<void> => {
    if (visited >= max) { omit(relative || ".", "inventory limit reached"); return; }
    const children: string[] = [];
    const directory = await opendir(join(root, relative));
    for await (const entry of directory) {
      if (visited >= max) { omit(relative || ".", "inventory limit reached"); break; }
      visited++;
      if ([".git", "node_modules", ".agentx"].includes(entry.name)) continue;
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      const info = await lstat(join(root, path));
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) { omit(path, "not a plain file or folder"); continue; }
      if (info.isDirectory()) {
        if (/(?:^|\/)(?:evals?|evaluations)(?:\/[^/]+)?$/u.test(path)) add(path, "eval folder");
        if (depth >= 6) omit(path, "folder depth limit reached"); else children.push(path);
      } else if (Object.hasOwn(tools, entry.name)) add(path, tools[entry.name]!);
      else if (entry.name === "rovara-measures.json" || /^(?:junit|eval[-_.].*)\.xml$/iu.test(entry.name)) {
        const read = await readReportPartsFile({ root, cwd: ".", argument: path, notBeforeMs: 0 });
        if (!read.ok) { omit(path, "report could not be read"); continue; }
        if (read.parts.measures !== undefined) {
          const questions = read.parts.measures.questions?.length;
          add(path, "measures", { perQuestion: questions !== undefined, ...(questions === undefined ? {} : { questions }) });
        } else if (read.parts.tests !== undefined) add(path, "JUnit", { perQuestion: true, questions: read.parts.tests.tests.length });
        else omit(path, "report has no question results");
      }
    }
    // Look at this directory's reports/configs before descending into large source trees.
    children.sort((a, b) => Number(/(?:^|\/)(?:evals?|evaluations)(?:\/|$)/u.test(b)) - Number(/(?:^|\/)(?:evals?|evaluations)(?:\/|$)/u.test(a)) || a.localeCompare(b));
    for (const child of children) await walk(child, depth + 1);
  };
  try {
    if (!Number.isSafeInteger(max) || max < 1 || max > 2_000 || !(await lstat(root)).isDirectory()) throw new Error("invalid inventory");
    await walk("", 0);
  } catch { omit(".", "inventory could not be read"); }
  const candidates = [...byRoot.values()].filter(candidate => candidate.tool !== "eval folder" || ![...byRoot.keys()].some(path => path.startsWith(`${candidate.path}/`)));
  candidates.sort((a, b) => a.path.localeCompare(b.path));
  const status = omitted.length > 0 ? "incomplete" : candidates.length > 0 ? "found" : "none";
  const message = status === "none" ? NO_EVAL : `${status === "incomplete" ? "Some eval locations could not be checked. " : ""}Confirm an eval or point to the right one. Nothing is run until its call estimate is approved.`;
  return { status, candidates, omitted, message };
}
