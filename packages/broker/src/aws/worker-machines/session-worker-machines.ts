// Engine host (migration plan v3.2 lane E2, step 4): the EC2 workspace sessions of Code's AWS deployment on the core's `WorkerMachines` port. Ported from the monolith's adapter.
//
// A machine is one ec2-ebs workspace's compute, exactly as the deployed broker runs it today: `start` is `SessionManager.ensureSession` (which starts the session provisioner state machine: the
// launch template, the boot user data from session-steps, the workspace volume), `stop` ends the instance and keeps the volume (what the idle reaper does; on the broker it asks the reaper
// to, with `SessionManager.requestStop`), `terminate` is `SessionManager.deleteSession` (the deleter: instance AND volume; only a Close, a setup check and the saved-environment sweep reach it),
// `health` reads the SESSION item and the worker's /ping, and `deliver` signs the same invoke token the dispatcher signs today
// (ec2-delivery.ts) and posts it to the same worker port. The adapter never calls RunInstances itself and never writes user data, an instance profile, a network or a metadata setting: everything
// a worker can do is still fixed by the provisioner and the launch template (no new worker power).
//
// One Code install serves every company. The registry holds one `SessionWorkerFleet`, which answers nothing itself: the core's runtime for a company binds it with `forCompany` (core-host/core-runtime.ts),
// and the bound `SessionWorkerMachines` reads which company the workspace belongs to on every call and treats a machine of any other company as one that does not exist: it is never started,
// stopped, ended, asked about or handed a job through that company's adapter.
import {
  ANSWERED_INVOCATION_KINDS,
  MachineError,
  OrgIdSchema,
  WORKER_INVOKE_AUTHORIZATION_SCHEME,
  WORKER_PING_FEATURES_FIELD,
  workerInvokeToken,
  workerInvokeTokenPayload,
  type DeliveryReceipt,
  type Ec2RuntimeBinding,
  type MachineCapabilities,
  type MachineHandle,
  type MachineHealth,
  type MachineSpec,
  type MachineState,
  type OrgId,
  type WorkerInvocation,
  type WorkerMachines,
  type WorkspaceSession,
} from "@agentx/contracts";
import type { SessionManager } from "../sessions.js";

/** The worker's port (packages/worker/ec2/boot.sh); /invocations accepts only tokens signed by the dispatcher's KMS key (#80). */
export const SESSION_WORKER_PORT = 8080;
/** A token outlives one delivery attempt and nothing more: the dispatcher's lifetime (ec2-delivery.ts). */
export const SESSION_INVOKE_TOKEN_SECONDS = 60;
/** What the worker reads at most (packages/worker/src/server.ts). A larger job is refused here, before anything is signed. */
export const SESSION_MAX_INVOCATION_BYTES = 1_048_576;
/** The worker's answer is read at most this far (a peek's patch is bounded to 128 KiB by its own schema). */
const ANSWER_MAX_CHARS = 1_048_576;
const MACHINE_ID_PREFIX = "ec2ws.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The /ping answer, as far as the adapter reads it. */
export interface SessionWorkerPing {
  status?: string;
  activeOperations?: number;
  features?: readonly string[];
}

