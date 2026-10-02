// packages/broker/src/aws/admin-change-plans.ts
// Spec 025 FR-039, E6, E7: each admin change's plan, computed against current state. A plan
// changes nothing: it says what will happen, hashes what it read, and says how to apply it through
// the existing handler. Every value it shows passes through redaction first.
import {
  ADMIN_CHANGE_EFFECT_MAX, AgentXNameSchema, CredentialRegistrationSchema, SlackChannelIdSchema, WorkspaceInstanceSchema, agentXError, developerTaskPolicy,
  redactSecrets, redactText, workspaceRecordFields,
  type AdminChangeInput, type AdminChangeKind, type ChannelByNameRequest, type ConfirmationMethod, type ChannelByNameResponse, type ProjectDefinition,
} from "@agentx/contracts";
import type { AuthenticatedIdentity } from "../auth.js";
import { MAX_PER_ORGANIZATION, MAX_PER_PERSON, isWholeLimit, readWorkspaceLimits, WORKSPACE_LIMITS_KEY } from "../developer/limits.js";
import {
  endSessions, grantProjectAccess, projectGrant, resolveDeveloper, revokeProjectAccess, setWorkspaceLimits,
  type AdminActionDependencies, type ResolvedDeveloper,
} from "./admin-actions.js";
import { adminProjects, channelLabels, getStateItem, latestProjectRecord, privateChannelsFor, queryAllItems, workspaceOwner, type AdminReadDependencies } from "./admin-reads.js";
import { hashJson } from "./broker-shared.js";
import type { CredentialRegistry } from "./credentials.js";

export interface AdminChangeHandlers {
  requireAdministrator(identity: AuthenticatedIdentity, project: string): Promise<void>;
  bindChannel(identity: AuthenticatedIdentity, teamId: string, channelId: string, project: string): Promise<Record<string, unknown>>;
  unbindChannel(identity: AuthenticatedIdentity, teamId: string, channelId: string): Promise<Record<string, unknown>>;
  /**
   * Registration's parse, refusals and vendor preflight for a new revision; stores nothing.
   * `preflight: false` (the re-plan at apply) skips the vendor preflight: its findings are
   * warnings, which are not in the hash, so it runs once, at planning (C8, final review M1).
   */
  checkRevision(identity: AuthenticatedIdentity, definition: unknown, runtimeBinding: unknown, options?: { preflight?: boolean }): Promise<{ definition: ProjectDefinition; warnings: string[] }>;
  /** Registers a checked revision without running the vendor preflight again (C8). */
  registerRevision(identity: AuthenticatedIdentity, definition: ProjectDefinition, runtimeBinding: unknown): Promise<Record<string, unknown>>;
  registerCredential(identity: AuthenticatedIdentity, registration: { ref: string; type: string; secretName: string }): Promise<Record<string, unknown>>;
  cancelWorkspaceTask(identity: AuthenticatedIdentity, workspaceId: string): Promise<Record<string, unknown>>;
}
export interface PlanDependencies {
  reads: AdminReadDependencies;
  actions: AdminActionDependencies;
  handlers: AdminChangeHandlers;
  channelByName?: (request: ChannelByNameRequest) => Promise<ChannelByNameResponse>;
  credentials?: Pick<CredentialRegistry, "registration" | "checkSecret">;
  /** The prefix the credential registry enforces (C5). */
  connectorSecretPrefix: string;
  /** The built-in GitHub App's credential reference, which no change may register (C6). */
  builtInCredentialRef?: string;
}
export interface ChangePlan {
  /** What will happen; stored in the audit record, so a private channel is named by ID only (R4). */
  effect: string;
  /** Present only when it differs from `effect`: a private channel named to a member admin (B4). */
  confirmationEffect?: string;
  details: Record<string, unknown>;
  snapshot: unknown;
  /** `how`: the method that confirmed the change, which a planner may record with what it writes (#216). */
  apply(identity: AuthenticatedIdentity, how?: { method: ConfirmationMethod }): Promise<Record<string, unknown>>;
  /**
   * #216: when this re-plan's state differs from the one a change was planned against (its stored
   * `details`), what changed, to what, and how and when when known, in plain words; undefined when
   * the planner cannot say, and the caller then describes the change as planned again now.
   */
  changedSince?(planned: Record<string, unknown>): string | undefined;
}
/**
 * B4: who is planning; their linked Slack user decides whether a private channel is named to them.
 * `replan`: this is the apply's re-plan, which never contacts a revision's vendors again (M1).
 */
export interface PlanOptions { slackUserId?: string; replan?: boolean }
export type Planner = (deps: PlanDependencies, identity: AuthenticatedIdentity, input: AdminChangeInput, options: PlanOptions) => Promise<ChangePlan>;

