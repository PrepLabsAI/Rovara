// The change tier's cases model a code host that reports each file's type (DEC 182: `entry` on a changed file). A file a case built without an `entry` key is given the plain one (an ordinary file, or nothing at the
// base for an added file); a case that wants the host's "could not tell" passes `entry: undefined` explicitly, and keeps it.
import type { DiffInput, TierFile } from "../../packages/broker/src/core/decisions/change-tier.js";

export function withPlainEntry(file: TierFile): TierFile {
  if ("entry" in file) return file;
  if (file.status === "removed") return { ...file, entry: { head: "none", base: "file" } };
  return { ...file, entry: { head: "file", base: file.status === "added" ? "none" : "file" } };
}

export const withPlainEntries = (input: DiffInput): DiffInput => ({ ...input, files: input.files.map(withPlainEntry) });
