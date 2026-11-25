// A fake Google token world for the Vertex tests: AWS STS (AssumeRole), Google STS (token exchange that EVALUATES the pool's
// attribute condition on the assumed-role ARN, after checking the AWS signature of the subject token), IAM credentials
// (generateAccessToken, checking who may impersonate) and OAuth (the key-file JWT). Nothing here opens a socket.
import { createVerify, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { signRequest, type AwsCredentials } from "../../packages/model-gateway/src/aws.js";
import type { TokenHttp, TokenHttpRequest } from "../../packages/model-gateway/src/product-vertex-token.js";

export const AWS_ACCOUNT = "111122223333";
export const ROLE_NAME = "RovaraProductAiFederation";
export const ROLE_ARN = `arn:aws:iam::${AWS_ACCOUNT}:role/${ROLE_NAME}`;
export const AWS_REGION = "us-west-2";
export const sessionArn = (session: string): string => `arn:aws:sts::${AWS_ACCOUNT}:assumed-role/${ROLE_NAME}/${session}`;
export const audienceOf = (pool: string, provider = "aws-rovara", project = "123456789012"): string => `//iam.googleapis.com/projects/${project}/locations/global/workloadIdentityPools/${pool}/providers/${provider}`;
/** The gateway's own task-role credentials (built at runtime, never a key-shaped literal). */
export const baseCredentials = (): AwsCredentials => ({ accessKeyId: ["AS", "IA"].join("") + randomBytes(8).toString("hex").toUpperCase(), secretAccessKey: randomBytes(30).toString("base64url"), sessionToken: randomBytes(40).toString("base64url"), expiresAt: Number.MAX_SAFE_INTEGER });

/** A service-account key file built at runtime (no key-shaped literal in the repository). */
export function keyFile(email = "tests-runner@acme-tests.iam.gserviceaccount.com", project = "acme-tests") {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const file = { type: "service_account", project_id: project, private_key_id: randomBytes(20).toString("hex"), private_key: pem, client_email: email, client_id: "1".repeat(21), auth_uri: "https://accounts.google.com/o/oauth2/auth", token_uri: "https://oauth2.googleapis.com/token", auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs", client_x509_cert_url: `https://www.googleapis.com/robot/v1/metadata/x509/${encodeURIComponent(email)}`, universe_domain: "googleapis.com" };
  return { file, publicKey: pair.publicKey, pem };
}

type Condition = (arn: string) => boolean;
const form = (body: Buffer) => new URLSearchParams(body.toString("utf8"));
const json = (status: number, value: unknown) => ({ status, body: Buffer.from(JSON.stringify(value)) });

export class FakeGoogle {
  now: number;
  ttlSeconds = 3600;
  readonly base = baseCredentials();
  readonly calls: Array<{ host: string; path: string }> = [];
  readonly requests: TokenHttpRequest[] = [];
  readonly pools = new Map<string, Condition>();
  readonly sessions = new Map<string, { secret: string; token: string; arn: string; expiresAt: number }>();
  /** Federated or service-account access token -> what it stands for. */
  readonly tokens = new Map<string, { subject: string; expiresAt: number; kind: "federated" | "service_account" | "key_file" }>();
  /** Service account -> the federated subjects allowed to impersonate it. */
  readonly impersonation = new Map<string, Set<string>>();
  readonly keyFiles = new Map<string, { kid: string; publicKey: KeyObject }>();
  /** Fault switches per host. */
  readonly fail = new Map<string, number>();
  assumeRefused = false;
  constructor(now: number) { this.now = now; }

  /** The customer's pool: an exact-ARN condition (correct) or a role-wide one (too open). */
  pool(audience: string, condition: Condition): void { this.pools.set(audience, condition); }
  exactPool(audience: string, cid: string): void { this.pool(audience, (arn) => arn === sessionArn(cid)); }
  openPool(audience: string): void { this.pool(audience, (arn) => arn.startsWith(`arn:aws:sts::${AWS_ACCOUNT}:assumed-role/${ROLE_NAME}/`)); }
  allowImpersonation(email: string, cid: string): void { this.impersonation.set(email, new Set([...(this.impersonation.get(email) ?? []), sessionArn(cid)])); }
  registerKeyFile(file: { client_email: string; private_key_id: string }, publicKey: KeyObject): void { this.keyFiles.set(file.client_email, { kid: file.private_key_id, publicKey }); }
  /** Who a token handed to Vertex stands for, or undefined if it is unknown or expired. */
  whoIs(token: string): string | undefined { const t = this.tokens.get(token); return t !== undefined && t.expiresAt > this.now ? t.subject : undefined; }

  readonly http: TokenHttp = async (request) => {
    this.calls.push({ host: request.host, path: request.path }); this.requests.push(request);
    const failing = this.fail.get(request.host);
    if (failing !== undefined) return { status: failing, body: Buffer.from(`{"error":"failed ${"q".repeat(4)}"}`) };
    if (request.host === `sts.${AWS_REGION}.amazonaws.com`) return this.#assumeRole(request);
    if (request.host === "sts.googleapis.com") return this.#exchange(request);
    if (request.host === "iamcredentials.googleapis.com") return this.#impersonate(request);
    if (request.host === "oauth2.googleapis.com") return this.#jwt(request);
    return { status: 404, body: Buffer.alloc(0) };
  };

  #issue(subject: string, kind: "federated" | "service_account" | "key_file"): string {
    const token = `ya29.${kind}.${randomBytes(24).toString("base64url")}`;
    this.tokens.set(token, { subject, expiresAt: this.now + this.ttlSeconds * 1000, kind });
    return token;
  }
  #assumeRole(request: TokenHttpRequest) {
    const params = form(request.body);
    const expected = signRequest({ method: "POST", host: request.host, region: AWS_REGION, service: "sts", headers: { "content-type": request.headers["content-type"]! }, body: request.body, credentials: this.base, now: amzDateOf(request.headers["x-amz-date"]!) });
    if (request.path !== "/" || request.headers.authorization !== expected.authorization || params.get("Action") !== "AssumeRole" || params.get("Version") !== "2011-06-15") return { status: 403, body: Buffer.from("<ErrorResponse><Error><Code>SignatureDoesNotMatch</Code></Error></ErrorResponse>") };
    if (this.assumeRefused || params.get("RoleArn") !== ROLE_ARN) return { status: 403, body: Buffer.from("<ErrorResponse><Error><Code>AccessDenied</Code></Error></ErrorResponse>") };
    const session = params.get("RoleSessionName") ?? "";
    if (!/^[\w+=,.@-]{2,64}$/u.test(session)) return { status: 400, body: Buffer.from("<ErrorResponse><Error><Code>ValidationError</Code></Error></ErrorResponse>") };
    const accessKeyId = ["AS", "IA"].join("") + randomBytes(8).toString("hex").toUpperCase();
    const secret = randomBytes(30).toString("base64url"); const token = randomBytes(60).toString("base64url");
    const expiresAt = this.now + Number(params.get("DurationSeconds") ?? 3600) * 1000;
    this.sessions.set(accessKeyId, { secret, token, arn: sessionArn(session), expiresAt });
    return { status: 200, body: Buffer.from(`<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleResult><AssumedRoleUser><AssumedRoleId>AROA:${session}</AssumedRoleId><Arn>${sessionArn(session)}</Arn></AssumedRoleUser><Credentials><AccessKeyId>${accessKeyId}</AccessKeyId><SecretAccessKey>${secret}</SecretAccessKey><SessionToken>${token}</SessionToken><Expiration>${new Date(expiresAt).toISOString()}</Expiration></Credentials></AssumeRoleResult></AssumeRoleResponse>`) };
  }
  #exchange(request: TokenHttpRequest) {
    const p = form(request.body);
    if (request.path !== "/v1/token" || request.headers.authorization !== undefined || p.get("grant_type") !== "urn:ietf:params:oauth:grant-type:token-exchange" || p.get("requested_token_type") !== "urn:ietf:params:oauth:token-type:access_token"
      || p.get("subject_token_type") !== "urn:ietf:params:aws:token-type:aws4_request" || p.get("scope") !== "https://www.googleapis.com/auth/cloud-platform") return json(400, { error: "invalid_request" });
    const audience = p.get("audience") ?? "";
    const condition = this.pools.get(audience);
    if (condition === undefined) return json(400, { error: "invalid_target", error_description: `pool ${audience} not found` });
    let subject: { url: string; method: string; headers: Array<{ key: string; value: string }> };
    try { subject = JSON.parse(decodeURIComponent(p.get("subject_token") ?? "")) as typeof subject; } catch { return json(400, { error: "invalid_grant" }); }
    const header = (name: string) => subject.headers.find((h) => h.key.toLowerCase() === name)?.value;
    if (subject.method !== "POST" || subject.url !== `https://sts.${AWS_REGION}.amazonaws.com?Action=GetCallerIdentity&Version=2011-06-15` || header("x-goog-cloud-target-resource") !== audience || header("host") !== `sts.${AWS_REGION}.amazonaws.com`) return json(400, { error: "invalid_grant" });
    const akid = /Credential=([A-Z0-9]+)\//u.exec(header("authorization") ?? "")?.[1] ?? "";
    const session = this.sessions.get(akid);
    if (session === undefined || session.expiresAt <= this.now) return json(400, { error: "invalid_grant" });
    // AWS checks the signature when Google forwards the GetCallerIdentity request: recompute it with the session's secret.
    const signed = signRequest({ method: "POST", host: `sts.${AWS_REGION}.amazonaws.com`, region: AWS_REGION, service: "sts", query: "Action=GetCallerIdentity&Version=2011-06-15", headers: { "x-goog-cloud-target-resource": audience }, body: Buffer.alloc(0), credentials: { accessKeyId: akid, secretAccessKey: session.secret, sessionToken: session.token }, now: amzDateOf(header("x-amz-date") ?? "") });
    if (signed.authorization !== header("authorization") || header("x-amz-security-token") !== session.token) return json(400, { error: "invalid_grant" });
    if (!condition(session.arn)) return json(403, { error: "unauthorized_client", error_description: `The given credential is rejected by the attribute condition for ${session.arn}` });
    return json(200, { access_token: this.#issue(session.arn, "federated"), issued_token_type: "urn:ietf:params:oauth:token-type:access_token", token_type: "Bearer", expires_in: this.ttlSeconds });
  }
  #impersonate(request: TokenHttpRequest) {
    const m = /^\/v1\/projects\/-\/serviceAccounts\/([^/:]+):generateAccessToken$/u.exec(request.path);
    const bearer = /^Bearer (.+)$/u.exec(request.headers.authorization ?? "")?.[1] ?? "";
    const federated = this.tokens.get(bearer);
    if (m === null || federated === undefined || federated.kind !== "federated" || federated.expiresAt <= this.now) return json(401, { error: { code: 401, status: "UNAUTHENTICATED" } });
    const email = decodeURIComponent(m[1]!);
    let body: { scope?: unknown; lifetime?: unknown };
    try { body = JSON.parse(request.body.toString("utf8")) as typeof body; } catch { return json(400, { error: { code: 400 } }); }
    if (!Array.isArray(body.scope) || body.scope[0] !== "https://www.googleapis.com/auth/cloud-platform") return json(400, { error: { code: 400 } });
    if (!(this.impersonation.get(email)?.has(federated.subject) ?? false)) return json(403, { error: { code: 403, message: `Permission iam.serviceAccounts.getAccessToken denied on ${email}`, status: "PERMISSION_DENIED" } });
    const token = this.#issue(`sa:${email}`, "service_account");
    return json(200, { accessToken: token, expireTime: new Date(this.now + this.ttlSeconds * 1000).toISOString().replace(/\.\d{3}Z$/u, "Z") });
  }
  #jwt(request: TokenHttpRequest) {
    const p = form(request.body);
    if (request.path !== "/token" || p.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer") return json(400, { error: "invalid_request" });
    const parts = (p.get("assertion") ?? "").split(".");
    if (parts.length !== 3) return json(400, { error: "invalid_grant" });
    const [h, c, s] = parts as [string, string, string];
    let header: Record<string, unknown>; let claims: Record<string, unknown>;
    try { header = JSON.parse(Buffer.from(h, "base64url").toString()) as Record<string, unknown>; claims = JSON.parse(Buffer.from(c, "base64url").toString()) as Record<string, unknown>; } catch { return json(400, { error: "invalid_grant" }); }
    const registered = this.keyFiles.get(String(claims.iss));
    const valid = registered !== undefined && header.alg === "RS256" && header.typ === "JWT" && header.kid === registered.kid && claims.aud === "https://oauth2.googleapis.com/token" && claims.scope === "https://www.googleapis.com/auth/cloud-platform"
      && typeof claims.iat === "number" && typeof claims.exp === "number" && claims.exp > claims.iat && claims.exp - claims.iat <= 3600 && Math.abs(claims.iat * 1000 - this.now) < 300_000
      && createVerify("RSA-SHA256").update(`${h}.${c}`).verify(registered.publicKey, Buffer.from(s, "base64url"));
    if (!valid) return json(400, { error: "invalid_grant", error_description: "Invalid JWT Signature." });
    return json(200, { access_token: this.#issue(`sa:${String(claims.iss)}`, "key_file"), expires_in: this.ttlSeconds, token_type: "Bearer" });
  }
}
function amzDateOf(value: string): Date {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/u.exec(value);
  return m === null ? new Date(0) : new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])));
}
