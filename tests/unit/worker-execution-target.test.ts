// SH35: the ExecutionTarget seam. The `sandbox` target is today's task sandbox with NO behaviour change (the same docker calls, arguments, environment, timeouts and outputs), `runner:<id>` is refused
// ("no runner configured"), and no call site starts a command except through the seam.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectCommand } from "../../packages/contracts/src/index.js";
import {
  NO_RUNNER_CONFIGURED, SANDBOX_TARGET, executionFor, formatExecutionTarget, parseExecutionTarget, proveCommandPort,
} from "../../packages/worker/src/execution-target.js";
import { TaskSandbox } from "../../packages/worker/src/task-sandbox.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";
import { programOf } from "../support/task-owner-scan.js";

const IMAGE = "123456789012.dkr.ecr.us-west-2.amazonaws.com/agentx-staging/worker@sha256:" + "a".repeat(64);
const TASK = "0b9f6a1e-6c1e-4c53-9d0a-5d3a1d6f2c11";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

/** A fake Docker that records every call WITH the options it was given (timeout, signal, output hooks), and answers `exec` with a fixed result. */
function recordingDocker(exec: { exitCode: number; stdout: string; stderr: string }) {
  const calls: Array<{ args: string[]; timeoutMs: number | undefined; hasSignal: boolean }> = [];
  const docker: DockerCli = {
    run: async (args, options) => {
      calls.push({ args: [...args], timeoutMs: options?.timeoutMs, hasSignal: options?.signal !== undefined });
      if (args[0] === "network" && args[1] === "inspect") return { exitCode: 0, stdout: "bridge {} false", stderr: "" };
      if (args[0] === "exec") { options?.onStdout?.(Buffer.from(exec.stdout)); options?.onStderr?.(Buffer.from(exec.stderr)); return exec; }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { docker, calls };
}

async function sandboxWith(exec = { exitCode: 3, stdout: "out\n", stderr: "err\n" }, shared?: string) {
  const root = shared ?? await mkdtemp(join(tmpdir(), "exec-target-"));
  if (shared === undefined) roots.push(root);
  const fake = recordingDocker(exec);
  return { sandbox: new TaskSandbox({ rootPath: root, taskId: TASK, docker: fake.docker, image: IMAGE }), fake, root };
}

/** The docker calls after the start, with this sandbox's container name and every random file name made stable, so two runs of the same command can be compared. */
function normalized(calls: ReturnType<typeof recordingDocker>["calls"], name: string) {
  return calls.filter((call) => call.args[0] === "exec").map((call) => ({ ...call, args: call.args.map((arg) => arg.split(name).join("<container>").replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu, "<uuid>").replace(/[0-9a-f]{16,}/gu, "<hex>")) }));
}

const command: ProjectCommand = { cwd: ".", executable: "pytest", args: ["-q", "tests/unit"], timeoutSeconds: 1_800, env: { PYTHONHASHSEED: "0", CI: "1" } };

describe("the sandbox target is the task sandbox, unchanged", () => {
  it("runs a project command with the same docker calls, arguments, environment, timeout and output", async () => {
    const direct = await sandboxWith();
    const viaSeam = await sandboxWith(undefined, direct.root);
    const signal = new AbortController().signal;
    const directResult = await direct.sandbox.runCommand(command, signal);
    const seamResult = await executionFor(SANDBOX_TARGET, { sandbox: viaSeam.sandbox }).runCommand(command, signal);
    expect(seamResult).toEqual(directResult);
    expect(seamResult).toMatchObject({ exitCode: 3, stdout: "out\n", stderr: "err\n" });
    const expected = normalized(direct.fake.calls, direct.sandbox.name);
    expect(expected.length).toBeGreaterThan(0);
    expect(normalized(viaSeam.fake.calls, viaSeam.sandbox.name)).toEqual(expected);
    // The command's environment and its timeout reached docker.
    expect(expected.some((call) => call.args.some((arg) => arg.includes("PYTHONHASHSEED=0")))).toBe(true);
    expect(expected.some((call) => call.timeoutMs !== undefined)).toBe(true);
    expect(expected.some((call) => call.hasSignal)).toBe(true);
  });

  it("runs a project command with no signal exactly as the sandbox does", async () => {
    const direct = await sandboxWith();
    const viaSeam = await sandboxWith(undefined, direct.root);
    await direct.sandbox.runCommand(command);
    await executionFor(SANDBOX_TARGET, { sandbox: viaSeam.sandbox }).runCommand(command);
    expect(normalized(viaSeam.fake.calls, viaSeam.sandbox.name)).toEqual(normalized(direct.fake.calls, direct.sandbox.name));
  });

  it("gives the agent's shell the same docker calls, environment, timeout and output", async () => {
    const direct = await sandboxWith();
    const viaSeam = await sandboxWith(undefined, direct.root);
    const run = async (operations: ReturnType<TaskSandbox["bashOperations"]>, root: string) => {
      const seen: string[] = [];
      const result = await operations.exec("echo hi && pytest -q", root, { onData: (data) => seen.push(data.toString("utf8")), timeout: 120, env: { ...process.env, AGENTX_TEST: "1" } });
      return { result, seen };
    };
    const expected = await run(direct.sandbox.bashOperations(), direct.root);
    const actual = await run(executionFor(SANDBOX_TARGET, { sandbox: viaSeam.sandbox }).bashOperations(), viaSeam.root);
    expect(actual.result).toEqual(expected.result);
    expect(actual.seen).toEqual(expected.seen);
    expect(normalized(viaSeam.fake.calls, viaSeam.sandbox.name)).toEqual(normalized(direct.fake.calls, direct.sandbox.name));
  });

  it("calls the sandbox's own methods, passing exactly the arguments given", async () => {
    const seen: unknown[][] = [];
    const sandbox = {
      runCommand: (...args: unknown[]) => { seen.push(args); return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }); },
      bashOperations: () => { seen.push(["bash"]); return { exec: () => Promise.resolve({ exitCode: 0 }) }; },
    } as unknown as TaskSandbox;
    const target = executionFor(SANDBOX_TARGET, { sandbox });
    const signal = new AbortController().signal;
    await target.runCommand(command);
    await target.runCommand(command, signal);
    target.bashOperations();
    expect(seen).toEqual([[command], [command, signal], ["bash"]]);
    expect(seen[0]).toHaveLength(1);
  });

  it("needs the sandbox the caller started, and never starts or falls back to anything else", () => {
    expect(() => executionFor(SANDBOX_TARGET, {})).toThrow(/no task sandbox/u);
  });
});

