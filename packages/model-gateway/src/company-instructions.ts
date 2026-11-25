// L4-HW3c (owner choice B, 2026-11-18): the company's approved rules, for Rovara Code's hosted broker. Code's `company-instructions` plug-in point
// (packages/contracts/src/ports/company-instructions.ts) is answered on a laptop from a local file; on a deployed install nothing registered it, so
// hosted steps never carried the company's rules. The rules Cloud keeps (company-settings.ts `instructions`, in the Companies table's SETTINGS item) are
// read here, for one company, and handed to the broker when a task starts (Code pins them for the task: no per-step re-read).
//
//   POST /v1/service/company-instructions
//     authorization: Bearer <service token>   typ rovara-service+jwt, aud COMPANY_INSTRUCTIONS_AUDIENCE, cid = the company asked about,
//                                             signed by the install's TASK key (verified exactly as the eval-cap token is)
//     body exactly {"company": <org id>}
//   200 exactly {"company", "version": "<settings version, or 0 when the company saved none>", "rules": [{"text", "priority": "required"|"preferred"}]}
//       rules is [] when the company has no saved settings or no instructions (a company that has no rules is a plain 200, never a 404, so a
//       gateway that lacks this route (404) can never be read as "no rules")
//
// Approved only: the SETTINGS item is what Cloud applied (a change to instructions is a loosening that a second admin approves, company-settings.ts
// `loosens`); a change waiting for that second admin is the PENDING item, which is never read here (one exact GET of SETTINGS, strongly consistent).
//
// Company isolation: the token's company is THE company. A body naming another company is a fixed 404 (nothing about either is said); the one read is
// the key COMPANY#<cid> / SETTINGS, and the item's own companyId is checked against it.
//
// Fail closed: a stored item that does not read (not this company's, bad version, an instruction that is not { text, priority }, over decision 57.6's
// limits) is 503, never "no rules". 401 an unsigned call; 400 a body that is not exactly the contract; 413 over COMPANY_INSTRUCTIONS_BODY_MAX; 405
// not a POST; 429 busy. Nothing from the request, the token or the store is echoed or logged.
import type { IncomingMessage, ServerResponse } from "node:http";
import { GATEWAY_COMPANY_SETTINGS } from "./deploy.js";
import type { Dynamo } from "./dynamo.js";
import { EVAL_AUTHORITY_ANSWERS } from "./eval-authority.js";
import { COMPANY, record, whole } from "./model-gateway-token.js";
import { SERVICE_TOKEN_CLAIMS, SERVICE_TOKEN_SECONDS, SERVICE_TOKEN_TYPE } from "./offered-models.js";
import { serviceCallLimiter } from "./service-call.js";
import type { SignedTokenKind } from "./token.js";

export const COMPANY_INSTRUCTIONS_PATH = "/v1/service/company-instructions";
export const COMPANY_INSTRUCTIONS_AUDIENCE = "rovara-model-gateway-company-instructions";
/** The request body is under 100 bytes; anything over this is refused unread past it. */
export const COMPANY_INSTRUCTIONS_BODY_MAX = 4_096;
/** Per serving task, before any store read (the path is on the public load balancer). */
export const COMPANY_INSTRUCTIONS_OPEN = 8;
export const COMPANY_INSTRUCTIONS_PER_MINUTE = 600;
/** Decision 57.6, as Cloud's COMPANY_SETTINGS_LIMITS holds them (a contract test holds the two equal). */
export const COMPANY_INSTRUCTION_LIMITS = Object.freeze({ max: 30, chars: 600, totalChars: 12_000 });

