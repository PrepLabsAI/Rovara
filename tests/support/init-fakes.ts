// Shared fakes for `agentx init` tests. Nothing here reaches AWS, GitHub or Slack.
import type { Prompter } from "../../packages/cli/src/init/prompts.js";
import type { InitAnswers } from "../../packages/cli/src/init/install-state.js";

/** A complete, valid set of `agentx init` answers, for tests that round-trip or size-check them
 * rather than exercising the prompts that collect them. */
export function sampleAnswers(overrides: Partial<InitAnswers> = {}): InitAnswers {
  return {
    schemaVersion: 1,
    env: "staging",
    region: "us-east-1",
    account: "123456789012",
    engine: "templates",
    releaseVersion: "1.2.3",
    identity: { mode: "cognito" },
    models: { orchestrator: "us.anthropic.claude-sonnet-4-6", classifier: "amazon.nova-lite-v1:0", worker: "amazon.nova-pro-v1:0" },
    alert: { kind: "email", address: "ops@example.com" },
    github: { account: "acme", accountType: "organization", appName: "AgentX acme staging" },
    slack: { appName: "AgentX", appPostedMessages: "accept" },
    createdAt: "2026-09-27T00:00:00.000Z",
    ...overrides,
  };
}

export type ScriptedAnswer = string | boolean;

/** Answers questions in order. "" takes the question's default. Records every question asked. */
export function scriptedPrompter(script: ScriptedAnswer[]): Prompter & { asked: string[]; remaining: () => number } {
  const queue = [...script];
  const asked: string[] = [];
  const next = (question: string): ScriptedAnswer => {
    asked.push(question);
    const answer = queue.shift();
    if (answer === undefined) throw new Error(`test setup: no scripted answer for "${question}"`);
    return answer;
  };
  return {
    asked,
    remaining: () => queue.length,
    async ask(question, options) {
      const answer = next(question);
      if (typeof answer !== "string") throw new Error(`test setup: "${question}" wants text`);
      const value = answer === "" && options.defaultValue !== undefined ? options.defaultValue : answer;
      const problem = options.validate?.(value);
      if (problem !== undefined) throw new Error(`test setup: "${question}" refused ${JSON.stringify(value)}: ${problem}`);
      return value;
    },
    async choose<T extends string>(question: string, choices: ReadonlyArray<{ value: T; label: string }>, options: { flag: string; defaultValue: T }): Promise<T> {
      const answer = next(question);
      if (answer === "") return options.defaultValue;
      const match = choices.find((choice) => choice.value === answer);
      if (match === undefined) throw new Error(`test setup: "${question}" has no choice ${String(answer)}`);
      return match.value;
    },
    async confirm(question) {
      const answer = next(question);
      if (typeof answer !== "boolean") throw new Error(`test setup: "${question}" wants true or false`);
      return answer;
    },
    async secret(question) {
      const answer = next(question);
      if (typeof answer !== "string") throw new Error(`test setup: "${question}" wants text`);
      return answer;
    },
  };
}