export interface SessionWorkerMachinesDependencies {
  /** The one company this adapter serves. */
  companyId: OrgId;
  /** Broker restriction: the broker cannot end an instance, so stop asks the session's reaper to (the volume is kept); live health and dispatch refuse. Absent preserves dispatcher behavior. */
  brokerOnly?: boolean;
  sessions: Pick<SessionManager, "get" | "ensureSession" | "deleteSession" | "claimStop" | "requestStop" | "markStopped">;
  /** The company a workspace belongs to (its record's company), or undefined when there is no such workspace. Read on every call, never cached. */
  companyOfWorkspace: (workspaceId: string) => Promise<OrgId | undefined>;
  /** Where the workspace's worker runs (the install's own subnets and launch template on Code's deployment; never a binding a company writes). Asked only for a workspace of this adapter's company. */
  binding: (workspaceId: string) => Promise<Ec2RuntimeBinding | undefined>;
  /**
   * The workspace a machine key names. The core keys a machine by its workspace id, so the default takes a lower-case UUID as itself and
   * refuses anything else. Tests that run Code's conformance suite (whose keys are short words) map them.
   */
  workspaceOfKey?: (machineKey: string) => string | undefined;
  /** Ends the session's instance (the reaper's TerminateInstances; the workspace volume is kept). Resolves `gone: true` once the instance no longer runs. */
  stopInstance: (instanceId: string) => Promise<{ gone: boolean }>;
  /** KMS Sign, ECDSA_SHA_256 over the message bytes; returns the DER signature. Only the dispatcher's role may call it. */
  sign: (message: Uint8Array) => Promise<Uint8Array>;
  /** POST to the worker. Rejects when the worker cannot be reached. */
  post: (url: string, init: { authorization: string; body: string }) => Promise<{ status: number; body: string }>;
  /** GET on the worker's /ping. Rejects or resolves undefined when the worker does not answer. */
  ping: (url: string) => Promise<SessionWorkerPing | undefined>;
  /** Epoch milliseconds. */
  now?: () => number;
}

export const BROKER_DISPATCH_ONLY_WORDS = "only the dispatcher starts workers and signs or posts worker jobs";
export const BROKER_LIVE_HEALTH_WORDS = "live worker health is unavailable on the broker";

const defaultWorkspaceOfKey = (machineKey: string): string | undefined => (UUID.test(machineKey) ? machineKey : undefined);

export function sessionMachineId(workspaceId: string): string {
  return `${MACHINE_ID_PREFIX}${workspaceId}`;
}

function workspaceOfMachineId(machineId: string): string | undefined {
  if (!machineId.startsWith(MACHINE_ID_PREFIX)) return undefined;
  const workspaceId = machineId.slice(MACHINE_ID_PREFIX.length);
  return UUID.test(workspaceId) ? workspaceId : undefined;
}

