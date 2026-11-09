// Port lane W0, port 4: the plug-in points and the config that names the adapters.
//
// ONE registry (decisions 40, 45.5 and 51). Pratik's spec 062 phase 3 registers channel adapters at run time (an administrator
// PUTs a callback URL and gets a signing secret). That stays the way an out-of-process channel adapter joins; here it is the
// `channel` point of the same registry: such an adapter is registered under its channel id like any other, and an in-process
// adapter is named in the config file. A "plug-in point" is what decision 40 calls a plug-in kind; it is named a point here so
// it cannot be mixed up with an adapter's own kind (`github`, `linear`), which the code-host, tracker and check-runner
// contracts call `PluginKind`.
import { z } from "zod";
import type { ChannelCapabilities, ChannelDecision, ChannelEvent } from "../channel-adapter.js";
import type { InboundMessage } from "../conversation.js";
import type { DocumentStore } from "./document-store.js";
import type { JsonObject } from "./json.js";
import type { ModelKeyStore } from "./model-keys.js";
import type { Admission, Approvers, IdentityProvider, Metering } from "./policy.js";
import type { AuditSink } from "./audit-sink.js";
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
  identity: "many",
  "build-system": "many",
  admission: "one",
  "audit-sink": "one",
  approvers: "one",
  metering: "one",
  "model-keys": "one",
};

/** What a plug-in is called: lower-case words and digits with hyphens, the same shape as an adapter's kind. */
export const PluginNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);

// ---- The channel point: Pratik's channel adapters, in-process ----

/** Where an in-process channel adapter hands what it heard. The adapter is trusted by the config that named it (no signature). */
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
  /** Rovara to the channel. At least once: `event.id` is stable across retries, so an adapter drops a repeat. */
  deliver(event: ChannelEvent): Promise<void>;
  /** In-process adapters begin listening here. Webhook adapters need no listener: they post to the channel API. */
  start?(sink: ChannelInboundSink): Promise<{ stop(): Promise<void> }>;
}

/**
 * The thing an adapter of a point not yet specified in W0 must be. The lane that defines the point's port (L1 brings code host,
 * tracker and check runner) narrows its line in `PluginPointTypes` to the real interface. Until then only the name is known.
 */
export interface UnspecifiedAdapter {
  readonly kind?: string;
}

/** The adapter type for each point. A lane that adds a port edits its own line here. */
export interface PluginPointTypes {
  "code-host": UnspecifiedAdapter;
  tracker: UnspecifiedAdapter;
  "check-runner": UnspecifiedAdapter;
  channel: ChannelAdapter;
  "worker-machines": WorkerMachines;
  storage: DocumentStore;
  queue: QueueService;
  monitoring: UnspecifiedAdapter;
  learning: UnspecifiedAdapter;
  "team-record-source": UnspecifiedAdapter;
  identity: IdentityProvider;
  "build-system": UnspecifiedAdapter;
  admission: Admission;
  "audit-sink": AuditSink;
  approvers: Approvers;
  metering: Metering;
  "model-keys": ModelKeyStore;
}

export type AdapterOf<P extends PluginPoint> = PluginPointTypes[P];

// ---- The registry ----

export interface AdapterRegistration {
  /** Set for Code's built-in defaults: a configured adapter replaces a default without a conflict. */
  isDefault?: boolean;
}

export interface AdapterRegistry {
  /** Adds an adapter. Throws when the name is taken, or when a `one` point already holds an adapter that is not a default. */
  register<P extends PluginPoint>(point: P, name: string, adapter: AdapterOf<P>, registration?: AdapterRegistration): void;
  /** Removes an adapter (a channel adapter an administrator deleted). Returns whether there was one. */
  unregister(point: PluginPoint, name: string): boolean;
  get<P extends PluginPoint>(point: P, name: string): AdapterOf<P> | undefined;
  /**
   * The adapter by name; with no name, the only adapter of the point. Throws a `PluginRegistryError` (`not_registered`, or
   * `ambiguous` when several are registered and no name was given).
   */
  require<P extends PluginPoint>(point: P, name?: string): AdapterOf<P>;
  names(point: PluginPoint): string[];
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
  companyId: string;
  /** This adapter's block of the config file. Never holds a secret in clear: name where to read it (a file, an environment variable). */
  settings: JsonObject;
  registry: AdapterRegistry;
  now: () => Date;
}

export const PLUGIN_CONFIG_VERSION = 1;

/**
 * Where a module comes from: a package name (`@rovara/plugin-github`) or a path inside the project that starts with `./` or `../`
 * (resolved against the config file). Never a URL, an absolute path, or a path with `..` in the middle.
 */
export function isAllowedModuleSpecifier(value: string): boolean {
  const relative = /^(\.\/|\.\.\/)([A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(value);
  const packageName = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(\/[A-Za-z0-9._-]+)*$/.test(value);
  if (!relative && !packageName) return false;
  // Leading `./` and `../` steps are the relative form; any `.` or `..` after them walks around and is refused.
  const segments = value.split("/");
  while (relative && (segments[0] === "." || segments[0] === "..")) segments.shift();
  return segments.every((segment) => segment !== "." && segment !== "..");
}
export const PluginModuleSpecifierSchema = z.string().min(1).max(256).refine(
  isAllowedModuleSpecifier,
  "a package name, or a relative path that starts with ./ or ../ (no URL, no absolute path)",
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
  /** The company Code runs as (decision 45.6). Absent: the implicit company. */
  companyId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
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
