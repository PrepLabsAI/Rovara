// L4-HW3c (owner choice B): Code's adapter for the `company-instructions` plug-in point on a deployed install. The company's rules are kept by Cloud (company settings, approved by a second admin) and read by the
// Cloud model gateway for ONE company; this adapter asks the gateway for the asking company's approved rules. On a laptop the same point is the owner's local file (`FileCompanyInstructions`).
//
//   POST <gateway>/v1/service/company-instructions
//     headers  accept: application/json, content-type: application/json, authorization: Bearer <service token>
//              the service token is the one the offered-models read uses (`signServiceToken`: the install's TASK key, typ rovara-service+jwt), with aud
//              "rovara-model-gateway-company-instructions" and cid = the company asked about
//     body     exactly {"company": <org id>}
//   200 body   exactly {"company", "version": <1..64 characters>, "rules": [{"text", "priority": "required"|"preferred"}]}; `rules` is [] when the company has none
//
// The answer must name the SAME company that was asked about. An empty list is "no rules" (`undefined`, as the laptop's missing file). Everything else (a non-200 including the gateway's 404, a redirect, an extra member, a body
// over the limit, unparseable JSON, a fault or no answer within the timeout) is a THROW, so the task start fails closed (`readCompanyInstructions`: "The company rules could not be read, so this step did not start"): a company
// that has rules never starts a task without them. The size limits and the prompt framing are the core's (`checkedCompanyInstructions`), applied to this answer exactly as to the laptop's. Nothing here logs or echoes the gateway's answer.
import { CompanyRuleSchema, OrgIdSchema, type CompanyInstructionsSnapshot, type CompanyInstructionsSource } from "@agentx/contracts";
import { z } from "zod";
import type { TokenSigner } from "../developer/tokens.js";
import { readGatewayModelAccess } from "./gateway-model-access.js";
import { boundedText, signServiceToken } from "./offered-models-http.js";
import { coreAdapter, type CoreAdapterModule } from "./registry.js";

export const COMPANY_INSTRUCTIONS_PATH = "/v1/service/company-instructions";
export const COMPANY_INSTRUCTIONS_AUDIENCE = "rovara-model-gateway-company-instructions";
/** 30 rules of 600 characters, JSON-escaped, are far under this; anything bigger is not the contract. */
export const COMPANY_INSTRUCTIONS_BODY_MAX_BYTES = 262_144;
/** The whole ask (signing, request and body) in at most this long. */
export const COMPANY_INSTRUCTIONS_HTTP_TIMEOUT_MS = 4_000;
/** The registry name of the HTTP adapter. */
export const COMPANY_INSTRUCTIONS_ADAPTER_NAME = "model-gateway";
/** The only thing a failed read says. */
export const COMPANY_INSTRUCTIONS_READ_FAILED = "the gateway's company rules could not be read";

// Not limited here beyond a sane bound on the list: `checkedCompanyInstructions` refuses an over-budget answer with the clear sentence.
const AnswerSchema = z.object({ company: OrgIdSchema, version: z.string().min(1).max(64), rules: z.array(CompanyRuleSchema).max(1_000) }).strict();
const failed = (): Error => new Error(COMPANY_INSTRUCTIONS_READ_FAILED);

export interface CompanyInstructionsHttpInputs {
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

export function companyInstructionsAdapter(input: CompanyInstructionsHttpInputs): CompanyInstructionsSource {
  const origin = input.gatewayUrl.replace(/\/+$/u, "");
  return {
    async current(company): Promise<CompanyInstructionsSnapshot | undefined> {
      // The company is checked before anything is signed or sent: the body and the token can only ever name a well-formed company id.
      const checked = OrgIdSchema.safeParse(company);
      if (!checked.success) throw failed();
      const asked: string = checked.data;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      // The whole read (the signature, the request and the body) is held to one time; a fetch that ignores the abort is still given up on.
      const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(failed()); }, input.timeoutMs ?? COMPANY_INSTRUCTIONS_HTTP_TIMEOUT_MS); });
      const read = async (): Promise<CompanyInstructionsSnapshot | undefined> => {
        const token = await signServiceToken(input, asked, COMPANY_INSTRUCTIONS_AUDIENCE);
        const response = await (input.fetch ?? fetch)(`${origin}${COMPANY_INSTRUCTIONS_PATH}`, {
          method: "POST", redirect: "error", signal: controller.signal, body: JSON.stringify({ company: asked }),
          headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${token}` },
        });
        if (response.status !== 200) { await response.body?.cancel().catch(() => undefined); throw failed(); }
        const parsed = AnswerSchema.safeParse(JSON.parse(await boundedText(response, COMPANY_INSTRUCTIONS_BODY_MAX_BYTES)));
        // The same company that was asked about, and no other.
        if (!parsed.success || parsed.data.company !== asked) throw failed();
        return parsed.data.rules.length === 0 ? undefined : { version: parsed.data.version, rules: parsed.data.rules.map((rule) => ({ text: rule.text, priority: rule.priority })) };
      };
      try { return await Promise.race([read(), deadline]); } catch { throw failed(); }
      finally { clearTimeout(timer); deadline.catch(() => undefined); }
    },
  };
}

/**
 * The `company-instructions` module of a deployed broker (a point of ONE adapter): only where the model gateway is configured (ROVARA_CORE_MODEL_GATEWAY_URL with its agent model, checked) and the install's task key
 * signs (`taskTokens`). Otherwise none: the point stays empty and no company rules reach a task, exactly as before. Never the laptop default.
 */
export function companyInstructionsModules(env: NodeJS.ProcessEnv, taskTokens: (() => { signer: TokenSigner; issuer: string } | undefined) | undefined, fetchImpl?: typeof fetch): CoreAdapterModule[] {
  const settings = readGatewayModelAccess(env);
  if (settings === undefined || "problem" in settings) return [];
  const tokens = taskTokens?.();
  if (tokens === undefined || typeof tokens.issuer !== "string" || tokens.issuer === "" || typeof tokens.signer?.sign !== "function" || typeof tokens.signer.publicJwk !== "function") return [];
  return [coreAdapter({
    point: "company-instructions", name: COMPANY_INSTRUCTIONS_ADAPTER_NAME, owner: "L4-HW3c (the company's approved rules, kept by Cloud and read by the model gateway)",
    create: () => companyInstructionsAdapter({ gatewayUrl: settings.gatewayUrl, issuer: tokens.issuer, signer: tokens.signer, ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }) }),
  })];
}
