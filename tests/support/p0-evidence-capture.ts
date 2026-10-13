import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface OriginalEvidencePrimary {
  readonly kind: string;
  readonly key: string;
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly producer: string;
  readonly sourceCandidateDigest: string;
}

/** Persist exact in-memory object bytes before the test scope or its fake S3 Map is torn down. */
export async function persistOriginalEvidencePrimary(input: {
  root: string;
  kind: string;
  key: string;
  bytes: string | Uint8Array;
  producer: string;
  sourceCandidateDigest: string;
}): Promise<OriginalEvidencePrimary> {
  const bytes = Buffer.from(input.bytes);
  const safeKind = input.kind.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  const keyDigest = createHash("sha256").update(input.key).digest("hex");
  const directory = join(input.root, "immutable-primaries");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${safeKind}-${keyDigest}.bin`);
  await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
  const readback = await readFile(path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (!readback.equals(bytes) || createHash("sha256").update(readback).digest("hex") !== sha256) {
    throw new Error(`persisted original evidence primary failed byte readback: ${input.kind}`);
  }
  const primary: OriginalEvidencePrimary = {
    kind: input.kind, key: input.key, path, byteLength: bytes.byteLength, sha256,
    producer: input.producer, sourceCandidateDigest: input.sourceCandidateDigest,
  };
  await writeFile(`${path}.json`, `${JSON.stringify(primary, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return primary;
}

export async function persistOriginalMapPrimary(input: {
  root: string;
  kind: string;
  key: string;
  objects: ReadonlyMap<string, string | Uint8Array>;
  producer: string;
  sourceCandidateDigest: string;
}): Promise<OriginalEvidencePrimary> {
  const value = input.objects.get(input.key);
  if (value === undefined) throw new Error(`original in-memory object is unavailable before teardown: ${input.kind}`);
  return persistOriginalEvidencePrimary({ ...input, bytes: value });
}