export const stateHash = (snapshot: unknown): string => hashJson(snapshot);

const SHOWN_VALUE_MAX = 120;
const show = (value: unknown): string => {
  const text = JSON.stringify(redactSecrets(value)) ?? "null";
  return text.length > SHOWN_VALUE_MAX ? `${text.slice(0, SHOWN_VALUE_MAX - 3)}...` : text;
};

const REDACTED = "[REDACTED]";

/** Each leaf by path. */
function leaves(value: unknown, path: string, into: Map<string, unknown>): Map<string, unknown> {
  if (Array.isArray(value)) value.forEach((entry, index) => leaves(entry, `${path}[${index}]`, into));
  else if (value !== null && typeof value === "object") for (const [key, entry] of Object.entries(value)) leaves(entry, path === "" ? key : `${path}.${key}`, into);
  else into.set(path, value);
  return into;
}

/**
 * Leaf by leaf, in the order the new definition names them, then what it removed. Changes are
 * found on the raw values; what is shown comes from redactSecrets of the whole value, so every
 * rule it has applies (credential keys, name/value pairs, header tuples, argv flags). A leaf
 * redactSecrets folded away or renamed (a redacted key, a whole credential-named object) shows
 * as redacted.
 */
export function fieldDiff(before: unknown, after: unknown, max = 200): Array<{ field: string; from?: string; to?: string }> {
  const old = leaves(before, "", new Map());
  const next = leaves(after, "", new Map());
  const oldShown = leaves(redactSecrets(before), "", new Map());
  const nextShown = leaves(redactSecrets(after), "", new Map());
  const shown = (from: Map<string, unknown>, field: string) => show(from.has(field) ? from.get(field) : REDACTED);
  const changes: Array<{ field: string; from?: string; to?: string }> = [];
  // A field name is the definition's own text, so it is redacted like a value.
  for (const [field, value] of next) {
    if (!old.has(field)) changes.push({ field: redactText(field), to: shown(nextShown, field) });
    else if (JSON.stringify(old.get(field)) !== JSON.stringify(value)) changes.push({ field: redactText(field), from: shown(oldShown, field), to: shown(nextShown, field) });
  }
  for (const [field] of old) if (!next.has(field)) changes.push({ field: redactText(field), from: shown(oldShown, field) });
  return changes.slice(0, max);
}

/** FR-030: a credential tool refuses any input that looks like a secret value. */
export function looksLikeSecret(value: string): boolean {
  if (redactText(value) !== value) return true;
  // A long unbroken run of key-like characters is refused too, whatever its prefix. Only "/" and "."
  // separate, so a base64url secret with "_" or "-" inside is caught; a dotted or pathed name is not.
  return value.split(/[/.]/).some((part) => part.length >= 32 && /^[A-Za-z0-9_+=-]+$/.test(part));
}

const CHANNEL_NAME = /^[a-z0-9][a-z0-9._-]{0,79}$/;

/** A resolved channel: `label` names a private channel by ID; `confirmationLabel` names it to a member admin. */
export interface ResolvedChannel { channelId: string; label: string; confirmationLabel: string }

/**
 * E12 (Q8): a channel ID as it is; a public channel's name (with or without "#") among the
 * bindings, then through Slack. A private channel is never found by name.
 */