export interface CompanyInstructionsClaims { iss: string; aud: typeof COMPANY_INSTRUCTIONS_AUDIENCE; jti: string; iat: number; nbf: number; exp: number; cid: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** The service token's claims, exactly (the offered-models token's members, with this route's audience). */
export function parseCompanyInstructionsClaims(value: unknown): CompanyInstructionsClaims | undefined {
  const c = record(value);
  if (c === undefined || Object.keys(c).length !== SERVICE_TOKEN_CLAIMS.length || !SERVICE_TOKEN_CLAIMS.every((name) => Object.hasOwn(c, name))) return undefined;
  if (typeof c.iss !== "string" || c.iss.length === 0 || c.iss.length > 2048 || c.aud !== COMPANY_INSTRUCTIONS_AUDIENCE) return undefined;
  if (typeof c.jti !== "string" || !UUID.test(c.jti) || !whole(c.iat) || !whole(c.nbf) || !whole(c.exp)) return undefined;
  if (typeof c.cid !== "string" || !COMPANY.test(c.cid)) return undefined;
  return c as unknown as CompanyInstructionsClaims;
}
/** createSignedTokenVerifier(..., COMPANY_INSTRUCTIONS_TOKEN_KIND): pinned issuer and task key ids, RS256, at most 60 seconds of life. */
export const COMPANY_INSTRUCTIONS_TOKEN_KIND: SignedTokenKind<CompanyInstructionsClaims> = { typ: SERVICE_TOKEN_TYPE, parse: parseCompanyInstructionsClaims, maxSeconds: SERVICE_TOKEN_SECONDS };

export interface CompanyRuleAnswer { text: string; priority: "required" | "preferred" }
export interface CompanyInstructionsAnswer { company: string; version: string; rules: CompanyRuleAnswer[] }

/** What the route needs: the company's approved rules, `undefined` when it has none; a throw when the stored item does not read or the read failed. */
export interface CompanyInstructionsSource { read(cid: string, signal?: AbortSignal): Promise<{ version: string; rules: CompanyRuleAnswer[] } | undefined> }

const HIDDEN = /[\p{Cc}\p{Cf}]/gu;
/** Folds white space and removes hidden characters, exactly as Cloud's `foldInstruction` (company-settings.ts) does before it measures and stores an instruction. */
export function foldInstruction(text: string): string {
  return text.replace(/\s+/gu, " ").replace(HIDDEN, "").replace(/\s+/gu, " ").trim();
}

/**
 * The company's approved rules from Cloud's Companies table: the one SETTINGS item of COMPANY#<cid>, strongly consistent. No item: no rules. An item that is not
 * this company's, has no whole version of at least 1, or holds instructions that are not exactly Cloud's shape and limits: a throw (the call fails closed).
 */
export class CompanyStoredInstructions implements CompanyInstructionsSource {
  constructor(private readonly db: Dynamo, private readonly table: string) {}
  async read(cid: string, signal?: AbortSignal): Promise<{ version: string; rules: CompanyRuleAnswer[] } | undefined> {
    if (!COMPANY.test(cid)) throw new Error("not a company");
    const item = await this.db.get(this.table, { pk: `${GATEWAY_COMPANY_SETTINGS.partitionPrefix}${cid}`, sk: GATEWAY_COMPANY_SETTINGS.sortKey }, { consistent: true, ...(signal === undefined ? {} : { signal }) });
    if (item === undefined) return undefined;
    if (item.companyId !== cid || !whole(item.version) || item.version < 1) throw new Error("the company's settings do not read");
    const list = record(item.settings)?.instructions;
    if (!Array.isArray(list) || list.length > COMPANY_INSTRUCTION_LIMITS.max) throw new Error("the company's rules do not read");
    const rules: CompanyRuleAnswer[] = [];
    let total = 0;
    for (const entry of list as unknown[]) {
      const rule = record(entry);
      if (rule === undefined || Object.keys(rule).length !== 2 || typeof rule.text !== "string" || (rule.priority !== "required" && rule.priority !== "preferred")) throw new Error("the company's rules do not read");
      // Bounded before folding, so a huge string costs nothing (Cloud's own order).
      if (rule.text.length > COMPANY_INSTRUCTION_LIMITS.chars * 4) throw new Error("the company's rules do not read");
      const text = foldInstruction(rule.text);
      const length = Array.from(text).length;
      if (length === 0 || length > COMPANY_INSTRUCTION_LIMITS.chars) throw new Error("the company's rules do not read");
      total += length;
      rules.push({ text, priority: rule.priority });
    }
    if (total > COMPANY_INSTRUCTION_LIMITS.totalChars) throw new Error("the company's rules do not read");
    return rules.length === 0 ? undefined : { version: String(item.version), rules };
  }
}

export interface CompanyInstructionsHandlerOptions {
  /** createSignedTokenVerifier(..., COMPANY_INSTRUCTIONS_TOKEN_KIND) over this gateway's one install. */
  verify: (token: unknown) => Promise<CompanyInstructionsClaims | undefined>;
  rules: CompanyInstructionsSource;
  now?: () => number;
}

const ANSWERS = EVAL_AUTHORITY_ANSWERS;
export const COMPANY_INSTRUCTIONS_ANSWERS = ANSWERS;

type Request = { method: string; headers: Readonly<Record<string, string | string[] | undefined>>; body: AsyncIterable<Uint8Array> };

/** Reads at most `max` bytes; undefined when the body is longer (the rest is left unread). */
async function readBody(body: AsyncIterable<Uint8Array>, max: number): Promise<Buffer | undefined> {
  const parts: Buffer[] = []; let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > max) return undefined;
    parts.push(Buffer.from(chunk));
  }
  return Buffer.concat(parts);
}

