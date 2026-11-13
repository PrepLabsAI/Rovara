// The laptop's connection secrets: one owner-only file for each saved version, read back through the `secrets` socket under its file rules.
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID } from "@rovara-code/contracts";
import { createLocalConnectionSecrets } from "../../packages/core/src/connections/local-secrets.js";
import { orgConnectorSecretName } from "../../packages/core/src/connections/org-secrets.js";
import { createLocalSecretStore } from "../../packages/core/src/ports/secret-stores.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length > 0) await cleanup.pop()!(); });

const NAME = orgConnectorSecretName("local", IMPLICIT_COMPANY_ID, "con_aaaaaaaaaaaaaaaaaaaa");

async function world(clock = { ms: 1_700_000_000_000 }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rovara-connection-secrets-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "connection-secrets");
  const secrets = createLocalConnectionSecrets({ directory, secrets: createLocalSecretStore({ environment: {} }), companyId: IMPLICIT_COMPANY_ID, env: "local", now: () => clock.ms });
  return { root, directory, secrets, clock, folder: join(directory, IMPLICIT_COMPANY_ID) };
}

describe("the connection secrets on a laptop", () => {
  it("writes each version as a file only the owner can read, in a folder only the owner can enter, and reads it back through the secrets socket", async () => {
    const w = await world();
    const version = await w.secrets.put(IMPLICIT_COMPANY_ID, NAME, JSON.stringify({ apiKey: "k1" }));
    expect(version).toMatch(/^\d{13}-[0-9a-f]{8}$/u);
    const files = await readdir(w.folder);
    expect(files).toEqual([`con_aaaaaaaaaaaaaaaaaaaa.${version}`]);
    expect((await lstat(join(w.folder, files[0]!))).mode & 0o777).toBe(0o600);
    expect((await lstat(w.folder)).mode & 0o777).toBe(0o700);
    expect(await w.secrets.read(IMPLICIT_COMPANY_ID, NAME, version)).toBe(JSON.stringify({ apiKey: "k1" }));
    expect(await w.secrets.read(IMPLICIT_COMPANY_ID, NAME)).toBe(JSON.stringify({ apiKey: "k1" }));
    expect(await w.secrets.read(IMPLICIT_COMPANY_ID, NAME, "0000000000000-deadbeef")).toBeUndefined();
  });

  it("keeps the version before the newest (a save that lost its race must not take the winner's secret away) and removes older ones", async () => {
    const w = await world();
    const versions: string[] = [];
    for (const value of ["one", "two", "three"]) { w.clock.ms += 1_000; versions.push(await w.secrets.put(IMPLICIT_COMPANY_ID, NAME, value)); }
    expect((await readdir(w.folder)).sort()).toEqual([versions[1]!, versions[2]!].map((version) => `con_aaaaaaaaaaaaaaaaaaaa.${version}`));
    expect(await w.secrets.read(IMPLICIT_COMPANY_ID, NAME, versions[0])).toBeUndefined();
    expect(await w.secrets.read(IMPLICIT_COMPANY_ID, NAME, versions[1])).toBe("two");
    expect(await w.secrets.read(IMPLICIT_COMPANY_ID, NAME)).toBe("three");
  });

  it("removes every version, and a secret that is not there is already gone", async () => {
    const w = await world();
    await w.secrets.put(IMPLICIT_COMPANY_ID, NAME, "one");
    await w.secrets.scheduleDelete(IMPLICIT_COMPANY_ID, NAME);
    expect(await readdir(w.folder)).toEqual([]);
    expect(await w.secrets.read(IMPLICIT_COMPANY_ID, NAME)).toBeUndefined();
    await expect(w.secrets.scheduleDelete(IMPLICIT_COMPANY_ID, NAME)).resolves.toBeUndefined();
  });

  it("checks a name against its company before it touches a file, and refuses a name that climbs out of the folder", async () => {
    const w = await world();
    await expect(w.secrets.put("org_bbbbbbbbbbbbbbbbbbbb", NAME, "x")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(w.secrets.read(IMPLICIT_COMPANY_ID, `agentx/local/org-connectors/${IMPLICIT_COMPANY_ID}/../../escape`)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(w.secrets.put(IMPLICIT_COMPANY_ID, `agentx/local/org-connectors/${IMPLICIT_COMPANY_ID}/a/b`, "x")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await readdir(w.root)).toEqual([]);
  });

  it("refuses a secret that is too long to be a key or a token", async () => {
    const w = await world();
    await expect(w.secrets.put(IMPLICIT_COMPANY_ID, NAME, "x".repeat(20_000))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("does not read a file anyone else can read, or one that was swapped for a link: the socket's file rules apply", async () => {
    const w = await world();
    const version = await w.secrets.put(IMPLICIT_COMPANY_ID, NAME, "one");
    const file = join(w.folder, `con_aaaaaaaaaaaaaaaaaaaa.${version}`);
    await chmod(file, 0o644);
    await expect(w.secrets.read(IMPLICIT_COMPANY_ID, NAME, version)).rejects.toThrow(/must not be readable by other users/u);
    await chmod(file, 0o600);
    await rm(file);
    await mkdir(join(w.root, "elsewhere"), { recursive: true });
    await writeFile(join(w.root, "elsewhere", "stolen"), "not-the-secret", { mode: 0o600 });
    await symlink(join(w.root, "elsewhere", "stolen"), file);
    await expect(w.secrets.read(IMPLICIT_COMPANY_ID, NAME, version)).rejects.toThrow(/link/u);
    expect(await readFile(join(w.root, "elsewhere", "stolen"), "utf8")).toBe("not-the-secret");
  });
});
