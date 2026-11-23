// The exchange the worker calls at `prepare` (POST .../operations/<id>/registry-credentials). The worker names a registry; the broker decides everything else:
//   - the install can serve registries at all, and the request carries the operation's repository grant (signed, bound to this workspace, operation and project, short-lived);
//   - the operation is this company's workspace's ACTIVE PREPARE at the workspace's own fence: no other kind of operation (a task, a publication) ever receives a registry credential, and neither does
//     a preparation that is over. The COMPANY is the one of the stored operation record (the flow's own company: another company's workspace is "no such operation"), never the request's;
//   - the registry is one the broker itself offered this preparation: a CodeArtifact entry of the project revision the workspace is pinned to, or an entry the project's COMPANY set (named by
//     `companyRegistryNames`), never a name or a host the request supplies;
//   - the edition rule and the company's binding of a CodeArtifact domain are checked again here (they may have changed since the invocation was built);
//   - a preparation asks at most REGISTRY_REQUESTS_MAX_PER_OPERATION times (a counter on the operation, added to with a condition): the worker asks once per registry;
//   - every use is AUDITED before the credential is handed on (who: the run's requester, when, which registry host and scope, which project and operation; never the value, the secret's name or its address).
//     A use that cannot be recorded is refused. The log line names the registry and the kind only.
import { randomUUID } from "node:crypto";
import { REGISTRY_PROBLEM_MESSAGES, RegistryCredentialRequestSchema, REGISTRIES_MAX, agentXError, companyRegistryNames, registryHostOf, registryProblems, type AuditEvent, type ProjectRegistry, type RegistryCredential } from "@agentx/contracts";
import { REGISTRY_UNAVAILABLE_MESSAGE, companyRegistryCredential, mintCodeArtifactCredential } from "./mint.js";
import { REGISTRIES_NOT_AVAILABLE, type ProjectRegistriesInstall } from "./prepare.js";

/** The worker asks once for each registry; a few more cover a retry of the request itself. */
export const REGISTRY_REQUESTS_MAX_PER_OPERATION = REGISTRIES_MAX * 2;
const LIVE_STATUSES = new Set(["ACCEPTED", "DISPATCHING", "RUNNING"]);

export interface RegistryExchangeContext {
  /** The company whose flow this is: the only company whose projects and secrets are reached. */
  companyId: string;
  install: ProjectRegistriesInstall | undefined;
  /** Verifies the grant's signature and expiry and returns what it is bound to. Throws FORBIDDEN. */
  inspectGrant(grant: string): { workspaceId: string; operationId: string; projectName?: string };
  /** The operation and its workspace, as stored (undefined fields: not there). Throws NOT_FOUND for a workspace or operation of another company. */
  readOperation(workspaceId: string, operationId: string): Promise<{ kind: string; status: string; readOnly: boolean; fence: number | undefined; projectName: string; projectRevision: number | undefined; requesterId?: string | undefined; workspace: { status: string; activeOperationId: string | null | undefined; fence: number | undefined } }>;
  /** The CodeArtifact registries and approved websites of that project revision (this company's). */
  readProject(project: string, revision: number): Promise<{ registries: readonly ProjectRegistry[]; allowedDomains: readonly string[] } | undefined>;
  /** Counts one request against the operation, atomically: false once it has had REGISTRY_REQUESTS_MAX_PER_OPERATION. */
  countRequest(workspaceId: string, operationId: string): Promise<boolean>;
  /** The company's audit ledger: a use is recorded before the credential leaves (fail closed). */
  audit: { record(event: AuditEvent): Promise<void> };
  newId?: () => string;
  now?: () => Date;
  log?: ((event: Record<string, unknown>) => void) | undefined;
}

const notCovered = (): never => { throw agentXError("FORBIDDEN", "registry credential grant does not cover this request"); };

