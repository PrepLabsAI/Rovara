// vitest: fresh-modules (this file changes process.env, spies on console and runs the guard as a process; it loads none of the broker)
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NamesError, fetchWithAwsCli, runPipelineGuard, type NamesFetcher } from "../../scripts/port-guard-pipeline.js";
import {
  PORT_GUARD_NAMES_PARAMETER_VARIABLE,
  portGuardNamesReadStatements,
  portGuardStepCommands,
  portGuardStepVariables,
} from "../../infra/lib/port-guard-step.js";
import { main } from "../../scripts/port-guard.js";

// L14: the pipeline loads the private name list at run time from SSM, never prints it, and fails closed. The names here are INVENTED, and the list
// value is assembled at run time so the guard (which scans this file) finds nothing in it.
const SECRET_NAME = ["flib", "jabbet"].join("");
const LIST_VALUE = `# invented list\n${SECRET_NAME}\\s*corp\n`;
const PARAM = "/example/port-guard/names";
const ACCOUNT = ["1234", "5678", "9012"].join("");

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "port-guard-pipeline-"));
  roots.push(dir);
  return dir;
};

let out: string[];
beforeEach(() => {
  out = [];
  vi.spyOn(console, "log").mockImplementation((...args) => void out.push(args.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args) => void out.push(args.join(" ")));
});
afterEach(() => vi.restoreAllMocks());

const fetchOf = (value: string): NamesFetcher => () => value;
const failing: NamesFetcher = () => {
  throw new NamesError("could not fetch the extended name list from SSM: the aws CLI exited 254 (AccessDeniedException)");
};

describe("runPipelineGuard (fake fetch, fake guard)", () => {
  it("hands the guard a private 0600 file in a 0700 directory, requires the list, and removes the file afterwards", () => {
    let seen: { file: string; text: string; fileMode: number; dirMode: number; argv: readonly string[]; env: NodeJS.ProcessEnv } | undefined;
    const status = runPipelineGuard({
      argv: ["--range", "a..b"],
      env: { [PORT_GUARD_NAMES_PARAMETER_VARIABLE]: PARAM },
      fetch: fetchOf(LIST_VALUE),
      tempRoot: scratch(),
      guard: (argv, env) => {
        const file = env.PORT_GUARD_PRIVATE_NAMES!;
        seen = { file, text: readFileSync(file, "utf8"), fileMode: statSync(file).mode & 0o777, dirMode: statSync(join(file, "..")).mode & 0o777, argv, env };
        return 1;
      },
    });
    expect(status).toBe(1);
    expect(seen!.text).toBe(LIST_VALUE);
    expect(seen!.fileMode).toBe(0o600);
    expect(seen!.dirMode).toBe(0o700);
    expect(seen!.argv).toEqual(["--range", "a..b", "--require-private-names"]);
    expect(seen!.env.PORT_GUARD_REQUIRE_PRIVATE_NAMES).toBe("1");
    expect(existsSync(seen!.file)).toBe(false);
    expect(existsSync(join(seen!.file, ".."))).toBe(false);
    expect(out.join("\n")).not.toContain(SECRET_NAME);
  });

  it("removes the file even when the guard throws, and says nothing about the list", () => {
    let file = "";
    const status = runPipelineGuard({
      argv: [],
      env: { [PORT_GUARD_NAMES_PARAMETER_VARIABLE]: PARAM },
      fetch: fetchOf(LIST_VALUE),
      tempRoot: scratch(),
      guard: (_argv, env) => {
        file = env.PORT_GUARD_PRIVATE_NAMES!;
        throw new Error(`boom ${SECRET_NAME}`);
      },
    });
    expect(status).toBe(2);
    expect(existsSync(file)).toBe(false);
    expect(out.join("\n")).not.toContain(SECRET_NAME);
  });

  it("fails closed, without starting the guard, when the parameter name is missing", () => {
    const guard = vi.fn(() => 0);
    for (const env of [{}, { [PORT_GUARD_NAMES_PARAMETER_VARIABLE]: "" }, { [PORT_GUARD_NAMES_PARAMETER_VARIABLE]: "  " }]) {
      expect(runPipelineGuard({ argv: [], env, fetch: fetchOf(LIST_VALUE), guard })).toBe(2);
    }
    expect(guard).not.toHaveBeenCalled();
    expect(out.join("\n")).toContain("refusing to run with only the built-in list");
  });

  it("fails closed, without starting the guard, when the fetch fails (and prints no more than the error code)", () => {
    const guard = vi.fn(() => 0);
    expect(runPipelineGuard({ argv: [], env: { [PORT_GUARD_NAMES_PARAMETER_VARIABLE]: PARAM }, fetch: failing, guard })).toBe(2);
    expect(runPipelineGuard({ argv: [], env: { [PORT_GUARD_NAMES_PARAMETER_VARIABLE]: PARAM }, fetch: () => { throw new Error(`leak ${SECRET_NAME}`); }, guard })).toBe(2);
    expect(guard).not.toHaveBeenCalled();
    const text = out.join("\n");
    expect(text).toContain("AccessDeniedException");
    expect(text).not.toContain(SECRET_NAME);
  });

  it("fails closed when the list holds no patterns (empty, comments only, or the CLI's word for null)", () => {
    const guard = vi.fn(() => 0);
    for (const value of ["", "\n\n", "# only a comment\n", "None\n"]) {
      expect(runPipelineGuard({ argv: [], env: { [PORT_GUARD_NAMES_PARAMETER_VARIABLE]: PARAM }, fetch: fetchOf(value), guard })).toBe(2);
    }
    expect(guard).not.toHaveBeenCalled();
  });
});

