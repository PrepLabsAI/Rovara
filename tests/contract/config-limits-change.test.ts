// tests/contract/config-limits-change.test.ts
// Spec 025 FR-053, E17, E19: agentx config set limits.* plans the change, shows it, asks, and applies
// it through the admin change path with the cli method; the broker's next creation uses it.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tokenStoreKey } from "../../packages/cli/src/auth.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";
import { runConfigSet, type ConfigServices } from "../../packages/cli/src/config/commands.js";
import { writeEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { createAdminChangeBroker } from "../support/admin-change-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM, ensureWorkspace } from "../support/slack-broker.js";
import { configServicesFor } from "../support/config-services.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";
import { STAGING_SETTINGS } from "../support/setup-fakes.js";

/** The CLI's fetch, into the broker in process, with the admin sign-in's claims (API Gateway's JWT authorizer). */
function brokerFetch(harness: Awaited<ReturnType<typeof createAdminChangeBroker>>): typeof fetch {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const answer = await harness.admin(init?.method ?? "GET", `${url.pathname}${url.search}`, { ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}) });
    return Response.json(answer.body, { status: answer.status });
  };
}

const SESSION = { controlPlaneUrl: "https://abc123.execute-api.us-east-1.amazonaws.com", accessToken: "admin-token-for-tests" };

