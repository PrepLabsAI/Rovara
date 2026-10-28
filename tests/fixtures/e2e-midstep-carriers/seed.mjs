// The recipe's seed command (rovara-accounts-file/v1): reads the accounts file the Rovara host wrote for this run and builds the app's own user records in /data. The app reads only those records.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const file = process.env.ROVARA_ACCOUNTS_FILE;
const dir = process.env.ROVARA_DATA_DIR;
if (!file || !dir) { console.error("the seed needs ROVARA_ACCOUNTS_FILE and ROVARA_DATA_DIR"); process.exit(2); }
const input = JSON.parse(readFileSync(file, "utf8"));
if (input?.schemaVersion !== "rovara-accounts/v1" || !Array.isArray(input.accounts) || input.accounts.length < 1) { console.error("the accounts file is not rovara-accounts/v1"); process.exit(3); }
const users = input.accounts.map((account) => {
  if (![account.profileId, account.email, account.password, account.tenantRef, account.roleRef].every((value) => typeof value === "string" && value !== "")) { console.error("an account record is incomplete"); process.exit(3); }
  return { email: account.email, passwordDigest: createHash("sha256").update(account.password, "utf8").digest("hex"), subjectId: `subject-${randomUUID()}`,
    tenantId: account.tenantRef, role: account.roleRef, displayName: `Rovara ${account.profileId}` };
});
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "users.json"), JSON.stringify({ users }), { mode: 0o600 });
console.log(`seeded ${users.length} account(s)`);
