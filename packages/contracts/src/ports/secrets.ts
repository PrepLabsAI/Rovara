// Owner decision 60 (item R2): a small `secrets` socket. An adapter that needs a secret (a code host's token, a webhook's signing secret, a model key)
// names WHERE to read it and asks this socket; it never writes its own reader. Code's adapter reads the environment and files; Cloud's later adapter
// reads its secret service. A secret is always a `SecretValue`, so it prints as `[secret]` everywhere.
import { z } from "zod";
import type { SecretValue } from "./model-keys.js";

/**
 * A reference to a secret: an object with exactly ONE entry, whose key names the kind of source and whose value says which one. The kinds are the
 * adapter's to define, so a reference is plain data that config files may hold (never the secret itself):
 *
 * - `{ "env": "NAME" }`: an environment variable (Code).
 * - `{ "file": "/absolute/path" }`: a file only its owner can read (Code).
 * - `{ "key": "provider" }`: an entry of the owner's key file (`keys.json`) (Code).
 *
 * An adapter that does not know a kind answers `undefined`, not an error, so one config can name sources for more than one install.
 */
export type SecretRef = Readonly<Record<string, string>>;

/** The most characters a reference's value may have. */
export const SECRET_REF_VALUE_MAX = 1_024;

export const SecretRefSchema = z
  .record(z.string().regex(/^[a-z][A-Za-z0-9]{0,31}$/), z.string().min(1).max(SECRET_REF_VALUE_MAX))
  .refine((ref) => Object.keys(ref).length === 1, "exactly one source");

export interface SecretStore {
  /**
   * The secret a reference names, or `undefined` when there is none (the variable is unset, the file is not there, the kind is not known to this
   * store). The company comes with each call, as in every shared port: Code ignores it, Cloud serves many. Throws with a FIXED sentence that never
   * quotes the reference's value or any content when a source exists but must not be used (a key file other users can read, a link, a file that is too big)
   * or when the reference is not valid. The value is read on every call, so a rotation takes effect at once; a caller that wants it cached caches the `SecretValue`.
   */
  read(companyId: string, ref: SecretRef): Promise<SecretValue | undefined>;
  /**
   * Optional. Lets go of what the adapter holds (connections, timers) so the process can exit. Called once, when the process is done with the adapter: at the end of `rovara up`, and after
   * `rovara up --check` has loaded a configured one. Reads after it are not made.
   */
  close?(): Promise<void> | void;
}
