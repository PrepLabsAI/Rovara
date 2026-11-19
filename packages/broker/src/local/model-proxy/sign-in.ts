// Port lane P5 (item K2): signing a call to a model provider. The proxy holds the credential; this builds the headers that carry it and says which strings an answer
// must never contain. The worker never reaches this code: a token it holds is good for the proxy only.
//
// Sign-in kinds (contracts/ports/model-provider.ts): a bearer key, a key in a named header, AWS Signature Version 4, a Google access token, a Microsoft Entra access token,
// or none. A token for Google or Entra is a plain bearer token here; it is refreshed by the provider plug-in's `credential()`, not by the proxy.
import { createHash, createHmac } from "node:crypto";
import type { ModelProviderAdapter, SecretValue } from "@agentx/contracts";

/** What a signed call carries, and the strings (key, secret key, session token, access token) an answer must never contain. */
export interface SignedCall {
  headers: Record<string, string>;
  sensitive: string[];
}

export class SignInProblem extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignInProblem";
  }
}

export interface SignInRequest {
  provider: ModelProviderAdapter;
  /** The final address of the call. */
  url: URL;
  /** The headers the call already has (content type, the format's own headers); a signed call signs them. Names are lower case. */
  headers: Readonly<Record<string, string>>;
  /** The exact body that is sent. */
  body: string;
  /** The credential, or undefined for sign-in kind `none`. */
  secret: SecretValue | undefined;
  now: Date;
}

/** Whether a provider needs a credential at all. */
export function needsCredential(provider: ModelProviderAdapter): boolean {
  return provider.signIn.kind !== "none";
}

export function signCall(request: SignInRequest): SignedCall {
  const { signIn } = request.provider;
  if (signIn.kind === "none") return { headers: {}, sensitive: [] };
  if (request.secret === undefined) throw new SignInProblem("no credential");
  const value = request.secret.reveal();
  switch (signIn.kind) {
    case "bearer-key":
    case "google-oauth":
    case "microsoft-entra":
      return { headers: { authorization: `Bearer ${value}` }, sensitive: [value] };
    case "named-header":
      return { headers: { [signIn.header]: value }, sensitive: [value] };
    case "aws-sigv4": {
      const credentials = parseAwsCredentials(value);
      const headers = signV4({ method: "POST", url: request.url, headers: request.headers, body: request.body, credentials, region: signIn.region, service: signIn.service, now: request.now });
      return { headers, sensitive: [credentials.secretAccessKey, ...(credentials.sessionToken === undefined ? [] : [credentials.sessionToken])] };
    }
  }
}

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** The credential of `aws-sigv4`: JSON `{"accessKeyId","secretAccessKey","sessionToken"?}`. A message never quotes the value. */
export function parseAwsCredentials(text: string): AwsCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SignInProblem("the AWS credential is not JSON");
  }
  const record = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  const accessKeyId = record?.accessKeyId, secretAccessKey = record?.secretAccessKey, sessionToken = record?.sessionToken;
  const plain = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4_096 && !/[\s\p{Cc}]/u.test(value);
  if (record === undefined || !plain(accessKeyId) || !plain(secretAccessKey) || (sessionToken !== undefined && !plain(sessionToken))
    || Object.keys(record).some((name) => !["accessKeyId", "secretAccessKey", "sessionToken"].includes(name))) {
    throw new SignInProblem("the AWS credential must be {accessKeyId, secretAccessKey, sessionToken?}");
  }
  return { accessKeyId, secretAccessKey, ...(sessionToken === undefined ? {} : { sessionToken }) };
}

const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const hmac = (key: Buffer | string, text: string): Buffer => createHmac("sha256", key).update(text, "utf8").digest();
/** RFC 3986 encoding as AWS wants it: everything but A-Z a-z 0-9 - _ . ~ */
const awsEncode = (text: string): string => encodeURIComponent(text).replaceAll(/[!'()*]/gu, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

export interface SignV4Options {
  method: string;
  url: URL;
  headers: Readonly<Record<string, string>>;
  body: string;
  credentials: AwsCredentials;
  region: string;
  service: string;
  now: Date;
}

/**
 * AWS Signature Version 4 over a request. Returns the headers to add to the call: `authorization`, `x-amz-date` and, with a session token, `x-amz-security-token`. Every
 * header in `headers` is signed too, plus `host`. The path is encoded a second time, as every service but S3 expects. Checked against AWS's published example (tests).
 */
export function signV4(options: SignV4Options): Record<string, string> {
  const amzDate = options.now.toISOString().replaceAll(/[-:]/gu, "").replace(/\.\d{3}/u, "");
  const day = amzDate.slice(0, 8);
  const signed: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.headers)) signed[name.toLowerCase()] = value.trim().replaceAll(/\s+/gu, " ");
  signed.host = options.url.host;
  signed["x-amz-date"] = amzDate;
  if (options.credentials.sessionToken !== undefined) signed["x-amz-security-token"] = options.credentials.sessionToken;
  const names = Object.keys(signed).sort();
  const canonicalHeaders = names.map((name) => `${name}:${signed[name]!}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalPath = options.url.pathname.split("/").map(awsEncode).join("/") || "/";
  const canonicalQuery = [...options.url.searchParams.entries()].map(([name, value]) => [awsEncode(name), awsEncode(value)] as const).sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1)).map(([name, value]) => `${name}=${value}`).join("&");
  const canonicalRequest = [options.method, canonicalPath, canonicalQuery, canonicalHeaders, signedHeaders, sha256Hex(options.body)].join("\n");
  const scope = `${day}/${options.region}/${options.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${options.credentials.secretAccessKey}`, day), options.region), options.service), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");
  return {
    "x-amz-date": amzDate,
    ...(options.credentials.sessionToken === undefined ? {} : { "x-amz-security-token": options.credentials.sessionToken }),
    authorization: `AWS4-HMAC-SHA256 Credential=${options.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
