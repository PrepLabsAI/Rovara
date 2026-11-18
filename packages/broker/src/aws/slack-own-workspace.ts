// Slack's part of the attention email's verified-address rule (attention-email.ts): a sign-in record is from this install's own Slack workspace only when its issuer is
// Slack's OIDC issuer and its subject is a plain user id (another workspace's sign-in names its subject `<team>:<user>` and stores no email). Kept in a slack-* module
// so the Slack names stay inside the Slack boundary (tests/contract/slack-boundary.test.ts).
import { SLACK_OIDC_ISSUER, SlackUserIdSchema } from "@agentx/contracts";

export function isOwnSlackWorkspaceSignIn(issuer: unknown, subject: unknown): boolean {
  return issuer === SLACK_OIDC_ISSUER && SlackUserIdSchema.safeParse(subject).success;
}
