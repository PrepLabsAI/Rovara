// packages/broker/src/aws/admin-change-plans.ts
// Spec 025 FR-039, E6, E7: each admin change's plan, computed against current state. A plan
// changes nothing: it says what will happen, hashes what it read, and says how to apply it through
// the existing handler. Every value it shows passes through redaction first.
import {
  ADMIN_CHANGE_EFFECT_MAX, AgentXNameSchema, CredentialRegistrationSchema, SlackChannelIdSchema, agentXError, redactSecrets, redactText,
  type AdminChangeInput, type AdminChangeKind, type ChannelByNameRequest, type ChannelByNameResponse, type ProjectDefinition,
} from "@agentx/contracts";
import type { AuthenticatedIdentity } from "../auth.js";
import type { AdminActionDependencies } from "./admin-actions.js";
import { adminProjects, channelLabels, getStateItem, latestProjectRecord, privateChannelsFor, queryAllItems, type AdminReadDependencies } from "./admin-reads.js";
import { hashJson } from "./broker-shared.js";
import type { CredentialRegistry } from "./credentials.js";

export interface AdminChangeHandlers {
  requireAdministrator(identity: AuthenticatedIdentity, project: string): Promise<void>;
  bindChannel(identity: AuthenticatedIdentity, teamId: string, channelId: string, project: string): Promise<Record<string, unknown>>;
  unbindChannel(identity: AuthenticatedIdentity, teamId: string, channelId: string): Promise<Record<string, unknown>>;
  /** Registration's parse, refusals and vendor preflight for a new revision; stores nothing. */
  checkRevision(identity: AuthenticatedIdentity, definition: unknown, runtimeBinding: unknown): Promise<{ definition: ProjectDefinition; warnings: string[] }>;
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
  apply(identity: AuthenticatedIdentity): Promise<Record<string, unknown>>;
}
/** B4: who is planning; their linked Slack user decides whether a private channel is named to them. */
export interface PlanOptions { slackUserId?: string }
export type Planner = (deps: PlanDependencies, identity: AuthenticatedIdentity, input: AdminChangeInput, options: PlanOptions) => Promise<ChangePlan>;

export const stateHash = (snapshot: unknown): string => hashJson(snapshot);

const SHOWN_VALUE_MAX = 120;
const show = (value: unknown): string => {
  const text = JSON.stringify(redactSecrets(value)) ?? "null";
  return text.length > SHOWN_VALUE_MAX ? `${text.slice(0, SHOWN_VALUE_MAX - 3)}...` : text;
};

function leaves(value: unknown, path: string, into: Map<string, unknown>): Map<string, unknown> {
  if (Array.isArray(value)) value.forEach((entry, index) => leaves(entry, `${path}[${index}]`, into));
  else if (value !== null && typeof value === "object") for (const [key, entry] of Object.entries(value)) leaves(entry, path === "" ? key : `${path}.${key}`, into);
  else into.set(path, value);
  return into;
}

/** Leaf by leaf, in the order the new definition names them, then what it removed. */
export function fieldDiff(before: unknown, after: unknown, max = 200): Array<{ field: string; from?: string; to?: string }> {
  const old = leaves(before, "", new Map());
  const next = leaves(after, "", new Map());
  const changes: Array<{ field: string; from?: string; to?: string }> = [];
  // A field name is the definition's own text, so it is redacted like a value.
  for (const [field, value] of next) {
    if (!old.has(field)) changes.push({ field: redactText(field), to: show(value) });
    else if (JSON.stringify(old.get(field)) !== JSON.stringify(value)) changes.push({ field: redactText(field), from: show(old.get(field)), to: show(value) });
  }
  for (const [field, value] of old) if (!next.has(field)) changes.push({ field: redactText(field), from: show(value) });
  return changes.slice(0, max);
}

/** FR-030: a credential tool refuses any input that looks like a secret value. */
export function looksLikeSecret(value: string): boolean {
  if (redactText(value) !== value) return true;
  // A long unbroken run of key-like characters is refused too, whatever its prefix; a descriptive
  // name broken by "-", "_", "." or "/" is not.
  return /[A-Za-z0-9+=]{32,}/.test(value);
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
  if (found?.channel === undefined) throw agentXError("NOT_FOUND", `no public channel named #${text} in this Slack workspace; give a private channel by its ID`);
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

const planRevision: Planner = async (deps, identity, input) => {
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
  const { definition, warnings } = await deps.handlers.checkRevision(identity, input.definition, latest.runtimeBinding);
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
  if (deps.credentials === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "connector credentials are not configured in this deployment; ask whoever deploys AgentX to set them up");
  const [current, check, projects] = await Promise.all([
    deps.credentials.registration(registration.ref),
    deps.credentials.checkSecret(registration),
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

export const PLANNERS: Partial<Record<AdminChangeKind, Planner>> = {
  bind_channel: planBind,
  unbind_channel: planUnbind,
  register_project_revision: planRevision,
  register_credential: planCredential,
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
