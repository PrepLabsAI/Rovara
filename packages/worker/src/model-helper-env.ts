// TE-F2 part B (M2, release 0.5.19; te-f1 design 2.3; the redirect check): the variables that point a model client at the helper, as PURE functions. F1-b owns the hosted builder (`model-sandbox-env.ts`: `rovara-models`, the
// dummy key, `GCE_METADATA_*`); it was not pushed when this was written, so the LAPTOP path builds its own map here from the catalog rows (F1-b's builder replaces it for the hosted run), and this file adds the `/f/<mode>`
// failure base URL as a pure function (F1-b asked for that one).
//
// The dummy key is a fixed, non-secret string that matches no real key shape. On the laptop the worker inherits the user's shell, which may hold REAL AI-provider and cloud credentials. The GOAL: none of them reaches a model host
// from a customer's test in a helper round. Three layers, all returned from `laptopModelEnvironment` (`environment` is SET in the commands, `unset` is REMOVED from them):
//   1. SET: every model key and token variable the catalog or this file knows (`modelKeyVariables`) gets the dummy; the redirect variables point at the helper.
//   2. UNSET (removed, not blanked, so a client sees no credential at all), case-insensitively: every variable of the user's shell whose name (a) CONTAINS `APIKEY`, `API_KEY`, `TOKEN`, `SECRET`, `CREDENTIAL` or
//      `PASSPHRASE` (`AUTH_TOKEN` is covered by `TOKEN`); (b) starts with an AI or cloud VENDOR (OPENAI, ANTHROPIC, GEMINI, GOOGLE, VERTEX, AZURE, MISTRAL, GROQ, COHERE, DEEPSEEK, XAI, TOGETHER, PERPLEXITY, FIREWORKS,
//      OPENROUTER, HF, HUGGING, HUGGINGFACE, BEDROCK, AWS, GCP, GCLOUD, CLOUDSDK, HELICONE, PORTKEY, LLM, AI, MODEL) and an underscore and later has KEY, AUTH, BEARER, CREDENTIAL or PAT (`GEMINI_KEY`, `OPENAI_AUTH`); (c)
//      contains `PRIVATE_KEY` or `SERVICE_ACCOUNT`; (d) is `GH_PAT` or `GITHUB_PAT`; and an explicit list of cloud and AI names even when the shell does not hold them now (AWS keys, profile and bearer token, Google OAuth, Hugging Face). KEPT on purpose, because
//      blanking them breaks ordinary local tests and protects no AI key: `DATABASE_URL`, `REDIS_URL`, every database `*_PASSWORD`/`*_PASS`/`*_PWD` and `PGPASSWORD` variable (unless the name ALSO carries an AI or cloud
//      pattern above: `OPENAI_API_KEY_PASS` is unset), `SSH_AUTH_SOCK`, `SENTRY_DSN`, `GCLOUD_PROJECT`, `GOOGLE_CLOUD_QUOTA_PROJECT`, `TOKENIZERS_PARALLELISM`, and BARE non-vendor `*_KEY` names such as `STRIPE_KEY` and
//      `CACHE_KEY` (as often a cache key as a secret). The rule and the kept list are `isCredentialVariable` and `KEPT_VARIABLES` below; the PR body and the release notes repeat them.
//      A project test that needs one of the unset names in a helper round on a laptop must be given it by the readiness run, never inherited from the shell.
//   3. Only a round with a Vertex row points `CLOUDSDK_CONFIG` at an EMPTY worker-owned directory and `GCE_METADATA_*` at the helper. The inherited shell's `GOOGLE_APPLICATION_CREDENTIALS` is removed by layer 2;
//      the project's own setting survives in `withModelHelperRound`. Its library may mint a token with its own credential; the helper drops any inbound bearer.
// A client that ignores the redirect can still reach a real host on a laptop without the name block; project-provided Google credentials are preserved.
import { MODEL_REDIRECT_ENV_NAMES, isServedModelFamily, type ModelCatalogRow } from "@agentx/contracts";