/** The answer to one request: status and JSON body. Exported for tests; the server writes it. */
export async function answerCompanyInstructions(options: CompanyInstructionsHandlerOptions, request: Request, signal: AbortSignal = new AbortController().signal): Promise<{ status: number; body: unknown }> {
  if (request.method !== "POST") return ANSWERS.notAllowed;
  const auth = request.headers.authorization;
  if (typeof auth !== "string" || !auth.startsWith("Bearer ") || request.headers["x-api-key"] !== undefined) return ANSWERS.refused;
  const declared = request.headers["content-length"];
  if (typeof declared === "string" && /^[0-9]+$/u.test(declared) && Number(declared) > COMPANY_INSTRUCTIONS_BODY_MAX) return ANSWERS.tooLarge;
  const claims = await options.verify(auth.slice(7));
  if (claims === undefined) return ANSWERS.refused;
  const bytes = await readBody(request.body, COMPANY_INSTRUCTIONS_BODY_MAX);
  if (bytes === undefined) return ANSWERS.tooLarge;
  const type = request.headers["content-type"];
  if (typeof type !== "string" || type.split(";", 1)[0]!.trim().toLowerCase() !== "application/json") return ANSWERS.invalid;
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")) as unknown; } catch { return ANSWERS.invalid; }
  // Exactly the contract's one member.
  const input = record(parsed);
  if (input === undefined || Object.keys(input).length !== 1 || typeof input.company !== "string") return ANSWERS.invalid;
  // The token's company is THE company: a body naming another one is "not found" (nothing about either is said).
  if (input.company !== claims.cid) return ANSWERS.notFound;
  const cid = claims.cid;
  let found: Awaited<ReturnType<CompanyInstructionsSource["read"]>>;
  try { found = await options.rules.read(cid, signal); } catch { return ANSWERS.unavailable; }
  const answer: CompanyInstructionsAnswer = { company: cid, version: found?.version ?? "0", rules: found?.rules ?? [] };
  return { status: 200, body: answer };
}

/** The HTTP handler the serving process mounts at COMPANY_INSTRUCTIONS_PATH (process.ts), over Cloud's Companies table. */
export function createCompanyInstructionsHandler(options: CompanyInstructionsHandlerOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const limit = serviceCallLimiter(options.now ?? Date.now, COMPANY_INSTRUCTIONS_OPEN, COMPANY_INSTRUCTIONS_PER_MINUTE);
  return async (req, res) => {
    const controller = new AbortController(); const abort = () => controller.abort();
    res.once("close", abort);
    const release = limit.take();
    try {
      const answer = release === undefined ? ANSWERS.busy : await answerCompanyInstructions(options, { method: req.method ?? "", headers: req.headers, body: req }, controller.signal);
      if (release === undefined || answer.status !== 200) req.resume();
      if (res.headersSent || res.destroyed) return;
      res.writeHead(answer.status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(answer.body));
    } finally { release?.(); res.off("close", abort); }
  };
}