export async function resolveChannel(deps: PlanDependencies, teamId: string, value: string, options: PlanOptions = {}): Promise<ResolvedChannel> {
  const text = value.trim().replace(/^#/, "");
  if (SlackChannelIdSchema.safeParse(text).success) return labelled(deps, text, options);
  if (!CHANNEL_NAME.test(text)) throw agentXError("CONFIG_INVALID", "channel must be a Slack channel ID such as C0123456789, or a public channel's name such as #payments-dev");
  const bound = (await queryAllItems(deps.reads, `SLACK_BINDING#${teamId}`, "CHANNEL#")).map((item) => String(item.channelId));
  // No reveal here: only a public channel's name is ever matched.
  const { labels } = await channelLabels(deps.reads, bound);
  for (const [channelId, label] of labels) {
    if (!label.private && label.name === text) return { channelId, label: `#${text} (${channelId})`, confirmationLabel: `#${text} (${channelId})` };
  }
  const found = deps.channelByName === undefined ? undefined : await deps.channelByName({ kind: "channel-by-name", name: text });
  if (found !== undefined && !found.ok) throw agentXError("SLACK_UNAVAILABLE", "Slack could not be reached to find that channel; try again, or give the channel's ID");
  // Final review M6: the name the admin typed is never echoed; it may name a private channel.
  if (found?.channel === undefined) throw agentXError("NOT_FOUND", "no public channel with that name in this Slack workspace; give a private channel by its ID");
  const label = `#${text} (${found.channel.channelId})`;
  return { channelId: found.channel.channelId, label, confirmationLabel: label };
}

async function labelled(deps: PlanDependencies, channelId: string, options: PlanOptions): Promise<ResolvedChannel> {
  const slackUserId = options.slackUserId;
  const reveal = slackUserId === undefined ? undefined : (privateIds: string[]) => privateChannelsFor(deps.reads, slackUserId, privateIds);
  const known = (await channelLabels(deps.reads, [channelId], reveal === undefined ? {} : { reveal })).labels.get(channelId);
  if (known === undefined) return { channelId, label: channelId, confirmationLabel: channelId };
  if (!known.private) {
    const label = known.name === undefined ? channelId : `#${known.name} (${channelId})`;
    return { channelId, label, confirmationLabel: label };
  }
  const label = `${channelId} (a private channel)`;
  return { channelId, label, confirmationLabel: known.name === undefined ? label : `#${known.name} (${channelId}, a private channel)` };
}

const teamOf = (deps: PlanDependencies): string => {
  if (deps.reads.slackTeamId === undefined) throw agentXError("CONFIG_INVALID", "this environment records no Slack team, so channels cannot be bound from an AI tool; use agentx admin slack bind");
  return deps.reads.slackTeamId;
};
const bindingOf = async (deps: PlanDependencies, teamId: string, channelId: string) => {
  const item = await getStateItem(deps.reads, { pk: `SLACK_BINDING#${teamId}`, sk: `CHANNEL#${channelId}` });
  return typeof item?.projectName === "string" ? { projectName: item.projectName, updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : "" } : undefined;
};
/** "#name" for a named channel, the ID otherwise. */
const shortName = (label: string) => (label.startsWith("#") ? label.slice(0, label.indexOf(" ")) : label.split(" ")[0]!);

/** R4: the stored effect names a private channel by ID; the confirmation may name it (B4). */
function effects(channel: ResolvedChannel, say: (label: string) => string): Pick<ChangePlan, "effect" | "confirmationEffect"> {
  const effect = say(channel.label);
  const confirmationEffect = say(channel.confirmationLabel);
  return confirmationEffect === effect ? { effect } : { effect, confirmationEffect };
}

const planBind: Planner = async (deps, identity, input, options) => {
  if (input.kind !== "bind_channel") throw new Error("wrong planner");
  const teamId = teamOf(deps);
  const channel = await resolveChannel(deps, teamId, input.channel, options);
  const { channelId, label } = channel;
  await deps.handlers.requireAdministrator(identity, input.project);
  const current = await bindingOf(deps, teamId, channelId);
  if (current?.projectName === input.project) throw agentXError("CONFIG_INVALID", `channel ${label} is already bound to ${input.project}; there is nothing to change`);
  if (current !== undefined) await deps.handlers.requireAdministrator(identity, current.projectName);
  const latest = await latestProjectRecord(deps.reads, input.project);
  if (latest === undefined) throw agentXError("NOT_FOUND", `project ${input.project} is not registered; register it with agentx admin project register`);
  const now = current === undefined ? "It is bound to nothing today." : `It is bound to ${current.projectName} today; its existing threads keep their workspaces.`;
  return {
    ...effects(channel, (shown) => `Bind channel ${shown} to project ${input.project}. ${now} New threads in ${shortName(shown)} will use ${input.project} revision ${latest.definition.revision}.`),
    details: { channelId, project: input.project, currentProject: current?.projectName ?? null, revision: latest.definition.revision },
    snapshot: { binding: current ?? null, latestRevision: latest.definition.revision },
    apply: (applier) => deps.handlers.bindChannel(applier, teamId, channelId, input.project),
  };
};

const planUnbind: Planner = async (deps, identity, input, options) => {
  if (input.kind !== "unbind_channel") throw new Error("wrong planner");
  const teamId = teamOf(deps);
  const channel = await resolveChannel(deps, teamId, input.channel, options);
  const { channelId, label } = channel;
  const current = await bindingOf(deps, teamId, channelId);
  if (current === undefined) throw agentXError("NOT_FOUND", `channel ${label} is not bound to any project; list the bindings with agentx admin slack bindings`);
  await deps.handlers.requireAdministrator(identity, current.projectName);
  return {
    ...effects(channel, (shown) => `Unbind channel ${shown} from project ${current.projectName}. New messages there will get no reply; existing thread workspaces are kept.`),
    details: { channelId, project: current.projectName },
    snapshot: { binding: current },
    apply: (applier) => deps.handlers.unbindChannel(applier, teamId, channelId),
  };
};

/** How many changed fields the effect lists; details carry up to DETAIL_CHANGES_MAX. */
const EFFECT_CHANGES_MAX = 10;
const DETAIL_CHANGES_MAX = 50;

const planRevision: Planner = async (deps, identity, input, options) => {
  if (input.kind !== "register_project_revision") throw new Error("wrong planner");
  const name = input.definition.name;
  if (typeof name !== "string" || !AgentXNameSchema.safeParse(name).success) throw agentXError("CONFIG_INVALID", "the definition needs the project's name, such as \"payments\"");
  const latest = await latestProjectRecord(deps.reads, name);
  // Q5: a new revision keeps its project's runtime binding; a first revision needs the CLI's flags.
  if (latest === undefined) throw agentXError("NOT_FOUND", `project ${name} has no revision yet; register its first revision with agentx admin project register`);
  await deps.handlers.requireAdministrator(identity, name);
  const latestRevision = latest.definition.revision;
  // Before the vendor preflight, so a revision that can never register contacts no vendor.
  const asked = input.definition.revision;
  if (typeof asked === "number" && asked <= latestRevision) throw agentXError("CONFIG_INVALID", `revision ${asked} is not newer than the latest, ${latestRevision}; use ${latestRevision + 1}`);
  const { definition, warnings } = await deps.handlers.checkRevision(identity, input.definition, latest.runtimeBinding, { preflight: options.replan !== true });
  const changes = fieldDiff(latest.definition, definition).filter((change) => change.field !== "revision");
  const listed = changes.slice(0, EFFECT_CHANGES_MAX).map((change) => `${change.field}: ${change.from ?? "(none)"} -> ${change.to ?? "(removed)"}`);
  const more = changes.length > EFFECT_CHANGES_MAX ? `; and ${changes.length - EFFECT_CHANGES_MAX} more` : "";
  const shownWarnings = warnings.map((warning) => redactText(warning));
  const findings = shownWarnings.length === 0 ? "The preflight found nothing to fix." : `The preflight found: ${shownWarnings.join("; ")}.`;
  const effect = `Register revision ${definition.revision} of project ${name} (the latest is ${latestRevision}). It changes ${changes.length} field${changes.length === 1 ? "" : "s"}${listed.length === 0 ? "" : `: ${listed.join("; ")}${more}`}. ${findings} New threads and tasks use it; running ones keep their revision.`;
  return {
    effect: effect.length > ADMIN_CHANGE_EFFECT_MAX ? `${effect.slice(0, ADMIN_CHANGE_EFFECT_MAX - 3)}...` : effect,
    details: { project: name, revision: definition.revision, latestRevision, runtimeMode: latest.runtimeBinding.deploymentMode, changes: changes.slice(0, DETAIL_CHANGES_MAX), changedFields: changes.length, warnings: shownWarnings },
    snapshot: { latestRevision },
    apply: (applier) => deps.handlers.registerRevision(applier, definition, latest.runtimeBinding),
  };
};

type ConnectorsOf = { integrations?: { connectors?: Array<{ credentialRef?: unknown }> } };

const planCredential: Planner = async (deps, identity, input) => {
  if (input.kind !== "register_credential") throw new Error("wrong planner");
  // Defence in depth: the route checks the claim too, and registration checks it again at apply.
  if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required; sign in as an AgentX administrator");
  if (deps.credentials === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "connector credentials are not configured in this deployment; ask whoever deploys AgentX to set them up");
  const credentials = deps.credentials;
  // FR-030: refuse anything that looks like a secret value before it is read, shown or stored.
  if ([input.ref, input.type, input.secretName].some(looksLikeSecret)) throw agentXError("CONFIG_INVALID", `that input looks like a secret value; give the secret's name under ${deps.connectorSecretPrefix}, never its value`);
  const parsed = CredentialRegistrationSchema.safeParse({ ref: input.ref, type: input.type, secretName: input.secretName });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw agentXError("CONFIG_INVALID", `the credential is invalid: ${issue?.path.join(".") || "input"}: ${issue?.message ?? "invalid"}; fix it and plan again`);
  }
  const registration = parsed.data;
  if (!registration.secretName.startsWith(deps.connectorSecretPrefix)) throw agentXError("CONFIG_INVALID", `the secret name must be ${deps.connectorSecretPrefix}<name> in this deployment; create the secret there and plan again`);
  if (registration.ref === deps.builtInCredentialRef) throw agentXError("CONFIG_INVALID", `${registration.ref} is the built-in GitHub App credential and cannot be replaced; register the connector's credential under another reference`);
  const [current, check, projects] = await Promise.all([
    credentials.registration(registration.ref),
    credentials.checkSecret(registration),
    // C6: the admin's project list, read once with each latest revision.
    adminProjects(deps.reads, identity),
  ]);
  const users = projects
    .filter(({ latest }) => ((latest.definition as ConnectorsOf).integrations?.connectors ?? []).some((connector) => connector.credentialRef === registration.ref))
    .map(({ name }) => name);
  const secretText = {
    reads: `That secret exists and reads as ${registration.type}.`,
    missing: `That secret does not exist yet, so connectors naming ${registration.ref} will fail until it does.`,
    wrong_type: `That secret exists but does not read as ${registration.type}, so registering it will be refused; fix the secret's contents first.`,
    unavailable: "AgentX could not read that secret just now, so whether it exists is unknown.",
  }[check];
  const replaces = current === undefined ? "It is a new registration." : `It replaces the registration from ${current.registeredAt}, which read ${current.secretName} as ${current.type}.`;
  return {
    effect: `Register credential ${registration.ref} as ${registration.type}, read from ${registration.secretName}. ${secretText} ${users.length === 0 ? `No project names ${registration.ref} today.` : `Projects naming it: ${users.join(", ")}.`} ${replaces}`,
    // C7: no key redactSecrets would blank (secret, credential, credentialRef...).
    details: { ref: registration.ref, type: registration.type, secretName: registration.secretName, check, projects: users, replaces: current === undefined ? null : { type: current.type, secretName: current.secretName, registeredAt: current.registeredAt } },
    snapshot: { registration: current === undefined ? null : { type: current.type, secretName: current.secretName, registeredAt: current.registeredAt } },
    apply: (applier) => deps.handlers.registerCredential(applier, registration),
  };
};

