// Issue #235: Ctrl-C at a question of `agentx init --no-ui` is a stop the person chose, not an
// internal error: one plain line that says how to continue, and a non-zero exit.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentXError } from "@agentx/contracts";
import { executeCli } from "../../packages/cli/src/main.js";
import type { Prompter } from "../../packages/cli/src/init/prompts.js";
import type { CliInvocation } from "../../packages/cli/src/init/cli-command.js";
import { INSTALLED_CLI_INVOCATION, NPX_CLI_INVOCATION } from "../support/init-fakes.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const tmp = async (prefix: string) => { const dir = await mkdtemp(join(tmpdir(), prefix)); dirs.push(dir); return dir; };

async function releaseDir(): Promise<string> {
  const dir = await tmp("agentx-init-ctrlc-release-");
  const templates = [];
  for (const region of ["us-east-1", "eu-west-1"]) {
    await mkdir(join(dir, "templates", region), { recursive: true });
    for (const part of ["access", "foundation", "identity", "control-plane", "runtime", "slack"]) {
      const file = `templates/${region}/${part}.template.json`;
      await writeFile(join(dir, file), "{}");
      templates.push({ region, part, file, sha256: createHash("sha256").update("{}").digest("hex") });
    }
  }
  await writeFile(join(dir, "release.json"), JSON.stringify({
    schemaVersion: 1, version: "1.2.3", gitCommit: "a".repeat(40), environmentPlaceholder: "qqenv-placeholderqq", templates, packages: [],
    images: { worker: `public.ecr.aws/agentx/worker@sha256:${"a".repeat(64)}`, slack: `public.ecr.aws/agentx/slack@sha256:${"b".repeat(64)}` },
  }));
  return dir;
}

/** What Node's readline/promises rejects a question with when Ctrl-C is pressed. */
const readlineCtrlC = () => Object.assign(new Error("Aborted with Ctrl+C"), { name: "AbortError", code: "ABORT_ERR" });

/** A prompter whose first question fails with `error`, as the terminal's does on Ctrl-C. */
function failingPrompter(error: () => Error): Prompter {
  const fail = async (): Promise<never> => { throw error(); };
  return { ask: fail, choose: fail, confirm: fail, secret: fail };
}

async function run(error: () => Error, argv: string[] = [], cliInvocation: CliInvocation = INSTALLED_CLI_INVOCATION) {
  const err: string[] = [];
  const out: string[] = [];
  const code = await executeCli(["--env", "livefinal", "init", "--no-ui", "--release", await releaseDir(), ...argv], {
    stdout: { write: (text: string) => { out.push(text); return true; } },
    stderr: { write: (text: string) => { err.push(text); return true; } },
    environments: { home: await tmp("agentx-init-ctrlc-home-") },
    init: {
      cliInvocation,
      prompter: failingPrompter(error),
      processEnv: {},
      deploy: { identity: { get: async () => ({ account: "123456789012", arn: "arn:aws:sts::123456789012:assumed-role/Admin/alice" }) } },
      accountAlias: async () => undefined,
    },
  });
  return { code, err: err.join(""), out: out.join("") };
}

describe("Ctrl-C at an agentx init --no-ui question (#235)", () => {
  it("prints one plain line saying how to continue, no INTERNAL_ERROR, and exits non-zero", async () => {
    const { code, err, out } = await run(readlineCtrlC);
    expect(code).toBe(130);
    expect(err.endsWith("Stopped. Run agentx init --env livefinal again to continue from here.\n")).toBe(true);
    expect(err).not.toContain("INTERNAL_ERROR");
    expect(err).not.toContain("AgentX error");
    expect(err).not.toContain("Aborted with Ctrl+C");
    expect(out).toBe("");
  });

  it("says the same for Ctrl-C at a hidden question", async () => {
    const { code, err } = await run(() => agentXError("CONFIG_INVALID", "cancelled"));
    expect(code).toBe(130);
    expect(err.endsWith("Stopped. Run agentx init --env livefinal again to continue from here.\n")).toBe(true);
    expect(err).not.toContain("AgentX error");
  });

  it("keeps a real failure at a question as the error it is", async () => {
    const { code, err } = await run(() => agentXError("CONFIG_INVALID", "the answer file is unreadable"));
    expect(code).toBe(2);
    expect(err).toContain("AgentX error [CONFIG_INVALID]: the answer file is unreadable");
    expect(err).not.toContain("Stopped.");
  });

  it("with --json, says it as JSON", async () => {
    const { code, err } = await run(readlineCtrlC, ["--json"]);
    expect(code).toBe(130);
    expect(JSON.parse(err.trim().split("\n").at(-1)!)).toEqual({ ok: false, error: { code: "STOPPED", message: "Stopped. Run agentx init --env livefinal again to continue from here." } });
  });

  // Owner decision 2026-10-02: the same line, through npx with its version, when AgentX ran that way.
  it("shows that command through npx, with its version, when AgentX ran that way", async () => {
    const { code, err } = await run(readlineCtrlC, [], NPX_CLI_INVOCATION);
    expect(code).toBe(130);
    expect(err.endsWith(`Stopped. Run npx @preplabs/rovara-code@${NPX_CLI_INVOCATION.version} init --env livefinal again to continue from here.\n`)).toBe(true);
  });
});
