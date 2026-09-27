import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import {
  BUILT_IN_CONNECTOR_TYPES,
  type StoredConnectorConfig,
} from "../../packages/broker/src/aws/connector-types.js";
import type { ConnectorPolicy } from "../../packages/gateway/src/index.js";
import {
  ConnectorNameSchema,
  JiraConnectorSchema,
  StoredProjectDefinitionSchema,
  type ActionPolicy,
  type ProjectDefinition,
} from "../../packages/contracts/src/index.js";

export const EVAL_ROOT = fileURLToPath(new URL(".", import.meta.url)).replace(/\/$/, "");

const Phrase = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

/** The case format of contracts/evaluation.md: one JSON object per line in tests/eval/cases/*.jsonl. */
export const EvalCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,64}$/),
  project: z.string().regex(/^fixtures\/[a-z0-9-]+\.yaml$/),
  prompt: z.string().min(1).max(4_000),
  expect: z.object({
    tool: z.union([z.string().min(1), z.null(), z.array(z.string().min(1)).min(2)]),
    argsSubset: z.record(z.string(), z.unknown()).optional(),
    refusal: Phrase.optional(),
    contains: Phrase.optional(),
    /** Most non-empty lines the reply may have once Slack formatting is applied (spec 014 SC-006); the run uses the Slack reply style. */
    maxLines: z.number().int().min(1).max(20).optional(),
    /** The action gate's decision on the turn's first call (spec 014 SC-004, SC-005); only the new presentation has the gate. */
    gate: z.enum(["allow", "ask", "deny"]).optional(),
  }).strict().refine((value) => value.tool !== null || value.refusal !== undefined || value.contains !== undefined,
    "a case that expects no tool needs a refusal or contains phrase")
    .refine((value) => value.gate === undefined || value.tool !== null, "a gate expectation needs an expected tool"),
  source: z.enum(["synthetic", "channel", "channel-reconstructed", "turn-export"]).optional(),
  note: z.string().max(500).optional(),
}).strict();

/** One tool as the vendor's MCP server lists it, recorded after the binder removed its server-bound properties. */
export const UpstreamToolSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  // What the vendor tool does; the presented access comes from the project's approval, as in production.
  access: z.enum(["read", "write"]),
  description: z.string().max(2_048),
  inputSchema: z.record(z.string(), z.unknown()),
}).strict();

/**
 * Thread state a registered project definition cannot express, kept under the fixture's own `eval`
 * key: connectors whose credential is missing in this deployment, and unfinished operations.
 */
const EvalSettingsSchema = z.object({
  notConnected: z.array(ConnectorNameSchema).default([]),
  recoverableOperations: z.array(z.uuid()).default([]),
}).strict();

export interface EvalConnector {
  name: string;
  type: string;
  /** Thread and manifest label, for example "GitHub issues". */
  label: string;
  /** Vendor name in presented descriptions, for example "GitHub". */
  vendor: string;
  scopeNoun: string;
  /** The recorded catalog, tests/eval/catalogs/<catalog>.json; one per connector type. */
  catalog: string;
  scopes: string[];
  policy: ConnectorPolicy;
  approvals: ReadonlyArray<{ name: string; description?: string | undefined; examples?: ReadonlyArray<Record<string, unknown>> | undefined }>;
  connected: boolean;
  /** For a jira connector only: each scope's configured siteUrl (undefined where a scope has none), for the reply-link guard (issue 061). */
  jiraScopeSites?: Array<string | undefined>;
}

export interface EvalProject {
  name: string;
  instructions: string;
  repositories: string[];
  connectors: EvalConnector[];
  recoverableOperations: string[];
  /** The project's action policy (spec 014), which the gate applies in a gate case. */
  actionPolicy?: ActionPolicy | undefined;
}

/**
 * A fixture project: a project definition in the registered format (the same files the Linear and
 * Jira branches add), resolved by the broker's own connector types, plus optional `eval` settings.
 * A connector that this release cannot resolve fails the parse; it is never dropped.
 */
