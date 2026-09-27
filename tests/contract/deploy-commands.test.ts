// The real CommandRunner (commands.ts): shells out with node:child_process for real, unlike every
// other deploy test which scripts a fake CommandRunner. Ruling (b): shell: false, stream the
// child's output to our stderr, and on a non-zero exit throw an error naming the exit code,
// options.display (never the raw argv) and the last ~20 lines of stderr, redacted the same way the
// cdk engine's own printed command already is.
import { describe, expect, it } from "vitest";
import { realCommandRunner } from "../../packages/cli/src/deploy/commands.js";

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
    // The child did echo the secret to its own stderr, which realCommandRunner streams live to ours
    // exactly as it arrives (ruling b): the redaction only ever protects the *thrown error*, never
    // pretends the child's own output was safe. Confirm that's the only place the secret shows up.
    expect(stderr.text()).toContain(secret);
  });
});
