// TE-F2 part B (M2, release 0.5.19; te-f1 design 2.3; the redirect check): the variables that point a model client at the helper, as PURE functions. F1-b owns the hosted builder (`model-sandbox-env.ts`: `rovara-models`, the
// dummy key, `GCE_METADATA_*`); it was not pushed when this was written, so the LAPTOP path builds its own map here from the catalog rows (F1-b's builder replaces it for the hosted run), and this file adds the `/f/<mode>`
// failure base URL as a pure function (F1-b asked for that one).
//
// The dummy key is a fixed, non-secret string that matches no real key shape. On the laptop the worker inherits the user's shell, which may hold REAL keys: every model key variable the catalog knows, and a few it does not
// list, is OVERRIDDEN with the dummy here, and `GOOGLE_APPLICATION_CREDENTIALS` (a key FILE path a Google client would read, then call `oauth2.googleapis.com` with) is emptied. A client that ignores the redirect can still
// reach a real host on a laptop (nothing blocks model hosts there), and the dummy key is all it sends.
import { MODEL_REDIRECT_ENV_NAMES, isServedModelFamily, type ModelCatalogRow } from "@agentx/contracts";

export const MODEL_DUMMY_KEY = ["rovara", "test", "key"].join("-");
/** Key-shaped variables that no catalog row lists but that real model clients read. */
const EXTRA_KEY_VARIABLES = ["OPENROUTER_API_KEY", "AZURE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_VERTEX_API_KEY", "COHERE_API_KEY", "FIREWORKS_API_KEY", "DEEPSEEK_API_KEY", "XAI_API_KEY", "PERPLEXITY_API_KEY"] as const;
/** The key variables a laptop run overrides with the dummy: every catalog name ending `_API_KEY` or `_KEY`, each row's own, and the extras. Sorted, no duplicates. */
export function modelKeyVariables(rows: readonly Pick<ModelCatalogRow, "redirect">[] = []): string[] {
  const names = new Set<string>([...MODEL_REDIRECT_ENV_NAMES.filter((name) => name.endsWith("_KEY")), ...EXTRA_KEY_VARIABLES]);
  for (const row of rows) for (const redirect of row.redirect) if (redirect.kind === "env_var") for (const name of redirect.companion) if (name.endsWith("_KEY")) names.add(name);
  return [...names].sort();
}

/** The row's base URL on the helper: `<base>/p/<row>[/f/<mode>[.variant][/n/<n>]]<prefix>`; `prefix` is the row's own (`/v1beta/openai`), or `/v1` for an OpenAI-compatible row that has none. */
export function modelRowBaseUrl(row: Pick<ModelCatalogRow, "id" | "family" | "pathPrefix">, baseUrl: string, failure?: { readonly mode: string; readonly variant?: string | undefined; readonly afterCalls?: number | undefined }): string {
  const prefix = row.pathPrefix ?? (row.family === "openai_compatible" ? "/v1" : "");
  const failurePart = failure === undefined ? "" : `/f/${failure.mode}${failure.variant === undefined ? "" : `.${failure.variant}`}${failure.afterCalls === undefined ? "" : `/n/${String(failure.afterCalls)}`}`;
  return `${baseUrl.replace(/\/+$/u, "")}/p/${row.id}${failurePart}${prefix}`;
}
/** The base URL a client uses to reach the helper's FAILURE PACK for one row and mode (F1-b's env builder calls this; it is pure). */
export const modelFailureBaseUrl = modelRowBaseUrl;

export interface LaptopModelEnvironmentInput {
  /** The catalog rows (built-in plus the company's gateways turned into rows). */
  readonly rows: readonly ModelCatalogRow[];
  /** Which rows the project's client is pointed at (a reply set per family does not say which row; the readiness run does). */
  readonly rowIds: readonly string[];
  /** `http://127.0.0.1:<port>`. */
  readonly baseUrl: string;
  /** `127.0.0.1:<meta port>` for a Vertex row. */
  readonly metadataHostPort?: string | undefined;
  readonly projectId?: string | undefined;
  readonly location?: string | undefined;
}
export type LaptopModelEnvironment = { readonly ok: true; readonly environment: Readonly<Record<string, string>> } | { readonly ok: false; readonly reason: "unknown_row" | "not_served" | "conflict" };

/**
 * The variables a laptop run's commands get: each selected row's base-URL variables pointed at the helper, its companion variables (a project, a location, the metadata server), the dummy key in EVERY key variable the
 * user's shell might hold, and an emptied `GOOGLE_APPLICATION_CREDENTIALS`. Two rows that want one variable with different values are a conflict, refused (never a silent last-wins).
 */
export function laptopModelEnvironment(input: LaptopModelEnvironmentInput): LaptopModelEnvironment {
  const environment: Record<string, string> = Object.create(null) as Record<string, string>;
  let conflict = false;
  const set = (name: string, value: string): void => {
    if (environment[name] !== undefined && environment[name] !== value) conflict = true;
    environment[name] = value;
  };
  for (const id of input.rowIds) {
    const row = input.rows.find((candidate) => candidate.id === id);
    if (row === undefined) return { ok: false, reason: "unknown_row" };
    if (!isServedModelFamily(row.family)) return { ok: false, reason: "not_served" };
    const redirect = row.redirect.find((entry) => entry.kind === "env_var");
    if (redirect?.kind !== "env_var") return { ok: false, reason: "not_served" };
    const url = modelRowBaseUrl(row, input.baseUrl);
    for (const name of redirect.names) set(name, url);
    for (const name of redirect.companion) {
      if (name.endsWith("_KEY")) continue;
      if (name === "GOOGLE_CLOUD_PROJECT" && input.projectId !== undefined) set(name, input.projectId);
      else if (name === "GOOGLE_CLOUD_LOCATION") set(name, input.location ?? "us-central1");
      else if ((name === "GCE_METADATA_HOST" || name === "GCE_METADATA_IP") && input.metadataHostPort !== undefined) set(name, input.metadataHostPort);
    }
  }
  if (conflict) return { ok: false, reason: "conflict" };
  for (const name of modelKeyVariables(input.rows)) if (environment[name] === undefined) environment[name] = MODEL_DUMMY_KEY;
  environment.GOOGLE_APPLICATION_CREDENTIALS = "";
  return { ok: true, environment };
}
