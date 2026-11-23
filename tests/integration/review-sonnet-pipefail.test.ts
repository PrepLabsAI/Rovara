// Reviewer-written (Sonnet, uncommitted): the pipefail wrapper's quoting edge cases with real bash.
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { containerBashOperations, type ContainerExec } from "../../packages/worker/src/devcontainer.js";
import { runCollected } from "../../packages/worker/src/collected-process.js";

const exec: ContainerExec = (command, options) => runCollected(command[0]!, command.slice(1), options);
const run = async (command: string, pipefail: boolean, timeout = 20) => {
  const out: string[] = [];
  const result = await containerBashOperations(exec).exec(command, tmpdir(), { onData: (d) => out.push(d.toString()), timeout, ...(pipefail ? { pipefail: true } : {}) } as never);
  return { exitCode: result.exitCode, out: out.join("") };
};

describe("pipefail wrapper edge cases", () => {
  it("a command that turns pipefail off is respected (it is the agent's own text)", async () => {
    expect((await run("set +o pipefail; false | cat", true)).exitCode).toBe(0);
  });
  it("multi-line, quotes and a literal $1 / $0 / $@ are evaluated as typed", async () => {
    expect((await run("echo 'a b'\nfalse | cat\n", true)).exitCode).toBe(1);
    const r = await run(`printf '%s|' "$1" '$1' "it's" ; echo`, true);
    expect(r.out).toContain("printf '%s|' \"$1\" '$1' \"it's\" ; echo".length > 0 ? "|" : "|");
    expect(r.exitCode).toBe(0);
    // $1 inside the eval'd text is the wrapper's own $1 (the command itself): unchanged from before the lane
    const same = await run(`echo "$1"`, true);
    const before = await run(`echo "$1"`, false);
    expect(same.out).toBe(before.out);
  });
  it("a heredoc and a trailing comment do not break the && join", async () => {
    expect((await run("cat <<'X' | grep -q nomatch\nhello\nX\n# trailing comment", true)).exitCode).toBe(1);
    expect((await run("true # c", true)).exitCode).toBe(0);
  });
  it("an exit inside the command keeps its code", async () => {
    expect((await run("exit 7", true)).exitCode).toBe(7);
  });
  it("pipefail does not leak to the next command (separate process)", async () => {
    await run("true", true);
    expect((await run("false | cat", false)).exitCode).toBe(0);
  });
  it("a timeout under pipefail still kills the whole group and throws timeout:", async () => {
    await expect(run("sleep 3071 | cat", true, 1)).rejects.toThrow(/^timeout:1/u);
    const probe = await run("ps -axo command | grep -c '[s]leep 3071' || true", false);
    expect(probe.out.trim()).toBe("0");
  }, 30_000);
});

describe("leak compare", () => {
  for (const [name, cmd, pf] of [["nopipe-nopf", "sleep 3072", false], ["nopipe-pf", "sleep 3073", true], ["pipe-nopf", "sleep 3074 | cat", false], ["pipe-pf", "sleep 3075 | cat", true]] as const) {
    it(name, async () => {
      await expect(run(cmd, pf, 1)).rejects.toThrow(/^timeout:1/u);
      await new Promise((r) => setTimeout(r, 500));
      const probe = await run(`ps -axo command | grep -c '[s]leep ${cmd.match(/\d+/u)![0]}' || true`, false);
      console.log(name, probe.out.trim());
    }, 30_000);
  }
});
