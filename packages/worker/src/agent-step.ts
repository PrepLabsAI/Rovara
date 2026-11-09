// What the worker does with a coding step's settings (Task 18 of the agents plan): the step's tool list (which only ever
// narrows what the workflow mode allows), its skills (the broker's digest-pinned snapshot, never anything found on disk),
// and its time limit. A task without `agentStep` never reaches any of it.
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createSyntheticSourceInfo, type Skill } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { agentXError } from "@agentx/contracts";
import { piTaskToolCapabilities, type PiSessionHandle, type PiWorkflowMode } from "./pi-session.js";

/** One skill of this operation's snapshot, as the broker serves it (`GET /v1/internal/agent-skills`). */
export interface AgentSkillFile {
  name: string;
  description: string;
  /** SHA-256 of `content` as UTF-8, lowercase hex: the digest the agent version was published with. */
  digest: string;
  /** The skill's SKILL.md. */
  content: string;
}

const SKILL_CONTENT_MAX_BYTES = 32_768;
const AgentSkillFileSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u),
  description: z.string().refine((value) => [...value].length <= 1024, "a description is at most 1024 characters"),
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  content: z.string().refine((value) => Buffer.byteLength(value, "utf8") <= SKILL_CONTENT_MAX_BYTES, `a skill is at most ${SKILL_CONTENT_MAX_BYTES} bytes`),
});
const AgentSkillsResponseSchema = z.object({ skills: z.array(AgentSkillFileSchema).max(20) });

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const mismatch = (name: string) => agentXError("RUNTIME_UNAVAILABLE", `the skill ${name} does not match the digest this agent was published with`);

/**
 * The tools a step's session gets: the mode's own (`piTaskToolCapabilities`) narrowed to the step's list. A step can only
 * remove tools: a name the mode does not allow (bash in a review, write in a plan) or that Pi does not have is dropped,
 * and the shell is on only when bash is left.
 */
export function agentStepTools(mode: PiWorkflowMode, allow?: readonly string[]): { tools: string[]; shell: boolean } {
  const base = piTaskToolCapabilities(mode);
  const tools = allow === undefined ? base.tools : base.tools.filter((name) => allow.includes(name));
  return { tools, shell: base.shell && tools.includes("bash") };
}

/** The served skills the step is pinned to; a pinned digest the snapshot does not hold, or two skills of one name, is refused. */
export function pinnedSkills(served: readonly AgentSkillFile[], pinned: readonly { digest: string }[]): AgentSkillFile[] {
  const wanted = new Set(pinned.map(({ digest }) => digest));
  const kept = served.filter((skill) => wanted.has(skill.digest));
  const held = new Set(kept.map(({ digest }) => digest));
  if ([...wanted].some((digest) => !held.has(digest))) {
    throw agentXError("RUNTIME_UNAVAILABLE", "the control plane did not serve every skill this agent was published with");
  }
  if (new Set(kept.map(({ name }) => name)).size !== kept.length) {
    throw agentXError("RUNTIME_UNAVAILABLE", "the control plane served two skills with one name");
  }
  return kept;
}

/**
 * Writes each skill to `<stateDirectory>/skills/<digest>/SKILL.md`, read-only (0o444), after checking its content against
 * its digest, and returns the Pi skills for them. `stateDirectory` is the worker's own Pi directory (workerPiDirectory), which
 * no task container mounts: no sandbox mount is added for the files, and the model reads them through `read_skill`. Pi is told
 * not to list them itself (`disableModelInvocation`): its list would point the model at a file path and the `read` tool.
 */
export async function materializeSkills(stateDirectory: string, skills: readonly AgentSkillFile[]): Promise<Skill[]> {
  for (const skill of skills) if (sha256(skill.content) !== skill.digest) throw mismatch(skill.name);
  const loaded: Skill[] = [];
  for (const skill of skills) {
    const baseDir = join(stateDirectory, "skills", skill.digest);
    const filePath = join(baseDir, "SKILL.md");
    const present = await readFile(filePath, "utf8").catch(() => undefined);
    if (present === undefined || sha256(present) !== skill.digest) {
      await mkdir(baseDir, { recursive: true, mode: 0o700 });
      // Written beside the file and renamed over it, so a reader never sees half a file and a read-only old one is replaced.
      const temporary = join(baseDir, `.SKILL.md.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, skill.content, { mode: 0o444, flag: "wx" });
        await rename(temporary, filePath);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    }
    await chmod(filePath, 0o444);
    loaded.push({
      name: skill.name, description: skill.description, filePath, baseDir,
      sourceInfo: createSyntheticSourceInfo(filePath, { source: "agentx-step", scope: "temporary", origin: "top-level", baseDir }),
      disableModelInvocation: true,
    });
  }
  return loaded;
}

const escapeXml = (text: string): string => text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&apos;");

/** The skills list for the system prompt: names and descriptions only, and the way to load one, `read_skill`. */
export function skillsPromptSection(skills: readonly { name: string; description: string }[]): string {
  return [
    "The following skills hold specialized instructions for this agent.",
    "When the task matches a skill's description, call the read_skill tool with the skill's name to load its instructions. Skills are not files in your workspace.",
    "",
    "<available_skills>",
    ...skills.flatMap((skill) => ["  <skill>", `    <name>${escapeXml(skill.name)}</name>`, `    <description>${escapeXml(skill.description)}</description>`, "  </skill>"]),
    "</available_skills>",
  ].join("\n");
}

/** The operation's skills snapshot, from the control plane through the operation's callback capability. */
export function agentSkillsSource(input: { controlPlaneUrl: string; capability: string; fetch?: typeof fetch }): () => Promise<AgentSkillFile[]> {
  const transport = input.fetch ?? fetch;
  const url = `${input.controlPlaneUrl.replace(/\/$/u, "")}/v1/internal/agent-skills`;
  return async () => {
    const response = await transport(url, { method: "GET", headers: { "x-agentx-callback-capability": input.capability } });
    if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `agent skills request failed with HTTP ${response.status}`);
    const parsed = AgentSkillsResponseSchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw agentXError("RUNTIME_UNAVAILABLE", "the control plane answered the agent skills request with something unexpected");
    return parsed.data.skills;
  };
}

/**
 * Runs `run` within the step's time limit. When it passes, the session is aborted and the step ends with `timeout:<ms>`
 * (the broker reads that as `timed_out`); the abort is not waited for, so one that never answers cannot hold the step.
 * Without a limit it is `run` itself.
 */
export async function withStepTimeout<T>(
  handle: Pick<PiSessionHandle, "abort">,
  timeoutMs: number | undefined,
  run: () => Promise<T>,
  /** The limit the message names, when `timeoutMs` is what is left of a larger one. */
  limitMs: number | undefined = timeoutMs,
): Promise<T> {
  if (timeoutMs === undefined) return run();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      try { void Promise.resolve(handle.abort()).catch(() => undefined); } catch { /* the timeout below is the outcome */ }
      reject(new Error(`timeout:${limitMs}`));
    }, timeoutMs);
  });
  const running = run();
  // If the timeout wins, the run's own later failure must not surface as an unhandled rejection.
  running.catch(() => undefined);
  try {
    return await Promise.race([running, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
