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

  describe("an explicit takeover", () => {

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

    it("is one transaction: the revision, the membership grant and the audit row commit together, and a failed commit leaves none of them", async () => {
      const broker = await brokerWithPayments();
      type Item = { Put?: { Item?: Record<string, unknown> } };
      const transactions: Item[][] = [];
      const writes: string[] = [];
      let failNext = true;
      const send = broker.harness.db.send.bind(broker.harness.db);
      broker.harness.db.send = async (command) => {
        const name = command.constructor.name;
        if (name === "TransactWriteCommand") {
          const items = (command as unknown as { input: { TransactItems: Item[] } }).input.TransactItems;
          if (items.some((item) => item.Put?.Item?.entityType === "PROJECT_OWNERSHIP_TAKEOVER")) {
            transactions.push(items);
            if (failNext) { failNext = false; throw Object.assign(new Error("the table is unavailable"), { name: "InternalServerError" }); }
          }
        } else if (name === "PutCommand" || name === "UpdateCommand") writes.push(name);
        return send(command);
      };
      const before = structuredClone(broker.harness.db.find(() => true));
      const failed = await broker.register(OTHER, 2, { takeOwnership: true, takeOwnershipReason: "the owner left" });
      expect(failed.status).toBeGreaterThanOrEqual(500);
      expect(broker.harness.db.find(() => true)).toEqual(before);
      const taken = await broker.register(OTHER, 2, { takeOwnership: true, takeOwnershipReason: "the owner left" });
      expect(taken.status, JSON.stringify(taken.body)).toBe(201);
      // The one transaction that committed holds all three, and nothing else wrote an audit row or a membership outside it.
      const committed = transactions.at(-1)!.map((item) => item.Put?.Item?.entityType);
      expect(committed).toEqual(expect.arrayContaining(["PROJECT", "MEMBERSHIP", "PROJECT_OWNERSHIP_TAKEOVER"]));
      expect(writes).toEqual([]);
      expect(broker.memberships()).toHaveLength(2);
      expect(broker.takeovers()).toHaveLength(1);
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

    it("a first-registration race loser who asked for a takeover is made administrator only with an audit row", async () => {
      const broker = await brokerWithPayments();
      let fired = false;
      const send = broker.harness.db.send.bind(broker.harness.db);
      broker.harness.db.send = async (command) => {
        const items = command.constructor.name === "TransactWriteCommand" ? (command as unknown as { input: { TransactItems: Array<{ Put?: { Item?: Record<string, unknown> } }> } }).input.TransactItems : [];
        if (!fired && items.some((item) => item.Put?.Item?.entityType === "PROJECT" && (item.Put.Item.definition as { name?: string; revision?: number } | undefined)?.name === "billing"
          && (item.Put.Item.definition as { revision?: number }).revision === 2)) {
          fired = true;
          expect((await broker.register(FIRST, 1, {}, "billing")).status).toBe(201);
        }
        return send(command);
      };
      // OTHER judged this a first registration; FIRST commits revision 1 before OTHER's commit, so the retry must judge it a takeover.
      const loser = await broker.register(OTHER, 2, { takeOwnership: true, takeOwnershipReason: "raced" }, "billing");
      expect(loser.status, JSON.stringify(loser.body)).toBe(201);
      expect(broker.memberships("billing")).toHaveLength(2);
      expect(broker.takeovers("billing")).toHaveLength(1);
      expect(loser.body.ownershipTakenOver).toBe(true);
    });

    it("refuses an administrator whose membership stops saying administrator between the check and the commit", async () => {
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
