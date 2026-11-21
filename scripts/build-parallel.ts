// `npm run build`: the same project build as `tsc -b`, with independent projects built side by side (#1339). `tsc -b` builds the projects the root
// tsconfig.json references one at a time, so a 4-core runner spent most of the build on one core. This reads the reference graph (the root's references
// and each project's own), and starts `tsc -b <project>` for a project once every project it references has finished, up to one per core. Each child's
// own `tsc -b` then finds its references up to date and builds only its project, so the output is what `tsc -b` writes. A failure stops new starts,
// lets the running ones finish, prints every failed project's output and exits non-zero. Extra arguments (`--pretty false`) go to every `tsc -b`.
// Node runs this file directly, so only erasable syntax, Node's own modules and the typescript package.
import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

export type Graph = ReadonlyMap<string, readonly string[]>;

/** The projects the root tsconfig references and, for each, the projects it references (repository-relative paths, forward slashes). */
export function readGraph(root: string): Graph {
  const graph = new Map<string, string[]>();
  const configPath = (project: string): string => join(root, project, "tsconfig.json");
  const referencesOf = (project: string): string[] => {
    const file = project === "" ? join(root, "tsconfig.json") : configPath(project);
    const read = ts.readConfigFile(file, (path) => ts.sys.readFile(path));
    if (read.error !== undefined) throw new Error(`${relative(root, file)}: ${ts.flattenDiagnosticMessageText(read.error.messageText, "\n")}`);
    const references = (read.config as { references?: { path: string }[] }).references ?? [];
    return references.map((reference) => relative(root, resolve(dirname(file), reference.path)).replaceAll("\\", "/"));
  };
  const pending = referencesOf("");
  while (pending.length > 0) {
    const project = pending.shift()!;
    if (graph.has(project)) continue;
    const references = referencesOf(project);
    graph.set(project, references);
    pending.push(...references);
  }
  return graph;
}

/** The projects in an order `tsc -b` could build them one by one (each after its references); throws on a cycle. Ties keep the graph's order. */
export function buildOrder(graph: Graph): string[] {
  const order: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (project: string, path: readonly string[]): void => {
    if (state.get(project) === "done") return;
    if (state.get(project) === "visiting") throw new Error(`project references form a cycle: ${[...path, project].join(" -> ")}`);
    state.set(project, "visiting");
    for (const reference of graph.get(project) ?? []) visit(reference, [...path, project]);
    state.set(project, "done");
    order.push(project);
  };
  for (const project of graph.keys()) visit(project, []);
  return order;
}

export interface RunResult { ok: boolean; output: string }

/**
 * Builds every project of the graph, each only after all its references built, at most `parallel` at once. Resolves with the projects that failed (empty
 * when all built) and the ones never started because something failed. `run` builds one project.
 */
export async function buildAll(graph: Graph, parallel: number, run: (project: string) => Promise<RunResult>): Promise<{ failed: { project: string; output: string }[]; skipped: string[] }> {
  const order = buildOrder(graph);
  const done = new Set<string>();
  const started = new Set<string>();
  const failed: { project: string; output: string }[] = [];
  let running = 0;
  return await new Promise((resolveAll) => {
    const pump = (): void => {
      if (failed.length === 0) {
        for (const project of order) {
          if (running >= parallel) break;
          if (started.has(project) || !(graph.get(project) ?? []).every((reference) => done.has(reference))) continue;
          started.add(project);
          running += 1;
          void run(project).then((result) => {
            running -= 1;
            if (result.ok) done.add(project);
            else failed.push({ project, output: result.output });
            pump();
          });
        }
      }
      if (running === 0) resolveAll({ failed, skipped: order.filter((project) => !started.has(project)) });
    };
    pump();
  });
}

function runTsc(root: string, extra: readonly string[]): (project: string) => Promise<RunResult> {
  const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
  return (project) => new Promise((resolveRun) => {
    const child = spawn(process.execPath, [tsc, "-b", project, ...extra], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.on("error", (error) => resolveRun({ ok: false, output: `${output}${error.message}\n` }));
    child.on("close", (code) => resolveRun({ ok: code === 0, output }));
  });
}

if (process.argv[1]?.endsWith("build-parallel.ts")) {
  const root = process.cwd();
  const graph = readGraph(root);
  const parallel = Math.max(1, availableParallelism());
  const started = Date.now();
  const { failed, skipped } = await buildAll(graph, parallel, runTsc(root, process.argv.slice(2)));
  for (const { project, output } of failed) process.stderr.write(`tsc -b ${project} failed:\n${output}\n`);
  if (failed.length > 0) {
    if (skipped.length > 0) process.stderr.write(`Not built, because a project failed: ${skipped.join(", ")}\n`);
    process.exit(1);
  }
  console.log(`Built ${graph.size} projects, up to ${parallel} at once, in ${((Date.now() - started) / 1000).toFixed(1)} s.`);
}