describe("agentx config set limits.* (FR-053, owner requirement)", () => {
  it("shows who is over the new limit, asks, and the next creation uses it", async () => {
    const harness = await createAdminChangeBroker();
    for (const ts of ["1695500000.000401", "1695500000.000402", "1695500000.000403"]) await ensureWorkspace(harness.handler, `${SLACK_TEAM}/${SLACK_CHANNEL}/${ts}`, "U0PRIYA001");
    const asked: string[] = [];
    const services: ConfigServices = await configServicesFor({
      adminSession: async () => ({ controlPlaneUrl: "https://abc123.execute-api.us-east-1.amazonaws.com", accessToken: "admin-token-for-tests" }),
      fetch: brokerFetch(harness),
      prompter: { confirm: async (question: string) => { asked.push(question); return true; } } as never,
    });
    expect(await runConfigSet(services, "staging", { key: "limits.workspacesPerMember", value: "2", yes: false })).toEqual({ changed: true });
    expect(asked[0]).toContain("At or over 2 per person: Slack member U0PRIYA001 (3 open).");
    expect(harness.db.get("SETTINGS", "WORKSPACE_LIMITS")).toMatchObject({ perPerson: 2, perOrganization: 20 });
    const audit = harness.db.find((item) => item.entityType === "ADMIN_CHANGE_AUDIT")[0];
    expect(audit).toMatchObject({ kind: "set_workspace_limits", methodUsed: "cli", outcome: "confirmed" });
    // Existing workspaces keep running; the next one for this member is refused, another member's is not.
    expect((await ensureWorkspace(harness.handler, `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000404`, "U0PRIYA001")).body).toMatchObject({ outcome: "LIMIT_REACHED", limit: "MEMBER", maximum: 2 });
    expect((await ensureWorkspace(harness.handler, `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000405`, "U0OMAR0001")).body).toMatchObject({ outcome: "WORKSPACE", created: true });
  });

  it("changes nothing on no, and the audit says declined", async () => {
    const harness = await createAdminChangeBroker();
    const services = await configServicesFor({
      adminSession: async () => ({ controlPlaneUrl: "https://abc123.execute-api.us-east-1.amazonaws.com", accessToken: "admin-token-for-tests" }),
      fetch: brokerFetch(harness),
      prompter: { confirm: async () => false } as never,
    });
    expect(await runConfigSet(services, "staging", { key: "limits.workspacesPerOrg", value: "40", yes: false })).toEqual({ changed: false });
    expect(harness.db.get("SETTINGS", "WORKSPACE_LIMITS")).toBeUndefined();
    expect(harness.db.find((item) => item.entityType === "ADMIN_CHANGE_AUDIT")[0]).toMatchObject({ outcome: "declined", methodUsed: "cli" });
  });

  it("with --yes applies without asking, still prints the effect once, and never prints the admin token", async () => {
    const harness = await createAdminChangeBroker();
    const asked: string[] = [];
    const services = await configServicesFor({
      adminSession: async () => SESSION,
      fetch: brokerFetch(harness),
      prompter: { confirm: async (question: string) => { asked.push(question); return false; } } as never,
    });
    expect(await runConfigSet(services, "staging", { key: "limits.workspacesPerOrg", value: "40", yes: true })).toEqual({ changed: true });
    expect(asked).toEqual([]);
    expect(harness.db.get("SETTINGS", "WORKSPACE_LIMITS")).toMatchObject({ perPerson: 3, perOrganization: 40 });
    expect(services.lines.filter((line) => line.includes("40"))).toHaveLength(1);
    expect(services.lines.at(-1)).toBe("Applied.");
    expect(services.lines.join("\n")).not.toContain(SESSION.accessToken);
  });

  it("shows the effect once when it asks: in the question, not also above it", async () => {
    const harness = await createAdminChangeBroker();
    const asked: string[] = [];
    const services = await configServicesFor({
      adminSession: async () => SESSION,
      fetch: brokerFetch(harness),
      prompter: { confirm: async (question: string) => { asked.push(question); return false; } } as never,
    });
    await runConfigSet(services, "staging", { key: "limits.workspacesPerOrg", value: "40", yes: false });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/\nApply this change\?$/);
    const effect = asked[0]!.replace(/\nApply this change\?$/, "");
    expect(services.lines).not.toContain(effect);
    expect(services.lines).toEqual(["Nothing changed."]);
  });

  it("refuses a value out of range before anything is planned", async () => {
    const harness = await createAdminChangeBroker();
    const services = await configServicesFor({ adminSession: async () => SESSION, fetch: brokerFetch(harness) });
    await expect(runConfigSet(services, "staging", { key: "limits.workspacesPerMember", value: "51", yes: true })).rejects.toThrow("from 1 to 50");
    expect(harness.db.find((item) => item.entityType === "ADMIN_CHANGE_AUDIT")).toEqual([]);
    expect(harness.db.get("SETTINGS", "WORKSPACE_LIMITS")).toBeUndefined();
  });

  it("refuses in the legacy deployment, which has no admin change path (D14), and says what to do instead", async () => {
    const store = new MemoryParameterStore();
    await writeEnvironmentSettings(store, { ...STAGING_SETTINGS, env: "production", naming: "legacy" } as never);
    let fetched = false;
    const services = await configServicesFor({ store, adminSession: async () => SESSION, fetch: (async () => { fetched = true; return Response.json({}); }) as unknown as typeof fetch });
    await expect(runConfigSet(services, "production", { key: "limits.workspacesPerMember", value: "5", yes: true }))
      .rejects.toThrow("limits.workspacesPerMember changes through AgentX's admin change path, which only environments installed with agentx init have, not the legacy deployment; nothing changed. The legacy deployment keeps its stack parameter SlackMemberWorkspaceLimit");
    expect(fetched).toBe(false);
  });

  describe("through agentx config set", () => {
    const deployment = { controlPlaneUrl: "http://127.0.0.1:8787", auth: { issuer: "https://identity.example.test", clientId: "agentx-client", audience: "agentx-api" } };
    const TOKEN = "access-secret-7f3a";
    async function cli(options: { signedIn: boolean; prompter: boolean }) {
      const harness = await createAdminChangeBroker();
      const directory = await mkdtemp(join(tmpdir(), "agentx-config-limits-"));
      const deploymentFile = join(directory, "deployment.yaml");
      await writeFile(deploymentFile, JSON.stringify(deployment), "utf8");
      const tokens = new InMemoryTokenStore();
      if (options.signedIn) await tokens.set(tokenStoreKey(deployment.auth), { accessToken: TOKEN, expiresAt: Date.now() + 60_000 });
      // The config services' AWS clients are faked; the admin sign-in is main.ts's own.
      const { prompter, lines, ...config } = await configServicesFor();
      let fetched = 0;
      const fetch = brokerFetch(harness);
      let stdout = "";
      let stderr = "";
      const io = {
        fetchImplementation: (async (...args: Parameters<typeof fetch>) => { fetched += 1; return fetch(...args); }) as typeof fetch,
        tokenStore: tokens,
        config: { ...config, ...(options.prompter ? { prompter } : {}), write: (line: string) => { stderr += `${line}\n`; } },
        stdout: { write: (text: string) => { stdout += text; return true; } },
        stderr: { write: (text: string) => { stderr += text; return true; } },
      };
      const run = (args: string[]) => executeCli(["--env", "staging", "--deployment-file", deploymentFile, "--allow-loopback", "config", "set", ...args], io);
      return { harness, run, lines, stdout: () => stdout, stderr: () => stderr, fetched: () => fetched };
    }

    it("--yes applies with this computer's admin sign-in, audits the cli method, and never prints the token", async () => {
      const session = await cli({ signedIn: true, prompter: false });
      expect(await session.run(["limits.workspacesPerOrg", "40", "--yes"])).toBe(0);
      expect(session.stdout()).toBe("limits.workspacesPerOrg changed.\n");
      expect(session.stderr()).toContain("Applied.");
      expect(session.harness.db.get("SETTINGS", "WORKSPACE_LIMITS")).toMatchObject({ perOrganization: 40 });
      expect(session.harness.db.find((item) => item.entityType === "ADMIN_CHANGE_AUDIT")[0]).toMatchObject({ kind: "set_workspace_limits", methodUsed: "cli", outcome: "confirmed" });
      expect(`${session.stdout()}${session.stderr()}`).not.toContain(TOKEN);
    });

    it("without --yes and without a terminal, refuses before anything is planned", async () => {
      const session = await cli({ signedIn: true, prompter: false });
      expect(await session.run(["limits.workspacesPerMember", "2"])).not.toBe(0);
      expect(session.stderr()).toContain("limits.workspacesPerMember needs a yes: run the command in a terminal to answer its prompt, or pass --yes");
      expect(session.fetched()).toBe(0);
      expect(session.harness.db.find((item) => item.entityType === "ADMIN_CHANGE_AUDIT")).toEqual([]);
    });

    it("without the admin sign-in, says to sign in and plans nothing", async () => {
      const session = await cli({ signedIn: false, prompter: false });
      expect(await session.run(["limits.workspacesPerMember", "2", "--yes"])).not.toBe(0);
      expect(session.stderr()).toContain("limits.workspacesPerMember changes through AgentX's admin change path, which needs this computer's admin sign-in; run agentx --env staging login --admin, then try again");
      expect(session.fetched()).toBe(0);
    });
  });
});
