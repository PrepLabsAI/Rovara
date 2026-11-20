// tests/contract/config-limits-change.test.ts
// Spec 025 FR-053, E17, E19: agentx config set limits.* plans the change, shows it, asks, and applies
// it through the admin change path with the cli method; the broker's next creation uses it.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { tokenStoreKey } from "../../packages/cli/src/auth.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";
import { runConfigSet, type ConfigServices } from "../../packages/cli/src/config/commands.js";
import { createAdminChangeBroker } from "../support/admin-change-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM, ensureWorkspace } from "../support/slack-broker.js";
import { configServicesFor } from "../support/config-services.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

/** The CLI's fetch, into the broker in process, with the admin sign-in's claims (API Gateway's JWT authorizer). */
function brokerFetch(harness: Awaited<ReturnType<typeof createAdminChangeBroker>>): typeof fetch {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const answer = await harness.admin(init?.method ?? "GET", `${url.pathname}${url.search}`, { ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}) });
    return Response.json(answer.body, { status: answer.status });
  };
}

const LEGACY_REFUSAL = "limits.workspacesPerMember changes through AgentX's admin change path, which only environments installed with agentx init have, not the legacy deployment; nothing changed. To change it there, update the AgentXControlPlane stack parameter SlackMemberWorkspaceLimit";
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

  it("refuses a value out of range before anything is planned", async () => {
    const harness = await createAdminChangeBroker();
    const services = await configServicesFor({ adminSession: async () => SESSION, fetch: brokerFetch(harness) });
    await expect(runConfigSet(services, "staging", { key: "limits.workspacesPerMember", value: "51", yes: true })).rejects.toThrow("from 1 to 50");
    expect(harness.db.find((item) => item.entityType === "ADMIN_CHANGE_AUDIT")).toEqual([]);
    expect(harness.db.get("SETTINGS", "WORKSPACE_LIMITS")).toBeUndefined();
  });

  it("refuses the same way for production before agentx env adopt, when it has no settings record at all", async () => {
    let fetched = false;
    const services = await configServicesFor({ store: new MemoryParameterStore(), adminSession: async () => SESSION, fetch: (async () => { fetched = true; return Response.json({}); }) as unknown as typeof fetch });
    await expect(runConfigSet(services, "production", { key: "limits.workspacesPerMember", value: "5", yes: true })).rejects.toThrow(LEGACY_REFUSAL);
    // Any other environment with no settings is still not installed.
    await expect(runConfigSet(services, "staging", { key: "limits.workspacesPerMember", value: "5", yes: true })).rejects.toThrow("environment staging is not installed in this account and region; check --env and --region");
    expect(fetched).toBe(false);
  });

  describe("through agentx config set", () => {
    const deployment = { controlPlaneUrl: "http://127.0.0.1:8787", auth: { issuer: "https://identity.example.test", clientId: "agentx-client", audience: "agentx-api" } };
    const TOKEN = "access-secret-7f3a";
    /** A terminal's stdin when `tty`, with `answer` typed into it; otherwise a pipe with nothing in it. */
    function input(tty: boolean, answer?: string): PassThrough & { isTTY?: boolean } {
      const stream: PassThrough & { isTTY?: boolean } = new PassThrough();
      if (tty) stream.isTTY = true;
      if (answer !== undefined) stream.write(answer);
      return stream;
    }
    async function cli(options: { signedIn: boolean; prompter: boolean; stdin?: PassThrough & { isTTY?: boolean } }) {
      const harness = await createAdminChangeBroker();
      const directory = await mkdtemp(join(tmpdir(), "agentx-config-limits-"));
      const deploymentFile = join(directory, "deployment.yaml");
      await writeFile(deploymentFile, JSON.stringify(deployment), "utf8");
      const tokens = new InMemoryTokenStore();
      if (options.signedIn) await tokens.set(tokenStoreKey(deployment.auth), { accessToken: TOKEN, expiresAt: Date.now() + 60_000 });
      // The config services' AWS clients are faked; the admin sign-in is main.ts's own.
      // The admin sign-in and the fetch are main.ts's own here, not the services' test defaults.
      const { prompter, lines, ...config } = await configServicesFor();
      delete config.adminSession;
      delete config.fetch;
      let fetched = 0;
      const fetch = brokerFetch(harness);
      let stdout = "";
      let stderr = "";
      const io = {
        fetchImplementation: (async (...args: Parameters<typeof fetch>) => { fetched += 1; return fetch(...args); }) as typeof fetch,
        tokenStore: tokens,
        stdin: options.stdin ?? input(false),
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
      expect(session.stderr()).toContain("[CONFIRMATION_UNAVAILABLE]");
      expect(session.stderr()).toContain("limits.workspacesPerMember needs a yes: run the command in a terminal to answer its prompt, or pass --yes");
      expect(session.fetched()).toBe(0);
      expect(session.harness.db.find((item) => item.entityType === "ADMIN_CHANGE_AUDIT")).toEqual([]);
    });

    it("in a terminal, asks with the effect; n declines it, and the command says nothing changed", async () => {
      const session = await cli({ signedIn: true, prompter: false, stdin: input(true, "n\r") });
      expect(await session.run(["limits.workspacesPerOrg", "40"])).toBe(0);
      expect(session.stderr()).toContain("Apply this change? [y/N]");
      expect(session.stdout()).toBe("Nothing changed.\n");
      expect(session.harness.db.get("SETTINGS", "WORKSPACE_LIMITS")).toBeUndefined();
      expect(session.harness.db.find((item) => item.entityType === "ADMIN_CHANGE_AUDIT")[0]).toMatchObject({ outcome: "declined", methodUsed: "cli" });
    });

    it("without the admin sign-in, says to sign in and plans nothing", async () => {
      const session = await cli({ signedIn: false, prompter: false });
      expect(await session.run(["limits.workspacesPerMember", "2", "--yes"])).not.toBe(0);
      expect(session.stderr()).toContain("limits.workspacesPerMember changes through AgentX's admin change path, which needs this computer's admin sign-in; run agentx --env staging login --admin, then try again");
      expect(session.fetched()).toBe(0);
    });
  });
});
