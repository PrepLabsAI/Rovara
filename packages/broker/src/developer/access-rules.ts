// Spec 063 FR-004, extended (owner decision 132): the access check (POST /v1/dev/access) answers what Rovara's own rules give a registered service's
// signed-in person. A host may layer STRICTER rules on top (a fresh sign-in, a sign-in method, an approval it keeps), never looser ones: a rule can refuse
// the whole answer, take administrator away, or keep only some of the projects, and nothing it returns can add a project, raise an access level or make
// someone an administrator. Rules run in order, each on what the one before left; a rule that throws refuses (a broken stricter rule must not open).
import type { AccessCheckResponse } from "@agentx/contracts";

/** What a rule is told about the call. `session` is set only when the person's own token asked (`via: "token"`). */
export interface AccessCheckContext {
  clientId: string;
  via: "token" | "client_secret";
  developerId: string;
  session?: { sessionId: string; amr: string; startedAt: string; administrator: boolean };
  now: number;
}

/**
 * A host's rule. `refuse`: the call is answered with the access check's one refusal. Otherwise `administrator: false` takes it away and `projects` keeps
 * only the named ones (a name not in the answer is ignored). Undefined: no change.
 */
export type AccessCheckVerdict = { refuse: true } | { administrator?: false; projects?: readonly string[] } | undefined;
export type AccessCheckRule = (context: AccessCheckContext, answer: Readonly<AccessCheckResponse>) => AccessCheckVerdict | Promise<AccessCheckVerdict>;

/** The answer after every rule, or undefined when one refused (or failed). */
export async function applyAccessRules(rules: readonly AccessCheckRule[] | undefined, context: AccessCheckContext, answer: AccessCheckResponse): Promise<AccessCheckResponse | undefined> {
  let current: AccessCheckResponse = { ...answer, projects: answer.projects.map((project) => ({ ...project })), notices: [...answer.notices] };
  for (const rule of rules ?? []) {
    let verdict: AccessCheckVerdict;
    try {
      verdict = await rule(context, current);
    } catch {
      return undefined;
    }
    if (verdict === undefined) continue;
    if ("refuse" in verdict) {
      if (verdict.refuse === true) return undefined;
      continue;
    }
    const keep = verdict.projects === undefined ? undefined : new Set(verdict.projects);
    current = {
      ...current,
      // Only ever false: a rule cannot make anybody an administrator.
      administrator: verdict.administrator === false ? false : current.administrator,
      projects: keep === undefined ? current.projects : current.projects.filter((project) => keep.has(project.name)),
    };
  }
  return current;
}
