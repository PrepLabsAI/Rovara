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

  it("throws an error naming the exit code, options.display and the stderr tail on a non-zero exit", async () => {
    const stderr = capture();
    const runner = realCommandRunner(stderr);

    await expect(
      runner.run(process.execPath, ["-e", "console.error('boom'); process.exit(7);"], { cwd: process.cwd(), display: "npx cdk deploy AgentXControlPlane" }),
    ).rejects.toThrow(/npx cdk deploy AgentXControlPlane exited with code 7[\s\S]*boom/);
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
    if (!(error instanceof Error)) throw new Error("expected the sanitized spawn error");
    const message = error.message;
    expect(message).toContain("safe-display-only could not start");
    expect(message).not.toContain(secret);
    const spawnargs = "spawnargs" in error ? error.spawnargs : undefined;
    expect(spawnargs).toBeUndefined();
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
