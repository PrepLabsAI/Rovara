// Vertex AI credentials for the product route (DEC 229b): what a project connects in the product key store as provider
// "vertex". Two schemes:
// - "federation" (preferred): the customer's Google Cloud project trusts Rovara's AWS federation role through a workload
//   identity pool. Nothing secret is stored: the gateway assumes the role with the COMPANY as session name and exchanges a
//   signed AWS request for a short-lived Google token (product-vertex-token.ts). The pool's attribute condition names the
//   company's exact session ARN, so one company can't use another company's pool.
// - "service_account_key" (fallback): a Google service-account key file, sealed like an AI Studio key (write-only, rotatable).
// Both name the Google Cloud project and the Vertex location: the route sends calls ONLY there, whatever the request says.
// Parsing is strict and total: anything unexpected is refused as a whole, never partly read.
import { createPrivateKey } from "node:crypto";
import { COMPANY, record } from "./model-gateway-token.js";

/** Google Cloud project ids: 6 to 30 characters, lower-case letters, digits and hyphens, starting with a letter. */
export const GCP_PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u;
/** A regional Vertex location (us-central1, europe-west4, northamerica-northeast1) or "global". Multi-region (us, eu) is not offered. */
export const VERTEX_LOCATION = /^(?:global|[a-z]{2,15}-[a-z]{2,15}[0-9]{1,2})$/u;
/** The workload identity pool provider's full resource name (Google STS `audience`), with no https: scheme. */
export const WIF_AUDIENCE = /^\/\/iam\.googleapis\.com\/projects\/[0-9]{1,20}\/locations\/global\/workloadIdentityPools\/[a-z0-9-]{4,32}\/providers\/[a-z0-9-]{4,32}$/u;
/** A Google service account: user-managed, or a project's default compute account. */
export const SERVICE_ACCOUNT = /^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com|[0-9]{1,20}-compute@developer\.gserviceaccount\.com)$/u;
export const GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token";
const PRIVATE_KEY_ID = /^[a-f0-9]{40}$/u;
const MAX_PEM = 8192;

export type VertexCredential =
  | { scheme: "federation"; projectId: string; location: string; audience: string; serviceAccount?: string }
  | { scheme: "service_account_key"; projectId: string; location: string; clientEmail: string; privateKeyId: string; privateKey: string };
export type VertexScheme = VertexCredential["scheme"];
/** What Settings may show: never the private key. */
export interface VertexSummary { scheme: VertexScheme; projectId: string; location: string; serviceAccount?: string }

const exact = (r: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) =>
  required.every((k) => Object.hasOwn(r, k)) && Object.keys(r).every((k) => required.includes(k) || optional.includes(k));
