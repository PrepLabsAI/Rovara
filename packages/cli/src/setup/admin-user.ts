// FR-018 step 7 for a Cognito identity: the admin user, created once. Cognito emails a temporary
// password; the first sign-in asks for a new one. Re-running never sends a second email.
import { ADMIN_GROUP } from "./admin-session.js";
import type { CognitoAdmin } from "./services.js";

export async function ensureCognitoAdmin(input: { cognito: CognitoAdmin; poolId: string; email: string; write: (line: string) => void }): Promise<{ created: boolean }> {
  const status = await input.cognito.userStatus(input.poolId, input.email);
  if (status === undefined) {
    await input.cognito.createUser(input.poolId, input.email);
    input.write(`Created the admin user ${input.email}. Cognito emailed a temporary password to ${input.email}; you set your own password at the first sign-in.`);
  } else if (status === "FORCE_CHANGE_PASSWORD") {
    input.write(`The admin user ${input.email} already exists and has not signed in yet: use the temporary password from the first email Cognito sent.`);
  }
  // Idempotent: adding a member again changes nothing.
  await input.cognito.addToGroup(input.poolId, input.email, ADMIN_GROUP);
  return { created: status === undefined };
}