describe("the guard itself refuses a degraded run when the list is required", () => {
  const withEnv = (env: Record<string, string | undefined>, fn: () => void): void => {
    const saved = { list: process.env.PORT_GUARD_PRIVATE_NAMES, req: process.env.PORT_GUARD_REQUIRE_PRIVATE_NAMES };
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      fn();
    } finally {
      for (const [key, value] of [["PORT_GUARD_PRIVATE_NAMES", saved.list], ["PORT_GUARD_REQUIRE_PRIVATE_NAMES", saved.req]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };

  it("exits 2 for an unset, missing, or empty list; with no requirement the old note and run stay", () => {
    const dir = scratch();
    writeFileSync(join(dir, "empty.txt"), "# nothing\n\n");
    // Each of these stops before any git or gitleaks work, so no repository is needed.
    withEnv({ PORT_GUARD_PRIVATE_NAMES: undefined, PORT_GUARD_REQUIRE_PRIVATE_NAMES: "1" }, () => expect(main([])).toBe(2));
    withEnv({ PORT_GUARD_PRIVATE_NAMES: "", PORT_GUARD_REQUIRE_PRIVATE_NAMES: undefined }, () => expect(main(["--require-private-names"])).toBe(2));
    withEnv({ PORT_GUARD_PRIVATE_NAMES: join(dir, "missing.txt"), PORT_GUARD_REQUIRE_PRIVATE_NAMES: "1" }, () => expect(main([])).toBe(2));
    withEnv({ PORT_GUARD_PRIVATE_NAMES: join(dir, "empty.txt"), PORT_GUARD_REQUIRE_PRIVATE_NAMES: "1" }, () => expect(main([])).toBe(2));
    expect(out.join("\n")).toContain("required");
    expect(out.join("\n")).not.toContain("clean");
  });
});

/** A fake `aws` first on PATH: prints the list for the right parameter name, or fails the way the real CLI does. */
function fakeAws(mode: "ok" | "denied"): { bin: string; list: string } {
  const bin = scratch();
  const list = join(bin, "list.txt");
  writeFileSync(list, LIST_VALUE);
  const script =
    mode === "ok"
      ? `#!/bin/sh\n[ "$1 $2" = "ssm get-parameter" ] || exit 64\ncase " $* " in *" --with-decryption "*) ;; *) exit 65;; esac\ncase " $* " in *" ${PARAM} "*) cat "${list}";; *) exit 66;; esac\n`
      : `#!/bin/sh\necho "An error occurred (AccessDeniedException) when calling the GetParameter operation: not authorized ${SECRET_NAME}" >&2\nexit 254\n`;
  writeFileSync(join(bin, "aws"), script);
  chmodSync(join(bin, "aws"), 0o755);
  return { bin, list };
}

describe("fetchWithAwsCli", () => {
  it("returns the decrypted value from the aws CLI", () => {
    const { bin } = fakeAws("ok");
    expect(fetchWithAwsCli(PARAM, { PATH: `${bin}:${process.env.PATH ?? ""}` })).toBe(LIST_VALUE);
  });

  it("keeps only the error code of a failed call (the CLI's message is dropped)", () => {
    const { bin } = fakeAws("denied");
    let message = "";
    try {
      fetchWithAwsCli(PARAM, { PATH: `${bin}:${process.env.PATH ?? ""}` });
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toContain("AccessDeniedException");
    expect(message).toContain("254");
    expect(message).not.toContain(SECRET_NAME);
    expect(message).not.toContain(PARAM);
  });

  it("reports a missing aws CLI without a value", () => {
    expect(() => fetchWithAwsCli(PARAM, { PATH: scratch() })).toThrow(/could not run/);
  });
});

const hasGitleaks = spawnSync("gitleaks", ["version"], { encoding: "utf8" }).status === 0;

describe("the pipeline script as a process (fake aws on PATH)", () => {
  function lane(content: string): string {
    const dir = scratch();
    const run = (...args: string[]): void => void spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    run("init", "-q", "-b", "code-next");
    run("config", "user.email", "t@example.invalid");
    run("config", "user.name", "t");
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "README.md"), "base\n");
    run("add", "README.md");
    run("commit", "-q", "-m", "base");
    run("branch", "base");
    run("switch", "-q", "-c", "lane");
    writeFileSync(join(dir, "docs/notes.md"), content);
    run("add", "docs/notes.md");
    run("commit", "-q", "-m", "lane");
    return dir;
  }
  const runScript = (cwd: string, env: Record<string, string>): { status: number | null; text: string } => {
    const result = spawnSync(process.execPath, [join(process.cwd(), "scripts/port-guard-pipeline.ts"), "--range", "base..lane"], {
      cwd,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    });
    return { status: result.status, text: `${result.stdout}\n${result.stderr}` };
  };

  it("with no parameter name it exits 2 and never says clean", () => {
    const result = runScript(lane("fine\n"), {});
    expect(result.status).toBe(2);
    expect(result.text).toContain("refusing to run with only the built-in list");
    expect(result.text).not.toContain("clean");
  });

  it("when the fetch is denied it exits 2, prints no name, and does not run the guard", () => {
    const { bin } = fakeAws("denied");
    const result = runScript(lane("fine\n"), { PATH: `${bin}:${process.env.PATH ?? ""}`, [PORT_GUARD_NAMES_PARAMETER_VARIABLE]: PARAM });
    expect(result.status).toBe(2);
    expect(result.text).toContain("AccessDeniedException");
    expect(result.text).not.toContain(SECRET_NAME);
    expect(result.text).not.toContain("clean");
    expect(result.text).not.toContain("not loaded");
  });

  it.runIf(hasGitleaks)("with the list it passes a clean range and fails a range that holds a listed name, never printing the name", () => {
    const { bin } = fakeAws("ok");
    const env = { PATH: `${bin}:${process.env.PATH ?? ""}`, [PORT_GUARD_NAMES_PARAMETER_VARIABLE]: PARAM };
    const clean = runScript(lane("fine\n"), env);
    expect(clean.status).toBe(0);
    expect(clean.text).toContain("the extended name list was loaded (1 pattern)");
    expect(clean.text).not.toContain("not loaded");
    expect(clean.text).not.toContain(SECRET_NAME);
    const dirty = runScript(lane(`see ${SECRET_NAME} corp here\n`), env);
    expect(dirty.status).toBe(1);
    expect(dirty.text).toContain("docs/notes.md:1  [private-name]");
    expect(dirty.text).not.toContain(SECRET_NAME);
  });
});

describe("the pipeline step (buildspec commands and IAM)", () => {
  it("starts with set +x, fails on a missing variable, and carries the name only as a variable", () => {
    const commands = portGuardStepCommands(["--range", "origin/mainline..HEAD", "--allow-guard-edits"]);
    expect(commands[0]).toBe("set +x");
    expect(commands[1]).toContain(`test -n "$${PORT_GUARD_NAMES_PARAMETER_VARIABLE}"`);
    expect(commands[1]).toContain("exit 2");
    expect(commands[2]).toBe("node scripts/port-guard-pipeline.ts --range origin/mainline..HEAD --allow-guard-edits");
    expect(portGuardStepVariables(PARAM)).toEqual({ [PORT_GUARD_NAMES_PARAMETER_VARIABLE]: PARAM });
    const text = commands.join("\n");
    expect(text).not.toMatch(/get-parameter|get-secret|echo \$|--debug|set -x/);
  });

  it("refuses an unsafe guard argument", () => {
    expect(() => portGuardStepCommands(["--range", "a;rm -rf x"])).toThrow(/unsafe/);
  });

  it("grants read of exactly one parameter, and decrypt through SSM with one key", () => {
    const props = { partition: "aws", region: "us-east-1", account: ACCOUNT, parameterName: PARAM };
    const plain = portGuardNamesReadStatements(props).map((statement): unknown => statement.toStatementJson());
    expect(plain).toEqual([{ Sid: "ReadPortGuardNames", Effect: "Allow", Action: "ssm:GetParameter", Resource: `arn:aws:ssm:us-east-1:${ACCOUNT}:parameter${PARAM}` }]);
    const keyed = portGuardNamesReadStatements({ ...props, keyArn: `arn:aws:kms:us-east-1:${ACCOUNT}:key/00000000-0000-0000-0000-000000000000` }).map((s): unknown => s.toStatementJson());
    expect(keyed[1]).toMatchObject({ Action: "kms:Decrypt", Condition: { StringEquals: { "kms:ViaService": "ssm.us-east-1.amazonaws.com" } } });
    expect(JSON.stringify(keyed)).not.toContain('"*"');
  });
});
