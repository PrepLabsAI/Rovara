// Spec 048 FR-038 and SC-002: a sign-in a child process asks for is on the page, not only in the log.
import { describe, expect, it } from "vitest";
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
const PKCE = "If the browser does not open, open the following URL:\n\nhttps://oidc.us-east-1.amazonaws.com/authorize?response_type=code&client_id=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A53001%2Foauth%2Fcallback\n";

describe("the child action watcher", () => {
  it("finds the sign-in address and code of aws sso login, across chunk boundaries", () => {
    const seen: ChildAction[] = [];
    const watcher = childActionWatcher((action) => seen.push(action));
    for (let index = 0; index < DEVICE.length; index += 7) watcher.feed(DEVICE.slice(index, index + 7));
    expect(seen.at(-1)).toEqual({ url: "https://device.sso.us-east-1.amazonaws.com/", code: "WXYZ-ABCD" });
  });

  it("finds the address of the newer sign-in, which has no code", () => {
    const seen: ChildAction[] = [];
    childActionWatcher((action) => seen.push(action)).feed(PKCE);
    expect(seen).toEqual([{ url: "https://oidc.us-east-1.amazonaws.com/authorize?response_type=code&client_id=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A53001%2Foauth%2Fcallback" }]);
  });

  it("ignores an address no line asked the user to open, and anything that is not https", () => {
    const seen: ChildAction[] = [];
    const watcher = childActionWatcher((action) => seen.push(action));
    watcher.feed("Deploying https://example.com/stack\nopen the following URL:\nhttp://insecure.example.com/\n");
    expect(seen).toEqual([]);
  });

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
    const script = `process.stderr.write(${JSON.stringify(DEVICE)}); setTimeout(() => {}, 200);`;
    const running = runner.run(process.execPath, ["-e", script], { cwd: process.cwd(), display: "aws sso login" });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    expect(seen.at(-1)?.code).toBe("WXYZ-ABCD");
    await running;
  });
});
