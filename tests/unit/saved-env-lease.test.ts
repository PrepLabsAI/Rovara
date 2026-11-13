// Saved project images (SV wiring): the rebuild job's push login and result, and a preparation's fallback report. The login and the result answer to the job's lease AND the preparation's own grant, for the
// preparation made for that job only; nothing about the registry is told to the worker beyond one sentence.
import { beforeEach, describe, expect, it } from "vitest";
import { HostedSavedEnvRegistryAuthSchema, SavedEnvBuildResultSchema } from "../../packages/contracts/src/index.js";
import { checkRebuild, leaseForDispatch } from "../../packages/core/src/core/test-env/saved-env.js";
import { SAVED_ENV_PUSH_LOGIN_MAX_PER_OPERATION, savedEnvFallbackCore, savedEnvPushLoginCore, savedEnvResultCore, type SavedEnvLeaseContext } from "../../packages/core/src/core/test-env/saved-env-lease.js";
import { COMMIT, KEY, dig, imageOf, manifestOf, savedEnvWorld } from "../support/saved-env-world.js";

const WS = "11111111-1111-4111-8111-111111111111";
const OP = "22222222-2222-4222-8222-222222222222";

async function queued(over: Parameters<typeof savedEnvWorld>[0] = {}) {
  const w = savedEnvWorld(over);
  const checked = await checkRebuild(w.deps, w.ids, "poll");
  if (!checked.ok || !checked.queued) throw new Error(`not queued: ${JSON.stringify(checked)}`);
  const leased = await leaseForDispatch(w.deps, w.ids);
  if (!leased.ok) throw new Error("not leased");
  return { w, job: leased.job };
}

const pushLogins = { count: 0 };
beforeEach(() => { pushLogins.count = 0; });
function context(w: ReturnType<typeof savedEnvWorld>, operation: Partial<Awaited<ReturnType<SavedEnvLeaseContext["readOperation"]>>> = {}, options: { deps?: boolean } = {}): SavedEnvLeaseContext {
  return {
    deps: options.deps === false ? undefined : w.deps,
    countPushLogin: async () => { pushLogins.count += 1; return pushLogins.count <= SAVED_ENV_PUSH_LOGIN_MAX_PER_OPERATION; },
    inspectGrant: (grant) => { if (grant !== "grant-ok") throw Object.assign(new Error("bad grant"), { code: "FORBIDDEN" }); return { workspaceId: WS, operationId: OP }; },
    readOperation: async () => ({ kind: "prepare", status: "RUNNING", savedEnvJobId: undefined, savedEnvDigest: undefined, orgId: w.ids.orgId, projectName: w.ids.projectId, workspace: { status: "PREPARING", activeOperationId: OP }, ...operation }),
    log: () => undefined,
  };
}
/** A context that counts what it was asked: a refused request must not reach the grant or the stored records. */
function counting(w: ReturnType<typeof savedEnvWorld>, operation: Parameters<typeof context>[1] = {}, options: { deps?: boolean } = {}) {
  const base = context(w, operation, options);
  const asked = { grants: 0, reads: 0 };
  return { asked, context: { ...base, inspectGrant: (grant: string) => { asked.grants += 1; return base.inspectGrant(grant); }, readOperation: (a: string, b: string) => { asked.reads += 1; return base.readOperation(a, b); } } satisfies SavedEnvLeaseContext };
}
const input = (body: unknown, grant: string | null = "grant-ok") => ({ grant: grant ?? undefined, workspaceId: WS, operationId: OP, body });

