// Architecture guard: lesson data reaches a person or an agent only through the access check. This builds a TypeScript program over the whole broker package and resolves every call by TYPE, so
// aliases (`const s = deps.store`), destructuring (`const { list } = store`), re-exports and renamed imports cannot hide a read, and comments are not code. A call that reads the lesson store
// must sit in a top-level function that also calls `readVisible`, or in a file listed below as an internal worker that returns nothing to a viewer, with the reason. A stale list entry fails too.
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../../..");
const BROKER = join(ROOT, "packages/broker");

/** Files that read the lesson store and hand nothing back to a viewer (they act on a lesson: count, curate, delete, expire, promote, process). */
const INTERNAL_LESSON_FILES: Record<string, string> = {
  "lessons/counters.ts": "counts loads and outcomes on lessons; returns counters, never a lesson (feedback is gated: see recordFeedback)",
  "lessons/curate.ts": "merges drafts into lessons; returns the result to the pipeline",
  "lessons/deletion.ts": "withdraws and erases lessons; acts on them",
  "lessons/jobs.ts": "the nightly trial repair retires a live trial lesson a pending card contradicts; it returns counts only, never a lesson",
  "lessons/draft-retry.ts": "asks only whether a lesson the failed try made is in the store (a yes or no for the retry guard); returns nothing to a viewer",
  "lessons/expiry.ts": "expires lessons; acts on them",
  "lessons/promote.ts": "promotes a lesson to a rule; refuses restricted ones",
  "lessons/process.ts": "the reflector pipeline; lessons go back into the store",
  "lessons/store.ts": "the store itself",
  "lessons/metric.ts": "the same-mistake-twice measure: reads lessons, their versions and load manifests only to count; returns numbers, never a lesson or any text (metric.test.ts pins that)",
  "lessons/sources.ts": "the cold-start rule counts the person-approved lessons that name a source (L7-2); it returns names and a yes or no, never a lesson",
  "lessons/repo-file-pass.ts": "the weekly lessons file pass (R2) reads every stored head of the project to propose ONLY lessons that are repo-only for one repository (R1 `isRepoFileEligible`: every input readable by everyone who can read that repository, no names, stable or person-approved); its output is that repository's file, whose readers are those same people, so the reader-by-reader access check does not apply. It returns outcomes and counts, never a lesson",
  "lessons/trial.ts": "moves a trial lesson that earned it to stable (14 days, 3 loads, no thumbs-down); acts on it and returns ids, never a lesson",
  "lessons/task-end.ts": "reads the task's load records and the source tasks of the lessons loaded into it to add them to a new draft's provenance (LV-1 M2); returns task ids, never a lesson",
  "lessons/approve.ts": "decisions (approve, reject, retire, roll back) act on a lesson after mayHandle; the lists use readVisible",
};
const LESSON_READS = new Set(["list", "get", "manifests", "listAllHeads", "getHead", "versions"]);

interface Hit { file: string; kind: "lessons"; text: string; guarded: boolean }

/** Bypass samples the guard must catch. They are served from memory (never written to disk) and analysed in the same program as the real broker. */
const PLANTED: Record<string, string> = {
  "alias.ts": 'import type { LessonStore } from "../lessons/store.js";\nexport const a = (deps: { store: LessonStore }) => { const st = deps.store; return st.list({ workspaceId: "w", project: "p" }); };\n',
  "destructure.ts": 'import type { LessonStore } from "../lessons/store.js";\nexport const b = ({ store: s }: { store: LessonStore }) => { const { get } = s; return get({ workspaceId: "w", project: "p" }, "x"); };\n',
  "comment.ts": 'import type { LessonStore } from "../lessons/store.js";\n// read-visible.js readVisible( filterVisible(\nexport const c = (s: LessonStore) => s.list({ workspaceId: "w", project: "p" });\n',
};
const PLANTED_DIR = "zzguard";

/**
 * Builds ONE program for the broker plus the planted samples. The analysis resolves calls by the types of the broker's own code, so third-party declaration files are served empty
 * (the AWS SDK, openai, zod and the rest are about 14 MB of declarations and took the program from about 1 GB to about 2.5 GB, enough to kill a CI worker). The broker's own
 * sources, the workspace packages (@agentx/contracts and the others, which resolve to their own dist files) and the TypeScript lib files stay real, so LessonStore and the team-record store resolve exactly as before.
 */
