// L4-E7: where the stand-in writer's sample data is kept. One versioned set per project (rows for the tables, answers for the outside services), written once per setup run, read by every eval run so both sides of a comparison
// get the same data. A sibling of the fixture store (fixture-store.ts) and built on the same pieces: its object port (`FixtureObjectPort`: the AWS adapter is fixture-store-aws.ts), its key rule (org and project first), its
// digest check and its data guard (`fixtureSetFindings`); the rows do not fit a FixtureSet (an HTTP request and answer pair), so they are a set of their own.
//
// What this module guarantees, all of it fail closed:
//   - Company and project scoped: the object key is `private/<org>/standins/<project>/<digest>`, the rows are in the company's own partition (`ORG#<org>#STANDIN`), and the org and project come from the CALLER's run, never from the set.
//     A set another company or project wrote is not found (not "refused"): the same word as nothing stored.
//   - Never trusted twice: a set is parsed strictly (`StandInWriterSetSchema`, a bytes cap) and scanned for personal data, credentials and the project's production names at write, and AGAIN at every read with the list as it
//     is now; a stored object that no longer hashes to its digest is never returned.
//   - Versioned by digest: the same set written again is the same version (nothing changes); a different one is the next version and the project's pointer moves to it by a compare-and-set, so two writers cannot both
//     claim a version. `current` always answers one whole set or none.
//   - Written once per run: a marker per setup run (its task) lets exactly one set be stored for it, so a run that loops cannot make versions.
import { createHash } from "node:crypto";
import {
  OrgIdSchema, STANDIN_LIMITS, StandInWriterSetSchema, AGENTX_NAME_PATTERN, canonicalJson, companyScoped, standInSetDigest, when, type DocumentStore, type StandInWriterSet,
} from "@agentx/contracts";
import { fixtureSetFindings, type FixtureDenyFor, type FixtureObjectPort } from "./fixture-store.js";

const DIGEST = /^[a-f0-9]{64}$/u;
const PARTITION = "STANDIN";
const TASK_ID = /^[A-Za-z0-9._:-]{1,100}$/u;

export const standInObjectKey = (orgId: string, project: string, digest: string, prefix = "private"): string => `${prefix}/${orgId}/standins/${project}/${digest}`;

export type StandInStoreRefusal = "bad_org" | "bad_project" | "bad_run" | "invalid" | "too_large" | "data_guard" | "already_stored" | "unavailable";
export type StandInReadRefusal = "bad_org" | "bad_project" | "none" | "digest_mismatch" | "data_guard" | "unavailable";

export interface StandInVersion { digest: string; version: number }
/** The project pointer: the current version, the highest number ever given (a new version is the next one: a number is never reused after a move back) and a counter that moves with every change (the compare-and-set). */
interface Pointer extends StandInVersion { maxVersion: number; seq: number }

export interface StandInDataStoreDependencies {
  objects: FixtureObjectPort;
  documents: Pick<DocumentStore, "get" | "put" | "transact">;
  /** The production deny list of the project (fail closed: a list that cannot be read is a rejection, not an empty list). */
  denyFor: FixtureDenyFor;
  now?: () => Date;
  prefix?: string;
}

export interface StandInDataStore {
  /** Stores the set the setup run of `run.taskId` wrote, for this org and project. */
  put(orgId: string, project: string, run: { taskId: string; actor: string }, raw: unknown): Promise<{ ok: true; digest: string; version: number; created: boolean } | { ok: false; reason: StandInStoreRefusal }>;
  /** The project's current set, whole, scanned now. */
  current(orgId: string, project: string): Promise<{ ok: true; set: StandInWriterSet; digest: string; version: number } | { ok: false; reason: StandInReadRefusal }>;
  /** Just the version (digest) the project is at: what E4 hashes into the eval's stand-in version. `undefined` when none or unreadable. */
  versionOf(orgId: string, project: string): Promise<StandInVersion | undefined>;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export function createStandInDataStore(deps: StandInDataStoreDependencies): StandInDataStore {
  const now = deps.now ?? (() => new Date());
  const prefix = deps.prefix ?? "private";
  const gate = (orgId: string, project: string): "bad_org" | "bad_project" | undefined => (!OrgIdSchema.safeParse(orgId).success ? "bad_org" : !AGENTX_NAME_PATTERN.test(project) ? "bad_project" : undefined);
  const pointerSk = (project: string): string => `C#${project}`;
  const versionSk = (project: string, digest: string): string => `V#${project}#${digest}`;
  const runSk = (project: string, taskId: string): string => `R#${project}#${taskId}`;

  const pointerOf = async (orgId: string, project: string): Promise<Pointer | undefined | "unreadable"> => {
    const pk = companyScoped(orgId, PARTITION);
    const found = await deps.documents.get({ pk, sk: pointerSk(project) });
    if (found === undefined) return undefined;
    const digest = found["digest"]; const version = found["version"]; const maxVersion = found["maxVersion"]; const seq = found["seq"];
    if (found.pk !== pk || found.sk !== pointerSk(project) || found["kind"] !== "standin_current" || found["company"] !== orgId || found["project"] !== project || typeof digest !== "string" || !DIGEST.test(digest) || typeof version !== "number" || !Number.isSafeInteger(version) || version < 1 || typeof maxVersion !== "number" || !Number.isSafeInteger(maxVersion) || maxVersion < version || typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) return "unreadable";
    return { digest, version, maxVersion, seq };
  };

  /** The stored set at a digest, parsed and held against it. Undefined: nothing stored; "mismatch": the object is not the set the digest names. */
  const load = async (orgId: string, project: string, digest: string): Promise<StandInWriterSet | "mismatch" | undefined> => {
    const bytes = await deps.objects.get(standInObjectKey(orgId, project, digest, prefix), STANDIN_LIMITS.setBytes + 1);
    if (bytes === undefined) return undefined;
    if (bytes.length > STANDIN_LIMITS.setBytes) return "mismatch";
    let parsed: StandInWriterSet;
    try { parsed = StandInWriterSetSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); } catch { return "mismatch"; }
    return standInSetDigest(parsed) === digest ? parsed : "mismatch";
  };
  const clean = async (orgId: string, project: string, set: StandInWriterSet): Promise<boolean> => fixtureSetFindings(set, await deps.denyFor(orgId, project)).length === 0;

