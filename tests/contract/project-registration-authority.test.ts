import { describe, expect, it } from "vitest";
import { createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { call } from "../support/slack-broker.js";

// Task AUTH1 (finding N2b of the Task 3.1 reviews): registering a revision of an existing project does not make the registrant its administrator.
// A first registration does; a revision needs the project's own administrator membership; an instance administrator takes a project over only by asking
// for it, with a reason, and the takeover is recorded.

const FIRST = { subject: "admin-subject", admin: true };
const OTHER = { subject: "another-projects-admin", admin: true };
const DEVELOPER = { subject: "plain-developer", admin: false };

const binding = { deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3" };
const definitionOf = (name: string, revision: number) => ({
  name, revision, repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
  setup: [], readiness: [], orchestratorInstructions: `Delegate work (revision ${revision}).`,
});

async function brokerWithPayments() {
  // The harness registers payments revision 1 as FIRST, which makes FIRST its administrator.
  const harness = await createDeveloperTaskBroker();
  const register = (user: { subject: string; admin: boolean }, revision: number, extra: Record<string, unknown> = {}, name = "payments") =>
    call(harness.handler, { method: "POST", path: "/v1/admin/projects", user, body: { definition: definitionOf(name, revision), runtimeBinding: binding, ...extra } });
  const revisions = (name = "payments") => harness.db.find((row) => row.entityType === "PROJECT" && (row.definition as { name?: string }).name === name)
    .map((row) => (row.definition as { revision: number }).revision).sort((a, b) => a - b);
  const memberships = (name = "payments") => harness.db.find((row) => row.entityType === "MEMBERSHIP" && row.projectName === name && row.role === "administrator");
  const takeovers = (name = "payments") => harness.db.find((row) => row.entityType === "PROJECT_OWNERSHIP_TAKEOVER" && row.projectName === name);
  return { harness, register, revisions, memberships, takeovers };
}

describe("registering a project", () => {
  it("makes the registrant of a first registration the project's administrator, as before", async () => {
    const broker = await brokerWithPayments();
    const created = await broker.register(OTHER, 1, {}, "billing");
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(broker.memberships("billing").map((row) => row.ownerKey)).toHaveLength(1);
    expect(broker.takeovers("billing")).toEqual([]);
  });

  it("refuses a revision from an instance administrator who does not administer the project, and stores nothing", async () => {
    const broker = await brokerWithPayments();
    const before = structuredClone(broker.harness.db.find(() => true));
    const refused = await broker.register(OTHER, 2);
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(JSON.stringify(refused.body)).toContain("administrator of project payments");
    expect(JSON.stringify(refused.body)).toContain("takeOwnership");
    expect(broker.harness.db.find(() => true)).toEqual(before);
    expect(broker.revisions()).toEqual([1]);
  });

  it("does not let a reason alone take a project over: the flag is the request", async () => {
    const broker = await brokerWithPayments();
    const refused = await broker.register(OTHER, 2, { takeOwnershipReason: "I would like to" });
    expect(refused.status).toBe(403);
    expect(broker.revisions()).toEqual([1]);
    expect(broker.takeovers()).toEqual([]);
  });

  it("registers a revision for the project's own administrator and leaves the membership exactly as it was", async () => {
    const broker = await brokerWithPayments();
    const [membership] = broker.memberships();
    expect(broker.memberships()).toHaveLength(1);
    const created = await broker.register(FIRST, 2);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(broker.revisions()).toEqual([1, 2]);
    expect(broker.memberships()).toEqual([membership]);
    expect(broker.takeovers()).toEqual([]);
    expect(created.body.ownershipTakenOver).toBeUndefined();
  });

  it("registers the same revision again for anyone as the stored one, changing nothing (idempotent, as before)", async () => {
    const broker = await brokerWithPayments();
    const again = await broker.register(OTHER, 1, {}, "payments");
    expect(again.status).toBeLessThan(300);
    expect(broker.memberships()).toHaveLength(1);
    expect(broker.takeovers()).toEqual([]);
  });

  describe("an explicit takeover", () => {
    it("with a reason registers the revision, makes the caller an administrator, and records who, which project, when, and why", async () => {
      const broker = await brokerWithPayments();
      const ownerKey = broker.memberships()[0]!.ownerKey;
      const before = Date.now();
      const taken = await broker.register(OTHER, 2, { takeOwnership: true, takeOwnershipReason: "  the previous owner left the company  " });
      expect(taken.status, JSON.stringify(taken.body)).toBe(201);
      expect(taken.body.ownershipTakenOver).toBe(true);
      expect(broker.revisions()).toEqual([1, 2]);
      expect(broker.memberships()).toHaveLength(2);
      const [record, ...rest] = broker.takeovers();
      expect(rest).toEqual([]);
      const taker = broker.memberships().find((row) => row.ownerKey !== ownerKey)!.ownerKey;
      expect(record).toMatchObject({ projectName: "payments", revision: 2, reason: "the previous owner left the company", takenBy: taker, subject: OTHER.subject });
      expect(Date.parse(String(record!.at))).toBeGreaterThanOrEqual(before - 1000);
      // The taker now administers the project: their next revision needs no flag.
      const next = await broker.register(OTHER, 3);
      expect(next.status, JSON.stringify(next.body)).toBe(201);
      expect(broker.takeovers()).toHaveLength(1);
    });

    it("without a reason is refused, and stores nothing", async () => {
      const broker = await brokerWithPayments();
      const before = structuredClone(broker.harness.db.find(() => true));
      for (const extra of [{ takeOwnership: true }, { takeOwnership: true, takeOwnershipReason: "" }, { takeOwnership: true, takeOwnershipReason: "   " }]) {
        const refused = await broker.register(OTHER, 2, extra);
        expect(refused.status, JSON.stringify(refused.body)).toBe(400);
        expect(JSON.stringify(refused.body)).toContain("takeOwnershipReason");
      }
      expect(broker.harness.db.find(() => true)).toEqual(before);
    });

    it("refuses a takeOwnership that is not exactly true", async () => {
      const broker = await brokerWithPayments();
      for (const takeOwnership of ["yes", 1, "true"]) {
        const refused = await broker.register(OTHER, 2, { takeOwnership, takeOwnershipReason: "because" });
        expect(refused.status, JSON.stringify(refused.body)).toBe(400);
      }
      expect(broker.revisions()).toEqual([1]);
      expect(broker.takeovers()).toEqual([]);
    });

    it("is not available to a caller without the instance administrator claim", async () => {
      const broker = await brokerWithPayments();
      const refused = await broker.register(DEVELOPER, 2, { takeOwnership: true, takeOwnershipReason: "because" });
      expect(refused.status).toBe(403);
      expect(broker.revisions()).toEqual([1]);
      expect(broker.takeovers()).toEqual([]);
    });

    it("records nothing when the caller already administers the project, or the project is new", async () => {
      const broker = await brokerWithPayments();
      const own = await broker.register(FIRST, 2, { takeOwnership: true, takeOwnershipReason: "not needed" });
      expect(own.status, JSON.stringify(own.body)).toBe(201);
      expect(own.body.ownershipTakenOver).toBeUndefined();
      const fresh = await broker.register(OTHER, 1, { takeOwnership: true, takeOwnershipReason: "not needed either" }, "billing");
      expect(fresh.status, JSON.stringify(fresh.body)).toBe(201);
      expect(fresh.body.ownershipTakenOver).toBeUndefined();
      expect(broker.takeovers()).toEqual([]);
      expect(broker.takeovers("billing")).toEqual([]);
    });

    it("is recorded only when its transaction commits: a revision that a rival stored first leaves no takeover behind", async () => {
      const broker = await brokerWithPayments();
      const send = broker.harness.db.send.bind(broker.harness.db);
      let fired = false;
      broker.harness.db.send = async (command) => {
        const items = command.constructor.name === "TransactWriteCommand" ? (command as unknown as { input: { TransactItems: Array<{ Put?: { Item?: Record<string, unknown> } }> } }).input.TransactItems : [];
        if (!fired && items.some((item) => item.Put?.Item?.entityType === "PROJECT_OWNERSHIP_TAKEOVER")) {
          fired = true;
          expect((await broker.register(FIRST, 2)).status).toBe(201);
        }
        return send(command);
      };
      const taken = await broker.register(OTHER, 2, { takeOwnership: true, takeOwnershipReason: "racing the owner" });
      // The same revision was stored by the owner meanwhile: the taker is told it is a duplicate, and takes nothing.
      expect(taken.status).toBe(201);
      expect(taken.body.duplicate).toBe(true);
      expect(taken.body.ownershipTakenOver).toBeUndefined();
      expect(broker.revisions()).toEqual([1, 2]);
      expect(broker.takeovers()).toEqual([]);
      expect(broker.memberships()).toHaveLength(1);
    });
  });

  describe("races", () => {
    it("of two administrators racing a first registration of a new project, the loser is not made an administrator", async () => {
      const broker = await brokerWithPayments();
      const firstKey = broker.memberships()[0]!.ownerKey;
      let committed: Awaited<ReturnType<typeof broker.register>> | undefined;
      let fired = false;
      const send = broker.harness.db.send.bind(broker.harness.db);
      broker.harness.db.send = async (command) => {
        const items = command.constructor.name === "TransactWriteCommand" ? (command as unknown as { input: { TransactItems: Array<{ Put?: { Item?: Record<string, unknown> } }> } }).input.TransactItems : [];
        if (!fired && items.some((item) => item.Put?.Item?.entityType === "PROJECT" && (item.Put.Item.definition as { name?: string; revision?: number } | undefined)?.name === "billing"
          && (item.Put.Item.definition as { revision?: number }).revision === 2)) {
          fired = true;
          committed = await broker.register(FIRST, 1, {}, "billing");
        }
        return send(command);
      };
      // Both see no project yet; FIRST commits while OTHER is between its check and its commit.
      const loser = await broker.register(OTHER, 2, {}, "billing");
      expect(committed?.status, JSON.stringify(committed?.body)).toBe(201);
      expect(loser.status, JSON.stringify(loser.body)).toBe(403);
      expect(JSON.stringify(loser.body)).toContain("administrator of project billing");
      expect(broker.revisions("billing")).toEqual([1]);
      expect(broker.memberships("billing")).toHaveLength(1);
      expect(broker.memberships("billing")[0]!.ownerKey).toBe(firstKey);
    });

    it("of two administrators racing the same first revision, only one of them administers the project", async () => {
      const broker = await brokerWithPayments();
      const [first, second] = await Promise.all([broker.register(FIRST, 1, {}, "billing"), broker.register(OTHER, 1, {}, "billing")]);
      // Whichever commits second finds the winner's identical revision and is told it is a duplicate; it is not made an administrator.
      expect([first, second].filter((response) => response.body.duplicate === false)).toHaveLength(1);
      expect(broker.revisions("billing")).toEqual([1]);
      expect(broker.memberships("billing")).toHaveLength(1);
    });

    it("refuses an administrator whose membership is revoked between the check and the commit", async () => {
      const broker = await brokerWithPayments();
      const [membership] = broker.memberships();
      let fired = false;
      const send = broker.harness.db.send.bind(broker.harness.db);
      broker.harness.db.send = async (command) => {
        const items = command.constructor.name === "TransactWriteCommand" ? (command as unknown as { input: { TransactItems: Array<{ Put?: { Item?: Record<string, unknown> } }> } }).input.TransactItems : [];
        if (!fired && items.some((item) => item.Put?.Item?.entityType === "PROJECT" && (item.Put.Item.definition as { revision?: number } | undefined)?.revision === 2)) {
          fired = true;
          broker.harness.db.set({ ...membership!, role: "developer" });
        }
        return send(command);
      };
      const refused = await broker.register(FIRST, 2);
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      expect(broker.revisions()).toEqual([1]);
    });
  });
});