/** How a developer is named: by profile once they signed in, else by what the admin gave. */
function describeDeveloper(resolved: ResolvedDeveloper): string {
  if (resolved.profile !== undefined) return `${resolved.profile.displayName} (signs in with ${resolved.profile.provider === "slack" ? "Slack" : "the company sign-in"})`;
  if (resolved.slackUserId !== undefined) return `Slack user ${resolved.slackUserId}`;
  return `developer ${resolved.developerId.slice(0, 12)}`;
}
/** An effect's note for someone who has not signed in yet; a grant says when it takes hold. */
function notSignedIn(resolved: ResolvedDeveloper, grant: boolean): string {
  if (resolved.profile !== undefined) return "";
  return grant && resolved.slackUserId !== undefined ? " (not signed in to AgentX yet; the grant applies when they sign in with Slack)" : " (not signed in to AgentX yet)";
}

/** The admin claim alone (Q7): org-wide changes name no project. */
const requireAdminClaim = (identity: AuthenticatedIdentity) => {
  if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required; sign in as an AgentX administrator");
};

/**
 * The project name is checked before any key is built from it (the grant and revoke actions
 * interpolate it unchecked), and the project must be registered.
 */
async function projectMustExist(deps: PlanDependencies, identity: AuthenticatedIdentity, project: string) {
  // The claim first, so a caller without it learns nothing about which projects exist.
  requireAdminClaim(identity);
  if (!AgentXNameSchema.safeParse(project).success) throw agentXError("CONFIG_INVALID", "project must be a project name such as payments");
  const latest = await latestProjectRecord(deps.reads, project);
  if (latest === undefined) throw agentXError("NOT_FOUND", `project ${project} is not registered; check the project's name, or register it with agentx admin project register`);
  return latest;
}

