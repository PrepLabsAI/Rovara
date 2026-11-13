import { createHash } from "node:crypto";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { agentXError } from "@rovara-code/contracts";
import type { AgentSkillFile } from "./agent-step.js";

/** The sentence the model gets for a name that is not one of this operation's skills. */
const noSkillCalled = (name: string): string => `No skill called ${name.slice(0, 100)} in this agent.`;

/**
 * `read_skill`: how a model reads one of its operation's skills. The skills are files the worker wrote into its own
 * private state (agent-step.ts), which no task container mounts and the sandbox's file tools cannot reach, so the tool
 * runs in the worker process and serves the content it holds for this operation only. The name is looked up in this
 * operation's snapshot and is never a path, so it cannot name another operation's file or anything else on the worker.
 * Content is checked against its digest each time it is served.
 */
export function readSkillTool(skills: readonly AgentSkillFile[]): ToolDefinition {
  const byName = new Map(skills.map((skill) => [skill.name, skill] as const));
  return defineTool({
    name: "read_skill",
    label: "Read skill",
    description: "Load the full instructions of one of this agent's skills by its name, from the list of available skills.",
    parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 256, description: "The skill's name, as listed." }) }),
    execute: async (_toolCallId, parameters) => {
      const skill = byName.get(parameters.name);
      if (skill === undefined) return { content: [{ type: "text" as const, text: noSkillCalled(parameters.name) }], details: undefined };
      if (createHash("sha256").update(skill.content, "utf8").digest("hex") !== skill.digest) {
        throw agentXError("RUNTIME_UNAVAILABLE", `the skill ${skill.name} does not match the digest this agent was published with`);
      }
      return { content: [{ type: "text" as const, text: skill.content }], details: undefined };
    },
  });
}
