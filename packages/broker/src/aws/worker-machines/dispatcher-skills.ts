// SKILLS-TO-WORKERS: the hosted dispatcher's read of a project's live Rovara skills for a plan or build step. The selector is the laptop path's own (`lessons/skills.ts` `liveSkillsForStep`); this file only
// gives it a get-only view of the store that is limited to ONE company's partitions and to a share of reads, bytes and time of its own.
import { ROVARA_SKILL_TEXT_MAX_BYTES, companyScoped, type DocumentStore, type OrgId, type RovaraSkillFile } from "@agentx/contracts";
import { liveSkillsForStep } from "../../lessons/skills.js";

/**
 * The skills' own share, beside the lessons' reads (`DISPATCHER_LESSONS_LIMITS`): `liveSkillsForStep` reads the `set` row, then at most 64 members, 2 reads each (head and live version), and up to the skill text limit per
 * read. A read past this share (reads, bytes or its short clock), or a read that fails, makes the answer "no skills": a step never waits on a skill, and a skill read can never fail the lessons.
 */
export const DISPATCHER_SKILLS_LIMITS = { reads: 129, bytes: 64 * ROVARA_SKILL_TEXT_MAX_BYTES + 262_144, ms: 700 } as const;
class SkillsSpent extends Error {}

/**
 * The project's live skills for ONE step. `company` and `project` come from the workspace record and the task the dispatcher already checked, never from a request. Only this company's partitions are read, with `get`
 * only, and nothing is read once the call is over (`alive` false) or the share is spent. Never throws: a fault is no skills.
 */
export async function readHostedLiveSkills(input: { store: Pick<DocumentStore, "get">; company: OrgId; project: string; alive: () => boolean }): Promise<RovaraSkillFile[]> {
  const limits = DISPATCHER_SKILLS_LIMITS;
  const stopAt = Date.now() + limits.ms;
  const prefix = companyScoped(input.company, "");
  let askedReads = 0, askedBytes = 0, over = false;
  const view: Pick<DocumentStore, "get"> = {
    async get(key) {
      if (over || !input.alive() || !key.pk.startsWith(prefix) || Date.now() >= stopAt || ++askedReads > limits.reads) { over = true; throw new SkillsSpent(); }
      const answer = await input.store.get(key);
      askedBytes += Buffer.byteLength(JSON.stringify(answer) ?? "", "utf8");
      if (over || !input.alive() || askedBytes > limits.bytes || Date.now() >= stopAt) { over = true; throw new SkillsSpent(); }
      return answer;
    },
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const live = liveSkillsForStep(view, { workspaceId: input.company, project: input.project }).then((answer) => answer.skills, () => undefined);
    const skills = await Promise.race([live, new Promise<undefined>((resolve) => { timer = setTimeout(() => { over = true; resolve(undefined); }, limits.ms); timer.unref?.(); })]);
    return skills ?? [];
  } catch { return []; } finally { over = true; if (timer !== undefined) clearTimeout(timer); }
}
