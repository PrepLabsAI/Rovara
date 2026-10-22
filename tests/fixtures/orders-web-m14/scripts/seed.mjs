// The seed command of the recipe (rovara-accounts-file/v1). It reads the accounts file that the test harness writes for a run and builds the application's own user
// records in the data directory. The application reads only those records; it never sees the accounts file or a plain password.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const file = process.env.ROVARA_ACCOUNTS_FILE;
const directory = process.env.ROVARA_DATA_DIR;
if (!file || !directory) { console.error("the seed needs ROVARA_ACCOUNTS_FILE and ROVARA_DATA_DIR"); process.exit(2); }
const input = JSON.parse(readFileSync(file, "utf8"));
if (input?.schemaVersion !== "rovara-accounts/v1" || !Array.isArray(input.accounts) || input.accounts.length < 1) { console.error("the accounts file is not rovara-accounts/v1"); process.exit(3); }
const accounts = input.accounts.map((account) => {
  if (![account?.profileId, account?.email, account?.password, account?.tenantRef, account?.roleRef].every((value) => typeof value === "string" && value !== "")) {
    console.error("an account record is incomplete");
    process.exit(3);
  }
  return {
    email: account.email,
    passwordDigest: createHash("sha256").update(account.password, "utf8").digest("hex"),
    subjectId: `subject-${randomUUID()}`,
    tenantId: account.tenantRef,
    role: account.roleRef,
    displayName: `Rovara ${account.profileId}`,
  };
});
mkdirSync(directory, { recursive: true });
writeFileSync(join(directory, "users.json"), JSON.stringify({ accounts }), { mode: 0o600 });
console.log(`seeded ${accounts.length} account(s)`);