const planStop: Planner = async (deps, identity, input) => {
  if (input.kind !== "stop_workspace") throw new Error("wrong planner");
  // The claim first, so a caller without it learns nothing about workspaces.
  requireAdminClaim(identity);
  const item = await getStateItem(deps.reads, { pk: `WORKSPACE#${input.workspaceId}`, sk: "META" });
  const parsed = item === undefined ? undefined : WorkspaceInstanceSchema.safeParse(workspaceRecordFields(item));
  if (parsed === undefined || !parsed.success) throw agentXError("NOT_FOUND", `no workspace ${input.workspaceId}; check the workspace ID and plan again`);
  const workspace = parsed.data;
  await deps.handlers.requireAdministrator(identity, workspace.projectName);
  // Q2: stopping compute by hand is not supported (idle compute stops on its own), so the change
  // cancels the running task, through the admin cancel of #126.
  if (workspace.activeOperationId === null) throw agentXError("CONFIG_INVALID", `nothing is running in workspace ${workspace.id}; its compute stops on its own when idle`);
  const operation = await getStateItem(deps.reads, { pk: `WORKSPACE#${workspace.id}`, sk: `OPERATION#${workspace.activeOperationId}` });
  if (operation?.kind !== "task") throw agentXError("CONFIG_INVALID", `the running operation is a ${typeof operation?.kind === "string" ? operation.kind : "setup"}, which AgentX does not cancel midway; wait for it to end`);
  const { owner } = await workspaceOwner(deps.reads, workspace);
  const who = owner.threadUrl ?? (owner.developerName === undefined ? "its owner" : `${owner.developerName}'s task`);
  return {
    effect: `Cancel the task running in workspace ${workspace.id} (project ${workspace.projectName}, ${who}, ${workspace.status}). Its conversation keeps what finished before; its compute stops on its own when idle.`,
    details: { workspaceId: workspace.id, project: workspace.projectName, operationId: workspace.activeOperationId },
    snapshot: { status: workspace.status, activeOperationId: workspace.activeOperationId, fence: workspace.fence },
    // The admin cancel checks the applier's project administration itself (E6, FR-015).
    apply: (applier) => deps.handlers.cancelWorkspaceTask(applier, workspace.id),
  };
};

