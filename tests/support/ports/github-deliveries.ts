// P6: GitHub-shaped webhook deliveries for the tests, signed the way GitHub signs them (HMAC-SHA256 over the raw body, `x-hub-signature-256`). The secret is built at run time.
import { createHmac, randomUUID } from "node:crypto";
import type { RawDelivery } from "../../../packages/contracts/src/index.js";

export const WEBHOOK_SECRET = ["webhook", "secret", "for", "tests", "only", "0123456789abcdef"].join("-");
export const webhookSecretReader = (secret = WEBHOOK_SECRET) => async (): Promise<string> => secret;

export function signGithubBody(rawBody: string, secret = WEBHOOK_SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
}

/** A delivery as the broker receives it: the exact body, and GitHub's headers (lower-cased). */
export function githubDelivery(eventName: string, body: unknown, options: { secret?: string; deliveryId?: string; signature?: string; raw?: string } = {}): RawDelivery {
  const rawBody = options.raw ?? JSON.stringify(body);
  return {
    rawBody,
    headers: {
      "x-github-event": eventName, "x-github-delivery": options.deliveryId ?? randomUUID(),
      "x-hub-signature-256": options.signature ?? signGithubBody(rawBody, options.secret ?? WEBHOOK_SECRET),
    },
  };
}

const REPOSITORY = { id: 4242, full_name: "acme/app" };
const SENDER = { login: "priya" };

/** The payloads, one per kind of event GitHub sends that the normaliser follows. Fields not read by the normaliser are left in, as GitHub sends them. */
export const githubPayloads = {
  pullRequest: (action: string, number = 7, extra: Record<string, unknown> = {}) => ({ action, number, installation: { id: 77 }, repository: REPOSITORY, sender: SENDER, pull_request: { number, state: "open", merged: false, head: { sha: "a".repeat(40) }, ...extra } }),
  review: (action: string, state: string, number = 7) => ({ action, installation: { id: 77 }, repository: REPOSITORY, sender: SENDER, pull_request: { number }, review: { id: 901, state, html_url: "https://github.com/acme/app/pull/7#pullrequestreview-901" } }),
  reviewComment: (action: string, number = 7) => ({ action, installation: { id: 77 }, repository: REPOSITORY, sender: SENDER, pull_request: { number }, comment: { id: 555, body: "please rename" } }),
  issueComment: (action: string, number = 7, onPullRequest = true) => ({ action, installation: { id: 77 }, repository: REPOSITORY, sender: SENDER, issue: { number, ...(onPullRequest ? { pull_request: { url: `https://api.github.com/repos/acme/app/pulls/${number}` } } : {}) }, comment: { id: 556, body: "thanks" } }),
  checkRun: (action: string, conclusion: string | null, head = "b".repeat(40)) => ({ action, installation: { id: 77 }, repository: REPOSITORY, check_run: { head_sha: head, name: "unit", conclusion } }),
  checkSuite: (action: string, conclusion: string | null, head = "c".repeat(40)) => ({ action, installation: { id: 77 }, repository: REPOSITORY, check_suite: { head_sha: head, conclusion, app: { slug: "ci-app" } } }),
  status: (state: string, sha = "d".repeat(40)) => ({ installation: { id: 77 }, repository: REPOSITORY, sha, state, context: "ci/legacy" }),
  push: (ref: string, after = "e".repeat(40), deleted = false) => ({ installation: { id: 77 }, repository: REPOSITORY, sender: SENDER, ref, after, deleted }),
};
