// Rovara Code (owner decision 2026-10-27): where the repository has code owners that cover the paths a change request changes, a code owner has to approve it before Rovara calls it ready. The host reads and
// understands its own owners (`CodeHost.codeOwners()` answers a neutral `CodeOwnersRead`; port lane P2, item C4); this decides from that answer who is still missing. Pure except for the team lookup the
// caller passes in. It never trusts what it cannot read: an unreadable team is "unknown", and a path whose only owners are unknown teams is not satisfied.
import type { CodeOwner, CodeOwnersRead } from "@agentx/contracts";

export type CodeOwnerVerdict = { ok: true } | { ok: false; owners: string } | { ok: false; unreadable: true };

export interface CodeOwnerInput {
  /** The code owners of the base branch as the host reads them; undefined when it has none. */
  codeOwners: CodeOwnersRead | undefined;
  /** Every path the change request changes (a renamed file under both names). */
  paths: readonly string[];
  /** The host logins of the counted approvers. */
  approverLogins: readonly string[];
  teamMember(team: string, login: string): Promise<"member" | "not_member" | "unknown">;
}

const NAMED = 3;

/** How an owner is written in a refusal: a person as `@login`, a team as `@team`, anything else as the host wrote it. */
const writtenOwner = (owner: CodeOwner): string => (owner.kind === "person" ? `@${owner.login}` : owner.kind === "team" ? `@${owner.team}` : owner.label);
const ownerKey = (owner: CodeOwner): string => (owner.kind === "person" ? `p:${owner.login.toLowerCase()}` : owner.kind === "team" ? `t:${owner.team.toLowerCase()}` : `o:${owner.label.toLowerCase()}`);

/** Whether every changed path that has a code owner has an approval from one of its owners. */
export async function codeOwnerVerdict(input: CodeOwnerInput): Promise<CodeOwnerVerdict> {
  if (input.codeOwners === undefined) return { ok: true };
  if (input.codeOwners.unsupported) return { ok: false, unreadable: true };
  const owned = input.codeOwners;
  const approvers = [...new Set(input.approverLogins.map((login) => login.toLowerCase()))];
  const asked = new Map<string, Promise<"member" | "not_member" | "unknown">>();
  const inTeam = (team: string, login: string) => {
    const key = `${team.toLowerCase()}|${login}`;
    let found = asked.get(key);
    if (found === undefined) {
      found = input.teamMember(team, login).catch(() => "unknown" as const);
      asked.set(key, found);
    }
    return found;
  };
  // Paths with the same owners are asked about once.
  const ownerSets = new Map<string, readonly CodeOwner[]>();
  for (const path of input.paths) {
    const owners = owned.ownersOf(path.replaceAll("\\", "/").replace(/^\/+/u, ""));
    if (owners.length > 0) ownerSets.set(owners.map(ownerKey).sort().join(" "), owners);
  }
  const missing: string[] = [];
  let unreadable = false;
  for (const owners of ownerSets.values()) {
    let satisfied = owners.some((owner) => owner.kind === "person" && approvers.includes(owner.login.toLowerCase()));
    let unknown = false;
    if (!satisfied) {
      // An owner the core cannot match to an approver (an email) leaves the path open, not unowned.
      if (owners.some((owner) => owner.kind === "other")) unknown = true;
      for (const owner of owners) {
        if (owner.kind !== "team") continue;
        for (const login of approvers) {
          const answer = await inTeam(owner.team, login);
          if (answer === "member") { satisfied = true; break; }
          if (answer === "unknown") unknown = true;
        }
        if (satisfied) break;
      }
    }
    if (satisfied) continue;
    // A team that could not be read leaves it open whether an owner approved: that is "unreadable", unless a plain gap is also there to say.
    if (unknown) unreadable = true;
    else for (const owner of owners) { const written = writtenOwner(owner); if (!missing.includes(written)) missing.push(written); }
  }
  if (missing.length > 0) return { ok: false, owners: `${missing.slice(0, NAMED).join(", ")}${missing.length > NAMED ? ` and ${missing.length - NAMED} more` : ""}` };
  if (unreadable) return { ok: false, unreadable: true };
  return { ok: true };
}
