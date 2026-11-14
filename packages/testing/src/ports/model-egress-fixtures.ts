// Fixtures for the `model-egress` suite and its tests: one egress row per family (built through F0a's own row schema, so a row that is not a valid catalog row cannot exist here), a Vertex connection, and keys built AT RUNTIME
// (the public repository refuses key-shaped strings, so no key, token or key file is ever a literal).
import { createHash } from "node:crypto";
import { builtinModelCatalog, parseModelEgressRow, type ModelEgressConnection, type ModelEgressRow } from "@agentx/contracts";

/** A key-shaped string that depends only on the label, built at runtime: `sk-` style on purpose, so the scrubber and the logs are tested against a realistic shape. */
export function fixtureKey(label: string): string {
  const hex = createHash("sha256").update(`rovara-model-egress-fixture/${label}`).digest("hex");
  return ["fx", "key", hex.slice(0, 40)].join("-");
}

/** A token-shaped string for the Google token schemes, built at runtime. */
export function fixtureToken(label: string): string {
  return ["ya29", "fx", createHash("sha256").update(`token/${label}`).digest("base64url").slice(0, 48)].join(".");
}

const PRICES = [
  { model: "fixture-small", inputMicrosPerMTok: 150_000, outputMicrosPerMTok: 600_000 },
  { model: "fixture-large", inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000 },
];
const egress = (scheme: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ scheme, defaultMaxOutputTokens: 1024, prices: PRICES, ...extra });

function row(input: Record<string, unknown>): ModelEgressRow {
  const parsed = parseModelEgressRow(input);
  if (!parsed.ok) throw new Error(`fixture row is not valid: ${parsed.reason}`);
  return parsed.row;
}

/** The connection of the fixture sources: a Vertex project and location, and the Azure resource's own host (an Azure row names only a domain suffix). */
export const FIXTURE_AZURE_HOST = "fixture-resource.openai.azure.com";
export const FIXTURE_VERTEX_CONNECTION: ModelEgressConnection = { vertex: { project: "fixture-project-1", location: "us-central1" }, host: FIXTURE_AZURE_HOST };

/** F0a's built-in catalog row, as JSON, so every fixture row is a real catalog row (the same prefixes, hosts and auth the real catalog has). */
function catalogRow(id: string): Record<string, unknown> {
  const found = builtinModelCatalog().rows.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`the built-in catalog has no row ${id}`);
  return JSON.parse(JSON.stringify(found)) as Record<string, unknown>;
}

/** One row per family the core serves, plus a Bedrock row (served by nothing here). The hosts are the real providers' hosts: the suite proves nothing is ever sent to one. */
export function fixtureEgressRows(): Record<"gemini" | "vertex" | "openai" | "openrouter" | "anthropic" | "cohere" | "azure" | "bedrock", ModelEgressRow> {
  return {
    gemini: row({ ...catalogRow("gemini"), ...egress("header:x-goog-api-key") }),
    vertex: row({ ...catalogRow("vertex"), ...egress("gcp-oauth:federation") }),
    openai: row({ ...catalogRow("openai"), ...egress("bearer") }),
    openrouter: row({ ...catalogRow("openrouter"), ...egress("bearer") }),
    anthropic: row({ ...catalogRow("anthropic"), ...egress("header:x-api-key") }),
    cohere: row({ ...catalogRow("cohere"), ...egress("bearer") }),
    azure: row({ ...catalogRow("azure-openai"), ...egress("header:api-key", { azure: { deployment: "fixture-small", apiVersion: "2024-06-01" } }) }),
    bedrock: row({
      id: "bedrock", kind: "provider", hosts: ["bedrock-runtime.us-east-1.amazonaws.com"], authHosts: [], family: "bedrock", auth: [{ scheme: "sigv4" }], routesTo: "local_aws_front",
      redirect: [{ kind: "none", client: "a fixture client", verified: false }], streaming: ["aws_event_stream"], errors: { rateLimit: "fx.rate_limit", tokenLimit: "fx.token_limit", refusal: "fx.refusal", badToolJson: "fx.bad_tool_json", cutOffStream: "fx.cut_off_stream" }, notes: [],
      ...egress("sigv4"),
    }),
  };
}
