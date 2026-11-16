import { SlackWorkspaceScopeSchema, type SlackThread } from "@agentx/contracts";
import { createSlackWebClient } from "./slack-web.js";
import { createSlackUserNames } from "./user-names.js";

export interface ServiceSlackWorkspaces {
  requireCompany(teamId: string): Promise<string>;
  tokenForCompany(companyId: string, teamId: string): Promise<string | undefined>;
}
const refused = () => new Error("This Slack workspace is not available.");
const MAX_CLIENTS = 128;

/** Each client's token closure retains one immutable binding; concurrent requests share no mutable selection. */
export function createWorkspaceSlackClients(options: { legacyToken(): Promise<string>; workspaces?: ServiceSlackWorkspaces; fetch?: typeof fetch }) {
  const transport = options.fetch === undefined ? {} : { fetch: options.fetch };
  const legacy = { web: createSlackWebClient({ token: () => options.legacyToken(), ...transport }), userName: createSlackUserNames({ token: () => options.legacyToken(), ...transport }) };
  const cache = new Map<string, typeof legacy>();
  return {
    async forThread(thread: Pick<SlackThread, "teamId">): Promise<typeof legacy> {
      const workspaces = options.workspaces;
      if (workspaces === undefined) return legacy;
      try {
        const teamId = thread?.teamId;
        // Validate the team before any binding read, including hostile runtime callers.
        if (typeof teamId !== "string" || !/^T[A-Z0-9]{2,31}$/.test(teamId)) throw refused();
        const parsed = SlackWorkspaceScopeSchema.safeParse({ companyId: await workspaces.requireCompany(teamId), teamId });
        if (!parsed.success) throw refused();
        const scope = parsed.data;
        const key = `${scope.companyId}/${scope.teamId}`;
        const found = cache.get(key);
        if (found !== undefined) return found;
        const token = async () => {
          try {
            if (await workspaces.requireCompany(scope.teamId) !== scope.companyId) throw refused();
            const value = await workspaces.tokenForCompany(scope.companyId, scope.teamId);
            if (typeof value !== "string" || value.length > 4096 || !/^xoxb-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(value)) throw refused();
            return value;
          } catch { throw refused(); }
        };
        const web = createSlackWebClient({ token, ...transport });
        const client = { web, async userName(userId: string) {
          // No per-user cache inside each workspace: the TOTAL retained state is 128 clients.
          try {
            const user = await web.userInfo(userId, AbortSignal.timeout(2_000));
            return user?.profile?.display_name || user?.profile?.real_name || user?.real_name || user?.name || undefined;
          } catch { return undefined; }
        } };
        if (cache.size >= MAX_CLIENTS) cache.delete(cache.keys().next().value!);
        cache.set(key, client);
        return client;
      } catch { throw refused(); }
    },
  };
}