const planGrant: Planner = async (deps, identity, input) => {
  if (input.kind !== "grant_project_access") throw new Error("wrong planner");
  await projectMustExist(deps, identity, input.project);
  await deps.handlers.requireAdministrator(identity, input.project);
  const resolved = await resolveDeveloper(deps.actions, input.developer);
  const current = await projectGrant(deps.actions, input.project, resolved.developerId);
  if (current?.role === "developer") throw agentXError("CONFIG_INVALID", `${describeDeveloper(resolved)} already has a grant for ${input.project}; there is nothing to change`);
  if (current?.role === "administrator") throw agentXError("CONFIG_INVALID", `${describeDeveloper(resolved)} already administers ${input.project}; there is nothing to change`);
  const project = input.project;
  return {
    effect: `Grant ${describeDeveloper(resolved)}${notSignedIn(resolved, true)} access to project ${project}. They have no grant today. They can then hand tasks to ${project} from their AI tool.`,
    details: { developerId: resolved.developerId, via: resolved.via, project },
    // Who the effect names is state too: a first sign-in since planning changes the effect.
    snapshot: { grant: null, profile: resolved.profile === undefined ? null : { displayName: resolved.profile.displayName, provider: resolved.profile.provider } },
    apply: async (applier) => {
      // E6, FR-015: the applier must still administer the project.
      await deps.handlers.requireAdministrator(applier, project);
      return grantProjectAccess(deps.actions, { issuer: applier.issuer, subject: applier.subject }, project, resolved.developerId);
    },
  };
};

const planRevoke: Planner = async (deps, identity, input) => {
  if (input.kind !== "revoke_project_access") throw new Error("wrong planner");
  const latest = await projectMustExist(deps, identity, input.project);
  await deps.handlers.requireAdministrator(identity, input.project);
  const resolved = await resolveDeveloper(deps.actions, input.developer);
  const current = await projectGrant(deps.actions, input.project, resolved.developerId);
  // An administrator row is never a grant: revoking never removes an administrator.
  if (current?.role !== "developer") throw agentXError("NOT_FOUND", `${describeDeveloper(resolved)} has no grant for ${input.project}, so there is nothing to revoke`);
  const project = input.project;
  const channelMembersMayUse = developerTaskPolicy(latest.definition).channelMembersMayUse;
  const channels = channelMembersMayUse ? ` If they are a member of one of ${project}'s Slack channels, they keep access through it.` : "";
  return {
    effect: `Revoke the granted access of ${describeDeveloper(resolved)}${notSignedIn(resolved, false)} to project ${project}. Their running tasks keep running.${channels}`,
    details: { developerId: resolved.developerId, via: resolved.via, project },
    snapshot: { grant: current, channelMembersMayUse, profile: resolved.profile === undefined ? null : { displayName: resolved.profile.displayName, provider: resolved.profile.provider } },
    apply: async (applier) => {
      await deps.handlers.requireAdministrator(applier, project);
      return revokeProjectAccess(deps.actions, project, resolved.developerId);
    },
  };
};

const planEndSessions: Planner = async (deps, identity, input) => {
  if (input.kind !== "revoke_signin") throw new Error("wrong planner");
  requireAdminClaim(identity);
  const resolved = await resolveDeveloper(deps.actions, input.developer);
  if (resolved.profile === undefined) throw agentXError("NOT_FOUND", `${describeDeveloper(resolved)} has never signed in to AgentX, so there is no sign-in to end`);
  return {
    effect: `End every AgentX sign-in session of ${describeDeveloper(resolved)}. Their AI tools stop reaching AgentX at once; they may sign in again with agentx login. Their running tasks keep running.`,
    details: { developerId: resolved.developerId, via: resolved.via },
    snapshot: { sessionsEndedAt: resolved.profile.sessionsEndedAt ?? null, profile: { displayName: resolved.profile.displayName, provider: resolved.profile.provider } },
    apply: async () => endSessions(deps.actions, resolved.developerId),
  };
};

