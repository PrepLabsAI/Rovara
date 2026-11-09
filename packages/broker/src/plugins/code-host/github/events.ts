// Enterprise foundations, task P6: the GitHub webhook normaliser. It turns one GitHub delivery into neutral code host events (`CodeHostEvent`), and it is what
// `githubCodeHost(...).events.normalise` is.
//
// Order is fixed and tested: (1) the body's size, (2) the signature over the raw body, (3) the delivery id header, and only then (4) the JSON is read. A delivery that
// does not verify is refused before any of its body is parsed, and nothing is ever returned from one. Nothing in a verified body is believed beyond which change
// request, commit or branch to look at again: a consumer reads the host itself after an event.
//
// What a delivery maps to (anything else that is signed and well formed maps to no event):
//   pull_request opened                                -> change_request.opened
//   pull_request closed (merged / not merged)          -> change_request.merged / change_request.closed
//   pull_request reopened, synchronize, edited, ready_for_review, converted_to_draft -> change_request.updated
//   pull_request_review submitted, edited, dismissed   -> review.submitted (state from the review; dismissed is DISMISSED)
//   pull_request_review_comment / issue_comment (on a pull request) created -> comment.created
//   ... the same two, edited or deleted                -> change_request.updated (the thread changed; nothing is new)
//   check_run / check_suite completed, status (not pending) -> check.completed
//   push to a branch (not a delete, not a tag)         -> revision.pushed
// The event id is GitHub's delivery id: a redelivery is the same event, and the intake drops a repeat (plugins/events/intake.ts).
import { z } from "zod";
import {
  agentXError, CodeHostEventSchema, HostScopeSchema, CHECK_CONCLUSIONS,
  type CheckConclusion, type CodeHostEvent, type CodeHostEvents, type HostScope, type RawDelivery, type ReviewState,
} from "@agentx/contracts";
import { verifyGithubWebhookSignature } from "./signature.js";

export const GITHUB_WEBHOOK_MAX_BYTES = 1_048_576;
const DELIVERY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FULL_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const COMMIT = /^[a-f0-9]{40,64}$/;
const SIGNATURE_MESSAGE = "the delivery's signature does not verify";
const UNREADABLE_MESSAGE = "the delivery cannot be read";

const Repository = z.object({ full_name: z.string().regex(FULL_NAME).max(300) }).passthrough();
const Sender = z.object({ login: z.string().min(1).max(100) }).passthrough().optional();
const PullRequest = z.object({ number: z.number().int().positive(), merged: z.boolean().optional() }).passthrough();
const Base = { repository: Repository, sender: Sender } as const;

const PullRequestPayload = z.object({ ...Base, action: z.string().min(1).max(80), pull_request: PullRequest }).passthrough();
const ReviewPayload = z.object({
  ...Base, action: z.string().min(1).max(80), pull_request: PullRequest,
  review: z.object({ id: z.number().int().positive(), state: z.string().min(1).max(40) }).passthrough(),
}).passthrough();
const ReviewCommentPayload = z.object({
  ...Base, action: z.string().min(1).max(80), pull_request: PullRequest, comment: z.object({ id: z.number().int().positive() }).passthrough(),
}).passthrough();
const IssueCommentPayload = z.object({
  ...Base, action: z.string().min(1).max(80),
  issue: z.object({ number: z.number().int().positive(), pull_request: z.object({}).passthrough().optional() }).passthrough(),
  comment: z.object({ id: z.number().int().positive() }).passthrough(),
}).passthrough();
const CheckRunPayload = z.object({
  ...Base, action: z.string().min(1).max(80),
  check_run: z.object({ head_sha: z.string().regex(COMMIT), name: z.string().min(1).max(200), conclusion: z.string().max(40).nullable().optional() }).passthrough(),
}).passthrough();
const CheckSuitePayload = z.object({
  ...Base, action: z.string().min(1).max(80),
  check_suite: z.object({ head_sha: z.string().regex(COMMIT), conclusion: z.string().max(40).nullable().optional(), app: z.object({ slug: z.string().max(100).optional() }).passthrough().nullable().optional() }).passthrough(),
}).passthrough();
const StatusPayload = z.object({
  ...Base, sha: z.string().regex(COMMIT), state: z.string().min(1).max(40), context: z.string().min(1).max(200).optional(),
}).passthrough();
const PushPayload = z.object({
  ...Base, ref: z.string().min(1).max(300), after: z.string().regex(COMMIT).optional(), deleted: z.boolean().optional(),
}).passthrough();

