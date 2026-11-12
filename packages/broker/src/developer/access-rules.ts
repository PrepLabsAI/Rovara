// Spec 063 FR-004, extended (owner decision 132): the access check (POST /v1/dev/access) answers what Rovara's own rules give a registered service's
// signed-in person. A host may layer STRICTER rules on top (a fresh sign-in, a sign-in method, an approval it keeps), never looser ones: a rule can refuse
// the whole answer, take administrator away, or keep only some of the projects, and nothing it returns or changes can add a project, raise an access level or
// make someone an administrator. Each rule sees a frozen copy of the answer so far; the final answer is built only from Rovara's own answer, filtered by the
// verdicts. Rules run in order; a rule that throws, or answers with anything but undefined or an object, refuses (a broken stricter rule must not open).
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
 * A host's rule. `refuse: true`: the call is answered with the access check's one refusal. `administrator: false` takes it away and `projects` keeps only the
 * named ones (a name not in the answer is ignored); both apply whatever else the verdict says. Undefined: no change.
 */
export type AccessCheckVerdict = { refuse?: boolean; administrator?: false; projects?: readonly string[] } | undefined;
export type AccessCheckRule = (context: Readonly<AccessCheckContext>, answer: Readonly<AccessCheckResponse>) => AccessCheckVerdict | Promise<AccessCheckVerdict>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/** The answer after every rule, or undefined when one refused (or failed). Never wider than `answer`. */
export async function applyAccessRules(rules: readonly AccessCheckRule[] | undefined, context: AccessCheckContext, answer: AccessCheckResponse): Promise<AccessCheckResponse | undefined> {
  const original = deepFreeze(structuredClone(answer));
  let administrator = original.administrator;
  let kept = new Set(original.projects.map((project) => project.name));
  const current = (): AccessCheckResponse => ({
    developerId: original.developerId, displayName: original.displayName, administrator,
    projects: original.projects.filter((project) => kept.has(project.name)).map((project) => ({ name: project.name, access: project.access })),
    notices: [...original.notices],
  });
  for (const rule of rules ?? []) {
    try {
      const verdict: unknown = await rule(deepFreeze(structuredClone(context)), deepFreeze(current()));
      if (verdict === undefined) continue;
      if (verdict === null || typeof verdict !== "object" || Array.isArray(verdict)) return undefined;
      const { refuse, administrator: admin, projects } = verdict as { refuse?: unknown; administrator?: unknown; projects?: unknown };
      if (refuse === true) return undefined;
      if (admin === false) administrator = false;
      if (projects !== undefined) {
        if (!Array.isArray(projects)) return undefined;
        const names = new Set(projects.filter((name): name is string => typeof name === "string"));
        kept = new Set([...kept].filter((name) => names.has(name)));
      }
    } catch {
      return undefined;
    }
  }
  return current();
}
