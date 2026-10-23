// agentx doctor's browser and API runtime checks (evaluation fix RUN-3): the qualified runtime lives seven days and only an operator renewing it keeps browser and API checks
// running, so doctor warns ahead of time, naming when it expires and the exact command that renews it. Only the control plane knows the registrations, so they are read through this
// computer's admin sign-in; without one the check is skipped, with how to sign in.
import { CLI_PACKAGE_NAME, E2ERuntimeStatusSchema, e2eRuntimeExpiryNotice, e2eRuntimeRenewCommand, E2E_RUNTIME_GENERIC_RENEW_COMMAND, type E2ERuntimeStatus } from "@agentx/contracts";
import { check, type DoctorCheck, type DoctorContext } from "./checks.js";

export type RuntimeStatusRead = { kind: "status"; status: E2ERuntimeStatus; awsProfile?: string | undefined } | { kind: "signed-out" } | { kind: "not-set-up" };

/** GET /v1/admin/runtime-installation/status with an admin sign-in; any other failure throws, and the group says it could not run. */
export async function readRuntimeStatus(fetchImplementation: typeof fetch, session: { controlPlaneUrl: string; accessToken: string } | undefined, awsProfile?: string): Promise<RuntimeStatusRead> {
  if (session === undefined) return { kind: "signed-out" };
  const response = await fetchImplementation(`${session.controlPlaneUrl.replace(/\/$/, "")}/v1/admin/runtime-installation/status`, {
    headers: { authorization: `Bearer ${session.accessToken}` }, signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 404) return { kind: "not-set-up" };
  if (response.status === 401 || response.status === 403) return { kind: "signed-out" };
  if (!response.ok) throw new Error(`the control plane answered HTTP ${response.status}`);
  const parsed = E2ERuntimeStatusSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw new Error("the control plane answered with something unexpected");
  return { kind: "status", status: parsed.data, awsProfile };
}

export async function runtimeChecks(context: DoctorContext): Promise<DoctorCheck[]> {
  const read = context.services.runtime;
  const name = "browser and API runtime";
  if (read === undefined) return [check("runtime", name, "skip", "not checked by this agentx")];
  const result = await read();
  const cli = `npx ${CLI_PACKAGE_NAME} --env ${context.env}`;
  if (result.kind === "signed-out") return [check("runtime", name, "skip", `not checked: this computer has no working admin sign-in for ${context.env}`, `run ${cli} login --admin, then run agentx doctor again`)];
  if (result.kind === "not-set-up") return [check("runtime", name, "skip", "not set up in this deployment")];
  if (result.status.rows.length === 0) return [check("runtime", name, "skip", "no browser and API runtime has been qualified here, so browser and API checks are off")];
  const renew = result.awsProfile === undefined || result.awsProfile === "" ? E2E_RUNTIME_GENERIC_RENEW_COMMAND.replace("<env>", context.env)
    : e2eRuntimeRenewCommand({ env: context.env, profile: result.awsProfile });
  const now = context.services.now();
  return [...result.status.rows].sort((a, b) => a.kind.localeCompare(b.kind)).map((row) => {
    const label = `${row.kind} runtime`;
    // Every notice is a warning here: browser and API checks are optional, and doctor does not decide whether this installation needs them.
    if (row.state !== "READY") {
      return check("runtime", label, "warn", `the ${row.kind} runtime is ${row.state}, so browser and API checks cannot run`, `qualify the runtime again with: ${renew}`);
    }
    const notice = e2eRuntimeExpiryNotice({ subject: `the ${row.kind} runtime`, expiresAt: row.expiresAt, now, renewCommand: renew });
    if (notice !== undefined) return check("runtime", label, "warn", notice.problem, `renew it with: ${notice.renewCommand}`);
    return check("runtime", label, "ok", `qualified, good until ${row.expiresAt}`);
  });
}
