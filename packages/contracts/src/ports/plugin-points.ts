// Port lane W0, port 4: the plug-in points and the config that names the adapters.
//
// ONE registry (decisions 40, 45.5 and 51). Pratik's spec 062 phase 3 registers channel adapters at run time (an administrator
// PUTs a callback URL and gets a signing secret). That stays the way an out-of-process channel adapter joins; here it is the
// `channel` point of the same registry: such an adapter is registered under its channel id like any other, and an in-process
// adapter is named in the config file. A "plug-in point" is what decision 40 calls a plug-in kind; it is named a point here so
// it cannot be mixed up with an adapter's own kind (`github`, `linear`), which the code-host, tracker and check-runner
// contracts call `PluginKind`.
import { isBuiltin } from "node:module";
import { z } from "zod";
import { PluginKindSchema } from "../plugins/common.js";
import type { ChannelCapabilities, ChannelDecision, ChannelEvent, StepUpKind } from "../channel-adapter.js";
import type { InboundMessage } from "../conversation.js";
import type { CodeHost } from "../plugins/code-host.js";
import type { Tracker } from "../plugins/tracker.js";
import type { DocumentStore } from "./document-store.js";
import type { JsonObject } from "./json.js";
import type { ModelKeyStore } from "./model-keys.js";
import { MODEL_PROVIDER_ID_PATTERN, MODEL_REQUEST_FORMATS, type ModelProviderAdapter } from "./model-provider.js";
import type { ObjectStorage } from "./object-storage.js";
import type { OutboundEventsAdapter } from "./outbound-events.js";
import type { SecretStore } from "./secrets.js";
import type { CheckRunnerAdapter } from "./plugin-adapters.js";
import type { Admission, Approvers, IdentityProvider, Metering } from "./policy.js";
import type { AuditSink } from "./audit-sink.js";
import type { BuildSystem } from "./build-system.js";
import type { CompanyInstructionsSource } from "./company-instructions.js";
import type { QueueService } from "./queue.js";
import type { WorkerMachines } from "./worker-machines.js";

/** Every place an adapter can plug in. A new point is an interface change (both owners). */
export const PLUGIN_POINTS = [
  "code-host",
  "tracker",
  "check-runner",
  "channel",
  "worker-machines",
  "storage",
  "queue",
  "monitoring",
  "learning",
  "team-record-source",
  "identity",
  "build-system",
  "admission",
  "audit-sink",
  "approvers",
  "metering",
  "model-keys",
  /** Provisional (owner decision 58): files too big for the document store, behind `ObjectStorage`. */
  "object-storage",
  /** Owner decisions 57 and 60 (item L1): the company's standing rules, read-only. Code: a local file; Cloud: its store. */
  "company-instructions",
  /** Owner decisions 40 and 61 (item R3): signed events out, in the format of the channel events. */
  "outbound-events",
  /** Item K2 (owner decisions 60 and 61): where a model is, how to sign in to it, the request format it speaks and its prices. */
  "model-provider",
  /** Owner decision 60 (R2): where an adapter's secrets are read (`read(ref)` returns a `SecretValue`). */
  "secrets",
] as const;
export const PluginPointSchema = z.enum(PLUGIN_POINTS);
export type PluginPoint = z.infer<typeof PluginPointSchema>;

/**
 * Whether a point holds one adapter (the store, the queue, a policy seam) or many by name (every code host, every channel). A
 * point that holds one has Code's default until the config names another.
 */
export const PLUGIN_POINT_CARDINALITY: Readonly<Record<PluginPoint, "one" | "many">> = {
  "code-host": "many",
  tracker: "many",
  "check-runner": "many",
  channel: "many",
  "worker-machines": "many",
  storage: "one",
  queue: "one",
  monitoring: "many",
  learning: "many",
  "team-record-source": "many",
  identity: "one",
  "build-system": "many",
  admission: "one",
  "audit-sink": "one",
  approvers: "one",
  metering: "one",
  "model-keys": "one",
  "object-storage": "one",
  "company-instructions": "one",
  "outbound-events": "many",
  "model-provider": "many",
  secrets: "one",
};

/**
 * What a plug-in is called: lower-case words and digits with hyphens, the same shape as an adapter's kind. This IS the plug-in contracts' `PluginKindSchema` (lane L1 keeps
 * one definition and this name for new code); it accepts a one-letter name where W0's first draft asked for two.
 */
export const PluginNameSchema = PluginKindSchema;

// ---- The channel point: Pratik's channel adapters, in-process ----

/**
 * Where an in-process channel adapter hands what it heard. The adapter is trusted by the config that named it (no signature), but
 * not for who is speaking: the sink applies the same checks as the channel API does for a signed adapter (the space is bound to one
 * of the adapter's projects, the actor is linked to a developer, a decision matches its request, revision and digest, and a stepped-up
 * kind is refused). An in-process adapter gets no shortcut around them.
 */
