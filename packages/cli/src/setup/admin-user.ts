// FR-018 step 7 for a Cognito identity: the admin user, created once. Cognito emails a temporary
// password; the first sign-in asks for a new one. Re-running never sends a second email.
import { agentXError } from "@agentx/contracts";
import { ADMIN_GROUP } from "./admin-session.js";
import type { CognitoAdmin } from "./services.js";

/** Cognito's own sender: the user pool sends its invitations without SES (EmailSendingAccount COGNITO_DEFAULT). */
export const COGNITO_SENDER = "no-reply@verificationemail.com";

export async function ensureCognitoAdmin(input: {
  cognito: CognitoAdmin; poolId: string; email: string; write: (line: string) => void;
  /** Asked before a user who has already signed in is made an administrator (--yes answers yes). */
  confirm: (question: string) => Promise<boolean>;
}): Promise<{ created: boolean; temporaryPassword: boolean }> {
  const { cognito, poolId, email } = input;
  const status = await cognito.userStatus(poolId, email);
  if (status === undefined) {
    await cognito.createUser(poolId, email);
    input.write(`Created the admin user ${email}. Cognito emailed a temporary password to ${email} from ${COGNITO_SENDER} (check Spam); you set your own password at the first sign-in.`);
    await cognito.addToGroup(poolId, email, ADMIN_GROUP);
    return { created: true, temporaryPassword: true };
  }
  if (status === "FORCE_CHANGE_PASSWORD") {
    input.write(`The admin user ${email} already exists and has not signed in yet: use the temporary password from the first email Cognito sent, from ${COGNITO_SENDER} (check Spam).`);
    // Idempotent: adding a member again changes nothing.
    await cognito.addToGroup(poolId, email, ADMIN_GROUP);
    return { created: false, temporaryPassword: true };
  }
  if ((await cognito.groups(poolId, email)).includes(ADMIN_GROUP)) return { created: false, temporaryPassword: false };
  if (status === "CONFIRMED" && !(await input.confirm(`The user ${email} already exists and has signed in before. Make it an AgentX administrator (group ${ADMIN_GROUP})?`))) {
    throw agentXError("CONFIG_INVALID", `you chose not to make ${email} an AgentX administrator; run agentx init again and give the email address of the admin you want (--admin-email)`);
  }
  input.write(`The user ${email} already exists (status ${status}); adding it to ${ADMIN_GROUP}.`);
  await cognito.addToGroup(poolId, email, ADMIN_GROUP);
  return { created: false, temporaryPassword: false };
}
