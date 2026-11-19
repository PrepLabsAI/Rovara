// Members, not raw ids. A developer who was merged into another reads as that other, so two ids that name one member are one person wherever lessons count people (the author rules,
// the approvers a tier needs). Pure helpers over a resolver; the resolver itself is the directory's `resolveMember` (the sign-in table's `mergedInto`).
import { distinctIds, normId } from "./types.js";

/** Resolves an id to the member it stands for. */
export type MemberOf = (id: string) => string;
export type MemberResolver = (workspaceId: string, developerId: string) => Promise<string>;

/**
 * The member each of these ids stands for, as one function. Without a resolver the ids are compared as they are (normalised). `undefined` when the resolver could not answer: the caller refuses
 * (fail closed), never falls back to raw ids.
 */
export async function memberView(resolve: MemberResolver | undefined, workspaceId: string, ids: readonly string[]): Promise<MemberOf | undefined> {
  if (resolve === undefined) return normId;
  try {
    const found = new Map<string, string>();
    for (const id of distinctIds(ids)) found.set(normId(id), normId(await resolve(workspaceId, id)));
    return (id) => found.get(normId(id)) ?? normId(id);
  } catch { return undefined; }
}