export const MODEL_DUMMY_KEY = ["rovara", "test", "key"].join("-");
/** Key-shaped variables that no catalog row lists but that real model clients read. */
const EXTRA_KEY_VARIABLES = ["ANTHROPIC_AUTH_TOKEN", "AZURE_OPENAI_AD_TOKEN", "OPENAI_ADMIN_KEY", "HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "OPENROUTER_API_KEY", "AZURE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_VERTEX_API_KEY", "COHERE_API_KEY", "FIREWORKS_API_KEY", "DEEPSEEK_API_KEY", "XAI_API_KEY", "PERPLEXITY_API_KEY"] as const;
/** The key variables a laptop run overrides with the dummy: every catalog name ending `_API_KEY` or `_KEY`, each row's own, and the extras. Sorted, no duplicates. */
export function modelKeyVariables(rows: readonly Pick<ModelCatalogRow, "redirect">[] = []): string[] {
  const names = new Set<string>([...MODEL_REDIRECT_ENV_NAMES.filter((name) => name.endsWith("_KEY")), ...EXTRA_KEY_VARIABLES]);
  for (const row of rows) for (const redirect of row.redirect) if (redirect.kind === "env_var") for (const name of redirect.companion) if (name.endsWith("_KEY")) names.add(name);
  return [...names].sort();
}

const CREDENTIAL_WORD = /APIKEY|API_KEY|TOKEN|SECRET|CREDENTIAL|PASSPHRASE/iu;
/** An AI or cloud VENDOR prefix, then anything, then KEY, AUTH, BEARER, CREDENTIAL or PAT: `GEMINI_KEY`, `OPENAI_AUTH`, `AWS_ACCESS_KEY`, `ANTHROPIC_OAUTH`. */
const VENDOR_CREDENTIAL = /^(?:OPENAI|ANTHROPIC|GEMINI|GOOGLE|VERTEX|VERTEXAI|AZURE|MISTRAL|GROQ|COHERE|DEEPSEEK|XAI|TOGETHER|PERPLEXITY|FIREWORKS|OPENROUTER|HF|HUGGING|HUGGINGFACE|BEDROCK|AWS|GCP|GCLOUD|CLOUDSDK|HELICONE|PORTKEY|LLM|AI|MODEL)_.*(?:KEY|AUTH|BEARER|CREDENTIAL|PAT)/iu;
/** Variables the rule never unsets: databases, ssh, monitoring and the two Google project names. Matched case-insensitively and exactly. */
export const KEPT_VARIABLES: readonly string[] = ["DATABASE_URL", "REDIS_URL", "SSH_AUTH_SOCK", "SENTRY_DSN", "GCLOUD_PROJECT", "GOOGLE_CLOUD_QUOTA_PROJECT", "PGPASSWORD", "TOKENIZERS_PARALLELISM"];
const KEPT_SET: ReadonlySet<string> = new Set(KEPT_VARIABLES.map((name) => name.toUpperCase()));
/**
 * Whether a name of the user's shell is an AI-provider or cloud credential (and not on the exact kept list). The AI and cloud patterns come FIRST: `OPENAI_API_KEY_PASS`, `ANTHROPIC_API_KEY_PWD` and `GITHUB_TOKEN_PASSWORD` are
 * unset even though they end like a database password. A name with none of the words (`DB_PASSWORD`, `POSTGRES_PASS`, `MYSQL_PWD`) matches nothing here and so is kept, and so are bare non-vendor `*_KEY` names such as
 * `STRIPE_KEY` and `CACHE_KEY`, deliberately: they are as often a cache key as a secret and blanking them breaks ordinary tests.
 */
export function isCredentialVariable(name: string): boolean {
  if (KEPT_SET.has(name.toUpperCase())) return false;
  return VENDOR_CREDENTIAL.test(name) || /PRIVATE_KEY|SERVICE_ACCOUNT/iu.test(name) || /^(?:GH_PAT|GITHUB_PAT)$/iu.test(name) || CREDENTIAL_WORD.test(name);
}
/** Cloud and AI credential names unset even when the shell does not hold them now (a profile file may set them later): AWS, Google OAuth, Hugging Face. */
export const EXPLICIT_UNSET_VARIABLES = [
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_SECURITY_TOKEN", "AWS_BEARER_TOKEN_BEDROCK", "AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_SHARED_CREDENTIALS_FILE", "AWS_CONFIG_FILE",
  "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_ROLE_ARN", "GOOGLE_OAUTH_ACCESS_TOKEN", "CLOUDSDK_AUTH_ACCESS_TOKEN", "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE", "HUGGING_FACE_HUB_TOKEN",
] as const;

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
  /** `127.0.0.1:<meta port>`: used only when a selected row is Vertex. */
  readonly metadataHostPort: string;
  readonly projectId?: string | undefined;
  readonly location?: string | undefined;
  /** An EMPTY worker-owned directory for `CLOUDSDK_CONFIG`, used only for a Vertex round. */
  readonly adc: { readonly cloudsdkConfigDir: string };
  /** The user's shell (default `process.env`): every credential-shaped name in it is unset. */
  readonly inherited?: Readonly<Record<string, string | undefined>>;
}
export type LaptopModelEnvironment = { readonly ok: true; readonly environment: Readonly<Record<string, string>>; readonly unset: readonly string[] } | { readonly ok: false; readonly reason: "unknown_row" | "not_served" | "conflict" };

/**
 * The variables a laptop run's commands get (`environment`, set) and lose (`unset`): each selected row's base-URL variables pointed at the helper, its companion variables, the dummy key in EVERY model key variable, the
 * Vertex credential search pointed at the helper's metadata server, and every AI-provider or cloud credential of the user's shell removed. Two rows that want one variable with different values are a conflict, refused.
 */
export function laptopModelEnvironment(input: LaptopModelEnvironmentInput): LaptopModelEnvironment {
  const environment: Record<string, string> = Object.create(null) as Record<string, string>;
  let conflict = false;
  let hasVertex = false;
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
    if (row.family === "vertex") hasVertex = true;
    const url = modelRowBaseUrl(row, input.baseUrl);
    for (const name of redirect.names) set(name, url);
    for (const name of redirect.companion) {
      if (name.endsWith("_KEY")) continue;
      if (name === "GOOGLE_CLOUD_PROJECT" && input.projectId !== undefined) set(name, input.projectId);
      else if (name === "GOOGLE_CLOUD_LOCATION") set(name, input.location ?? "us-central1");
    }
  }
  if (conflict) return { ok: false, reason: "conflict" };
  for (const name of modelKeyVariables(input.rows)) if (environment[name] === undefined) environment[name] = MODEL_DUMMY_KEY;
  // Layer 3 is Vertex-only. Never overwrite the project's own credential-file setting.
  if (hasVertex) {
    environment.CLOUDSDK_CONFIG = input.adc.cloudsdkConfigDir;
    environment.GCE_METADATA_HOST = input.metadataHostPort;
    environment.GCE_METADATA_IP = input.metadataHostPort;
  }
  // Layer 2: everything else of the shell that is an AI or cloud credential is UNSET (never blanked).
  const unset = new Set<string>(EXPLICIT_UNSET_VARIABLES);
  for (const name of Object.keys(input.inherited ?? process.env)) if (isCredentialVariable(name)) unset.add(name);
  for (const name of Object.keys(environment)) unset.delete(name);
  return { ok: true, environment, unset: [...unset].sort() };
}
