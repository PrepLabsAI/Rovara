// The real CommandRunner (commands.ts): shells out with node:child_process for real, unlike every
// other deploy test which scripts a fake CommandRunner. Ruling (b): shell: false, stream the
// child's output to our stderr, and on a non-zero exit throw an error naming the exit code,
// options.display (never the raw argv) and the last ~20 lines of stderr, redacted the same way the
// cdk engine's own printed command already is.
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import type * as ChildProcessModule from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { CALLBACK_SIGNING_KEY_BYTES } from "../../packages/cli/src/deploy/signing-key.js";
import type { AgentXError } from "@agentx/contracts";
import { cliErrorFor, interactiveConfirm, realCommandRunner } from "../../packages/cli/src/deploy/commands.js";

// Wraps the real `spawn` in a mock that calls through by default, so every other test here still
// spawns a real process; only the one test below that needs a fully scripted child ever overrides
// it (with `mockReturnValueOnce`, restored automatically on the next call).
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

function capture() {
  const chunks: string[] = [];
  return { chunks, text: () => chunks.join(""), write: (text: string) => chunks.push(text) };
}

describe("the real CommandRunner", () => {
  it("runs a real command and returns its captured stdout, streaming it to our stderr too", async () => {
    const stderr = capture();
    const runner = realCommandRunner(stderr);

    const result = await runner.run(process.execPath, ["-e", "console.log('hello from child')"], { cwd: process.cwd(), display: "node -e ..." });

    expect(result.stdout).toContain("hello from child");
    expect(stderr.text()).toContain("hello from child");
  });

  it("with quiet, returns stdout without echoing it, and still streams stderr", async () => {
    const stderr = capture();
    const runner = realCommandRunner(stderr);

    const result = await runner.run(process.execPath, ["-e", "console.log('listing line'); console.error('a warning')"], { cwd: process.cwd(), display: "node -e ...", quiet: true });

    expect(result.stdout).toContain("listing line");
    expect(stderr.text()).not.toContain("listing line");
    expect(stderr.text()).toContain("a warning");
  });

  it("throws an error naming the exit code, options.display and the stderr tail on a non-zero exit", async () => {
    const stderr = capture();
    const runner = realCommandRunner(stderr);

    await expect(
      runner.run(process.execPath, ["-e", "console.error('boom'); process.exit(7);"], { cwd: process.cwd(), display: "npx cdk deploy AgentXControlPlane" }),
    ).rejects.toThrow(/npx cdk deploy AgentXControlPlane exited with code 7[\s\S]*boom/);
  });

  it("keeps only the last ~20 lines of stderr in the thrown error", async () => {
    const stderr = capture();
    const runner = realCommandRunner(stderr);
    const script = "for (let i = 1; i <= 40; i++) console.error('line ' + i); process.exit(1);";

    const error: unknown = await runner.run(process.execPath, ["-e", script], { cwd: process.cwd(), display: "many-lines" }).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("line 40");
    expect(message).not.toContain("line 1\n");
    expect(message).not.toContain("line 5\n");
  });

  it("never lets a secret in argv reach the thrown error: not raw (only options.display appears), and stderr is redacted", async () => {
    const stderr = capture();
    const runner = realCommandRunner(stderr);
    const secret = "s3cr3t-signing-key-value-should-never-leak";
    const script = "console.error(process.argv[1]); process.exit(3);";

    const error: unknown = await runner
      .run(process.execPath, ["-e", script, secret], {
        cwd: process.cwd(),
        display: "npx cdk deploy AgentXControlPlane --parameters AgentXControlPlane:CallbackSigningKey=<redacted>",
        redact: (text) => text.split(secret).join("<redacted>"),
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).not.toContain(secret);
    expect(message).toContain("<redacted>");
    expect(message).toContain("npx cdk deploy AgentXControlPlane --parameters AgentXControlPlane:CallbackSigningKey=<redacted>");
  });

  it("never lets a secret the child echoes reach our own stderr either: cdk -v/--debug can log CreateChangeSet parameters", async () => {
    const stderr = capture();
    const runner = realCommandRunner(stderr);
    const secret = "s3cr3t-signing-key-value-should-never-leak";
    const script = "console.error(process.argv[1]); process.exit(3);";

    await runner
      .run(process.execPath, ["-e", script, secret], {
        cwd: process.cwd(),
        display: "npx cdk deploy AgentXControlPlane --parameters AgentXControlPlane:CallbackSigningKey=<redacted>",
        redact: (text) => text.split(secret).join("<redacted>"),
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(stderr.text()).not.toContain(secret);
    expect(stderr.text()).toContain("<redacted>");
  });

  it("redacts a secret split across two separate data chunks: it is buffered to a line boundary before redaction runs", async () => {
    const stderr = capture();
    const runner = realCommandRunner(stderr);
    const secret = "s3cr3t-split-across-chunk-boundary-0123456789";
    const half = Math.floor(secret.length / 2);
    // A real gap between the two writes (a macrotask apart) makes the two `stderr.write` calls
    // arrive as two separate `data` events on our side almost certainly, not one: exactly the case
    // the line-buffering must survive, since neither half alone would match `redact`'s whole-secret
    // needle.
    const script = `
      process.stderr.write(${JSON.stringify(secret.slice(0, half))});
      setTimeout(() => {
        process.stderr.write(${JSON.stringify(secret.slice(half))} + "\\n");
        process.exitCode = 5;
      }, 20);
    `;

    const error: unknown = await runner
      .run(process.execPath, ["-e", script], { cwd: process.cwd(), display: "split-secret", redact: (text) => text.split(secret).join("<redacted>") })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(secret);
    expect((error as Error).message).toContain("<redacted>");
    expect(stderr.text()).not.toContain(secret);
    expect(stderr.text()).toContain("<redacted>");
  });

  it("wraps a spawn failure (e.g. a missing executable) in a sanitized error, never the raw spawn error whose spawnargs hold the secret", async () => {
    const stderr = capture();
    const runner = realCommandRunner(stderr);
    const secret = "s3cr3t-that-must-never-reach-spawnargs";

    const error: unknown = await runner
      .run("/nonexistent/agentx-test-command-xyz", [secret], { cwd: process.cwd(), display: "safe-display-only" })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("safe-display-only could not start");
    expect(message).not.toContain(secret);
    expect((error as NodeJS.ErrnoException).spawnargs).toBeUndefined();
  });

  it("caps a single unbroken line's buffer at 64 KiB, still catching a secret whose bytes straddle the cut", async () => {
    const stderr = capture();
    const runner = realCommandRunner(stderr);
    // The same length a real callback signing key is (base64url of CALLBACK_SIGNING_KEY_BYTES
    // random bytes), so the cap's retained-tail length (derived from the same constant in
    // commands.ts) is exactly big enough to keep this secret intact across a forced cut.
    const secret = "s".repeat(Math.ceil((CALLBACK_SIGNING_KEY_BYTES * 4) / 3));
    const CAP = 64 * 1024;
    // The script builds a single line (no newline) whose length crosses the 64 KiB cap, with the
    // secret positioned so its bytes are on both sides of wherever the cap falls.
    const script = `
      const secret = process.argv[1];
      const CAP = ${CAP};
      const before = "x".repeat(CAP - 20);
      const after = "y".repeat(200 * 1024 - before.length - secret.length);
      process.stdout.write(before + secret + after);
    `;

    await runner.run(process.execPath, ["-e", script, secret], { cwd: process.cwd(), display: "big-line", redact: (text) => text.split(secret).join("<redacted>") });

    expect(stderr.text()).not.toContain(secret);
    expect(stderr.text()).toContain("<redacted>");
    // The real bug this guards: with no cap, this whole 200 KiB unbroken line sits in memory and is
    // written to `stderr` in one shot at flush (a single `write` call) — proving redaction alone
    // doesn't prove the buffer was ever bounded. Capped, at least one forced cut happens partway
    // through (plus the final flush), so `stderr.write` is called more than once.
    expect(stderr.chunks.length).toBeGreaterThan(1);
  });

  it("flushes both streams before rejecting when the child fails after already emitting data (symmetry with close)", async () => {
    const fakeChild = new EventEmitter() as unknown as ReturnType<typeof spawn>;
    const stdout = new EventEmitter();
    const stderrStream = new EventEmitter();
    Object.assign(fakeChild, { stdout, stderr: stderrStream });
    vi.mocked(spawn).mockReturnValueOnce(fakeChild);

    const stderr = capture();
    const runner = realCommandRunner(stderr);
    const promise = runner.run("whatever", [], { cwd: process.cwd(), display: "flush-on-error" });

    stdout.emit("data", Buffer.from("partial line with no newline on stdout"));
    stderrStream.emit("data", Buffer.from("partial line with no newline on stderr"));
    fakeChild.emit("error", new Error("spawn boom"));

    await expect(promise).rejects.toThrow("flush-on-error could not start: spawn boom");
    expect(stderr.text()).toContain("partial line with no newline on stdout");
    expect(stderr.text()).toContain("partial line with no newline on stderr");
  });
});

describe("the interactive change set confirmation", () => {
  it("flags a Conditional replacement as well as a certain one", async () => {
    const written: string[] = [];
    const confirm = interactiveConfirm({ write: (text) => written.push(text) }, async () => "n");
    await confirm({
      stackName: "agentx-staging-runtime",
      changes: [
        { action: "Modify", logicalId: "Certain", type: "AWS::X", replacement: "True" },
        { action: "Modify", logicalId: "Maybe", type: "AWS::X", replacement: "Conditional" },
        { action: "Modify", logicalId: "InPlace", type: "AWS::X", replacement: "False" },
      ],
    });
    const text = written.join("");
    expect(text).toContain("  Modify Certain (AWS::X) [replacement]\n");
    expect(text).toContain("  Modify Maybe (AWS::X) [replacement: conditional]\n");
    expect(text).toContain("  Modify InPlace (AWS::X)\n");
  });
});

describe("cliErrorFor", () => {
  it("keeps the AWS error as the cause when it maps a credential failure or an access denial", () => {
    const expired = Object.assign(new Error("The security token included in the request is expired"), { name: "ExpiredTokenException" });
    const denied = Object.assign(new Error("not authorized to perform: ssm:GetParameter"), { name: "AccessDeniedException" });

    const auth = cliErrorFor(expired) as AgentXError;
    const forbidden = cliErrorFor(denied) as AgentXError;

    expect(auth.code).toBe("AUTH_REQUIRED");
    expect(auth.cause).toBe(expired);
    expect(forbidden.code).toBe("FORBIDDEN");
    expect(forbidden.cause).toBe(denied);
  });
});