describe("the push login", () => {
  it("gives a login for the job's repository to the preparation made for that job, with the job's lease", async () => {
    const { w, job } = await queued();
    const answer = await savedEnvPushLoginCore(context(w, { savedEnvJobId: job.jobId }), input({ jobId: job.jobId, leaseToken: job.leaseToken }));
    expect(answer.login).toMatchObject({ repository: w.repository, username: "rovara-local" });
    // minted by the PUSH role for the job's approved pin: the session names the repository
    expect(w.logins.some((call) => call.access === "push" && call.repository === w.repository)).toBe(true);
  });

  it("reads the login through the schema it is given: a hosted install's schema refuses the local registry's login", async () => {
    const { w, job } = await queued();
    await expect(savedEnvPushLoginCore({ ...context(w, { savedEnvJobId: job.jobId }), registryAuthSchema: HostedSavedEnvRegistryAuthSchema }, input({ jobId: job.jobId, leaseToken: job.leaseToken }))).rejects.toThrow();
  });

  it("needs the right operation and the lease: each missing piece is refused with a sentence that says nothing about the registry", async () => {
    const { w, job } = await queued();
    const lease = { jobId: job.jobId, leaseToken: job.leaseToken };
    const own = { savedEnvJobId: job.jobId };
    // a task, a finished preparation, or a preparation of another workspace state
    await expect(savedEnvPushLoginCore(context(w, { ...own, kind: "task" }), input(lease))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(savedEnvPushLoginCore(context(w, { ...own, status: "SUCCEEDED" }), input(lease))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(savedEnvPushLoginCore(context(w, { ...own, workspace: { status: "READY", activeOperationId: OP } }), input(lease))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(savedEnvPushLoginCore(context(w, { ...own, workspace: { status: "PREPARING", activeOperationId: "other" } }), input(lease))).rejects.toMatchObject({ code: "FORBIDDEN" });
    // a preparation that was not made for a job, or for another job
    await expect(savedEnvPushLoginCore(context(w, {}), input(lease))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(savedEnvPushLoginCore(context(w, { savedEnvJobId: "another" }), input(lease))).rejects.toMatchObject({ code: "FORBIDDEN" });
    // a wrong lease token, an extra field, no body
    await expect(savedEnvPushLoginCore(context(w, own), input({ jobId: job.jobId, leaseToken: "x".repeat(40) }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(savedEnvPushLoginCore(context(w, own), input({ ...lease, approved: { revision: 9, digest: "z" } }))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(savedEnvPushLoginCore(context(w, own), input({}))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(w.logins).toEqual([]);
  });

  it("is refused when the switch is off or the registry is not installed, and a lease that expired or a project that is gone gets nothing", async () => {
    const { w, job } = await queued();
    const lease = { jobId: job.jobId, leaseToken: job.leaseToken };
    const own = { savedEnvJobId: job.jobId };
    const none = counting(w, own, { deps: false });
    await expect(savedEnvPushLoginCore(none.context, input(lease))).rejects.toMatchObject({ code: "FORBIDDEN" });
    const off = counting(savedEnvWorld({ enabled: false }), own);
    await expect(savedEnvPushLoginCore(off.context, input(lease))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(savedEnvResultCore(off.context, input({ ...lease, result: { ok: false, reason: "not_proved" } }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(savedEnvFallbackCore(off.context, input({ step: "pull" }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(none.asked).toEqual({ grants: 0, reads: 0 });
    expect(off.asked).toEqual({ grants: 0, reads: 0 });
    w.clock.now += 4 * 3_600_000;
    await expect(savedEnvPushLoginCore(context(w, own), input(lease))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(w.logins).toEqual([]);
  });

  it("builds the login for the project of the WORKSPACE, never one the request names", async () => {
    const { w, job } = await queued();
    const other = { ...context(w, { savedEnvJobId: job.jobId, projectName: "proj-2" }) };
    await expect(savedEnvPushLoginCore(other, input({ jobId: job.jobId, leaseToken: job.leaseToken }))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("answers an unreachable registry as a fault to retry", async () => {
    const { w, job } = await queued({ state: "absent" });
    const broken = { ...context(w, { savedEnvJobId: job.jobId }) };
    w.registry.login = async () => { throw new Error("down"); };
    await expect(savedEnvPushLoginCore(broken, input({ jobId: job.jobId, leaseToken: job.leaseToken }))).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });
});

describe("the push login's count", () => {
  it("is given a few times at most for one operation (the worker asks once; a few more cover a retry of the request), then refused with nothing minted", async () => {
    const { w, job } = await queued();
    pushLogins.count = 0;
    const call = () => savedEnvPushLoginCore(context(w, { savedEnvJobId: job.jobId }), input({ jobId: job.jobId, leaseToken: job.leaseToken }));
    for (let index = 0; index < SAVED_ENV_PUSH_LOGIN_MAX_PER_OPERATION; index += 1) await expect(call()).resolves.toHaveProperty("login");
    const minted = w.logins.length;
    await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(w.logins.length).toBe(minted);
  });
});

describe("the result", () => {
  const good = (w: ReturnType<typeof savedEnvWorld>, over: Record<string, unknown> = {}) => SavedEnvBuildResultSchema.parse({
    ok: true, repository: w.repository, tag: "kcccc-1", imageDigest: dig(7), manifest: manifestOf({ imageDigest: dig(7), commits: [{ repositoryId: "svc", sha: COMMIT }], environmentKey: KEY }), ...over,
  });

  it("records a result that satisfies the lease, the job and the registry's rules, and answers how many digests the walk deleted", async () => {
    const { w, job } = await queued();
    const answer = await savedEnvResultCore(context(w, { savedEnvJobId: job.jobId }), input({ jobId: job.jobId, leaseToken: job.leaseToken, result: good(w) }));
    expect(answer).toEqual({ recorded: true, deleted: 0 });
    expect(w.row()?.images[0]?.digest).toBe(dig(7));
    expect(w.row()?.job).toBeUndefined();
  });

  it("answers a refusal with its fixed word and keeps nothing; a worker's failure is recorded as a failure", async () => {
    const { w, job } = await queued();
    const wrongCommit = good(w, { manifest: manifestOf({ imageDigest: dig(7), commits: [{ repositoryId: "svc", sha: "1".repeat(40) }] }) });
    const refused = await savedEnvResultCore(context(w, { savedEnvJobId: job.jobId }), input({ jobId: job.jobId, leaseToken: job.leaseToken, result: wrongCommit }));
    expect(refused).toEqual({ recorded: false, reason: "wrong_commits" });
    expect(w.row()?.images).toEqual([]);
    const second = await queued();
    const failed = await savedEnvResultCore(context(second.w, { savedEnvJobId: second.job.jobId }), input({ jobId: second.job.jobId, leaseToken: second.job.leaseToken, result: { ok: false, reason: "not_proved" } }));
    expect(failed).toEqual({ recorded: false, reason: "build_failed" });
    expect(second.w.row()?.health).toBe("needs_repair");
  });

  it("is refused for the wrong operation or job, and a wrong lease records nothing", async () => {
    const { w, job } = await queued();
    const body = { jobId: job.jobId, leaseToken: job.leaseToken, result: good(w) };
    await expect(savedEnvResultCore(context(w, {}), input(body))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await savedEnvResultCore(context(w, { savedEnvJobId: job.jobId }), input({ ...body, leaseToken: "y".repeat(40) }))).toMatchObject({ recorded: false, reason: "bad_lease" });
    expect(w.row()?.images).toEqual([]);
  });
});

describe("the fallback report", () => {
  it("marks the image the BROKER recorded with the operation stale, for a step that says something about the image", async () => {
    const w = savedEnvWorld();
    w.seed({ images: [imageOf(dig(1))], health: "healthy" });
    expect(await savedEnvFallbackCore(context(w, { savedEnvDigest: dig(1) }), input({ step: "extract" }))).toEqual({ ok: true });
    expect(w.row()?.images[0]).toMatchObject({ status: "stale", staleStep: "extract" });
  });

  it("changes nothing for a login step, names no image of its own, and needs the grant and an operation that was told to pull", async () => {
    const w = savedEnvWorld();
    w.seed({ images: [imageOf(dig(1)), imageOf(dig(2))], health: "healthy" });
    await savedEnvFallbackCore(context(w, { savedEnvDigest: dig(1) }), input({ step: "login" }));
    expect(w.row()?.images.map((image) => image.status)).toEqual(["ready", "ready"]);
    // the request cannot name a digest
    await expect(savedEnvFallbackCore(context(w, { savedEnvDigest: dig(1) }), input({ step: "pull", digest: dig(2) }))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(savedEnvFallbackCore(context(w, {}), input({ step: "pull" }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(savedEnvFallbackCore(context(w, { savedEnvDigest: dig(1) }), input({ step: "pull" }, null))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(savedEnvFallbackCore(context(w, { savedEnvDigest: dig(1), kind: "task" }), input({ step: "pull" }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(w.row()?.images.map((image) => image.status)).toEqual(["ready", "ready"]);
    // a store fault is not the worker's to hear about
    w.store.failNextCommit();
    expect(await savedEnvFallbackCore(context(w, { savedEnvDigest: dig(1) }), input({ step: "pull" }))).toEqual({ ok: true });
  });
});