export const EvalProjectSchema = z.object({ eval: EvalSettingsSchema.optional() }).passthrough().transform((value, context): EvalProject => {
  const { eval: settings, ...definition } = value;
  const parsed = StoredProjectDefinitionSchema.safeParse(definition);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) context.addIssue({ code: "custom", message: `${issue.path.join(".") || "project"}: ${issue.message}` });
    return z.NEVER;
  }
  const project = parsed.data as ProjectDefinition;
  const legacy = project.integrations?.githubMcp;
  const configs: StoredConnectorConfig[] = legacy
    ? [{ name: "github", type: "github", scopes: "all-repositories", tools: legacy.tools }]
    : project.integrations?.connectors ?? [];
  const notConnected = settings?.notConnected ?? [];
  for (const name of notConnected) {
    if (!configs.some((config) => config.name === name)) context.addIssue({ code: "custom", message: `eval.notConnected names ${name}, which the project does not configure` });
  }
  const connectors: EvalConnector[] = [];
  for (const config of configs) {
    const type = Object.hasOwn(BUILT_IN_CONNECTOR_TYPES, config.type) ? BUILT_IN_CONNECTOR_TYPES[config.type] : undefined;
    if (type === undefined) {
      context.addIssue({ code: "custom", message: `connector type ${config.type} (connector ${config.name}) has no connector type in this release` });
      continue;
    }
    const resolved = type.resolve(config, project, {});
    if ("unusable" in resolved) {
      context.addIssue({ code: "custom", message: `connector ${config.name} is unusable: ${resolved.unusable}` });
      continue;
    }
    // Re-parsed here (not read off `resolved.scopes`, which is generic over Scope) only to recover
    // each scope's siteUrl for the reply-link guard (issue 061); already validated once inside resolve.
    const jira = config.type === "jira" ? JiraConnectorSchema.safeParse(config).data : undefined;
    connectors.push({
      name: resolved.name,
      type: resolved.type,
      label: resolved.label,
      vendor: resolved.vendor,
      scopeNoun: resolved.scopeNoun,
      catalog: resolved.type,
      scopes: resolved.scopes.map((scope) => scope.alias),
      policy: resolved.policy,
      approvals: resolved.approvals,
      connected: !notConnected.includes(resolved.name),
      ...(jira === undefined ? {} : { jiraScopeSites: jira.scopes.map((scope) => scope.siteUrl) }),
    });
  }
  return {
    name: project.name,
    instructions: project.orchestratorInstructions,
    repositories: project.repositories.map((repository) => repository.name),
    connectors,
    recoverableOperations: settings?.recoverableOperations ?? [],
    ...(project.actionPolicy === undefined ? {} : { actionPolicy: project.actionPolicy }),
  };
});

export type EvalCase = z.infer<typeof EvalCaseSchema>;
export type UpstreamTool = z.infer<typeof UpstreamToolSchema>;

/**
 * The Jira site(s) a project configures, for the eval reply-link guard (issue 061): "unknown" when
 * the project has no Jira connector, or any of its scopes lacks a siteUrl, so a reply naming any
 * atlassian.net host is wrong; otherwise the distinct hosts a reply's link may legitimately name.
 */
export function jiraSiteHosts(project: EvalProject): "unknown" | string[] {
  const sites = project.connectors.flatMap((connector) => connector.jiraScopeSites ?? []);
  if (sites.length === 0 || sites.some((site) => site === undefined)) return "unknown";
  return [...new Set(sites.map((site) => new URL(site!).host))];
}

export async function loadCases(directory = join(EVAL_ROOT, "cases")): Promise<EvalCase[]> {
  const files = (await readdir(directory)).filter((file) => file.endsWith(".jsonl")).sort();
  const cases: EvalCase[] = [];
  for (const file of files) {
    const lines = (await readFile(join(directory, file), "utf8")).split("\n");
    lines.forEach((line, index) => {
      if (line.trim().length === 0) return;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        throw new Error(`${file}:${index + 1}: not JSON (${error instanceof Error ? error.message : String(error)})`, { cause: error });
      }
      const parsed = EvalCaseSchema.safeParse(value);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Error(`${file}:${index + 1}: ${issue ? `${issue.path.join(".") || "case"}: ${issue.message}` : "invalid case"}`);
      }
      cases.push(parsed.data);
    });
  }
  const ids = cases.map((entry) => entry.id);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate !== undefined) throw new Error(`duplicate evaluation case id ${duplicate}`);
  return cases;
}

export async function loadProject(path: string): Promise<EvalProject> {
  const parsed = EvalProjectSchema.safeParse(parse(await readFile(join(EVAL_ROOT, path), "utf8")));
  if (!parsed.success) throw new Error(`${path}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  return parsed.data;
}

export async function loadCatalog(name: string): Promise<UpstreamTool[]> {
  return z.array(UpstreamToolSchema).parse(JSON.parse(await readFile(join(EVAL_ROOT, "catalogs", `${name}.json`), "utf8")));
}