describe("the runner target is refused", () => {
  it("is refused with 'no runner configured', even when a sandbox is at hand", async () => {
    const { sandbox } = await sandboxWith();
    const target = parseExecutionTarget("runner:build-host-1");
    expect(target).toEqual({ kind: "runner", id: "build-host-1" });
    expect(() => executionFor(target, { sandbox })).toThrow(NO_RUNNER_CONFIGURED);
    expect(() => executionFor(target, {})).toThrow(NO_RUNNER_CONFIGURED);
  });

  it("parses only 'sandbox' and 'runner:<id>'", () => {
    expect(parseExecutionTarget("sandbox")).toEqual(SANDBOX_TARGET);
    expect(formatExecutionTarget(parseExecutionTarget("runner:a_b-1"))).toBe("runner:a_b-1");
    for (const bad of ["", "local", "Sandbox", "runner:", "runner:UPPER", "runner:a b", "runner:../x", "runner:-x", "sandbox:x", "runner:" + "a".repeat(64)]) {
      expect(() => parseExecutionTarget(bad), bad).toThrow(RangeError);
    }
  });
});

describe("Prove's command port", () => {
  it("returns the exit code, the output and a timeout flag from the target", async () => {
    const calls: unknown[][] = [];
    const port = proveCommandPort({
      bashOperations: () => { throw new Error("not used"); },
      runCommand: (...args) => { calls.push(args); return Promise.resolve({ exitCode: 124, stdout: "o", stderr: "e", timedOut: true }); },
    });
    const signal = new AbortController().signal;
    expect(await port(command, signal)).toEqual({ exitCode: 124, timedOut: true, stdout: "o", stderr: "e" });
    expect(calls).toEqual([[command, signal]]);
    const plain = proveCommandPort({ bashOperations: () => { throw new Error("x"); }, runCommand: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }) });
    expect(await plain(command, signal)).toEqual({ exitCode: 0, timedOut: false, stdout: "", stderr: "" });
  });
});

/**
 * The type-level guard: every place that reaches `TaskSandbox.runCommand` or `TaskSandbox.bashOperations`, found through the type checker rather than by text, so `?.`, destructuring, an alias, a split line
 * and a string key are all seen. Only the sandbox's own file and the seam may reach them.
 */
function sandboxCommandReaches(program: ts.Program, allowed: (file: string) => boolean): string[] {
  const checker = program.getTypeChecker();
  const names = new Set(["runCommand", "bashOperations"]);
  const isSandboxMember = (symbol: ts.Symbol | undefined): boolean => symbol?.declarations?.some((declaration) =>
    (ts.isMethodDeclaration(declaration) || ts.isPropertyDeclaration(declaration)) && ts.isClassDeclaration(declaration.parent) && declaration.parent.name?.text === "TaskSandbox" && names.has(declaration.name.getText())) ?? false;
  const isSandboxType = (type: ts.Type): boolean => (type.isUnion() ? type.types : [type]).some((part) => part.getSymbol()?.getName() === "TaskSandbox");
  const found: string[] = [];
  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile || allowed(file.fileName)) continue;
    const flag = (node: ts.Node) => found.push(`${file.fileName}:${String(file.getLineAndCharacterOfPosition(node.getStart()).line + 1)}`);
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && isSandboxMember(checker.getSymbolAtLocation(node.name))) flag(node);
      else if (ts.isElementAccessExpression(node)) {
        const argument = node.argumentExpression;
        if (ts.isStringLiteralLike(argument) ? isSandboxMember(checker.getSymbolAtLocation(argument)) || (names.has(argument.text) && isSandboxType(checker.getTypeAtLocation(node.expression))) : isSandboxType(checker.getTypeAtLocation(node.expression))) flag(node);
      } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const key = node.propertyName ?? node.name;
        const name = ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : undefined;
        const type = checker.getTypeAtLocation(node.parent);
        if (name !== undefined && names.has(name) && isSandboxMember(type.getProperty(name))) flag(node);
        else if (name === undefined && isSandboxType(type)) flag(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return found;
}