/** How many people at or over the new limit the effect names; details carry the full count. */
const EFFECT_PEOPLE_MAX = 10;

const counterCount = (item: Record<string, unknown> | undefined): number => (typeof item?.count === "number" && item.count >= 0 ? item.count : 0);

/** #216: how a setting was last confirmed, in words. */
const VIA_WORDS: Readonly<Record<string, string>> = { cli: "from the CLI", slack: "from Slack", elicitation: "from an AI tool" };

/** A stored time as "1:04 PM UTC"; the changes it describes are minutes old, so the day is left out. */
function clockTime(iso: unknown): string | undefined {
  if (typeof iso !== "string" || Number.isNaN(Date.parse(iso))) return undefined;
  const at = new Date(iso);
  const hours = at.getUTCHours();
  return `${hours % 12 === 0 ? 12 : hours % 12}:${String(at.getUTCMinutes()).padStart(2, "0")} ${hours < 12 ? "AM" : "PM"} UTC`;
}

const limitPair = (value: unknown): { perPerson: number; perOrganization: number } | undefined => {
  const record = value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
  return typeof record?.perPerson === "number" && typeof record.perOrganization === "number" ? { perPerson: record.perPerson, perOrganization: record.perOrganization } : undefined;
};

const wanted = (input: { perPerson?: number | undefined; perOrganization?: number | undefined }) => [
  ...(input.perPerson === undefined ? [] : [`${input.perPerson} per person`]),
  ...(input.perOrganization === undefined ? [] : [`${input.perOrganization} for the organization`]),
].join(" and ");

/**
 * #216: what changed in the workspace limits since a change was planned, e.g. "the per-person limit
 * was changed to 4 (from 1) by another administrator from the CLI at 1:04 PM UTC, after you asked;
 * ask again if you still want 2 per person". Undefined when the planned details cannot be read.
 */
function limitsChangedSince(
  planned: Record<string, unknown>,
  now: { perPerson: number; perOrganization: number },
  source: string,
  setting: Record<string, unknown> | undefined,
  identity: AuthenticatedIdentity,
  input: { perPerson?: number | undefined; perOrganization?: number | undefined },
): string | undefined {
  const was = limitPair(planned.current);
  if (was === undefined) return undefined;
  const changes: string[] = [];
  if (now.perPerson !== was.perPerson) changes.push(`the per-person limit was changed to ${now.perPerson} (from ${was.perPerson})`);
  if (now.perOrganization !== was.perOrganization) {
    changes.push(changes.length === 0 ? `the organization limit was changed to ${now.perOrganization} (from ${was.perOrganization})` : `the organization limit to ${now.perOrganization} (from ${was.perOrganization})`);
  }
  // Nothing it can name changed (a setting written again with the same values, or other defaults
  // behind a setting): the caller then says what the change would do now.
  if (changes.length === 0) return undefined;
  const what = changes.join(" and ");
  // With no valid setting, the limits are the deployment's defaults: no person, method or time to name.
  if (source === "parameters") return `${what} in the deployment's default limits, after you asked; ask again if you still want ${wanted(input)}`;
  const by = setting?.updatedBy !== null && typeof setting?.updatedBy === "object" ? setting.updatedBy as Record<string, unknown> : undefined;
  const who = by === undefined ? "" : by.issuer === identity.issuer && by.subject === identity.subject ? " by you" : " by another administrator";
  const via = typeof setting?.via === "string" && VIA_WORDS[setting.via] !== undefined ? ` ${VIA_WORDS[setting.via]}` : "";
  const time = setting === undefined ? undefined : clockTime(setting.updatedAt);
  return `${what}${who}${via}${time === undefined ? "" : ` at ${time}`}, after you asked; ask again if you still want ${wanted(input)}`;
}