function analyse(root = BROKER): Hit[] {
  const config = ts.getParsedCommandLineOfConfigFile(join(root, "tsconfig.json"), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined });
  if (config === undefined) throw new Error("no tsconfig");
  const options: ts.CompilerOptions = { ...config.options, noEmit: true, composite: false, incremental: false, skipLibCheck: true };
  const planted = new Map(Object.entries(PLANTED).map(([name, body]) => [join(root, "src", PLANTED_DIR, name), body]));
  const host = ts.createCompilerHost(options);
  const real = ts.createCompilerHost(options);
  host.fileExists = (name) => planted.has(name) || real.fileExists(name);
  host.readFile = (name) => planted.get(name) ?? real.readFile(name);
  host.getSourceFile = (name, languageVersion, ...rest) => {
    const body = planted.get(name);
    if (body !== undefined) return ts.createSourceFile(name, body, languageVersion);
    const empty = /[\\/]node_modules[\\/]/u.test(name) && !/[\\/]node_modules[\\/]typescript[\\/]lib[\\/]/u.test(name);
    return empty ? ts.createSourceFile(name, "", languageVersion) : real.getSourceFile(name, languageVersion, ...rest);
  };
  const program = ts.createProgram({ rootNames: [...config.fileNames, ...planted.keys()], options, host });
  const checker = program.getTypeChecker();
  const hits: Hit[] = [];
  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile || !source.fileName.startsWith(join(root, "src"))) continue;
    const file = relative(join(root, "src"), source.fileName);
    const visit = (node: ts.Node, top: ts.Node | undefined): void => {
      const unit = top ?? (node.parent !== undefined && ts.isSourceFile(node.parent) ? node : undefined);
      if (ts.isCallExpression(node)) {
        const kind = classify(node, checker);
        if (kind !== undefined && unit !== undefined) hits.push({ file, kind, text: node.getText(source).slice(0, 80), guarded: callsAccess(unit, "readVisible") || callsAccess(unit, "readVisibleRanked") });
      }
      ts.forEachChild(node, (child) => visit(child, unit));
    };
    visit(source, undefined);
  }
  return hits;
}

function classify(call: ts.CallExpression, checker: ts.TypeChecker): "lessons" | undefined {
  const type = checker.getTypeAtLocation(call.expression);
  for (const declaration of type.symbol?.declarations ?? []) {
    const parent = declaration.parent;
    if ((ts.isMethodSignature(declaration) || ts.isMethodDeclaration(declaration)) && declaration.name !== undefined && LESSON_READS.has(declaration.name.getText())
      && ((ts.isInterfaceDeclaration(parent) || ts.isClassDeclaration(parent)) && /LessonStore$/u.test(parent.name?.text ?? ""))) return "lessons";
  }
  return undefined;
}

function callsAccess(unit: ts.Node, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) found = true;
    ts.forEachChild(node, visit);
  };
  visit(unit);
  return found;
}

const allHits = analyse();

describe("every read path goes through the access check", () => {
  const hits = allHits.filter((hit) => !hit.file.startsWith(`${PLANTED_DIR}/`));

  it("the analysis sees the known readers (it is not vacuous)", () => {
    expect(new Set(hits.filter((hit) => hit.kind === "lessons").map((hit) => hit.file))).toEqual(expect.any(Set));
    for (const file of ["lessons/load.ts", "lessons/digest.ts", "lessons/panel.ts", "lessons/approve.ts", "lessons/counters.ts"]) expect(hits.some((hit) => hit.file === file && hit.kind === "lessons"), file).toBe(true);
  });

  it("each lesson-store read is in a function that calls readVisible, or in a listed internal file", () => {
    const offenders = hits.filter((hit) => hit.kind === "lessons" && !hit.guarded && INTERNAL_LESSON_FILES[hit.file] === undefined).map((hit) => `${hit.file}: ${hit.text}`);
    expect(offenders).toEqual([]);
  });

  it("the viewer-facing lesson functions read only through readVisible (approve.ts lists, load, digest, panel)", () => {
    for (const file of ["lessons/load.ts", "lessons/digest.ts", "lessons/panel.ts"]) {
      const own = hits.filter((hit) => hit.file === file && hit.kind === "lessons");
      expect(own.length, file).toBeGreaterThan(0);
      expect(own.filter((hit) => !hit.guarded).map((hit) => hit.text), file).toEqual([]);
    }
    const approve = hits.filter((hit) => hit.file === "lessons/approve.ts" && hit.kind === "lessons");
    expect(approve.some((hit) => hit.guarded)).toBe(true); // listWaiting and listQueued
  });

  it("the internal lists name only files that exist (a stale entry fails)", () => {
    for (const file of Object.keys(INTERNAL_LESSON_FILES)) expect(() => readFileSync(join(BROKER, "src", file), "utf8"), file).not.toThrow();
  });
});

describe("the guard catches the bypasses a text search misses", () => {
  it("an alias, a destructured method, a comment naming the filter, a subfolder and a new function in a guarded file all fail", () => {
    const found = allHits.filter((hit) => hit.file.startsWith(`${PLANTED_DIR}/`) && !hit.guarded).map((hit) => hit.file);
    expect(new Set(found)).toEqual(new Set(Object.keys(PLANTED).map((name) => `${PLANTED_DIR}/${name}`)));
  });
});
