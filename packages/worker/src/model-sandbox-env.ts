// TE-F1b (M2, release 0.5.19; te-f1 design 2.3): the VARIABLES a sandbox gets so customer code is pointed at the model helper instead of a real model host. Per row: the base URL (`http://rovara-models:8080/p/<rowId>`, plus the row's own
// API prefix for the clients whose variable carries it), the DUMMY key (one fixed, non-secret string that matches no real key shape), and, ONLY for a project with a Vertex row, the project, the location and Google's metadata-server
// variables (`GCE_METADATA_HOST` and `GCE_METADATA_IP`, the helper's address and port 8081, so a Google auth library finds a "credential" at the helper and sends a dummy token).
//
// What this module is: a pure builder. It returns data (`ServiceEnvironment`, service-env.ts); the one place a value is written is `withServiceEnvFile` (an env file of the exec on the run's tmpfs, mode 0600, removed when the
// call returns). The worker's own process environment is never read or written. The caller passes these variables to a command LAST, after anything the project or the task sets (service-env.ts FOR TS30), so a repository's own
// `OPENAI_BASE_URL` cannot win.
//
// Rules, each with a test: the names are F0a's allow-list (`MODEL_REDIRECT_ENV_NAMES`; a loader, proxy or AWS variable can never be written by a row); a row id is a plain id (it goes into a URL); the helper's address is .9 of a run
// network; the metadata variables belong to a Vertex row only; two rows may not set one variable to two values (the readiness run chooses which client to point); a value is a printable word (no line break can add a variable).
// A row's FIRST `env_var` redirect is used; the others (a client that needs a per-client choice) are the readiness run's. The per-exec real-call token segment (`/x/<token>`) is F1-c's, not here.
import { MODEL_REDIRECT_ENV_NAMES, type CompanyGatewayRow, type ModelCatalogRow } from "@agentx/contracts";
import { MODEL_HELPER_ALIAS } from "./run-network.js";
import { isModelHelperAddress } from "./model-helper-block.js";
import type { ServiceEnvironment } from "./service-env.js";

/** The helper's HTTP port and the metadata server's (TE-F2's `MODEL_HELPER_DEFAULT_PORT` and `MODEL_HELPER_DEFAULT_META_PORT`). */
export const MODEL_HELPER_PORT = 8080;
export const MODEL_METADATA_PORT = 8081;
export const MODEL_HELPER_BASE_URL = `http://${MODEL_HELPER_ALIAS}:${String(MODEL_HELPER_PORT)}`;
/** One fixed, non-secret string: it matches no real key shape, so push protection and the redactor ignore it. Built at runtime, never a literal key. */
export const MODEL_DUMMY_KEY = ["rovara", "test", "key"].join("-");

/** The one error of this module; its message is a fixed sentence and never carries a value. */
export class ModelSandboxEnvError extends Error {
  constructor() {
    super("The model helper's environment could not be built");
    this.name = "ModelSandboxEnvError";
  }
}
const refuse = (): never => {
  throw new ModelSandboxEnvError();
};

const ALLOWED_NAMES: ReadonlySet<string> = new Set(MODEL_REDIRECT_ENV_NAMES);
const ROW_ID = /^[a-z][a-z0-9-]{0,39}$/u;
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u;
const LOCATION = /^[a-z][a-z0-9-]{0,38}[a-z0-9]$/u;
const VALUE = /^[\x21-\x7e]{1,2048}$/u;
/** The base-URL variables whose value carries the row's own API prefix (`/v1`, `/openai/v1`): the OpenAI-shaped clients add only the operation. The others (Azure's endpoint, Anthropic's, Cohere's, Google's) add their own. */
const KEEPS_PREFIX: ReadonlySet<string> = new Set(["OPENAI_BASE_URL", "GROQ_BASE_URL", "TOGETHER_BASE_URL"]);
const METADATA_NAMES: ReadonlySet<string> = new Set(["GCE_METADATA_HOST", "GCE_METADATA_IP"]);

/** The variables of a company gateway row, from the API shape it speaks (the row has no redirect list of its own). */
const GATEWAY_VARIABLES: Readonly<Record<CompanyGatewayRow["family"], { base: string; keys: readonly string[] }>> = {
  openai_compatible: { base: "OPENAI_BASE_URL", keys: ["OPENAI_API_KEY"] },
  anthropic_messages: { base: "ANTHROPIC_BASE_URL", keys: ["ANTHROPIC_API_KEY"] },
  gemini: { base: "GOOGLE_GEMINI_BASE_URL", keys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"] },
  cohere: { base: "CO_API_URL", keys: ["CO_API_KEY"] },
};

export interface ModelSandboxEnvInput {
  /** The rows the project uses (catalog rows and company gateway rows). */
  rows: readonly (ModelCatalogRow | CompanyGatewayRow)[];
  /** The model helper's address (.9 of the helper network): the metadata variables name it. */
  helperIp: string;
  /** The connected Vertex project and location: required when a Vertex row is among the rows. */
  vertex?: { projectId: string; location: string };
}

function baseUrl(rowId: string, variable: string, pathPrefix: string | undefined): string {
  return `${MODEL_HELPER_BASE_URL}/p/${rowId}${KEEPS_PREFIX.has(variable) && pathPrefix !== undefined ? pathPrefix : ""}`;
}

/** Builds the variables. Throws `ModelSandboxEnvError` (one fixed sentence) on anything that is not in its plain form. Entries are sorted by name. */
export function buildModelSandboxEnvironment(input: ModelSandboxEnvInput): ServiceEnvironment {
  if (!isModelHelperAddress(input.helperIp)) refuse();
  const values = new Map<string, string>();
  const set = (name: string, value: string): void => {
    if (!ALLOWED_NAMES.has(name) || !VALUE.test(value)) refuse();
    const existing = values.get(name);
    if (existing !== undefined && existing !== value) refuse();
    values.set(name, value);
  };
  for (const row of input.rows) {
    if (typeof row.id !== "string" || !ROW_ID.test(row.id)) refuse();
    if (!("redirect" in row)) {
      const shape = GATEWAY_VARIABLES[row.family];
      if (shape === undefined) refuse();
      set(shape.base, baseUrl(row.id, shape.base, row.pathPrefix));
      for (const key of shape.keys) set(key, MODEL_DUMMY_KEY);
      continue;
    }
    const redirect = row.redirect.find((entry) => entry.kind === "env_var");
    if (redirect === undefined || redirect.kind !== "env_var") continue;
    for (const name of redirect.names) set(name, baseUrl(row.id, name, row.pathPrefix));
    for (const name of redirect.companion) {
      if (/_API_KEY$/u.test(name)) set(name, MODEL_DUMMY_KEY);
      else if (METADATA_NAMES.has(name)) {
        // Google's metadata-server variables belong to a Vertex row, and nothing else may carry them.
        if (row.family !== "vertex") refuse();
        set(name, `${input.helperIp}:${String(MODEL_METADATA_PORT)}`);
      } else if (name === "GOOGLE_CLOUD_PROJECT" || name === "GOOGLE_CLOUD_LOCATION") {
        if (row.family !== "vertex" || input.vertex === undefined) refuse();
        const value = name === "GOOGLE_CLOUD_PROJECT" ? input.vertex!.projectId : input.vertex!.location;
        if (!(name === "GOOGLE_CLOUD_PROJECT" ? PROJECT_ID : LOCATION).test(value)) refuse();
        set(name, value);
      } else refuse();
    }
  }
  return { entries: [...values].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)), secretValues: [] };
}
