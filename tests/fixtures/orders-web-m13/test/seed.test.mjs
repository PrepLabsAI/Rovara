import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/seed.mjs", import.meta.url));
const file = { schemaVersion: "rovara-accounts/v1", accounts: [
  { profileId: "orders-owner", email: "kzr41@a.example", password: "pw-first", tenantRef: "tenant-a", roleRef: "owner" },
  { profileId: "orders-viewer", email: "mvd58@a.example", password: "pw-second", tenantRef: "tenant-a", roleRef: "viewer" },
] };

function seed(contents) {
  const directory = mkdtempSync(join(tmpdir(), "orders-seed-"));
  try {
    writeFileSync(join(directory, "accounts.json"), JSON.stringify(contents));
    const env = { PATH: process.env.PATH, ROVARA_ACCOUNTS_FILE: join(directory, "accounts.json"), ROVARA_DATA_DIR: join(directory, "data") };
    let failed = false;
    try { execFileSync(process.execPath, [script], { env, stdio: "pipe" }); } catch { failed = true; }
    const target = join(directory, "data", "users.json");
    return { failed, users: existsSync(target) ? JSON.parse(readFileSync(target, "utf8")) : null };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("the seed writes one user record per account, with a password digest and no password", () => {
  const { failed, users } = seed(file);
  assert.equal(failed, false);
  assert.deepEqual(users.accounts.map((account) => [account.email, account.tenantId, account.role]), [["kzr41@a.example", "tenant-a", "owner"], ["mvd58@a.example", "tenant-a", "viewer"]]);
  assert.ok(users.accounts.every((account) => /^[a-f0-9]{64}$/.test(account.passwordDigest)));
  assert.ok(!JSON.stringify(users).includes("pw-first"));
});

test("the seed refuses an accounts file it does not know and writes nothing", () => {
  for (const broken of [{ ...file, schemaVersion: "other/v1" }, { ...file, accounts: [] }, { ...file, accounts: [{ ...file.accounts[0], password: "" }] }]) {
    const { failed, users } = seed(broken);
    assert.equal(failed, true);
    assert.equal(users, null);
  }
});
