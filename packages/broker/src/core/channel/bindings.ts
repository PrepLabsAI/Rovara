// Which project a chat space serves (owner decision 58: the binding keys sit under the company scope). A space is a channel, group or room of an adapter; binding it to a project says that messages in it start work on that
// project. Only the owner binds (`rovara channel bind`); a message from a space that is not bound runs nothing.
import {
  ChannelBindingSchema, ChannelSpaceRefSchema, agentXError, channelBindingAttributes, orgChannelBindingKey, orgChannelBindingPartition, orgScoped, queryAll, readChannelBindingItem,
  type ChannelBinding, type ChannelSpaceRef, type DocumentStore, type OrgId,
} from "@agentx/contracts";

export interface ChannelBindingDeps {
  store: DocumentStore;
  orgId: OrgId;
  now: () => number;
}

/** The binding of one space, or undefined when it is not bound. A stored row that does not read is an error (a corrupt row is not "unbound"). */
export async function readChannelBinding(deps: Pick<ChannelBindingDeps, "store" | "orgId">, ref: ChannelSpaceRef): Promise<ChannelBinding | undefined> {
  const item = await deps.store.get(orgChannelBindingKey(deps.orgId, ref));
  return readChannelBindingItem(ref, item);
}

/** Binds a space to a project (replacing an earlier binding of the same space). */
export async function bindChannelSpace(deps: ChannelBindingDeps, ref: ChannelSpaceRef, projectName: string): Promise<ChannelBinding> {
  const parsed = ChannelSpaceRefSchema.safeParse(ref);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "that is not a valid space for this channel");
  const binding = ChannelBindingSchema.parse({ ...parsed.data, projectName, updatedAt: new Date(deps.now()).toISOString() });
  // The tenants a company has bound a space in are listed from one small partition, so every binding can be listed without knowing a tenant first.
  const result = await deps.store.transact([
    { kind: "put", item: { ...orgChannelBindingKey(deps.orgId, parsed.data), ...channelBindingAttributes(binding) } },
    { kind: "put", item: { pk: orgScoped(deps.orgId, "CHANNEL_TENANTS"), sk: `${parsed.data.channel}/${parsed.data.tenant}`, entityType: "CHANNEL_TENANT", channel: parsed.data.channel, tenant: parsed.data.tenant } },
  ]);
  if (!result.applied) throw agentXError("RUNTIME_UNAVAILABLE", "the binding could not be saved; try again");
  return binding;
}

/** Removes a binding. The answer says whether there was one. */
export async function unbindChannelSpace(deps: Pick<ChannelBindingDeps, "store" | "orgId">, ref: ChannelSpaceRef): Promise<boolean> {
  const parsed = ChannelSpaceRefSchema.parse(ref);
  return (await deps.store.delete({ key: orgChannelBindingKey(deps.orgId, parsed), return: "old" }).then((result) => result.applied && result.item !== undefined));
}

/** Every binding of one tenant on one channel, for a listing. Rows that do not read are left out. */
export async function listChannelBindings(deps: Pick<ChannelBindingDeps, "store" | "orgId">, channel: string, tenant: string): Promise<ChannelBinding[]> {
  const rows = await queryAll(deps.store, { pk: orgChannelBindingPartition(deps.orgId, channel, tenant) });
  return rows.flatMap((row) => {
    const space = typeof row["space"] === "string" ? row["space"] : typeof row["channelId"] === "string" ? row["channelId"] : undefined;
    if (space === undefined) return [];
    try {
      const binding = readChannelBindingItem({ channel, tenant, space }, row);
      return binding === undefined ? [] : [binding];
    } catch {
      return [];
    }
  });
}

/** Every binding of the company, over every tenant a space was bound in. */
export async function listAllChannelBindings(deps: Pick<ChannelBindingDeps, "store" | "orgId">): Promise<ChannelBinding[]> {
  const tenants = await queryAll(deps.store, { pk: orgScoped(deps.orgId, "CHANNEL_TENANTS") });
  const found: ChannelBinding[] = [];
  for (const row of tenants) {
    if (typeof row["channel"] === "string" && typeof row["tenant"] === "string") found.push(...await listChannelBindings(deps, row["channel"], row["tenant"]));
  }
  return found;
}
