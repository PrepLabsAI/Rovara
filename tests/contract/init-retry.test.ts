// tests/contract/init-retry.test.ts
// Q7: a check that fails on the page asks to be run again; without a page it fails exactly as it
// always has, asking nothing.
import { describe, expect, it } from "vitest";
import { agentXError } from "@agentx/contracts";
import { problemText, retryOnPage } from "../../packages/cli/src/init/retry.js";
import { scriptedPrompter } from "../support/init-fakes.js";
import type { WizardCard } from "../../packages/cli/src/init/ui/protocol.js";

const surface = () => { const cards: WizardCard[] = []; return { cards, card: (card: WizardCard) => { cards.push(card); } }; };

describe("retryOnPage", () => {
  it("without a page, rethrows the first failure and asks nothing", async () => {
    const prompter = scriptedPrompter([]);
    const failure = agentXError("CONFIG_INVALID", "the quota is 0");
    let runs = 0;
    const problems: string[] = [];
    await expect(retryOnPage({ surface: undefined, prompter, question: "Check again?", failed: (problem) => { problems.push(problem); }, run: async () => { runs += 1; throw failure; } }))
      .rejects.toBe(failure);
    expect(runs).toBe(1);
    expect(prompter.asked).toEqual([]);
    expect(problems).toEqual([]);
  });

  it("on the page, shows the problem without its code, asks, and runs again on yes", async () => {
    const prompter = scriptedPrompter([true]);
    const problems: string[] = [];
    let runs = 0;
    const result = await retryOnPage({
      surface: surface(), prompter, question: "Check the prerequisites again?", failed: (problem) => { problems.push(problem); },
      run: async () => { runs += 1; if (runs === 1) throw agentXError("CONFIG_INVALID", "the quota is 0; request an increase"); return "passed"; },
    });
    expect(result).toBe("passed");
    expect(problems).toEqual(["the quota is 0; request an increase"]);
    expect(prompter.asked).toEqual(["Check the prerequisites again?"]);
  });

  it("on the page, rethrows the original failure when the operator says no", async () => {
    const failure = agentXError("CONFIG_INVALID", "the quota is 0");
    await expect(retryOnPage({ surface: surface(), prompter: scriptedPrompter([false]), question: "Check again?", failed: () => undefined, run: async () => { throw failure; } }))
      .rejects.toBe(failure);
  });

  it("names an expired AWS session the way the rest of the CLI does", () => {
    const expired = Object.assign(new Error("The security token included in the request is expired"), { name: "ExpiredTokenException" });
    expect(problemText(expired)).toBe("AWS credentials missing or expired: The security token included in the request is expired");
    expect(problemText("plain")).toBe("plain");
  });

  it("strips only an AgentXError's own code, never a Node error's (ENOENT: ...)", () => {
    expect(problemText(agentXError("RUNTIME_UNAVAILABLE", "https://x/slack/events answered HTTP 500"))).toBe("https://x/slack/events answered HTTP 500");
    expect(problemText(new Error("ENOENT: no such file or directory, open '/tmp/key.pem'"))).toBe("ENOENT: no such file or directory, open '/tmp/key.pem'");
    expect(problemText(new Error("EACCES: permission denied"))).toBe("EACCES: permission denied");
  });
});
