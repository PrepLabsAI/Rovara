// Code's `ConnectionSecrets`: a connection's key or token (and a registered MCP server's token) kept as one file per saved version in a private folder of the state directory, and READ back
// through the `secrets` socket as a `{ file }` reference, so the file rules of that socket apply (no link in the path, a plain file that belongs to you, mode 0600, small). The owner puts a
// secret in on the local page; nothing else writes here, and a record never holds the value or the file's name.
//
// A file is named `<id>.<version>`; a version is `<milliseconds, 13 digits>-<8 random hex>`, so the newest sorts last. A new save keeps the version before it (a save that loses its race leaves
// a version nothing refers to) and removes the ones older than that. Removing a secret removes every version.
import { randomBytes } from "node:crypto";
import { readdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { agentXError, type SecretStore } from "@agentx/contracts";
import { ensurePrivateDirectory, writeOwnerFile } from "../local/state-directory.js";
import { admitSecretName, type ConnectionSecrets } from "./org-secrets.js";

const VERSION = /^\d{13}-[0-9a-f]{8}$/;
/** The most bytes of one secret: a token or a small JSON of a few keys. */
export const CONNECTION_SECRET_MAX_BYTES = 16_384;

export interface LocalConnectionSecretsOptions {
  /** The private folder the secrets live in (made, mode 0700, when it is not there). */
  directory: string;
  /** The `secrets` socket: how a saved file is read back. */
  secrets: SecretStore;
  /** The company a read is made for (Code's one implicit company). */
  companyId: string;
  /** The install's environment name that prefixes every secret name (`local` here). */
  env: string;
  now?: () => number;
}

/** A name as a file stem: its last segment (the id), which `admitSecretName` has checked is plain. */
const stemOf = (name: string): string => name.slice(name.lastIndexOf("/") + 1);

export function createLocalConnectionSecrets(options: LocalConnectionSecretsOptions): ConnectionSecrets {
  const now = options.now ?? Date.now;
  let chain: Promise<unknown> = Promise.resolve();
  /** Writes and removals of this process go one at a time. */
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const next = chain.then(task, task);
    chain = next.catch(() => undefined);
    return next;
  };
  const versionsOf = async (directory: string, stem: string): Promise<string[]> =>
    (await readdir(directory).catch(() => [] as string[])).filter((file) => file.startsWith(`${stem}.`) && VERSION.test(file.slice(stem.length + 1))).map((file) => file.slice(stem.length + 1)).sort();
  /** Every organisation's secrets are told apart by company folder: the company id is a path segment of the name, never of the file system. */
  const folderOf = async (orgId: string, name: string): Promise<{ directory: string; stem: string }> => {
    const org = admitSecretName(options.env, orgId, name);
    // The real path: the `secrets` socket refuses a path that goes through a link (a system folder such as `/var` on a Mac is one).
    const directory = await realpath(await ensurePrivateDirectory(join(options.directory, org)));
    return { directory, stem: stemOf(name) };
  };
  return {
    async read(orgId, name, versionId) {
      const { directory, stem } = await folderOf(orgId, name);
      const version = versionId ?? (await versionsOf(directory, stem)).at(-1);
      if (version === undefined || !VERSION.test(version)) return undefined;
      const value = await options.secrets.read(options.companyId, { file: join(directory, `${stem}.${version}`) });
      return value?.reveal();
    },
    async put(orgId, name, value) {
      if (Buffer.byteLength(value, "utf8") > CONNECTION_SECRET_MAX_BYTES) throw agentXError("CONFIG_INVALID", "secret: that is too long to be a key or a token");
      const { directory, stem } = await folderOf(orgId, name);
      return serial(async () => {
        const version = `${String(now()).padStart(13, "0")}-${randomBytes(4).toString("hex")}`;
        await writeOwnerFile(join(directory, `${stem}.${version}`), value, { exclusive: true });
        // The one before this stays (a save that loses its race must not take the winner's secret away); older ones go.
        const versions = await versionsOf(directory, stem);
        for (const older of versions.slice(0, -2)) await rm(join(directory, `${stem}.${older}`), { force: true });
        return version;
      });
    },
    async scheduleDelete(orgId, name) {
      const { directory, stem } = await folderOf(orgId, name);
      await serial(async () => {
        for (const version of await versionsOf(directory, stem)) await rm(join(directory, `${stem}.${version}`), { force: true });
      });
    },
  };
}