const planLimits: Planner = async (deps, identity, input) => {
  if (input.kind !== "set_workspace_limits") throw new Error("wrong planner");
  requireAdminClaim(identity);
  if (input.perPerson === undefined && input.perOrganization === undefined) throw agentXError("CONFIG_INVALID", "give per_person, per_organization or both");
  if (input.perPerson !== undefined && !isWholeLimit(input.perPerson, MAX_PER_PERSON)) throw agentXError("CONFIG_INVALID", `the per-person limit must be a whole number from 1 to ${MAX_PER_PERSON}`);
  if (input.perOrganization !== undefined && !isWholeLimit(input.perOrganization, MAX_PER_ORGANIZATION)) throw agentXError("CONFIG_INVALID", `the organization limit must be a whole number from 1 to ${MAX_PER_ORGANIZATION}`);
  const setting = await getStateItem(deps.reads, WORKSPACE_LIMITS_KEY);
  const current = await readWorkspaceLimits(deps.reads.documentClient, deps.reads.tableName, deps.reads.limitDefaults, (entry) => deps.reads.log(entry));
  const next = { perPerson: input.perPerson ?? current.member, perOrganization: input.perOrganization ?? current.organization };
  if (next.perPerson > next.perOrganization) throw agentXError("CONFIG_INVALID", `the per-person limit (${next.perPerson}) cannot be more than the organization limit (${next.perOrganization}); give both, or a smaller per-person limit`);
  const team = deps.reads.slackTeamId;
  const members = team === undefined ? [] : await queryAllItems(deps.reads, `SLACK_LIMIT#${team}`, "MEMBER#");
  // Developers without a Slack link count on their own DEVELOPER_LIMIT#<id> rows (one partition
  // each), so they are not named here; the organization's total includes them.
  const over = members
    .filter((item) => counterCount(item) >= next.perPerson)
    .map((item) => `Slack member ${String(item.sk).slice("MEMBER#".length)} (${counterCount(item)} open)`);
  const aiToolOnlyCount = counterCount(await getStateItem(deps.reads, { pk: "DEVELOPER_LIMIT#ORGANIZATION", sk: "ORGANIZATION" }));
  const organizationCount = (team === undefined ? 0 : counterCount(await getStateItem(deps.reads, { pk: `SLACK_LIMIT#${team}`, sk: "ORGANIZATION" }))) + aiToolOnlyCount;
  const change = (value: number, was: number) => (value === was ? "(unchanged)" : `(now ${was})`);
  const named = over.slice(0, EFFECT_PEOPLE_MAX).join(", ");
  const more = over.length > EFFECT_PEOPLE_MAX ? `, and ${over.length - EFFECT_PEOPLE_MAX} more` : "";
  const people = over.length === 0 ? "" : ` At or over ${next.perPerson} per person: ${named}${more}.`;
  // Final review T6: their workspaces are in the total, so say why nobody is named for them.
  const aiToolOnly = aiToolOnlyCount > 0 ? " People who use only an AI tool count in the total but are not named." : "";
  const orgNote = organizationCount >= next.perOrganization ? " The organization is at or over its new limit." : "";
  const effect = `Set the workspace limits to ${next.perPerson} per person ${change(next.perPerson, current.member)} and ${next.perOrganization} for the organization ${change(next.perOrganization, current.organization)}. Open workspaces: ${organizationCount} of ${next.perOrganization}.${people}${aiToolOnly}${orgNote} Existing workspaces keep running; a new one is refused while its person or the organization is at the limit.`;
  return {
    effect: effect.length > ADMIN_CHANGE_EFFECT_MAX ? `${effect.slice(0, ADMIN_CHANGE_EFFECT_MAX - 3)}...` : effect,
    details: { current: { perPerson: current.member, perOrganization: current.organization, source: current.source }, next, organizationCount, over: over.length },
    // The counts are informational and change often, so they are deliberately outside the hash.
    snapshot: { setting: setting === undefined ? null : { perPerson: setting.perPerson ?? null, perOrganization: setting.perOrganization ?? null, updatedAt: setting.updatedAt ?? null }, defaults: deps.reads.limitDefaults },
    apply: async (applier, how) => setWorkspaceLimits(deps.actions, { issuer: applier.issuer, subject: applier.subject }, next, how?.method),
    changedSince: (planned) => limitsChangedSince(planned, { perPerson: current.member, perOrganization: current.organization }, current.source, setting, identity, input),
  };
};

export const PLANNERS: Partial<Record<AdminChangeKind, Planner>> = {
  bind_channel: planBind,
  unbind_channel: planUnbind,
  register_project_revision: planRevision,
  register_credential: planCredential,
  stop_workspace: planStop,
  grant_project_access: planGrant,
  revoke_project_access: planRevoke,
  revoke_signin: planEndSessions,
  set_workspace_limits: planLimits,
};

/**
 * FR-039: the change's exact effect against current state. `options.slackUserId` is the planning
 * admin's linked Slack user (B4); it changes only `confirmationEffect`, never the hash.
 */
export async function planChange(deps: PlanDependencies, identity: AuthenticatedIdentity, input: AdminChangeInput, options: PlanOptions = {}): Promise<ChangePlan> {
  const planner = PLANNERS[input.kind];
  if (planner === undefined) throw agentXError("CONFIG_INVALID", `${input.kind} is not a change this AgentX can plan; update AgentX, or make the change with the agentx admin command`);
  return planner(deps, identity, input, options);
}
