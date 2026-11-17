// DEC 253k: Code's adapter for the `eval-reservation` plug-in point on a deployed install. The source of truth for "may this approved eval spend" is the Cloud model gateway: its
// stored approval plus the project's own connected customer key (never Rovara-paid). Code's EVAL_SPEND row stays the setup-time plan binding (`createEvalSpendCapabilities`).
//
//   POST <gateway>/v1/product/eval/authority
//     headers  accept: application/json, content-type: application/json, authorization: Bearer <service token>
//              the service token is the one the offered-models read uses (`signServiceToken`: the install's TASK key, typ rovara-service+jwt), with aud
//              "rovara-model-gateway-eval-authority" and cid = the company asked about
//     body     exactly {"company": <org id>, "project": <project>, "approver": {"personId": <id>, "provider": <identity adapter>}}
//   200 body   exactly {"company", "project", "principal": {companyId, personId, displayName, roles, provider[, authTime][, methods]}, "provider": "customer", "connected": true}
//
// Accepted only when the answer names the SAME company and project that were asked about, and its principal is the asked approver (same person and identity provider) in that
// company. Anything else (connected false, any other provider, an extra member, a non-200, a redirect, a body over EVAL_AUTHORITY_BODY_MAX_BYTES, unparseable JSON, a fault or
// no answer within the timeout) is undefined: spend not approved. Nothing here throws to its caller, logs or echoes the gateway's answer.
//
// DEC 253q(c) `monthlyCapMicros()`: the eval monthly cap from Cloud's company budget.
//   POST <gateway>/v1/product/eval/cap
//     headers  as above, with aud "rovara-model-gateway-eval-cap" and cid = the company asked about
//     body     exactly {"company": <org id>, "project": <project>}
//   200 body   exactly {"company", "project", "monthlyCapMicros": <whole micro-dollars>}: the smaller of the company's and the project's monthly caps
// Accepted only when the answer names the SAME company and project; anything else (a non-200, a redirect, an oversized or unparseable body, a fault, the timeout) is undefined: no cap, and the
// confirm is refused. Nothing throws, logs or echoes.
//
// `reserve()` holds nothing here and answers undefined: the per-run hold is the worker's, through the gateway's own /v1/product/eval/hold with the operation's task token
// (`worker/src/verification/eval-gateway-access.ts`). A broker-side meter that asks this adapter for a hold is refused, so it dispatches no calls.
import { OrgIdSchema, type EvalReservationAdapter, type Principal } from "@agentx/contracts";
import { z } from "zod";
import type { TokenSigner } from "../developer/tokens.js";
import { readGatewayModelAccess } from "./gateway-model-access.js";
import { boundedText, signServiceToken } from "./offered-models-http.js";
import { coreAdapter, type CoreAdapterModule } from "./registry.js";

export const EVAL_AUTHORITY_PATH = "/v1/product/eval/authority";
export const EVAL_AUTHORITY_AUDIENCE = "rovara-model-gateway-eval-authority";
export const EVAL_CAP_PATH = "/v1/product/eval/cap";
export const EVAL_CAP_AUDIENCE = "rovara-model-gateway-eval-cap";
/** The answer is a few hundred bytes; anything bigger is not the contract. */
export const EVAL_AUTHORITY_BODY_MAX_BYTES = 8_192;
/** The whole ask (signing, request and body) in at most this long. */
export const EVAL_AUTHORITY_HTTP_TIMEOUT_MS = 3_000;
/** The registry name of the HTTP adapter. */
export const EVAL_RESERVATION_ADAPTER_NAME = "model-gateway";

const ProjectSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u);
const ApproverSchema = z.object({ personId: z.string().min(1).max(256), provider: z.string().min(1).max(200) });
const text = z.string().min(1).max(256);
const PrincipalAnswerSchema = z.object({
  companyId: OrgIdSchema, personId: text, displayName: z.string().max(256), roles: z.array(z.string().max(64)).max(32), provider: text,
  authTime: z.iso.datetime().optional(), methods: z.array(z.string().max(64)).max(16).optional(),
}).strict();
const CapAnswerSchema = z.object({ company: OrgIdSchema, project: ProjectSchema, monthlyCapMicros: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict();
const AuthorityAnswerSchema = z.object({
  company: OrgIdSchema, project: ProjectSchema, principal: PrincipalAnswerSchema, provider: z.literal("customer"), connected: z.literal(true),
}).strict();

export interface EvalAuthorityHttpInputs {
  /** The gateway's https origin (ROVARA_CORE_MODEL_GATEWAY_URL, already checked). */
  gatewayUrl: string;
  /** The install's sign-in issuer (DEVELOPER_TOKEN_ISSUER), whose JWKS publishes the task key. */
  issuer: string;
  /** The task key's signer (`taskKeySigner`). */
  signer: TokenSigner;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

export function evalAuthorityAdapter(input: EvalAuthorityHttpInputs): EvalReservationAdapter {
  const origin = input.gatewayUrl.replace(/\/+$/u, "");
  return {
    async authority(request) {
      // Checked before anything is signed or sent.
      const company = OrgIdSchema.safeParse(request?.company);
      const project = ProjectSchema.safeParse(request?.project);
      const approver = ApproverSchema.safeParse(request?.approver);
      if (!company.success || !project.success || !approver.success) return undefined;
      const asked = { company: company.data, project: project.data, approver: { personId: approver.data.personId, provider: approver.data.provider } };
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<undefined>((resolve) => { timer = setTimeout(() => { controller.abort(); resolve(undefined); }, input.timeoutMs ?? EVAL_AUTHORITY_HTTP_TIMEOUT_MS); });
      const ask = async () => {
        const token = await signServiceToken(input, asked.company, EVAL_AUTHORITY_AUDIENCE);
        const response = await (input.fetch ?? fetch)(`${origin}${EVAL_AUTHORITY_PATH}`, {
          method: "POST", redirect: "error", signal: controller.signal, body: JSON.stringify(asked),
          headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${token}` },
        });
        if (response.status !== 200) { await response.body?.cancel().catch(() => undefined); return undefined; }
        const parsed = AuthorityAnswerSchema.safeParse(JSON.parse(await boundedText(response, EVAL_AUTHORITY_BODY_MAX_BYTES)));
        if (!parsed.success) return undefined;
        const found = parsed.data;
        // The same company, project and approver that were asked about; the approver in that company.
        if (found.company !== asked.company || found.project !== asked.project || found.principal.companyId !== asked.company
          || found.principal.personId !== asked.approver.personId || found.principal.provider !== asked.approver.provider) return undefined;
        const principal: Principal = {
          companyId: found.principal.companyId, personId: found.principal.personId, displayName: found.principal.displayName, roles: [...found.principal.roles], provider: found.principal.provider,
          ...(found.principal.authTime === undefined ? {} : { authTime: found.principal.authTime }), ...(found.principal.methods === undefined ? {} : { methods: [...found.principal.methods] }),
        };
        return { company: found.company, project: found.project, principal, provider: found.provider, connected: found.connected };
      };
      try { return await Promise.race([ask(), deadline]); } catch { return undefined; }
      finally { clearTimeout(timer); }
    },
    async reserve() { return undefined; },
    async monthlyCapMicros(request) {
      const company = OrgIdSchema.safeParse(request?.company);
      const project = ProjectSchema.safeParse(request?.project);
      if (!company.success || !project.success) return undefined;
      const asked = { company: company.data, project: project.data };
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<undefined>((resolve) => { timer = setTimeout(() => { controller.abort(); resolve(undefined); }, input.timeoutMs ?? EVAL_AUTHORITY_HTTP_TIMEOUT_MS); });
      const ask = async (): Promise<number | undefined> => {
        const token = await signServiceToken(input, asked.company, EVAL_CAP_AUDIENCE);
        const response = await (input.fetch ?? fetch)(`${origin}${EVAL_CAP_PATH}`, {
          method: "POST", redirect: "error", signal: controller.signal, body: JSON.stringify(asked),
          headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${token}` },
        });
        if (response.status !== 200) { await response.body?.cancel().catch(() => undefined); return undefined; }
        const parsed = CapAnswerSchema.safeParse(JSON.parse(await boundedText(response, EVAL_AUTHORITY_BODY_MAX_BYTES)));
        if (!parsed.success || parsed.data.company !== asked.company || parsed.data.project !== asked.project) return undefined;
        return parsed.data.monthlyCapMicros;
      };
      try { return await Promise.race([ask(), deadline]); } catch { return undefined; }
      finally { clearTimeout(timer); }
    },
  };
}

/**
 * The `eval-reservation` module of a deployed broker (a point of ONE adapter: a root that also lists its own `eval-reservation` module is refused at build, so Cloud does not register one): only where the model gateway is configured (ROVARA_CORE_MODEL_GATEWAY_URL with its agent model, checked) and the broker can sign with
 * its task key. Otherwise none: the point stays empty and no approved eval spends.
 */
export function evalReservationModules(env: NodeJS.ProcessEnv, taskTokens: (() => { signer: TokenSigner; issuer: string } | undefined) | undefined, fetchImpl?: typeof fetch): CoreAdapterModule[] {
  const settings = readGatewayModelAccess(env);
  if (settings === undefined || "problem" in settings) return [];
  const tokens = taskTokens?.();
  if (tokens === undefined || typeof tokens.issuer !== "string" || tokens.issuer === "" || typeof tokens.signer?.sign !== "function" || typeof tokens.signer.publicJwk !== "function") return [];
  return [coreAdapter({
    point: "eval-reservation", name: EVAL_RESERVATION_ADAPTER_NAME, owner: "DEC 253k (eval spend authority in the model gateway)",
    create: () => evalAuthorityAdapter({ gatewayUrl: settings.gatewayUrl, issuer: tokens.issuer, signer: tokens.signer, ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }) }),
  })];
}