  return {
    async put(orgId, project, run, raw) {
      const refused = gate(orgId, project);
      if (refused !== undefined) return { ok: false, reason: refused };
      if (typeof run?.taskId !== "string" || !TASK_ID.test(run.taskId) || typeof run.actor !== "string" || run.actor.trim() === "") return { ok: false, reason: "bad_run" };
      const parsed = StandInWriterSetSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, reason: "invalid" };
      const set = parsed.data;
      const bytes = new TextEncoder().encode(canonicalJson(set));
      if (bytes.length > STANDIN_LIMITS.setBytes) return { ok: false, reason: "too_large" };
      try {
        // The data guard, with the project's own production list: a finding stops the write and nothing is stored.
        if (!(await clean(orgId, project, set))) return { ok: false, reason: "data_guard" };
        const digest = standInSetDigest(set);
        const pk = companyScoped(orgId, PARTITION);
        const at = now().toISOString();
        // ONE set per setup run: the marker is written first, and a second set from the same run finds it.
        const marked = await deps.documents.put({ item: { pk, sk: runSk(project, run.taskId), kind: "standin_run", company: orgId, project, taskId: run.taskId, digest, at }, condition: when.absent() });
        if (!marked.applied) return { ok: false, reason: "already_stored" };
        const key = standInObjectKey(orgId, project, digest, prefix);
        if ((await deps.objects.putIfAbsent(key, bytes, "application/json")) === "exists") {
          const current = await deps.objects.get(key, STANDIN_LIMITS.setBytes + 1);
          if (current === undefined || sha256(current) !== sha256(bytes)) {
            // A bad object under a digest: made right only by a write that is conditional on it still being the bad one.
            if (current === undefined || (await deps.objects.replaceIfUnchanged(key, current, bytes, "application/json")) !== "replaced") return { ok: false, reason: "unavailable" };
          }
        }
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const pointer = await pointerOf(orgId, project);
          if (pointer === "unreadable") return { ok: false, reason: "unavailable" };
          if (pointer !== undefined && pointer.digest === digest) return { ok: true, digest, version: pointer.version, created: false };
          const known = await deps.documents.get({ pk, sk: versionSk(project, digest) });
          const knownVersion = known?.["kind"] === "standin_version" && known["digest"] === digest && known["project"] === project && known["company"] === orgId && typeof known["version"] === "number" ? known["version"] : undefined;
          const version = knownVersion ?? (pointer?.maxVersion ?? 0) + 1;
          const next = { pk, sk: pointerSk(project), kind: "standin_current", company: orgId, project, digest, version, maxVersion: Math.max(version, pointer?.maxVersion ?? 0), seq: (pointer?.seq ?? 0) + 1, at };
          const moved = knownVersion !== undefined
            ? await deps.documents.put({ item: next, condition: pointer === undefined ? when.absent() : when.eq("seq", pointer.seq) })
            : await deps.documents.transact([
              { kind: "put", item: { pk, sk: versionSk(project, digest), kind: "standin_version", company: orgId, project, digest, version, bytes: bytes.length, writtenBy: run.actor.slice(0, 120), at }, condition: when.absent() },
              { kind: "put", item: next, condition: pointer === undefined ? when.absent() : when.eq("seq", pointer.seq) },
            ]);
          if (moved.applied) return { ok: true, digest, version, created: true };
        }
        return { ok: false, reason: "unavailable" };
      } catch {
        return { ok: false, reason: "unavailable" };
      }
    },
    async current(orgId, project) {
      const refused = gate(orgId, project);
      if (refused !== undefined) return { ok: false, reason: refused };
      try {
        const pointer = await pointerOf(orgId, project);
        if (pointer === undefined) return { ok: false, reason: "none" };
        if (pointer === "unreadable") return { ok: false, reason: "digest_mismatch" };
        const set = await load(orgId, project, pointer.digest);
        if (set === undefined) return { ok: false, reason: "none" };
        if (set === "mismatch") return { ok: false, reason: "digest_mismatch" };
        // Scanned again with the list as it is now: a production name added since stops the set from being handed out.
        if (!(await clean(orgId, project, set))) return { ok: false, reason: "data_guard" };
        return { ok: true, set, digest: pointer.digest, version: pointer.version };
      } catch {
        return { ok: false, reason: "unavailable" };
      }
    },
    async versionOf(orgId, project) {
      if (gate(orgId, project) !== undefined) return undefined;
      try {
        const pointer = await pointerOf(orgId, project);
        return pointer === undefined || pointer === "unreadable" ? undefined : { digest: pointer.digest, version: pointer.version };
      } catch { return undefined; }
    },
  };
}
