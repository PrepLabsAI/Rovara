// The HTTP reader of one project's nightly upkeep cap at the model gateway (lead 4 L4-SR1; contract `UpkeepCapReadSchema`, contracts/upkeep.ts). The same family as the offered-models read (offered-models-http.ts):
// the broker signs a SERVICE token with the install's task key (aud `UPKEEP_CAP_AUDIENCE`, cid = the company), sends a GET with no body and no query, and takes the answer only if it is exactly the contract.
//   GET <gateway origin>/v1/service/companies/<company>/upkeep/<project>   ->   { version: 1, company, project, month, enforced: true, limitMicros, spentMicros }
// The company and the project are checked names before anything is signed or sent (a path can never name another). Anything but a 200 with exactly that body, in time and within the size limit, is a failed read
// (`UPKEEP_CAP_READ_FAILED`, fixed words: never the gateway's answer, a URL, a token or a cause), and a failed read starts nothing (core/upkeep/cap.ts). A gateway that has no such route answers 404 and is therefore
// "not enforcing" as far as Code can tell: nothing spends until the route exists.
import { AGENTX_NAME_PATTERN, OrgIdSchema, UPKEEP_CAP_AUDIENCE, UpkeepCapReadSchema, type UpkeepCapRead } from "@agentx/contracts";
import type { TokenSigner } from "../developer/tokens.js";
import type { UpkeepCapReader } from "../core/upkeep/cap.js";
import { readGatewayUrl } from "./gateway-model-access.js";
import { boundedText, signServiceToken } from "./offered-models-http.js";

/** The most of an answer that is read (the contract is a few hundred bytes). */
export const UPKEEP_CAP_BODY_MAX_BYTES = 4_096;
/** The longest a read may take. */
export const UPKEEP_CAP_HTTP_TIMEOUT_MS = 4_000;
/** The only thing a failed read says. */
export const UPKEEP_CAP_READ_FAILED = "the gateway's upkeep cap could not be read";

const failed = (): Error => new Error(UPKEEP_CAP_READ_FAILED);

export interface UpkeepCapHttpInputs {
  /** The gateway's https origin (ROVARA_CORE_MODEL_GATEWAY_URL, already checked). */
  gatewayUrl: string;
  /** The install's sign-in issuer, whose JWKS publishes the task key. */
  issuer: string;
  signer: TokenSigner;
  /** The company this reader is for (every call names it; one reader never reads for another). */
  companyId: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

/** A reader of one COMPANY's projects' caps. */
export function upkeepCapHttpReader(input: UpkeepCapHttpInputs): UpkeepCapReader {
  const origin = input.gatewayUrl.replace(/\/+$/u, "");
  const company = OrgIdSchema.safeParse(input.companyId);
  return {
    async read(project): Promise<UpkeepCapRead> {
      if (!company.success || typeof project !== "string" || !AGENTX_NAME_PATTERN.test(project)) throw failed();
      const companyId: string = company.data;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      // The whole read (the signature, the request and the body) is held to one time; a fetch that ignores the abort is still given up on.
      const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(failed()); }, input.timeoutMs ?? UPKEEP_CAP_HTTP_TIMEOUT_MS); });
      const read = async (): Promise<UpkeepCapRead> => {
        const token = await signServiceToken(input, companyId, UPKEEP_CAP_AUDIENCE);
        const response = await (input.fetch ?? fetch)(`${origin}/v1/service/companies/${companyId}/upkeep/${encodeURIComponent(project)}`, {
          method: "GET", redirect: "error", signal: controller.signal, headers: { accept: "application/json", authorization: `Bearer ${token}` },
        });
        if (response.status !== 200) { await response.body?.cancel().catch(() => undefined); throw failed(); }
        const parsed = UpkeepCapReadSchema.safeParse(JSON.parse(await boundedText(response, UPKEEP_CAP_BODY_MAX_BYTES)));
        if (!parsed.success) throw failed();
        return parsed.data;
      };
      try { return await Promise.race([read(), deadline]); } catch { throw failed(); }
      finally { clearTimeout(timer); deadline.catch(() => undefined); }
    },
  };
}

/**
 * The reader of a deployment, for one company: only where the model gateway's origin is configured (ROVARA_CORE_MODEL_GATEWAY_URL, checked) and the install can give a task-token signer and issuer. Otherwise none, and
 * no nightly AI starts (the cap signal is "unknown"). The signer is asked at each read (never kept), and a signer that is not there at that moment is a failed read.
 */
export function upkeepCapReaderFromEnvironment(env: NodeJS.ProcessEnv, taskTokens: (() => { signer: TokenSigner; issuer: string } | undefined) | undefined, companyId: string, fetchImpl?: typeof fetch): UpkeepCapReader | undefined {
  const gatewayUrl = readGatewayUrl(env);
  if (typeof gatewayUrl !== "string" || taskTokens === undefined) return undefined;
  return {
    async read(project) {
      let tokens: { signer: TokenSigner; issuer: string } | undefined;
      try { tokens = taskTokens(); } catch { throw failed(); }
      if (tokens === undefined || typeof tokens.issuer !== "string" || tokens.issuer === "") throw failed();
      return await upkeepCapHttpReader({ gatewayUrl, issuer: tokens.issuer, signer: tokens.signer, companyId, ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }) }).read(project);
    },
  };
}
