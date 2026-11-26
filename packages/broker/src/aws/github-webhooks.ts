import { verifyGithubWebhookSignature } from "../plugins/code-host/github/signature.js";


export const GITHUB_WEBHOOK_SIGNATURE_INVALID = "GitHub webhook signature is invalid";

/**
 * How the route answers a refusal: "reject" is a 403 (the default), "ignore" is a 202 for a SIGNED delivery that is simply not ours to act on (an unsupported or incomplete payload, a repository outside the
 * registered scope), "conflict" is a 409 (a delivery id reused with other content). `reason` is a fixed word for the log and the answer; `action` is the payload's own action word, when it was read. Never payload text.
 */
export interface GithubWebhookRefusalDetails { kind?: "reject" | "ignore" | "conflict"; reason?: string; action?: string }

export class GithubWebhookRefusal extends Error {
  readonly details: GithubWebhookRefusalDetails;
  constructor(message: string, details: GithubWebhookRefusalDetails = {}) {
    super(message);
    this.name = "GithubWebhookRefusal";
    this.details = details;
  }
}

/** Transient delivery conflicts must receive a retryable response, not an authorization refusal. */
export class GithubWebhookRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubWebhookRetryableError";
  }
}


// The signature check lives with the GitHub code host adapter, so the webhook route and the neutral normaliser share one function and cannot drift.
export { verifyGithubWebhookSignature };


