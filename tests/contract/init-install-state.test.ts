import { describe, expect, it } from "vitest";
import { emptyProgress, installAnswersParameterName, installProgressParameterName, readInstallAnswers, readInstallProgress, SLACK_BOT_HANDLE_PATTERN, writeInstallAnswers, writeInstallProgress } from "../../packages/cli/src/init/install-state.js";
import { sampleAnswers } from "../support/init-fakes.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

const T0 = Date.parse("2026-09-27T00:00:00.000Z");

describe("install state", () => {

  it("holds the bot handle to one pattern, the one the Slack app step checks before it stores it", async () => {
    expect(SLACK_BOT_HANDLE_PATTERN.test("agentx-acme-staging")).toBe(true);
    expect(SLACK_BOT_HANDLE_PATTERN.test("AgentX Bot")).toBe(false);
    const store = new MemoryParameterStore();
    const progress = { ...emptyProgress("staging", T0), slack: { appId: "A0APP00001", teamId: "T0123456789", botUserId: "U0BOT00001", botName: "AgentX Bot" } };
    await expect(writeInstallProgress(store, progress)).rejects.toThrow();
  });

  it("refuses a value larger than a standard SSM parameter, naming the size", async () => {
    const store = new MemoryParameterStore();
    const huge = sampleAnswers({ identity: { mode: "oidc", issuer: "https://id.example.com", audience: "a", clientId: "c", adminClaim: "groups", adminValues: Array.from({ length: 400 }, (_, i) => `group-${i}`) } });
    await expect(writeInstallAnswers(store, huge)).rejects.toThrow(/install answers for environment staging are \d+ bytes, more than SSM's 4096-byte limit/);
    expect(store.values.size).toBe(0);
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

  // Fix round 1, item 2: a webhook's secretName must be this environment's own alert-endpoint
  // secret, not some other environment's.
  it("refuses a webhook secretName for a different environment than the answers themselves", async () => {
    const store = new MemoryParameterStore();
    const wrongEnv = sampleAnswers({ alert: { kind: "webhook", display: "https://events.pagerduty.com/...", secretName: "agentx/production/alert-endpoint" } });
    await expect(writeInstallAnswers(store, wrongEnv)).rejects.toThrow("must be agentx/staging/alert-endpoint");
    expect(store.values.size).toBe(0);
  });

});