export interface ChannelInboundSink {
  message(message: InboundMessage): Promise<void>;
  decision(decision: ChannelDecision): Promise<void>;
}

/**
 * A channel adapter as the registry holds it. The capabilities are Pratik's (`ChannelCapabilities`), and the events are his
 * `ChannelEvent`s, so a webhook adapter registered over HTTP and an in-process one look the same to the core.
 */
export interface ChannelAdapter {
  readonly capabilities: ChannelCapabilities;
  /** The projects the adapter serves (Pratik's `ChannelAdapterRecord.projects`). */
  readonly projects: readonly string[];
  /** Decision kinds that must be made on the task page, not through this adapter (`ChannelAdapterRecord.stepUp`). */
  readonly stepUp: readonly StepUpKind[];
  /** Rovara to the channel. At least once: `event.id` is stable across retries, so an adapter drops a repeat. */
  deliver(event: ChannelEvent): Promise<void>;
  /** In-process adapters begin listening here. Webhook adapters need no listener: they post to the channel API. */
  start?(sink: ChannelInboundSink): Promise<{ stop(): Promise<void> }>;
}

/**
 * The thing an adapter of a point that has no port yet must be (monitoring, learning, team-record-source). The lane
 * that defines the point's port narrows its line in `PluginPointTypes` to the real interface. Until then only the name is known.
 */
export interface UnspecifiedAdapter {
  readonly kind?: string;
}

/** The adapter type for each point. A lane that adds a port edits its own line here. */
export interface PluginPointTypes {
  "code-host": CodeHost;
  tracker: Tracker;
  "check-runner": CheckRunnerAdapter;
  channel: ChannelAdapter;
  "worker-machines": WorkerMachines;
  storage: DocumentStore;
  queue: QueueService;
  monitoring: UnspecifiedAdapter;
  learning: UnspecifiedAdapter;
  "team-record-source": UnspecifiedAdapter;
  identity: IdentityProvider;
  "build-system": BuildSystem;
  admission: Admission;
  "audit-sink": AuditSink;
  approvers: Approvers;
  metering: Metering;
  "model-keys": ModelKeyStore;
  "object-storage": ObjectStorage;
  "company-instructions": CompanyInstructionsSource;
  "outbound-events": OutboundEventsAdapter;
  "model-provider": ModelProviderAdapter;
  secrets: SecretStore;
}

export type AdapterOf<P extends PluginPoint> = PluginPointTypes[P];

// ---- The registry ----

export interface AdapterRegistration {
  /** Set for Code's built-in defaults: a configured adapter replaces a default without a conflict. */
  isDefault?: boolean;
}

/** What an adapter's `create` may do with the registry: look, not change. */
export type RegistryView = Pick<AdapterRegistry, "get" | "require" | "names">;

export interface AdapterRegistry {
  /** Adds an adapter. Throws when the name is taken, or when a `one` point already holds an adapter that is not a default. */
  register<P extends PluginPoint>(point: P, name: string, adapter: AdapterOf<P>, registration?: AdapterRegistration): void;
  /**
   * Removes an adapter (a channel adapter an administrator deleted). Returns whether there was one. Only the `channel` point may be
   * changed once the registry is sealed.
   */
  unregister(point: PluginPoint, name: string): boolean;
  get<P extends PluginPoint>(point: P, name: string): AdapterOf<P> | undefined;
  /**
   * The adapter by name; with no name, the only adapter of the point. Throws a `PluginRegistryError` (`not_registered`, or
   * `ambiguous` when several are registered and no name was given).
   */
  require<P extends PluginPoint>(point: P, name?: string): AdapterOf<P>;
  names(point: PluginPoint): string[];
  /**
   * Ends set-up. Afterwards `register` and `unregister` work only on the `channel` point (administrators add and remove channel
   * adapters while the process runs); a plug-in can no longer replace the approvers, the identity or the admission rule.
   */
  seal(): void;
}

export type PluginRegistryErrorCode =
  | "not_registered"
  | "ambiguous"
  | "already_registered"
  | "bad_config"
  | "bad_module"
  | "create_failed";

export class PluginRegistryError extends Error {
  constructor(readonly code: PluginRegistryErrorCode, message: string) {
    super(message);
    this.name = "PluginRegistryError";
  }
}

// ---- Plug-in modules and the config file ----

/** What an adapter's module hands the registry. The module exports it as `plugin` (or as its default export). */
export interface PluginModule<P extends PluginPoint = PluginPoint> {
  readonly point: P;
  readonly name: string;
  /** Builds the adapter. It validates its own `settings`, and reaches other adapters (a queue needs the store) through `context.registry`. */
  create(context: PluginContext): AdapterOf<P> | Promise<AdapterOf<P>>;
}