export async function exchangeRegistryCredentialCore(context: RegistryExchangeContext, input: { grant: string | undefined; workspaceId: string; operationId: string; body: unknown }): Promise<{ credential: RegistryCredential }> {
  const install = context.install;
  if (install === undefined) throw agentXError("FORBIDDEN", REGISTRIES_NOT_AVAILABLE);
  if (!input.grant) throw agentXError("FORBIDDEN", "repository grant is required");
  const request = RegistryCredentialRequestSchema.safeParse(input.body);
  if (!request.success) throw agentXError("CONFIG_INVALID", "registry credential request is invalid");
  const claims = context.inspectGrant(input.grant);
  if (claims.workspaceId !== input.workspaceId || claims.operationId !== input.operationId) return notCovered();
  const operation = await context.readOperation(input.workspaceId, input.operationId);
  if (operation.kind !== "prepare" || operation.readOnly || !LIVE_STATUSES.has(operation.status) || operation.workspace.status !== "PREPARING" || operation.workspace.activeOperationId !== input.operationId
    || operation.fence === undefined || operation.fence !== operation.workspace.fence) {
    throw agentXError("FORBIDDEN", "registry credentials are given to a running preparation only");
  }
  // The grant was issued for this workspace's project; a grant that names another project covers nothing here.
  if (claims.projectName !== undefined && claims.projectName !== operation.projectName) return notCovered();
  if (operation.projectRevision === undefined) return notCovered();
  const project = await context.readProject(operation.projectName, operation.projectRevision);
  if (project === undefined) return notCovered();
  const own = project.registries.find((candidate) => candidate.name === request.data.registry);
  let offered: { registry: string; kind: string; host: string; scope: string | undefined; mint: () => Promise<RegistryCredential> } | undefined;
  if (own !== undefined) {
    const problem = registryProblems({ edition: install.edition, registries: [own], allowedDomains: project.allowedDomains, orgId: context.companyId, boundDomains: install.boundDomains ?? [] })[0];
    if (problem !== undefined) throw agentXError("FORBIDDEN", REGISTRY_PROBLEM_MESSAGES[problem.code]);
    offered = { registry: own.name, kind: own.kind, host: registryHostOf(own), scope: own.scope, mint: () => mintCodeArtifactCredential(own, install.codeArtifact, context.now) };
  } else if (install.company !== undefined) {
    let entries: Awaited<ReturnType<NonNullable<typeof install.company>["entries"]>>;
    try { entries = await install.company.entries(context.companyId); } catch { throw agentXError("RUNTIME_UNAVAILABLE", REGISTRY_UNAVAILABLE_MESSAGE(request.data.registry)); }
    const item = companyRegistryNames(entries).find((candidate) => candidate.name === request.data.registry);
    const company = install.company;
    if (item !== undefined) offered = { registry: item.name, kind: "npm", host: item.host, scope: item.scope, mint: () => companyRegistryCredential(company, context.companyId, item.host, item.name) };
  }
  if (offered === undefined) return notCovered();
  if (!(await context.countRequest(input.workspaceId, input.operationId))) throw agentXError("FORBIDDEN", "registry credentials were already given for this preparation");
  const credential = await offered.mint();
  try {
    await context.audit.record({
      eventId: (context.newId ?? randomUUID)(), companyId: context.companyId, at: (context.now ?? (() => new Date()))().toISOString(),
      actor: operation.requesterId === undefined ? { type: "system", id: "prepare" } : { type: "person", id: operation.requesterId },
      action: "registry_secret.used",
      details: { registry: offered.registry, host: offered.host, ...(offered.scope === undefined ? {} : { scope: offered.scope }), project: operation.projectName, workspaceId: input.workspaceId, operationId: input.operationId },
    });
  } catch {
    // Nothing leaves that was not recorded.
    throw agentXError("RUNTIME_UNAVAILABLE", REGISTRY_UNAVAILABLE_MESSAGE(offered.registry));
  }
  // The line names the registry and its kind; the credential, its name and its value are never in it.
  context.log?.({ component: "callbacks", event: "registry.credential_issued", registry: offered.registry, kind: offered.kind, workspaceId: input.workspaceId, operationId: input.operationId, ...(credential.expiresAt === undefined ? {} : { expiresAt: credential.expiresAt }) });
  return { credential };
}
