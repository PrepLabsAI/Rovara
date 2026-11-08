// Spec 062 FR-030, FR-031: one-time, expiring link codes bound to the actor that asked; links under actor and developer.
import { describe, expect, it } from "vitest";
import { linkCodeHash } from "@agentx/contracts";
import { issueLinkCode, linkedDeveloper, listDeveloperLinks, previewLinkCode, redeemLinkCode, removeLink } from "../../packages/broker/src/aws/channel-links.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const actor = { channel: "whatsapp", tenant: "+14155550100", userId: "+919876544821" };

function setup() {
  const db = new FakeDynamoDb();
  let now = Date.parse("2026-11-08T10:00:00.000Z");
  const deps = { documentClient: db, stateTableName: "state", now: () => now };
  return { db, deps, advance: (ms: number) => { now += ms; } };
}

describe("link codes", () => {
  it("store only the code's hash, and preview the channel and masked user ID", async () => {
    const { db, deps } = setup();
    const { code, expiresAt } = await issueLinkCode(deps, actor);
    expect(expiresAt).toBe(Date.parse("2026-11-08T10:10:00.000Z") / 1000);
    expect(JSON.stringify([...db.items.values()])).not.toContain(code);
    expect(db.get(`CHANNEL_LINK_CODE#${linkCodeHash(code)}`, "META")).toMatchObject({ actor, expiresAt });
    expect(await previewLinkCode(deps, code)).toEqual({ channel: "whatsapp", maskedUserId: "+91 ••• 4821" });
  });

  it("link the code's actor to the signed-in developer, once", async () => {
    const { deps } = setup();
    const { code } = await issueLinkCode(deps, actor);
    const link = await redeemLinkCode(deps, "dev-1", code);
    expect(link).toEqual({ actor, developerId: "dev-1", linkedAt: "2026-11-08T10:00:00.000Z" });
    expect(await linkedDeveloper(deps, actor)).toBe("dev-1");
    expect(await listDeveloperLinks(deps, "dev-1")).toEqual([link]);
    await expect(redeemLinkCode(deps, "dev-2", code)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await previewLinkCode(deps, code)).toBeUndefined();
  });

  it("expire after 10 minutes, even before the table removes them", async () => {
    const { deps, advance } = setup();
    const { code } = await issueLinkCode(deps, actor);
    advance(600_000);
    expect(await previewLinkCode(deps, code)).toBeUndefined();
    await expect(redeemLinkCode(deps, "dev-1", code)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await linkedDeveloper(deps, actor)).toBeUndefined();
  });

  it("do not relink an actor already linked to someone", async () => {
    const { deps } = setup();
    await redeemLinkCode(deps, "dev-1", (await issueLinkCode(deps, actor)).code);
    const second = (await issueLinkCode(deps, actor)).code;
    await expect(redeemLinkCode(deps, "dev-2", second)).rejects.toMatchObject({ code: "CHANGE_STALE" });
    expect(await linkedDeveloper(deps, actor)).toBe("dev-1");
  });

  it("refuse malformed codes and Slack actors", async () => {
    const { deps } = setup();
    expect(await previewLinkCode(deps, "short")).toBeUndefined();
    await expect(issueLinkCode(deps, { channel: "slack", tenant: "T0123ABCD", userId: "U0123456789" })).rejects.toThrow();
  });
});

describe("removing links", () => {
  it("lets a developer remove their own link and an administrator remove anyone's", async () => {
    const { deps } = setup();
    await redeemLinkCode(deps, "dev-1", (await issueLinkCode(deps, actor)).code);
    await expect(removeLink(deps, actor, "dev-2")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await removeLink(deps, actor, "dev-1")).toMatchObject({ removed: true });
    expect(await linkedDeveloper(deps, actor)).toBeUndefined();
    expect(await listDeveloperLinks(deps, "dev-1")).toEqual([]);

    await redeemLinkCode(deps, "dev-1", (await issueLinkCode(deps, actor)).code);
    expect(await removeLink(deps, actor, undefined)).toMatchObject({ removed: true });
    expect(await linkedDeveloper(deps, actor)).toBeUndefined();
  });
});