const REVIEW_STATES: Readonly<Record<string, ReviewState>> = {
  approved: "APPROVED", changes_requested: "CHANGES_REQUESTED", commented: "COMMENTED", dismissed: "DISMISSED", pending: "PENDING",
};
const CONCLUSIONS: ReadonlySet<string> = new Set(CHECK_CONCLUSIONS);

function readable<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", UNREADABLE_MESSAGE);
  return parsed.data;
}

/** Only an address GitHub's own repository name builds: never a url taken from the body. */
const repositoryUrlOf = (fullName: string): string => `https://github.com/${fullName}`;
const changeRequestRefOf = (fullName: string, number: number) => ({ repository: { url: repositoryUrlOf(fullName) }, id: String(number), url: `${repositoryUrlOf(fullName)}/pull/${number}` });

/** The neutral events of a delivery whose signature has been verified. Pure: no I/O. `deliveryId` is GitHub's, from the header. */
export function neutralEventsOfGithub(eventName: string | undefined, body: unknown, deliveryId: string): CodeHostEvent[] {
  const base = { eventId: deliveryId, host: "github" } as const;
  const actorOf = (sender: { login: string } | undefined) => (sender === undefined ? {} : { actor: sender.login });
  const finish = (event: unknown): CodeHostEvent[] => [CodeHostEventSchema.parse(event)];
  switch (eventName) {
    case "pull_request": {
      const payload = readable(PullRequestPayload, body);
      const ref = changeRequestRefOf(payload.repository.full_name, payload.pull_request.number);
      const actor = actorOf(payload.sender);
      switch (payload.action) {
        case "opened": return finish({ ...base, type: "change_request.opened", ref, ...actor });
        case "closed": return finish({ ...base, type: payload.pull_request.merged === true ? "change_request.merged" : "change_request.closed", ref, ...actor });
        case "reopened": case "synchronize": case "edited": case "ready_for_review": case "converted_to_draft":
          return finish({ ...base, type: "change_request.updated", ref, ...actor });
        default: return [];
      }
    }
    case "pull_request_review": {
      const payload = readable(ReviewPayload, body);
      if (payload.action !== "submitted" && payload.action !== "edited" && payload.action !== "dismissed") return [];
      const state = payload.action === "dismissed" ? "DISMISSED" : REVIEW_STATES[payload.review.state.toLowerCase()];
      if (state === undefined) throw agentXError("CONFIG_INVALID", UNREADABLE_MESSAGE);
      return finish({ ...base, type: "review.submitted", ref: changeRequestRefOf(payload.repository.full_name, payload.pull_request.number), state, ...actorOf(payload.sender) });
    }
    case "pull_request_review_comment": {
      const payload = readable(ReviewCommentPayload, body);
      const ref = changeRequestRefOf(payload.repository.full_name, payload.pull_request.number);
      if (payload.action === "created") return finish({ ...base, type: "comment.created", ref, commentId: `review_comment:${payload.comment.id}`, ...actorOf(payload.sender) });
      return payload.action === "edited" || payload.action === "deleted" ? finish({ ...base, type: "change_request.updated", ref, ...actorOf(payload.sender) }) : [];
    }
    case "issue_comment": {
      const payload = readable(IssueCommentPayload, body);
      // A comment on an issue is not a change request's.
      if (payload.issue.pull_request === undefined) return [];
      const ref = changeRequestRefOf(payload.repository.full_name, payload.issue.number);
      if (payload.action === "created") return finish({ ...base, type: "comment.created", ref, commentId: `discussion:${payload.comment.id}`, ...actorOf(payload.sender) });
      return payload.action === "edited" || payload.action === "deleted" ? finish({ ...base, type: "change_request.updated", ref, ...actorOf(payload.sender) }) : [];
    }
    case "check_run": {
      const payload = readable(CheckRunPayload, body);
      const conclusion = payload.check_run.conclusion;
      if (payload.action !== "completed" || conclusion === null || conclusion === undefined || !CONCLUSIONS.has(conclusion)) return [];
      return finish({ ...base, type: "check.completed", repository: { url: repositoryUrlOf(payload.repository.full_name) }, revision: payload.check_run.head_sha, name: payload.check_run.name, conclusion: conclusion as CheckConclusion });
    }
    case "check_suite": {
      const payload = readable(CheckSuitePayload, body);
      const conclusion = payload.check_suite.conclusion;
      if (payload.action !== "completed" || conclusion === null || conclusion === undefined || !CONCLUSIONS.has(conclusion)) return [];
      return finish({ ...base, type: "check.completed", repository: { url: repositoryUrlOf(payload.repository.full_name) }, revision: payload.check_suite.head_sha, name: payload.check_suite.app?.slug ?? "check-suite", conclusion: conclusion as CheckConclusion });
    }
    case "status": {
      const payload = readable(StatusPayload, body);
      const conclusion: CheckConclusion | undefined = payload.state === "success" ? "success" : payload.state === "failure" ? "failure" : payload.state === "error" ? "error" : undefined;
      if (conclusion === undefined) return [];
      return finish({ ...base, type: "check.completed", repository: { url: repositoryUrlOf(payload.repository.full_name) }, revision: payload.sha, name: payload.context ?? "status", conclusion });
    }
    case "push": {
      const payload = readable(PushPayload, body);
      const branch = /^refs\/heads\/(.+)$/.exec(payload.ref)?.[1];
      if (branch === undefined || payload.deleted === true || payload.after === undefined || /^0+$/.test(payload.after)) return [];
      return finish({ ...base, type: "revision.pushed", repository: { url: repositoryUrlOf(payload.repository.full_name) }, branch, revision: payload.after });
    }
    default:
      return [];
  }
}

