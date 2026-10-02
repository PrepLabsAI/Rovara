import { describe, expect, it } from "vitest";
import {
  INIT_STEP_IDS, emptyProgress, installAnswersParameterName, installProgressParameterName, readInstallAnswers,
  readInstallProgress, SLACK_BOT_HANDLE_PATTERN, writeInstallAnswers, writeInstallProgress, type InitAnswers,
} from "../../packages/cli/src/init/install-state.js";
import { GITHUB_LOGIN_PATTERN } from "../../packages/cli/src/deploy/answer-schemas.js";
import { sampleAnswers } from "../support/init-fakes.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

const T0 = Date.parse("2026-09-27T00:00:00.000Z");

describe("install state", () => {
  it("names its parameters under the environment's settings prefix", () => {
    expect(installAnswersParameterName("staging")).toBe("/agentx/staging/install/answers");
    expect(installProgressParameterName("staging")).toBe("/agentx/staging/install/progress");
  });

  it("round-trips answers and progress", async () => {
    const store = new MemoryParameterStore();
    await writeInstallAnswers(store, sampleAnswers());
    expect(await readInstallAnswers(store, "staging")).toEqual(sampleAnswers());
    const progress = { ...emptyProgress("staging", T0), steps: { access: { status: "done" as const, at: "2026-09-27T00:00:00.000Z" } } };
    await writeInstallProgress(store, progress);
    expect(await readInstallProgress(store, "staging")).toEqual(progress);
    expect(await readInstallProgress(store, "other")).toBeUndefined();
  });

  it("reads an older Slack record that has no bot handle or workspace name", async () => {
    const store = new MemoryParameterStore();
    const older = { ...emptyProgress("staging", T0), slack: { appId: "A0APP00001", teamId: "T0123456789", botUserId: "U0BOT00001" } };
    await writeInstallProgress(store, older);
    expect(await readInstallProgress(store, "staging")).toEqual(older);
  });

  it("holds the bot handle to one pattern, the one the Slack app step checks before it stores it", async () => {
    expect(SLACK_BOT_HANDLE_PATTERN.test("agentx-acme-staging")).toBe(true);
    expect(SLACK_BOT_HANDLE_PATTERN.test("AgentX Bot")).toBe(false);
    const store = new MemoryParameterStore();
    const progress = { ...emptyProgress("staging", T0), slack: { appId: "A0APP00001", teamId: "T0123456789", botUserId: "U0BOT00001", botName: "AgentX Bot" } };
    await expect(writeInstallProgress(store, progress)).rejects.toThrow();
  });

  it("shares the GitHub login pattern with answers.ts (Fix round 1, item 1): refuses the same invalid login", async () => {
    expect(GITHUB_LOGIN_PATTERN.test("-bad")).toBe(false);
    const store = new MemoryParameterStore();
    await expect(writeInstallAnswers(store, sampleAnswers({ github: { account: "-bad", accountType: "organization", appName: "AgentX" } })))
      .rejects.toThrow("install answers are invalid");
    expect(store.values.size).toBe(0);
  });

  it("refuses answers that carry an unknown field, such as a secret someone added", async () => {
    const store = new MemoryParameterStore();
    await expect(writeInstallAnswers(store, { ...sampleAnswers(), botToken: "xoxb-1" } as InitAnswers)).rejects.toThrow("install answers are invalid");
    expect(store.values.size).toBe(0);
  });

  it("refuses a value larger than a standard SSM parameter, naming the size", async () => {
    const store = new MemoryParameterStore();
    const huge = sampleAnswers({ identity: { mode: "oidc", issuer: "https://id.example.com", audience: "a", clientId: "c", adminClaim: "groups", adminValues: Array.from({ length: 400 }, (_, i) => `group-${i}`) } });
    await expect(writeInstallAnswers(store, huge)).rejects.toThrow(/install answers for environment staging are \d+ bytes, more than SSM's 4096-byte limit/);
    expect(store.values.size).toBe(0);
  });

  it("the largest ordinary answers fit comfortably", async () => {
    const store = new MemoryParameterStore();
    const big = sampleAnswers({
      permissionsBoundaryArn: `arn:aws:iam::123456789012:policy/${"b".repeat(120)}`,
      operatorPrincipalArn: `arn:aws:iam::123456789012:role/${"o".repeat(64)}`,
      images: { worker: `123456789012.dkr.ecr.us-east-1.amazonaws.com/w@sha256:${"a".repeat(64)}`, slack: `123456789012.dkr.ecr.us-east-1.amazonaws.com/s@sha256:${"b".repeat(64)}` },
      alert: { kind: "webhook", display: "https://events.pagerduty.com/...", secretName: "agentx/staging/alert-endpoint" },
    });
    await writeInstallAnswers(store, big);
    expect(Buffer.byteLength(store.values.get("/agentx/staging/install/answers")!)).toBeLessThan(2048);
  });

  it("explains progress written by a newer agentx (a schema version this agentx does not know)", async () => {
    const store = new MemoryParameterStore();
    store.values.set("/agentx/staging/install/progress", JSON.stringify({ ...emptyProgress("staging", T0), schemaVersion: 2 }));
    await expect(readInstallProgress(store, "staging")).rejects.toThrow("install progress for environment staging is invalid or was written by a newer agentx; upgrade agentx and run it again");
  });

  // Fix round 1, item 6: an unknown step id (one an older or newer agentx used, that this one has
  // removed or renamed) must not fail the whole read — it carries no state this agentx can use, but
  // every other step's already-recorded progress is still worth keeping.
  it("drops an unknown step id instead of refusing, keeping the known steps intact", async () => {
    const store = new MemoryParameterStore();
    store.values.set(installProgressParameterName("staging"), JSON.stringify({
      ...emptyProgress("staging", T0),
      steps: {
        access: { status: "done", at: "2026-09-27T00:00:00.000Z" },
        "future-step": { status: "done", at: "2026-09-27T00:00:00.000Z" },
      },
    }));
    const progress = await readInstallProgress(store, "staging");
    expect(progress?.steps).toEqual({ access: { status: "done", at: "2026-09-27T00:00:00.000Z" } });
  });

  it("still refuses a malformed record under a known step id once unknown ids are dropped", async () => {
    const store = new MemoryParameterStore();
    store.values.set(installProgressParameterName("staging"), JSON.stringify({
      ...emptyProgress("staging", T0),
      steps: {
        access: { status: "finished", at: "2026-09-27T00:00:00.000Z" },
        "future-step": { status: "done", at: "2026-09-27T00:00:00.000Z" },
      },
    }));
    await expect(readInstallProgress(store, "staging")).rejects.toThrow("install progress for environment staging is invalid or was written by a newer agentx; upgrade agentx and run it again");
  });

  // F22: reading install state refuses when the stored env does not match the requested one, even
  // though the stored value is otherwise a perfectly well-formed answers/progress document (its own
  // `env` field is just a different, equally valid, environment name).
  it("refuses install answers whose own env field names a different environment than requested, saying what to do next", async () => {
    const store = new MemoryParameterStore();
    await writeInstallAnswers(store, sampleAnswers({ env: "production" }));
    // Copy the value under staging's parameter name, as if it had been restored or copied by hand.
    store.values.set(installAnswersParameterName("staging"), store.values.get(installAnswersParameterName("production"))!);
    await expect(readInstallAnswers(store, "staging")).rejects.toThrow(/staging.*production/);
    await expect(readInstallAnswers(store, "staging")).rejects.toThrow("run agentx init --env production, or delete /agentx/staging/install/answers to start over");
  });

  it("refuses install progress whose own env field names a different environment than requested, saying what to do next", async () => {
    const store = new MemoryParameterStore();
    await writeInstallProgress(store, emptyProgress("production", T0));
    store.values.set(installProgressParameterName("staging"), store.values.get(installProgressParameterName("production"))!);
    await expect(readInstallProgress(store, "staging")).rejects.toThrow(/staging.*production/);
    await expect(readInstallProgress(store, "staging")).rejects.toThrow("run agentx init --env production, or delete /agentx/staging/install/progress to start over");
  });

  // Fix round 1, item 1: a webhook display value must never be able to carry an integration key
  // (or any other userinfo) through to what gets stored and shown back.
  it("refuses a webhook display that embeds userinfo, so a key cannot slip into the stored value", async () => {
    const store = new MemoryParameterStore();
    const withKey = sampleAnswers({ alert: { kind: "webhook", display: "https://KEY@host/...", secretName: "agentx/staging/alert-endpoint" } });
    await expect(writeInstallAnswers(store, withKey)).rejects.toThrow("install answers are invalid");
    expect(store.values.size).toBe(0);
  });

  // Fix round 1, item 2: a webhook's secretName must be this environment's own alert-endpoint
  // secret, not some other environment's.
  it("refuses a webhook secretName for a different environment than the answers themselves", async () => {
    const store = new MemoryParameterStore();
    const wrongEnv = sampleAnswers({ alert: { kind: "webhook", display: "https://events.pagerduty.com/...", secretName: "agentx/production/alert-endpoint" } });
    await expect(writeInstallAnswers(store, wrongEnv)).rejects.toThrow("must be agentx/staging/alert-endpoint");
    expect(store.values.size).toBe(0);
  });

  it("accepts a webhook secretName that does match the answers' own environment", async () => {
    const store = new MemoryParameterStore();
    const rightEnv = sampleAnswers({ alert: { kind: "webhook", display: "https://events.pagerduty.com/...", secretName: "agentx/staging/alert-endpoint" } });
    await writeInstallAnswers(store, rightEnv);
    expect(await readInstallAnswers(store, "staging")).toEqual(rightEnv);
  });

  // Fix round 1, item 3: the size-limit error's advice depends on what is too big.
  it("the size-limit error for answers suggests shortening the longest answer", async () => {
    const store = new MemoryParameterStore();
    const huge = sampleAnswers({ identity: { mode: "oidc", issuer: "https://id.example.com", audience: "a", clientId: "c", adminClaim: "groups", adminValues: Array.from({ length: 400 }, (_, i) => `group-${i}`) } });
    await expect(writeInstallAnswers(store, huge)).rejects.toThrow(/shorten the longest answer/);
  });

  it("the size-limit error for progress says it is an internal limit and that deleting the parameter restarts init safely", async () => {
    const store = new MemoryParameterStore();
    const huge = {
      ...emptyProgress("staging", T0),
      steps: { "github-app": { status: "waiting" as const, at: "2026-09-27T00:00:00.000Z" } },
      github: {
        account: "acme",
        appId: "123",
        slug: "a".repeat(4200),
        privateKeySecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:x",
      },
    };
    await expect(writeInstallProgress(store, huge)).rejects.toThrow(/internal limit/);
    await expect(writeInstallProgress(store, huge)).rejects.toThrow(/delete the install\/progress parameter/);
    await expect(writeInstallProgress(store, huge)).rejects.toThrow(/restart agentx init safely/);
  });

  describe("spec 048 phase 2: the install record", () => {
    it("keeps your email and the developer sign-in choice, and still reads a record without them", async () => {
      const store = new MemoryParameterStore();
      await writeInstallAnswers(store, sampleAnswers({ adminEmail: "alice@example.com", signinMethods: "both" }));
      expect(await readInstallAnswers(store, "staging")).toMatchObject({ adminEmail: "alice@example.com", signinMethods: "both" });
      await writeInstallAnswers(store, sampleAnswers());
      expect(await readInstallAnswers(store, "staging")).not.toHaveProperty("adminEmail");
    });

    it("refuses an email that is not one, and a sign-in choice it does not know", async () => {
      const store = new MemoryParameterStore();
      await expect(writeInstallAnswers(store, sampleAnswers({ adminEmail: "alice" }))).rejects.toThrow("install answers are invalid: adminEmail");
      await expect(writeInstallAnswers(store, { ...sampleAnswers(), signinMethods: "saml" } as unknown as InitAnswers)).rejects.toThrow("install answers are invalid: signinMethods");
    });

    it("FR-032: records a GitHub app made but not yet stored", async () => {
      const store = new MemoryParameterStore();
      await writeInstallProgress(store, { ...emptyProgress("staging", T0), githubPending: { account: "acme", appId: "424242", slug: "agentx-acme-staging" } });
      expect((await readInstallProgress(store, "staging"))?.githubPending).toEqual({ account: "acme", appId: "424242", slug: "agentx-acme-staging" });
    });
  });
});

describe("15d2 install state", () => {
  it("appends the five finishing steps after developer-signin, moving no earlier id", () => {
    expect(INIT_STEP_IDS).toEqual([
      "prerequisites", "access", "core", "github-app", "control-plane", "slack-app", "slack-service", "developer-signin",
      "admin-user", "first-project", "connectors", "alerts", "e2e",
    ]);
  });

  it("round-trips the admin, project, connector and alert facts", async () => {
    const store = new MemoryParameterStore();
    const progress = {
      ...emptyProgress("staging", T0),
      admin: { username: "alice@example.com", mode: "cognito" as const },
      project: { name: "payments", revision: 2, channelName: "payments", channelId: "C0123456789", teamId: "T0123456789" },
      connectors: [{ type: "linear" as const, ref: "linear" }, { type: "jira" as const, ref: "jira", warning: "the Jira service account can also see issues in HR, FIN" }],
      alerts: { subscribed: true, tested: false },
    };
    await writeInstallProgress(store, progress);
    expect(await readInstallProgress(store, "staging")).toEqual(progress);
  });

  it("refuses a project name or channel id that could not have come from AgentX or Slack", async () => {
    const store = new MemoryParameterStore();
    await expect(writeInstallProgress(store, { ...emptyProgress("staging", T0), project: { name: "Payments!", revision: 1 } })).rejects.toThrow("install progress is invalid: project.name");
    await expect(writeInstallProgress(store, { ...emptyProgress("staging", T0), project: { name: "payments", revision: 1, channelId: "D0123" } })).rejects.toThrow("project.channelId");
  });

  it("still reads progress an older agentx wrote, with none of the new fields", async () => {
    const store = new MemoryParameterStore();
    store.values.set("/agentx/staging/install/progress", JSON.stringify({ schemaVersion: 1, env: "staging", steps: { "developer-signin": { status: "done", at: "2026-09-27T00:00:00.000Z" } }, updatedAt: "2026-09-27T00:00:00.000Z" }));
    expect((await readInstallProgress(store, "staging"))?.steps["developer-signin"]?.status).toBe("done");
  });
});
