// agentx doctor's Sign in with ChatGPT checks (#343): the admin's switch, how many people are
// connected, and whether the control plane reaches OpenAI. The control plane alone knows these, so
// they are read through this computer's admin sign-in; without one they are skipped, with how to sign in.
import { CLI_PACKAGE_NAME, ChatGptHealthSchema, type ChatGptHealth } from "@agentx/contracts";
import { check, type DoctorCheck, type DoctorContext } from "./checks.js";

export type ChatGptHealthRead = { kind: "health"; health: ChatGptHealth } | { kind: "signed-out" } | { kind: "not-set-up" };

/** GET /v1/admin/chatgpt with an admin sign-in; any other failure throws, and the group says it could not run. */
export async function readChatGptHealth(fetchImplementation: typeof fetch, session: { controlPlaneUrl: string; accessToken: string } | undefined): Promise<ChatGptHealthRead> {
  if (session === undefined) return { kind: "signed-out" };
  const response = await fetchImplementation(`${session.controlPlaneUrl.replace(/\/$/, "")}/v1/admin/chatgpt`, {
    headers: { authorization: `Bearer ${session.accessToken}` }, signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 404) return { kind: "not-set-up" };
  if (response.status === 401 || response.status === 403) return { kind: "signed-out" };
  if (!response.ok) throw new Error(`the control plane answered HTTP ${response.status}`);
  const parsed = ChatGptHealthSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw new Error("the control plane answered with something unexpected");
  return { kind: "health", health: parsed.data };
}

export async function chatGptChecks(context: DoctorContext): Promise<DoctorCheck[]> {
  const read = context.services.chatgpt;
  const name = "Sign in with ChatGPT";
  const cli = `npx ${CLI_PACKAGE_NAME} --env ${context.env}`;
  if (read === undefined) return [check("chatgpt", name, "skip", "not checked by this agentx")];
  const result = await read();
  if (result.kind === "signed-out") {
    return [check("chatgpt", name, "skip", `not checked: this computer has no working admin sign-in for ${context.env}`, `run ${cli} login --admin, then run agentx doctor again`)];
  }
  if (result.kind === "not-set-up") return [check("chatgpt", name, "skip", "not set up in this deployment")];
  const { health } = result;
  const people = `${health.connected}${health.connectedComplete ? "" : " or more"} ${health.connected === 1 && health.connectedComplete ? "person has" : "people have"} connected a ChatGPT plan`;
  const reach = (host: string, reached: boolean): DoctorCheck => reached
    ? check("chatgpt", `reach ${host}`, "ok", "the control plane reaches it")
    // Only a problem while the switch is on: off, nothing uses OpenAI.
    : check("chatgpt", `reach ${host}`, health.enabled ? "fail" : "warn", `the control plane could not reach ${host} over HTTPS`,
      "check the control plane's outbound internet access (the broker Lambda), then run agentx doctor again");
  return [
    health.enabled
      ? check("chatgpt", name, "ok", `on; tasks prefer ${health.preferredModel} where a person's plan allows it`)
      : check("chatgpt", name, "ok", `off; turn it on with ${cli} config set models.chatgpt.enabled true`),
    check("chatgpt", "connections", "ok", people),
    reach("auth.openai.com", health.reachable.auth),
    reach("api.openai.com", health.reachable.api),
  ];
}