/** The port's state for a session state. READY is refined by the worker's /ping in `health`. */
function machineState(state: WorkspaceSession["state"] | "NONE"): MachineState {
  switch (state) {
    case "PROVISIONING":
      return "starting";
    case "READY":
      return "ready";
    case "STOPPING":
    case "DELETING":
      return "stopping";
    case "STOPPED":
      return "stopped";
    case "FAILED":
      return "unhealthy";
    case "NONE":
    case "DELETED":
      return "terminated";
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : undefined;
}

/** A session-manager refusal in the port's words. Fixed sentences: nothing from the error itself (it may name a resource) reaches the caller. */
function asMachineError(error: unknown): MachineError {
  if (error instanceof MachineError) return error;
  switch (errorCode(error)) {
    case "WORKSPACE_NOT_READY":
      return new MachineError("not_found", "the workspace's compute has been deleted");
    case "WORKSPACE_BUSY":
      return new MachineError("unavailable", "the workspace's compute is starting or stopping; try again");
    case "CONFIG_INVALID":
      return new MachineError("rejected", "the workspace's runtime binding cannot place its compute");
    default:
      return new MachineError("unavailable", "the workspace's compute could not be reached; try again");
  }
}

function readAnswer(text: string): Record<string, unknown> {
  if (text.length > ANSWER_MAX_CHARS) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** The EC2 workspace sessions on the `WorkerMachines` port, for one company. */
export class SessionWorkerMachines implements WorkerMachines {
  readonly capabilities: MachineCapabilities = { isolation: "vm", persistentVolume: true, canStop: true, maxConcurrentMachines: null };
  readonly #deps: SessionWorkerMachinesDependencies;

  constructor(dependencies: SessionWorkerMachinesDependencies) {
    // Checked at run time, not only by the type: an adapter bound to no company (or to a malformed one) would compare every workspace against nothing.
    if (!OrgIdSchema.safeParse(dependencies.companyId).success) throw new MachineError("rejected", "the company id is not valid");
    this.#deps = dependencies;
  }

  get companyId(): OrgId {
    return this.#deps.companyId;
  }

  async start(spec: MachineSpec): Promise<MachineHandle> {
    if (this.#deps.brokerOnly === true) throw new MachineError("rejected", BROKER_DISPATCH_ONLY_WORDS);
    if (spec.companyId !== this.#deps.companyId) throw new MachineError("rejected", "this machine adapter serves another company");
    // What a worker runs and with what is the launch template's and the boot script's alone: a spec cannot choose an image, sizes or environment.
    if (spec.image !== undefined || spec.resources !== undefined || Object.keys(spec.environment ?? {}).length > 0) {
      throw new MachineError("rejected", "this adapter starts workers only as the install's launch template says");
    }
    const workspaceId = (this.#deps.workspaceOfKey ?? defaultWorkspaceOfKey)(spec.machineKey);
    if (workspaceId === undefined || !UUID.test(workspaceId)) throw new MachineError("rejected", "the machine key does not name a workspace");
    // Fail closed: a workspace of another company, or none, is never started here (the same answer for both).
    if ((await this.#ownedWorkspace(workspaceId)) === undefined) throw new MachineError("rejected", "no such workspace for this company");
    const binding = await this.#deps.binding(workspaceId);
    // No placement is the install's configuration fault, not the job's: the record comes back (a refusal would end the task for good).
    if (binding === undefined) throw new MachineError("unavailable", "the install has no worker placement for this workspace; try again");
    let result: Awaited<ReturnType<SessionManager["ensureSession"]>>;
    try {
      // No waiting outbox record: the core retries its own message until the machine answers `ready`.
      result = await this.#deps.sessions.ensureSession({ workspaceId, binding });
    } catch (error) {
      throw asMachineError(error);
    }
    return { machineId: sessionMachineId(workspaceId), machineKey: spec.machineKey, state: result.ready ? "ready" : machineState(result.state) };
  }

  async stop(machineId: string): Promise<void> {
    const owned = await this.#ownedSession(machineId);
    if (owned === undefined) return;
    if (owned.session.state === "PROVISIONING") throw new MachineError("unavailable", "the machine is starting; stop it once it is ready");
    if (this.#deps.brokerOnly !== true) return this.#stopSession(owned);
    // The broker has no EC2 terminate: it marks the session STOPPING (only while the workspace still runs the operation being cancelled) and the reaper ends the instance, keeping the volume.
    // Never `terminate`: that deletes the volume, and only a Close may.
    try {
      await this.#deps.sessions.requestStop(owned.workspaceId);
    } catch (error) {
      throw asMachineError(error);
    }
  }

  async terminate(machineId: string): Promise<void> {
    const owned = await this.#ownedSession(machineId);
    if (owned === undefined) return;
    try {
      await this.#deps.sessions.deleteSession(owned.workspaceId);
    } catch (error) {
      throw asMachineError(error);
    }
  }

  async health(machineId: string): Promise<MachineHealth> {
    const checkedAt = new Date(this.#now()).toISOString();
    const idle = (state: MachineState, detail?: string): MachineHealth => ({ state, activeOperations: 0, features: [], checkedAt, ...(detail === undefined ? {} : { detail }) });
    const owned = await this.#ownedSession(machineId);
    if (owned === undefined) return idle("terminated");
    const { session } = owned;
    if (session.state !== "READY") return idle(machineState(session.state), session.state === "FAILED" ? "the worker did not start" : undefined);
    // READY is a stored provisioning result, not evidence of current liveness. The watchdog waits on this refusal.
    if (this.#deps.brokerOnly === true) throw new MachineError("unavailable", BROKER_LIVE_HEALTH_WORDS);
    if (session.privateIp === undefined) return idle("unhealthy", "the worker has no address");
    let ping: SessionWorkerPing | undefined;
    try {
      ping = await this.#deps.ping(`http://${session.privateIp}:${SESSION_WORKER_PORT}/ping`);
    } catch {
      ping = undefined;
    }
    if (ping === undefined || (ping.status !== "Healthy" && ping.status !== "HealthyBusy")) return idle("unhealthy", ping?.status === "BootFailed" ? "the worker's boot failed" : "the worker does not answer");
    const reported = ping.activeOperations;
    const active = typeof reported === "number" && Number.isSafeInteger(reported) && reported >= 0 ? reported : ping.status === "HealthyBusy" ? 1 : 0;
    // What the worker lists now; the list recorded when the session became READY when the ping had none. Unknown is none (fail closed).
    const features = [...(ping.features ?? session.workerFeatures ?? [])];
    return { state: active > 0 ? "busy" : "ready", activeOperations: active, features, checkedAt };
  }

  async deliver(machineId: string, invocation: WorkerInvocation): Promise<DeliveryReceipt> {
    if (this.#deps.brokerOnly === true) throw new MachineError("rejected", BROKER_DISPATCH_ONLY_WORDS);
    const owned = await this.#ownedSession(machineId);
    if (owned === undefined || owned.session.state === "DELETING" || owned.session.state === "DELETED") throw new MachineError("not_found", "no such machine");
    const { workspaceId, session } = owned;
    if (session.state !== "READY" || session.privateIp === undefined) throw new MachineError("not_ready", `the machine is ${machineState(session.state)}`);
    if (invocation.workspaceId !== workspaceId) throw new MachineError("rejected", "the job is for another workspace than this machine's");
    // Project setup runs on its own sessions, under its own stored authority (ec2-delivery.ts): never through a workspace's machine.
    if (invocation.kind === "project-setup-smoke") throw new MachineError("rejected", "project setup is not run through a workspace's machine");
    const body = JSON.stringify(invocation);
    if (Buffer.byteLength(body, "utf8") > SESSION_MAX_INVOCATION_BYTES) throw new MachineError("rejected", "the job is too large for a worker");

    // The claims ec2-delivery.ts signs for a workspace invocation: this workspace, this session generation, this operation at its fence, for one minute.
    const payload = workerInvokeTokenPayload({
      workspaceId,
      generation: session.generation,
      operationId: invocation.operationId,
      fence: invocation.fence,
      expiresAt: Math.floor(this.#now() / 1_000) + SESSION_INVOKE_TOKEN_SECONDS,
      purpose: "WORKSPACE",
      ...(invocation.kind === "publish" && invocation.payload.publicationMode !== undefined
        ? { publicationMode: invocation.payload.publicationMode, publicationContextDigest: invocation.payload.publicationContextDigest }
        : {}),
    });
    const signature = await this.#deps.sign(Buffer.from(payload, "ascii"));
    let response: { status: number; body: string };
    try {
      response = await this.#deps.post(`http://${session.privateIp}:${SESSION_WORKER_PORT}/invocations`, {
        authorization: `${WORKER_INVOKE_AUTHORIZATION_SCHEME} ${workerInvokeToken(payload, signature)}`,
        body,
      });
    } catch {
      throw new MachineError("unavailable", "the worker could not be reached");
    }
    if (response.status === 401) throw new MachineError("unauthorized", "the worker refused the job's credentials");
    if (response.status === 400 || response.status === 409 || response.status === 413) throw new MachineError("rejected", `the worker refused the job (HTTP ${response.status})`);
    if (response.status < 200 || response.status >= 300) throw new MachineError("unavailable", `the worker answered HTTP ${response.status}`);
    const answer = readAnswer(response.body);
    const answered = (ANSWERED_INVOCATION_KINDS as readonly string[]).includes(invocation.kind);
    return { duplicate: answer.duplicate === true, ...(answered ? { answer } : {}) };
  }

  // ---- internals ----

  /** The dispatcher's stop: claim a READY session (the reaper's claim), end its instance and, once it is gone, mark it STOPPED. The volume is kept. */
  async #stopSession(owned: { workspaceId: string; session: WorkspaceSession }): Promise<void> {
    let session = owned.session;
    if (session.state === "READY") {
      // The reaper's claim: only while nothing touched the session since it was read and the workspace runs no operation, so a dispatch always wins.
      if (!(await this.#deps.sessions.claimStop(session))) {
        const again = await this.#deps.sessions.get(owned.workspaceId);
        if (again?.state === "READY") throw new MachineError("unavailable", "the machine is in use; try again");
        if (again === undefined || again.state !== "STOPPING") return;
        session = again;
      } else {
        session = { ...session, state: "STOPPING" };
      }
    }
    if (session.state !== "STOPPING") return;
    // A STOPPING session is finished here when its instance is gone, else by the reaper's next tick (the instance is ended either way).
    const gone = session.instanceId === undefined ? true : (await this.#deps.stopInstance(session.instanceId)).gone;
    if (gone) await this.#deps.sessions.markStopped(owned.workspaceId, session.generation);
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  /** The workspace id when the workspace is this company's; undefined for another company's or a missing one (the two are not told apart). */
  async #ownedWorkspace(workspaceId: string): Promise<string | undefined> {
    const company = await this.#deps.companyOfWorkspace(workspaceId);
    return company !== undefined && company === this.#deps.companyId ? workspaceId : undefined;
  }

  /** The session behind a machine id, only for this company's workspaces. A session that never started (NONE) or was deleted reads as none. */
  async #ownedSession(machineId: string): Promise<{ workspaceId: string; session: WorkspaceSession } | undefined> {
    if (this.#deps.brokerOnly === true && typeof machineId !== "string") return undefined;
    const workspaceId = workspaceOfMachineId(machineId);
    if (workspaceId === undefined || (await this.#ownedWorkspace(workspaceId)) === undefined) return undefined;
    const session = await this.#deps.sessions.get(workspaceId);
    if (session === undefined || session.state === "NONE" || session.state === "DELETED") return undefined;
    return { workspaceId, session };
  }
}

/** Reads a worker's /ping body into what the adapter needs. Any HTTP status: a failed boot answers 503 with `BootFailed`. */
export function sessionWorkerPing(body: unknown): SessionWorkerPing {
  if (typeof body !== "object" || body === null) return {};
  const value = body as Record<string, unknown>;
  const listed = value[WORKER_PING_FEATURES_FIELD];
  return {
    ...(typeof value.status === "string" ? { status: value.status } : {}),
    ...(typeof value.activeOperations === "number" ? { activeOperations: value.activeOperations } : {}),
    ...(Array.isArray(listed) ? { features: listed.filter((feature): feature is string => typeof feature === "string") } : {}),
  };
}

/** What the fleet needs: everything a company's adapter needs except the company. */
export type SessionWorkerFleetDependencies = Omit<SessionWorkerMachinesDependencies, "companyId">;

/** The words of a call made on the fleet itself, not on a company's adapter. Fixed. */
export const FLEET_UNBOUND_WORDS = "the EC2 workers answer only through one company's adapter";

/**
 * The registry's `worker-machines` adapter on Code's AWS deployment: one per install, serving every company, but only through `forCompany(companyId)`. Each of its own calls refuses
 * (`rejected`), so a holder that forgot to bind it can do nothing with a machine. A company's adapter is made once and kept.
 */
export class SessionWorkerFleet implements WorkerMachines {
  readonly capabilities: MachineCapabilities = { isolation: "vm", persistentVolume: true, canStop: true, maxConcurrentMachines: null };
  readonly #deps: SessionWorkerFleetDependencies;
  readonly #companies = new Map<string, SessionWorkerMachines>();

  constructor(dependencies: SessionWorkerFleetDependencies) {
    this.#deps = dependencies;
  }

  /** The adapter of one company. A value that is not a company id is refused (never bound to a guess). */
  forCompany(companyId: string): SessionWorkerMachines {
    if (!OrgIdSchema.safeParse(companyId).success) throw new MachineError("rejected", "the company id is not valid");
    let found = this.#companies.get(companyId);
    if (found === undefined) {
      found = new SessionWorkerMachines({ ...this.#deps, companyId });
      this.#companies.set(companyId, found);
    }
    return found;
  }

  async start(): Promise<MachineHandle> {
    throw new MachineError("rejected", FLEET_UNBOUND_WORDS);
  }

  async stop(): Promise<void> {
    throw new MachineError("rejected", FLEET_UNBOUND_WORDS);
  }

  async terminate(): Promise<void> {
    throw new MachineError("rejected", FLEET_UNBOUND_WORDS);
  }

  async health(): Promise<MachineHealth> {
    throw new MachineError("rejected", FLEET_UNBOUND_WORDS);
  }

  async deliver(): Promise<DeliveryReceipt> {
    throw new MachineError("rejected", FLEET_UNBOUND_WORDS);
  }
}
