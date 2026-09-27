// agentx whoami and agentx logout (FR-011).
import { AGENTX_CLI_CLIENT_ID, DeveloperProjectsResponseSchema, agentXError, type DeveloperProjectsResponse } from "@agentx/contracts";
import { developerTokenKey, removeDeveloperEnvironment, resolveDeveloperEnvironment } from "./config.js";
import { developerAccessToken, type DeveloperSessionDeps } from "./session.js";

export async function fetchDeveloperProjects(deps: DeveloperSessionDeps, env: string | undefined): Promise<{ env: string; url: string; projects: DeveloperProjectsResponse }> {
  const session = await developerAccessToken(deps, env);
  let response: Response;
  try {
    response = await deps.fetch(`${session.entry.url}/v1/dev/projects`, { headers: { authorization: `Bearer ${session.accessToken}` }, signal: AbortSignal.timeout(20_000) });
  } catch {
    throw agentXError("RUNTIME_UNAVAILABLE", `could not reach AgentX at ${session.entry.url}; check your connection and try again`);
  }
  if (response.status === 401) throw agentXError("AUTH_REQUIRED", `your AgentX sign-in for ${session.env} has ended; run npx @charterarc/agentx login ${session.entry.url}`);
  if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `AgentX answered HTTP ${response.status}; try again`);
  const parsed = DeveloperProjectsResponseSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw agentXError("RUNTIME_UNAVAILABLE", "AgentX answered with something unexpected; try again, or upgrade: npx @charterarc/agentx@latest whoami");
  return { env: session.env, url: session.entry.url, projects: parsed.data };
}

export function whoamiText(result: { env: string; url: string; projects: DeveloperProjectsResponse }): string {
  const { developer, projects, notices } = result.projects;
  const method = developer.provider === "slack" ? "Slack" : "your company sign-in";
  const link = developer.slackUserId === undefined ? "" : ` (${developer.slackUserId})`;
  const lines = [`Signed in to AgentX environment ${result.env} (${result.url}) as ${developer.name}, with ${method}${link}.`];
  if (projects.length === 0) {
    lines.push("You cannot use any project yet: join a project's Slack channel, or ask an admin for access.");
  } else {
    lines.push("Projects you can use:");
    for (const project of projects) {
      const how = project.access === "granted" ? "an admin granted you access" : `you are in its Slack channel ${project.channels.map((channel) => channel.channelId).join(", ")}`;
      lines.push(`  ${project.name}  (${how})`);
    }
  }
  if (notices.includes("slack_unavailable")) lines.push("Slack could not be reached, so projects you use through a Slack channel are not listed; try again later.");
  return `${lines.join("\n")}\n`;
}

/**
 * Ends the sign-in at the server (RFC 7009 revoke) and on this computer. The local tokens and
 * environment are removed even when the server cannot be reached; `revoked` says whether it was.
 */
export async function developerLogout(deps: DeveloperSessionDeps, env: string | undefined): Promise<{ env: string; revoked: boolean }> {
  const resolved = await resolveDeveloperEnvironment(deps.home, env);
  const key = developerTokenKey(resolved.entry.issuer);
  const tokens = await deps.tokenStore.get(key);
  let revoked = false;
  if (tokens?.refreshToken !== undefined) {
    revoked = await deps.fetch(resolved.entry.revocationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: tokens.refreshToken, client_id: AGENTX_CLI_CLIENT_ID }).toString(),
      signal: AbortSignal.timeout(5_000),
    }).then((response) => response.ok, () => false);
  }
  await deps.tokenStore.delete(key);
  await removeDeveloperEnvironment(deps.home, resolved.env);
  return { env: resolved.env, revoked };
}