export interface PluginContext {
  /** The company Code runs as. Cloud serves many companies, so an adapter takes the company from each call, not from here. */
  defaultCompanyId: string;
  /** This adapter's block of the config file. Never holds a secret in clear: name where to read it (a file, an environment variable: a `SecretRef`), and read it through the `secrets` point. */
  settings: JsonObject;
  registry: RegistryView;
  now: () => Date;
  /** Port lane P6: the folder the install keeps its own files in (Code: the state folder, `~/.rovara` by default). A plug-in that keeps a file puts its default there, not in the home folder. Absent for an install with no such folder (Cloud). */
  stateDirectory?: string;
}

export const PLUGIN_CONFIG_VERSION = 1;

/**
 * Where a module comes from: a package name (`@rovara/plugin-github`) or a path that starts with `./` and stays inside the config
 * file's folder (the loader resolves it and checks the real path). Never a URL, an absolute path, `..`, a hidden folder or a Node
 * built-in. The config file is owner-controlled: it must never be read from repository content an agent works on, because naming a
 * module runs its code in the broker.
 */
export function isAllowedModuleSpecifier(value: string): boolean {
  if (isBuiltin(value)) return false;
  const relative = /^\.\/([A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(value);
  const packageName = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(\/[A-Za-z0-9._-]+)*$/.test(value);
  if (!relative && !packageName) return false;
  // Nothing may walk around (`.`, `..`) or reach into a hidden folder (`.git`, `.ssh`) after the leading `./`.
  const segments = value.split("/").slice(relative ? 1 : 0);
  return segments.every((segment) => !segment.startsWith("."));
}
export const PluginModuleSpecifierSchema = z.string().min(1).max(256).refine(
  isAllowedModuleSpecifier,
  "a package name, or a path inside the config's folder that starts with ./ (no URL, no absolute path, no .., no Node built-in)",
);

const JsonSettingSchema: z.ZodType<JsonObject> = z.record(z.string(), z.json());

export const PluginConfigEntrySchema = z.object({
  point: PluginPointSchema,
  name: PluginNameSchema,
  module: PluginModuleSpecifierSchema,
  enabled: z.boolean().default(true),
  settings: JsonSettingSchema.default({}),
}).strict();
export type PluginConfigEntry = z.infer<typeof PluginConfigEntrySchema>;

/** The config file's content. Entries are created in order, so list a queue's store before the queue. */
export const PluginConfigSchema = z.object({
  version: z.literal(PLUGIN_CONFIG_VERSION),
  /** The company Code runs as (decision 45.6). Absent: the implicit company. It has the shape of an organization id (`org_` and 20 characters), because plug-in calls carry it as their scope (`HostScope`). */
  companyId: z.string().regex(/^org_[0-9a-z]{20}$/, "a company id looks like org_ and 20 lower-case letters or digits (the same shape a hosted install uses; code-host and tracker calls are scoped by it)").optional(),
  /**
   * Port lane L11 (laptop only, owner-set): a worker may be given the owner's own code-host token even when that token reaches every repository its owner can (a classic token, the GitHub CLI's).
   * Absent or false: such a token is refused for a worker, and a fine-grained token limited to the project's repositories is required. A cloud install ignores it.
   */
  allowBroadTokenForWorker: z.boolean().optional(),
  /**
   * Port lane L13 (laptop only, owner-set): the model a task step calls, e.g. `{ "provider": "openrouter", "id": "anthropic/claude-sonnet-4.6" }`; the provider is any registered `model-provider` (item K2). Absent: the install's first provider with a key
   * (Anthropic, then OpenAI, then OpenRouter) and that provider's default model. Read only from the owner's own config; a project or a task cannot set it.
   */
  model: z.object({
    provider: z.string().regex(MODEL_PROVIDER_ID_PATTERN, "a provider id is lower-case letters, digits and hyphens (anthropic, openai, openrouter, or a `model-provider` plug-in's id)"),
    /** The request format, when the provider speaks several and the owner wants one other than its first (Bedrock: Claude through anthropic-messages, an open model through openai-completions). */
    api: z.enum(MODEL_REQUEST_FORMATS).optional(),
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/@~-]{0,199}$/u, "a model id is plain characters, as the provider lists it (for OpenRouter, vendor/model)"),
  }).strict().optional(),
  plugins: z.array(PluginConfigEntrySchema).max(64),
}).strict().superRefine((config, context) => {
  const seen = new Set<string>();
  const one = new Set<string>();
  config.plugins.forEach((entry, index) => {
    if (!entry.enabled) return;
    const id = `${entry.point}/${entry.name}`;
    if (seen.has(id)) context.addIssue({ code: "custom", path: ["plugins", index], message: "two enabled entries name the same plug-in" });
    seen.add(id);
    if (PLUGIN_POINT_CARDINALITY[entry.point] === "one") {
      if (one.has(entry.point)) context.addIssue({ code: "custom", path: ["plugins", index], message: `${entry.point} takes one adapter and the config enables two` });
      one.add(entry.point);
    }
  });
});
export type PluginConfig = z.infer<typeof PluginConfigSchema>;
