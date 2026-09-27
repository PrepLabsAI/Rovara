// Shared fakes for `agentx init` tests. Nothing here reaches AWS, GitHub or Slack.
import type { Prompter } from "../../packages/cli/src/init/prompts.js";

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