const str = (v: unknown, pattern: RegExp): v is string => typeof v === "string" && v.length <= 256 && pattern.test(v);
/** An RSA private key of at least 2048 bits in PEM. Any parse failure is a refusal with no detail (the error is never kept). */
function rsaPem(v: unknown): v is string {
  if (typeof v !== "string" || v.length > MAX_PEM || !v.startsWith("-----BEGIN PRIVATE KEY-----")) return false;
  try {
    const key = createPrivateKey({ key: v, format: "pem" });
    return key.asymmetricKeyType === "rsa" && (key.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048;
  } catch { return false; }
}
const KEY_FILE_REQUIRED = ["type", "project_id", "private_key_id", "private_key", "client_email"] as const;
const KEY_FILE_OPTIONAL = ["client_id", "auth_uri", "token_uri", "auth_provider_x509_cert_url", "client_x509_cert_url", "universe_domain"] as const;
function parseKeyFile(value: unknown): { projectId: string; clientEmail: string; privateKeyId: string; privateKey: string } | undefined {
  let v = value;
  if (typeof v === "string") { if (v.length > 16_384) return undefined; try { v = JSON.parse(v) as unknown; } catch { return undefined; } }
  const f = record(v);
  if (f === undefined || !exact(f, KEY_FILE_REQUIRED, KEY_FILE_OPTIONAL) || f.type !== "service_account") return undefined;
  if (!str(f.project_id, GCP_PROJECT) || !str(f.client_email, SERVICE_ACCOUNT) || !str(f.private_key_id, PRIVATE_KEY_ID) || !rsaPem(f.private_key)) return undefined;
  // The token endpoint is fixed: a file that points elsewhere is refused (the gateway never sends a signed assertion anywhere else).
  if (f.token_uri !== undefined && f.token_uri !== GOOGLE_TOKEN_URI) return undefined;
  if (f.universe_domain !== undefined && f.universe_domain !== "googleapis.com") return undefined;
  if (KEY_FILE_OPTIONAL.some((k) => f[k] !== undefined && (typeof f[k] !== "string" || f[k].length > 512))) return undefined;
  return { projectId: f.project_id, clientEmail: f.client_email, privateKeyId: f.private_key_id, privateKey: f.private_key };
}

/**
 * The connect (or rotate) input: JSON text, one of
 * `{"scheme":"federation","projectId","location","audience","serviceAccount"?}` or
 * `{"scheme":"service_account_key","location","projectId"?,"keyFile":<the key file JSON, as an object or as its text>}`.
 */
export function parseVertexConnect(text: string): VertexCredential | undefined {
  if (typeof text !== "string" || text.length > 16_384) return undefined;
  let v: unknown;
  try { v = JSON.parse(text) as unknown; } catch { return undefined; }
  const r = record(v);
  if (r === undefined) return undefined;
  if (r.scheme === "federation") {
    if (!exact(r, ["scheme", "projectId", "location", "audience"], ["serviceAccount"])) return undefined;
    if (!str(r.projectId, GCP_PROJECT) || !str(r.location, VERTEX_LOCATION) || !str(r.audience, WIF_AUDIENCE) || (r.serviceAccount !== undefined && !str(r.serviceAccount, SERVICE_ACCOUNT))) return undefined;
    return { scheme: "federation", projectId: r.projectId, location: r.location, audience: r.audience, ...(r.serviceAccount === undefined ? {} : { serviceAccount: r.serviceAccount }) };
  }
  if (r.scheme === "service_account_key") {
    if (!exact(r, ["scheme", "location", "keyFile"], ["projectId"])) return undefined;
    if (!str(r.location, VERTEX_LOCATION) || (r.projectId !== undefined && !str(r.projectId, GCP_PROJECT))) return undefined;
    const file = parseKeyFile(r.keyFile);
    if (file === undefined) return undefined;
    return { scheme: "service_account_key", projectId: typeof r.projectId === "string" ? r.projectId : file.projectId, location: r.location, clientEmail: file.clientEmail, privateKeyId: file.privateKeyId, privateKey: file.privateKey };
  }
  return undefined;
}
/** The sealed form: only the fields the token flow needs, in a fixed order. */
export function serializeVertexCredential(c: VertexCredential): string {
  return c.scheme === "federation"
    ? JSON.stringify({ scheme: c.scheme, projectId: c.projectId, location: c.location, audience: c.audience, ...(c.serviceAccount === undefined ? {} : { serviceAccount: c.serviceAccount }) })
    : JSON.stringify({ scheme: c.scheme, projectId: c.projectId, location: c.location, clientEmail: c.clientEmail, privateKeyId: c.privateKeyId, privateKey: c.privateKey });
}
/** Re-checks an unsealed credential as strictly as at connect time. Undefined: unusable (never a guess). */
export function parseStoredVertexCredential(text: string): VertexCredential | undefined {
  if (typeof text !== "string" || text.length > 16_384) return undefined;
  let v: unknown;
  try { v = JSON.parse(text) as unknown; } catch { return undefined; }
  const r = record(v);
  if (r === undefined) return undefined;
  if (r.scheme === "federation") return parseVertexConnect(text);
  if (r.scheme !== "service_account_key" || !exact(r, ["scheme", "projectId", "location", "clientEmail", "privateKeyId", "privateKey"])) return undefined;
  if (!str(r.projectId, GCP_PROJECT) || !str(r.location, VERTEX_LOCATION) || !str(r.clientEmail, SERVICE_ACCOUNT) || !str(r.privateKeyId, PRIVATE_KEY_ID) || !rsaPem(r.privateKey)) return undefined;
  return { scheme: "service_account_key", projectId: r.projectId, location: r.location, clientEmail: r.clientEmail, privateKeyId: r.privateKeyId, privateKey: r.privateKey };
}
export function vertexSummary(c: VertexCredential): VertexSummary {
  const account = c.scheme === "federation" ? c.serviceAccount : c.clientEmail;
  return { scheme: c.scheme, projectId: c.projectId, location: c.location, ...(account === undefined ? {} : { serviceAccount: account }) };
}
export function validVertexSummary(value: unknown): value is VertexSummary {
  const r = record(value);
  return r !== undefined && exact(r, ["scheme", "projectId", "location"], ["serviceAccount"]) && (r.scheme === "federation" || r.scheme === "service_account_key")
    && str(r.projectId, GCP_PROJECT) && str(r.location, VERTEX_LOCATION) && (r.serviceAccount === undefined || str(r.serviceAccount, SERVICE_ACCOUNT));
}

// ---- Connect text (setup steps) ------------------------------------------------------------------------------------------
/** The AWS session the gateway uses for a company: the federation role, with the company id as session name. */
export function vertexSessionArn(awsAccountId: string, roleName: string, cid: string): string {
  if (!/^[0-9]{12}$/u.test(awsAccountId) || !/^[\w+=,.@-]{1,64}$/u.test(roleName) || !COMPANY.test(cid)) throw new Error("invalid vertex session");
  return `arn:aws:sts::${awsAccountId}:assumed-role/${roleName}/${cid}`;
}
export interface VertexSetupSteps {
  awsAccountId: string; roleName: string; sessionArn: string;
  /** The attribute condition the customer pastes into the pool's AWS provider. */
  condition: string;
  steps: Array<{ title: string; detail: string }>;
}
/** The customer's Google Cloud setup for workload identity federation, with the company's own ARN (a pure function for the screens). */
export function vertexSetupSteps(input: { awsAccountId: string; roleName: string; cid: string }): VertexSetupSteps {
  const sessionArn = vertexSessionArn(input.awsAccountId, input.roleName, input.cid);
  const condition = `assertion.arn == '${sessionArn}'`;
  return {
    awsAccountId: input.awsAccountId, roleName: input.roleName, sessionArn, condition,
    steps: [
      { title: "Turn on the Vertex AI API", detail: "In the Google Cloud console, open the project your tests use and enable the Vertex AI API (aiplatform.googleapis.com)." },
      { title: "Create a workload identity pool", detail: "IAM & Admin > Workload Identity Federation > Create pool. Any pool id works; note the project number shown on the project's dashboard." },
      { title: "Add an AWS provider to the pool", detail: `Provider type AWS, AWS account id ${input.awsAccountId}. Keep the default attribute mapping (google.subject = assertion.arn).` },
      { title: "Limit the provider to your company", detail: `Set the provider's attribute condition to exactly: ${condition}. Without it the pool would trust every Rovara company, and Rovara refuses to save it.` },
      { title: "Give it the Vertex AI User role", detail: `Grant the role Vertex AI User (roles/aiplatform.user) on this project only, either to the principal principal://iam.googleapis.com/projects/<project number>/locations/global/workloadIdentityPools/<pool id>/subject/${sessionArn}, or to a service account that this principal may impersonate (the Workload Identity User role on that service account).` },
      { title: "Connect it in Rovara", detail: "In Settings > Product AI choose Vertex AI and enter the project id, the location your tests call (for example us-central1), the provider's full name (//iam.googleapis.com/projects/<project number>/locations/global/workloadIdentityPools/<pool id>/providers/<provider id>) and, if you used one, the service account. Rovara tests the connection before saving." },
    ],
  };
}
