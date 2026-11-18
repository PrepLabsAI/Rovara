// DEC 254g: `agentx config set coreEngine.agentModel <id>` takes ANY model the model gateway offers, not a list Code holds. Before any deploy, a non-Claude id is checked against the
// gateway's LIVE offered-models answer for this install: only the broker may sign the gateway's service token (the task key's policy permits only its role), so the CLI asks the broker's
// admin read (contracts CORE_OFFERED_MODELS_ADMIN_PATH, core-host/offered-models-http.ts) with this computer's admin sign-in, for the administrator's company.
//
// Fail closed: no admin sign-in, a gateway that is not set up, an answer that is not the contract (OfferedAgentModels), a time-out or any other failure refuses the change, in fixed
// words. Nothing of the broker's or gateway's answer is echoed except the offered model names themselves (each already held to the contract's model-name characters).
import { CORE_OFFERED_MODELS_ADMIN_PATH, OfferedAgentModelsSchema, agentXError, isCoreAgentModelId, CLI_COMMAND_NAME } from "@agentx/contracts";

/** The longest the read may take. */
export const GATEWAY_OFFERED_TIMEOUT_MS = 15_000;
/** The most of the answer that is read. */
export const GATEWAY_OFFERED_BODY_MAX_BYTES = 65_536;
/** How many offered models a refusal names. */
export const GATEWAY_OFFERED_EXAMPLES = 5;

export interface GatewayOfferedInputs {
  key: string;
  env: string;
  /** The id already checked by the key's parser (isCoreAgentModelId), so it is safe to name. */
  value: string;
  session: { controlPlaneUrl: string; accessToken: string } | undefined;
  fetch: typeof fetch;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > GATEWAY_OFFERED_BODY_MAX_BYTES) throw new Error("too large");
  // Read with a running byte cap: a chunked answer with no length is never buffered past the limit.
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined;
  for (;;) {
    if (reader === undefined) break;
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > GATEWAY_OFFERED_BODY_MAX_BYTES) { await reader.cancel().catch(() => undefined); throw new Error("too large"); }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

/** Refuses (fixed words) unless the model gateway offers `value` to the administrator's company now. */
export async function requireGatewayOffers(input: GatewayOfferedInputs): Promise<void> {
  const { key, env, value } = input;
  const notChanged = `${key} was not changed`;
  if (input.session === undefined) {
    throw agentXError("AUTH_REQUIRED", `${notChanged}: a model other than Claude is checked against the models the model gateway offers, which needs this computer's admin sign-in for ${env}; run ${CLI_COMMAND_NAME} --env ${env} login --admin, then try again; nothing changed`);
  }
  const unreadable = () => agentXError("RUNTIME_UNAVAILABLE", `${notChanged}: the models the model gateway offers could not be read just now, so ${value} could not be checked; nothing changed, try again`);
  let status: number;
  let body: unknown;
  try {
    const response = await input.fetch(`${input.session.controlPlaneUrl.replace(/\/+$/u, "")}${CORE_OFFERED_MODELS_ADMIN_PATH}`, {
      method: "GET", redirect: "error", headers: { accept: "application/json", authorization: `Bearer ${input.session.accessToken}` }, signal: AbortSignal.timeout(GATEWAY_OFFERED_TIMEOUT_MS),
    });
    status = response.status;
    body = status === 200 ? await boundedJson(response) : undefined;
    if (status !== 200) await response.body?.cancel().catch(() => undefined);
  } catch { throw unreadable(); }
  if (status === 401 || status === 403) {
    throw agentXError("AUTH_REQUIRED", `${notChanged}: Rovara would not show the models the model gateway offers to this computer's admin sign-in; run ${CLI_COMMAND_NAME} --env ${env} login --admin, then try again; nothing changed`);
  }
  if (status === 404) {
    throw agentXError("CONFIG_INVALID", `${notChanged}: the model gateway is not set up on ${env} yet, so ${value} cannot be checked; set coreEngine.modelGatewayUrl first (${CLI_COMMAND_NAME} --env ${env} config set coreEngine.modelGatewayUrl <https origin>), then try again; nothing changed`);
  }
  if (status !== 200) throw unreadable();
  // The broker's answer is the contract plus its own requestId; only the contract's two fields are judged (the schema is strict).
  const record = body !== null && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const parsed = OfferedAgentModelsSchema.safeParse({ version: record.version, models: record.models });
  if (!parsed.success) throw unreadable();
  const names = parsed.data.models.map((entry) => entry.model);
  if (names.includes(value)) return;
  // Only names this setting can hold are offered as examples (the gateway's names may be longer or carry upper case).
  const settable = names.filter(isCoreAgentModelId);
  const examples = [...settable.filter((name) => !name.startsWith("claude-")), ...settable.filter((name) => name.startsWith("claude-"))].slice(0, GATEWAY_OFFERED_EXAMPLES);
  const offers = examples.length === 0 ? "it offers no model this setting can hold" : `it offers ${examples.join(", ")}${settable.length > examples.length ? `, and ${settable.length - examples.length} more` : ""}`;
  // DEC 254g: the agent model is the whole install's; this is the administrator's company's list (the gateway still refuses at run time for a company it does not offer it to).
  throw agentXError("CONFIG_INVALID", `${notChanged}: the model gateway does not offer ${value} to this company; ${offers}; nothing changed`);
}