/**
 * The adapter's `events`: a delivery is verified against the webhook secret first and only then read. `secret` is read for each delivery (the install's secret can be
 * rotated); a secret that cannot be read refuses the delivery.
 */
export function githubCodeHostEvents(secret: (options?: { refresh?: boolean }) => Promise<string>): CodeHostEvents {
  return {
    mode: "webhook",
    async normalise(delivery: RawDelivery, scope: HostScope): Promise<CodeHostEvent[]> {
      if (!HostScopeSchema.safeParse(scope).success) throw agentXError("CONFIG_INVALID", "the plug-in call has no valid scope");
      if (Buffer.byteLength(delivery.rawBody, "utf8") > GITHUB_WEBHOOK_MAX_BYTES) throw agentXError("CONFIG_INVALID", "the delivery is too large");
      const headers = Object.fromEntries(Object.entries(delivery.headers).map(([key, value]) => [key.toLowerCase(), value]));
      // The signature first, before any of the body is read.
      let verified = verifyGithubWebhookSignature(delivery.rawBody, headers["x-hub-signature-256"], await secret());
      if (!verified) verified = verifyGithubWebhookSignature(delivery.rawBody, headers["x-hub-signature-256"], await secret({ refresh: true }));
      if (!verified) throw agentXError("CALLBACK_FORBIDDEN", SIGNATURE_MESSAGE);
      const deliveryId = headers["x-github-delivery"];
      if (deliveryId === undefined || !DELIVERY_ID.test(deliveryId)) throw agentXError("CONFIG_INVALID", UNREADABLE_MESSAGE);
      let body: unknown;
      try {
        body = JSON.parse(delivery.rawBody) as unknown;
      } catch {
        throw agentXError("CONFIG_INVALID", UNREADABLE_MESSAGE);
      }
      return neutralEventsOfGithub(headers["x-github-event"], body, deliveryId.toLowerCase());
    },
  };
}
