// A versioned S3 bucket, faithful for what the person erase sends (ListObjectVersions with markers, DeleteObjects by key and version id, ListObjectsV2, PutObject), for tests only.
// A plain DeleteObjects without a version id adds a delete marker (as S3 does on a versioned bucket); one with a version id removes that version for good.
import { DeleteObjectsCommand, ListObjectVersionsCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";

interface Version { versionId: string; marker: boolean }

export class VersionedBucket {
  readonly objects = new Map<string, Version[]>();
  readonly sent: Array<{ name: string; input: Record<string, unknown> }> = [];
  /** Keys whose versioned delete reports a per-key error. */
  readonly failKeys = new Set<string>();
  /** Answer the next version listing with this raw value instead. */
  rawListing: unknown;
  pageSize = 1_000;
  #next = 1;

  /** Writes `count` versions of `key` (the newest current), optionally followed by a delete marker. */
  write(key: string, count = 1, deleted = false): void {
    const versions = this.objects.get(key) ?? [];
    for (let i = 0; i < count; i += 1) versions.push({ versionId: `v${String(this.#next++)}`, marker: false });
    if (deleted) versions.push({ versionId: `m${String(this.#next++)}`, marker: true });
    this.objects.set(key, versions);
  }

  versionsUnder(prefix: string): number {
    return [...this.objects].filter(([key]) => key.startsWith(prefix)).reduce((sum, [, versions]) => sum + versions.length, 0);
  }

  readonly client = {
    send: async (command: unknown): Promise<unknown> => {
      const name = (command as { constructor: { name: string } }).constructor.name;
      const input = (command as { input: Record<string, unknown> }).input;
      this.sent.push({ name, input });
      if (command instanceof ListObjectVersionsCommand) {
        if (this.rawListing !== undefined) { const raw = this.rawListing; this.rawListing = undefined; return raw; }
        const prefix = typeof input["Prefix"] === "string" ? input["Prefix"] : "";
        const all = [...this.objects].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1)).flatMap(([key, versions]) => versions.map((version) => ({ key, ...version })));
        let start = 0;
        if (typeof input["KeyMarker"] === "string") start = all.findIndex((entry) => entry.key === input["KeyMarker"] && entry.versionId === input["VersionIdMarker"]) + 1;
        const page = all.slice(start, start + this.pageSize);
        const truncated = start + this.pageSize < all.length;
        const last = page[page.length - 1];
        return {
          Versions: page.filter((entry) => !entry.marker).map((entry) => ({ Key: entry.key, VersionId: entry.versionId })),
          DeleteMarkers: page.filter((entry) => entry.marker).map((entry) => ({ Key: entry.key, VersionId: entry.versionId })),
          IsTruncated: truncated,
          ...(truncated && last !== undefined ? { NextKeyMarker: last.key, NextVersionIdMarker: last.versionId } : {}),
        };
      }
      if (command instanceof DeleteObjectsCommand) {
        const objects = ((input["Delete"] as { Objects: Array<{ Key: string; VersionId?: string }> }).Objects);
        const errors: unknown[] = [];
        for (const { Key, VersionId } of objects) {
          if (this.failKeys.has(Key)) { errors.push({ Key, Code: "AccessDenied" }); continue; }
          if (VersionId === undefined) { this.write(Key, 0, true); continue; }
          const left = (this.objects.get(Key) ?? []).filter((version) => version.versionId !== VersionId);
          if (left.length === 0) this.objects.delete(Key); else this.objects.set(Key, left);
        }
        return errors.length === 0 ? {} : { Errors: errors };
      }
      if (command instanceof ListObjectsV2Command) {
        const prefix = typeof input["Prefix"] === "string" ? input["Prefix"] : "";
        return { Contents: [...this.objects].filter(([key, versions]) => key.startsWith(prefix) && versions[versions.length - 1]?.marker === false).map(([key]) => ({ Key: key })) };
      }
      if (command instanceof PutObjectCommand) { this.write(String(input["Key"])); return { ETag: "\"e\"" }; }
      throw new Error(`the fake bucket does not answer ${name}`);
    },
  };
}
