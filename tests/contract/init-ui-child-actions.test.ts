// Spec 048 FR-038 and SC-002: a sign-in a child process asks for is on the page, not only in the log.
import { describe, expect, it, vi } from "vitest";
import { realCommandRunner } from "../../packages/cli/src/deploy/commands.js";
import { awsSignInCard } from "../../packages/cli/src/init/ui/cards.js";
import { childActionWatcher, type ChildAction } from "../../packages/cli/src/init/ui/child-actions.js";

const DEVICE = [
  "Attempting to automatically open the SSO authorization page in your default browser.",
  "If the browser does not open or you wish to use a different device to authorize this request, open the following URL:",
  "",
  "https://device.sso.us-east-1.amazonaws.com/",
  "",
  "Then enter the code:",
  "",
  "WXYZ-ABCD",
  "",
].join("\n");

describe("the child action watcher", () => {

  it("shows a card with the link and the code, and a done card after", () => {
    expect(awsSignInCard({ url: "https://device.sso.us-east-1.amazonaws.com/", code: "WXYZ-ABCD" })).toEqual({
      id: "aws-signin", title: "Sign in to AWS", status: "waiting",
      lines: ["AWS asks you to approve this sign-in in your browser.", "Check that AWS shows this code: WXYZ-ABCD", "This page moves on by itself once you approve it."],
      link: { url: "https://device.sso.us-east-1.amazonaws.com/", label: "Open the AWS sign-in page" },
    });
    expect(awsSignInCard({ done: true })).toMatchObject({ status: "ok", lines: ["You are signed in to AWS."] });
  });

  it("works on a real child process's streamed output, while it is still running", async () => {
    const seen: ChildAction[] = [];
    const watcher = childActionWatcher((action) => seen.push(action));
    const runner = realCommandRunner({ write: (text: string) => { watcher.feed(text); } });
    const script = `process.stderr.write(${JSON.stringify(DEVICE)}); setTimeout(() => {}, 3000);`;
    const running = runner.run(process.execPath, ["-e", script], { cwd: process.cwd(), display: "aws sso login" });
    // Seen while the child still runs (it stays 3 s): polled, not a fixed wait, so a busy machine's slow child start does not fail it.
    await vi.waitFor(() => { expect(seen.at(-1)?.code).toBe("WXYZ-ABCD"); }, { timeout: 2_500, interval: 20 });
    await running;
  });
});
