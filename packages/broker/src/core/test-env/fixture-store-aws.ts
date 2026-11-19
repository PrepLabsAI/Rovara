// The fixture store's object port over the install's object storage (S3 in a hosted install, a folder on a laptop): `FixtureObjectPort` of fixture-store.ts, built from the `object-storage` port that the AWS adapter
// (`@agentx/aws-adapters/s3`) implements. It adds no rule of its own: the keys, the org and project scoping, the digest checks and the data guard are the store's (fixture-store.ts, standin-data-store.ts); this only says how
// "write once", "replace only if unchanged" and "read at most N bytes" are done on that port.
//   - putIfAbsent: a put that does not overwrite; the port's own conflict error is "exists" (S3's `If-None-Match: *`, one winner among racing writers).
//   - replaceIfUnchanged: the port has no conditional replace, so the object is read again and compared byte for byte, then overwritten. The window between the two is real but harmless HERE: keys are the digest of the
//     bytes that belong in them, so every writer of a key writes the same correct bytes, and a lost race rewrites those same bytes.
//   - presignGet: a signed read link needs the adapter's signer (the deployment passes it in); without one the port refuses, so a store that never hands out links (the stand-in data store) is not given the means to.
//   - Errors never carry the storage's own words (they can name a bucket or a key): anything but the port's refusals is the fixed `FixtureObjectError`.
import { ObjectConflictError, type ObjectStorage } from "@agentx/contracts";
import type { FixtureObjectPort } from "./fixture-store.js";

export class FixtureObjectError extends Error {
  constructor(message = "the fixture object store could not do that") {
    super(message);
    this.name = "FixtureObjectError";
  }
}

/** A fixture is kept until it is deleted: its retention class names no lifetime, and the adapter keeps an object of a class its settings do not map (the port's rule). */
const meta = (contentType: string) => ({ contentType, metadata: {}, retention: "fixture" });
const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((value, index) => value === b[index]);

export function fixtureObjectPortOf(storage: ObjectStorage, options: { presign?: ((key: string, expiresInSeconds: number) => Promise<string>) | undefined } = {}): FixtureObjectPort {
  return {
    async putIfAbsent(key, bytes, contentType) {
      try {
        await storage.put(key, bytes, meta(contentType));
        return "created";
      } catch (error) {
        if (error instanceof ObjectConflictError) return "exists";
        throw new FixtureObjectError();
      }
    },
    async replaceIfUnchanged(key, observed, bytes, contentType) {
      try {
        const current = await storage.get(key, Math.max(observed.length, bytes.length) + 1);
        if (current === undefined || !same(current, observed)) return "changed";
        await storage.put(key, bytes, meta(contentType), { overwrite: true });
        return "replaced";
      } catch {
        throw new FixtureObjectError();
      }
    },
    async get(key, maxBytes) {
      try {
        return await storage.get(key, maxBytes);
      } catch {
        throw new FixtureObjectError();
      }
    },
    async presignGet(key, expiresInSeconds) {
      if (options.presign === undefined) throw new FixtureObjectError("this fixture store hands out no signed reads");
      try {
        return await options.presign(key, expiresInSeconds);
      } catch {
        throw new FixtureObjectError();
      }
    },
  };
}