function virtualProgram(files: Record<string, string>): ts.Program {
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, noLib: true, strict: true, noEmit: true };
  const host = ts.createCompilerHost(options);
  const original = { fileExists: host.fileExists.bind(host), readFile: host.readFile.bind(host), getSourceFile: host.getSourceFile.bind(host) };
  const directoryExists = host.directoryExists?.bind(host);
  host.directoryExists = (name) => name === "/v" || (directoryExists?.(name) ?? false);
  host.realpath = (name) => name;
  host.fileExists = (name) => name in files || original.fileExists(name);
  host.readFile = (name) => files[name] ?? original.readFile(name);
  host.getSourceFile = (name, languageVersion, onError) => (name in files ? ts.createSourceFile(name, files[name]!, languageVersion, true) : original.getSourceFile(name, languageVersion, onError));
  return ts.createProgram({ rootNames: Object.keys(files), options, host });
}

describe("no call site reaches the sandbox's commands except through the seam", () => {
  const sandboxFile = "class TaskSandbox { runCommand(c: string): number { return 0; } bashOperations(): number { return 0; } fileOpsTarget(): number { return 0; } }\nexport { TaskSandbox };\n";
  const header = 'import { TaskSandbox } from "./task-sandbox";\ndeclare const sandbox: TaskSandbox;\ndeclare const maybe: TaskSandbox | undefined;\n';
  const bad: Record<string, string> = {
    "/v/call.ts": "sandbox.runCommand(\"x\");",
    "/v/optional.ts": "maybe?.bashOperations();",
    "/v/destructure.ts": "const { runCommand } = sandbox; void runCommand;",
    "/v/renamed.ts": "const { bashOperations: ops } = sandbox; void ops;",
    "/v/split.ts": "sandbox\n  .\n  runCommand(\"x\");",
    "/v/string-key.ts": "sandbox[\"runCommand\"](\"x\");",
    "/v/dynamic-key.ts": "declare const key: string; (sandbox as unknown as Record<string, unknown>)[key]; sandbox[key as \"runCommand\"];",
    "/v/alias.ts": "const same = sandbox; same\n.runCommand(\"x\");",
    "/v/parameter.ts": "export function f({ runCommand }: TaskSandbox) { return runCommand; }",
    "/v/bound.ts": "export const bound = sandbox.bashOperations.bind(sandbox);",
  };
  const good: Record<string, string> = {
    "/v/files.ts": "sandbox.fileOpsTarget();",
    "/v/other-class.ts": "class Other { runCommand(): number { return 1; } bashOperations(): number { return 2; } }\nnew Other().runCommand(); const { bashOperations } = new Other(); void bashOperations;",
    "/v/execution-target.ts": "sandbox.runCommand(\"x\"); sandbox.bashOperations();",
  };

  it("sees every way of reaching them, and nothing else (the detector itself)", () => {
    const files: Record<string, string> = { "/v/task-sandbox.ts": sandboxFile };
    for (const [name, body] of Object.entries({ ...bad, ...good })) files[name] = `${header}${body}\n`;
    const reached = sandboxCommandReaches(virtualProgram(files), (file) => file.endsWith("/task-sandbox.ts") || file.endsWith("/execution-target.ts"));
    expect([...new Set(reached.map((entry) => entry.split(":")[0]))].sort()).toEqual(Object.keys(bad).sort());
  }, 60_000);

  // Prove's production wiring (the setup executor's ports) and the person-command runner's shell must also be built from `executionFor` when they are wired; this guard then covers them like any other file.
  it("has no reach in the worker outside the sandbox's own file and the seam", () => {
    const program = programOf(join(process.cwd(), "packages/worker/tsconfig.json"));
    expect(program.getSourceFiles().some((file) => file.fileName.endsWith("/packages/worker/src/execution-target.ts"))).toBe(true);
    expect(sandboxCommandReaches(program, (file) => file.endsWith("/packages/worker/src/task-sandbox.ts") || file.endsWith("/packages/worker/src/execution-target.ts"))).toEqual([]);
  }, 180_000);
});
