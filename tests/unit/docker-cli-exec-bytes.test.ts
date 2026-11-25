// The Docker CLI seam's byte-exact exec (`createDockerCli().execBytes`): characterization against a fake `docker` binary
// on a temporary PATH. OE-c1 moved the seam out of the SWE-bench folder; this passes before and after the move.
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDockerCli } from "../../packages/worker/src/docker-cli.js";

let folder = "";
let savedPath: string | undefined;
let savedSecret: string | undefined;

async function fakeDocker(script: string): Promise<void> {
  const file = join(folder, "docker");
  await writeFile(file, `#!/bin/sh\n${script}\n`);
  await chmod(file, 0o755);
}

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "docker-cli-"));
  savedPath = process.env.PATH;
  savedSecret = process.env.DOCKER_CLI_TEST_SECRET;
  process.env.PATH = `${folder}:${savedPath ?? ""}`;
  delete process.env.DOCKER_CLI_TEST_SECRET;
});

afterEach(async () => {
  if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
  if (savedSecret === undefined) delete process.env.DOCKER_CLI_TEST_SECRET; else process.env.DOCKER_CLI_TEST_SECRET = savedSecret;
  await rm(folder, { recursive: true, force: true });
});

describe("createDockerCli().execBytes", () => {
  it("delivers stdin and returns stdout as exact bytes with the exit code", async () => {
    await fakeDocker("cat");
    const stdin = Buffer.from([0, 1, 2, 255, 254, 10, 13]);
    const result = await createDockerCli().execBytes!(["exec", "-i", "box"], { stdin, maxStdoutBytes: 1024 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.equals(stdin)).toBe(true);
    expect(result.timedOut).toBeUndefined();
    expect(result.aborted).toBeUndefined();
    expect(result.tooLarge).toBeUndefined();
  });

  it("passes the arguments through and keeps the last 8 KiB of stderr and a non-zero exit code", async () => {
    await fakeDocker("printf '%s|' \"$@\"; echo oops >&2; exit 3");
    const result = await createDockerCli().execBytes!(["a", "b c"], { maxStdoutBytes: 1024 });
    expect(result.exitCode).toBe(3);
    expect(result.stdout.toString("utf8")).toBe("a|b c|");
    expect(result.stderr).toBe("oops\n");
  });

  it("ends the process and sets tooLarge when stdout passes maxStdoutBytes", async () => {
    await fakeDocker("head -c 100000 /dev/zero; exec sleep 30");
    const result = await createDockerCli().execBytes!(["x"], { maxStdoutBytes: 1000 });
    expect(result.tooLarge).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(1000);
  });

  it("sets timedOut and kills the process when timeoutMs passes", async () => {
    await fakeDocker("exec sleep 30");
    const started = Date.now();
    const result = await createDockerCli().execBytes!(["x"], { maxStdoutBytes: 1000, timeoutMs: 200 });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("sets aborted and kills the process when the signal aborts, and does not start when already aborted", async () => {
    await fakeDocker("exec sleep 30");
    const controller = new AbortController();
    const pending = createDockerCli().execBytes!(["x"], { maxStdoutBytes: 1000, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const result = await pending;
    expect(result.aborted).toBe(true);

    await fakeDocker(`echo started > "${join(folder, "ran")}"`);
    const early = await createDockerCli().execBytes!(["x"], { maxStdoutBytes: 1000, signal: AbortSignal.abort() });
    expect(early).toEqual({ exitCode: null, stdout: Buffer.alloc(0), stderr: "", aborted: true });
    await expect(readFile(join(folder, "ran"))).rejects.toThrow();
  });

  it("gives env to the child's environment and never to its arguments", async () => {
    await fakeDocker("printf '%s' \"$DOCKER_CLI_TEST_SECRET\"; printf '|%s' \"$@\" >&2");
    const result = await createDockerCli().execBytes!(["run", "-e", "DOCKER_CLI_TEST_SECRET"], { maxStdoutBytes: 1024, env: { DOCKER_CLI_TEST_SECRET: "s3cret" } });
    expect(result.stdout.toString("utf8")).toBe("s3cret");
    expect(result.stderr).toBe("|run|-e|DOCKER_CLI_TEST_SECRET");
    expect(result.stderr).not.toContain("s3cret");
    expect(process.env.DOCKER_CLI_TEST_SECRET).toBeUndefined();
  });
});
