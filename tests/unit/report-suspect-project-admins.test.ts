import { readFileSync } from "node:fs";
import { BatchWriteCommand, DeleteCommand, GetCommand, PutCommand, QueryCommand, ScanCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import {
  collectReport,
  formatReportTable,
  parseReportArgs,
  readOnlyClient,
  type ReportClient,
} from "../../scripts/report-suspect-project-admins.js";

type Row = Record<string, unknown>;

const TABLE = "state-table";
const SECRET = "SUPER-SECRET-VALUE-do-not-print";

/** An in-memory DynamoDB table: Scan (filter applied after the page limit, as DynamoDB does), Get and Query; any write is recorded and refused. */
function fakeTable(rows: Row[], pageSize = 1000) {
  const sorted = [...rows].sort((a, b) => `${String(a.pk)}\0${String(a.sk)}`.localeCompare(`${String(b.pk)}\0${String(b.sk)}`));
  const commands: string[] = [];
  const scans: Array<Record<string, unknown>> = [];
  const resolve = (token: string, names: Record<string, string> | undefined) => (names?.[token] ?? token);
  const matches = (item: Row, filter: string | undefined, names: Record<string, string> | undefined, values: Record<string, unknown> | undefined) => {
    if (filter === undefined) return true;
    return filter.split(" AND ").every((clause) => {
      const inList = /^(\S+) IN \((.*)\)$/.exec(clause.trim());
      if (inList) return inList[2]!.split(",").some((token) => item[resolve(inList[1]!, names)] === values?.[token.trim()]);
      const [left, right] = clause.split(" = ").map((part) => part.trim());
      return item[resolve(left!, names)] === values?.[right!];
    });
  };
  const project = (item: Row, projection: string | undefined, names: Record<string, string> | undefined) => {
    if (projection === undefined) return { ...item };
    const out: Row = {};
    for (const token of projection.split(",").map((part) => part.trim())) {
      const field = resolve(token, names);
      if (field in item) out[field] = item[field];
    }
    return out;
  };
  const send = async (command: unknown): Promise<unknown> => {
    const name = (command as { constructor: { name: string } }).constructor.name;
    commands.push(name);
    const input = (command as { input: Record<string, unknown> }).input;
    if (input.TableName !== TABLE) throw new Error(`unexpected table ${String(input.TableName)}`);
    if (command instanceof ScanCommand) {
      scans.push(input);
      const start = input.ExclusiveStartKey as { pk: string; sk: string } | undefined;
      let from = 0;
      if (start !== undefined) from = sorted.findIndex((item) => item.pk === start.pk && item.sk === start.sk) + 1;
      const page = sorted.slice(from, from + pageSize);
      const names = input.ExpressionAttributeNames as Record<string, string> | undefined;
      const values = input.ExpressionAttributeValues as Record<string, unknown> | undefined;
      const items = page.filter((item) => matches(item, input.FilterExpression as string | undefined, names, values))
        .map((item) => project(item, input.ProjectionExpression as string | undefined, names));
      const last = page[page.length - 1];
      return { Items: items, ...(from + pageSize < sorted.length && last !== undefined ? { LastEvaluatedKey: { pk: last.pk, sk: last.sk } } : {}) };
    }
    if (command instanceof GetCommand) {
      const key = input.Key as { pk: string; sk: string };
      return { Item: sorted.find((item) => item.pk === key.pk && item.sk === key.sk) };
    }
    throw new Error(`write or unsupported command reached the table: ${name}`);
  };
  return { client: { send } as ReportClient, commands, scans };
}

const rev = (n: number) => `REV#${String(n).padStart(12, "0")}`;
const projectRow = (name: string, revision: number, registeredBy: string, registeredAt: string): Row => ({
  pk: `PROJECT#${name}`, sk: rev(revision), entityType: "PROJECT", registeredBy, registeredAt,
  definition: { name, revision, apiKey: SECRET }, runtimeBinding: { token: SECRET },
});
const adminRow = (owner: string, name: string, extra: Row = {}): Row => ({
  pk: `MEMBER#${owner}`, sk: `PROJECT#${name}`, entityType: "MEMBERSHIP", ownerKey: owner, projectName: name, role: "administrator", grantId: "g", ...extra,
});
const developerRow = (owner: string, name: string): Row => ({
  pk: `MEMBER#${owner}`, sk: `PROJECT#${name}`, entityType: "MEMBERSHIP", ownerKey: owner, projectName: name, role: "developer", grantId: "g",
  grantedBy: { issuer: "i", subject: "s" }, grantedAt: "2026-01-02T00:00:00.000Z",
});
const takeoverRow = (name: string, takenBy: string, at: string, revision = 2): Row => ({
  pk: `PROJECT_TAKEOVER#${name}`, sk: `AT#${at}#u`, entityType: "PROJECT_OWNERSHIP_TAKEOVER", projectName: name, revision, takenBy, subject: "sub", reason: SECRET, at,
});
const catalogRow = (name: string): Row => ({ pk: `PROJECT_CATALOG#${name}`, sk: "CATALOG", entityType: "PROJECT_CATALOG", name, latestRevision: 1 });

describe("report-suspect-project-admins", () => {
  describe("the report", () => {
    it("does not flag the first registrant of a project, who is its administrator", async () => {
      const { client } = fakeTable([projectRow("billing", 1, "alice", "2026-01-01T00:00:00.000Z"), adminRow("alice", "billing")]);
      const report = await collectReport(client, TABLE);
      expect(report.suspectAdministrators).toEqual([]);
      expect(report.projectsWithoutAdministrator).toEqual([]);
      expect(report.counts).toMatchObject({ projects: 1, revisions: 1, administrators: 1 });
    });

    it("lists an administrator who registered a later revision but not the lowest one, with everything the owner needs to judge it", async () => {
      const { client } = fakeTable([
        projectRow("billing", 1, "alice", "2026-01-01T00:00:00.000Z"),
        projectRow("billing", 2, "mallory", "2026-02-01T00:00:00.000Z"),
        projectRow("billing", 3, "mallory", "2026-03-01T00:00:00.000Z"),
        adminRow("alice", "billing"),
        adminRow("mallory", "billing"),
      ]);
      const report = await collectReport(client, TABLE);
      expect(report.suspectAdministrators).toEqual([{
        project: "billing",
        subject: "mallory",
        grantedAt: null,
        grantedBy: null,
        revisionsRegistered: [{ revision: 2, registeredAt: "2026-02-01T00:00:00.000Z" }, { revision: 3, registeredAt: "2026-03-01T00:00:00.000Z" }],
        originalRegistrant: "alice",
      }]);
    });

    it("reports grantedAt and grantedBy when the membership row has them, and an administrator who registered nothing", async () => {
      const { client } = fakeTable([
        projectRow("billing", 1, "alice", "2026-01-01T00:00:00.000Z"),
        adminRow("alice", "billing"),
        adminRow("bob", "billing", { grantedAt: "2026-04-01T00:00:00.000Z", grantedBy: { issuer: "https://issuer.example", subject: "admin-1" } }),
      ]);
      const [suspect] = (await collectReport(client, TABLE)).suspectAdministrators;
      expect(suspect).toMatchObject({
        subject: "bob", grantedAt: "2026-04-01T00:00:00.000Z", grantedBy: { issuer: "https://issuer.example", subject: "admin-1" }, revisionsRegistered: [], originalRegistrant: "alice",
      });
    });

    it("does not list an administrator whose membership a takeover audit row explains, and still lists one it does not", async () => {
      const { client } = fakeTable([
        projectRow("billing", 1, "alice", "2026-01-01T00:00:00.000Z"),
        projectRow("billing", 2, "carol", "2026-02-01T00:00:00.000Z"),
        adminRow("alice", "billing"),
        adminRow("carol", "billing"),
        takeoverRow("billing", "carol", "2026-02-01T00:00:00.000Z"),
        // Another project: the takeover row for billing explains nothing there.
        projectRow("search", 1, "alice", "2026-01-01T00:00:00.000Z"),
        projectRow("search", 2, "carol", "2026-02-01T00:00:00.000Z"),
        adminRow("alice", "search"),
        adminRow("carol", "search"),
      ]);
      const report = await collectReport(client, TABLE);
      expect(report.suspectAdministrators.map((suspect) => [suspect.project, suspect.subject])).toEqual([["search", "carol"]]);
      expect(report.explainedByTakeover).toEqual([{ project: "billing", subject: "carol", takenOverAt: "2026-02-01T00:00:00.000Z" }]);
    });

    it("lists a project that has no administrator at all, with its original registrant", async () => {
      const { client } = fakeTable([
        projectRow("orphaned", 1, "dave", "2026-01-01T00:00:00.000Z"),
        projectRow("orphaned", 2, "dave", "2026-01-02T00:00:00.000Z"),
        developerRow("erin", "orphaned"),
        projectRow("billing", 1, "alice", "2026-01-01T00:00:00.000Z"),
        adminRow("alice", "billing"),
      ]);
      const report = await collectReport(client, TABLE);
      expect(report.projectsWithoutAdministrator).toEqual([{ project: "orphaned", originalRegistrant: "dave", latestRevision: 2 }]);
      expect(report.suspectAdministrators).toEqual([]);
    });

    it("ignores developer memberships and catalog rows, and reports an administrator of a project with no revisions apart", async () => {
      const { client } = fakeTable([
        projectRow("billing", 1, "alice", "2026-01-01T00:00:00.000Z"),
        adminRow("alice", "billing"),
        developerRow("erin", "billing"),
        catalogRow("billing"),
        adminRow("zed", "ghost"),
      ]);
      const report = await collectReport(client, TABLE);
      expect(report.suspectAdministrators).toEqual([]);
      expect(report.administratorsOfUnknownProjects).toEqual([{ project: "ghost", subject: "zed" }]);
    });

    it("follows LastEvaluatedKey on every scan, so rows on later pages are found even when a page matches nothing", async () => {
      const rows: Row[] = [];
      for (let index = 0; index < 12; index += 1) {
        const name = `p${String(index).padStart(2, "0")}`;
        rows.push(projectRow(name, 1, `first-${name}`, "2026-01-01T00:00:00.000Z"), adminRow(`first-${name}`, name));
      }
      // The loophole grant and the project without an administrator sort last, behind many pages that match neither filter.
      rows.push(projectRow("p11", 2, "mallory", "2026-02-01T00:00:00.000Z"), adminRow("mallory", "p11"));
      rows.push(projectRow("zz-no-admin", 1, "nobody", "2026-01-01T00:00:00.000Z"));
      rows.push(projectRow("p05", 2, "carol", "2026-02-01T00:00:00.000Z"), adminRow("carol", "p05"), takeoverRow("p05", "carol", "2026-02-01T00:00:00.000Z"));
      const { client, scans } = fakeTable(rows, 3);
      const report = await collectReport(client, TABLE);
      expect(report.suspectAdministrators.map((suspect) => [suspect.project, suspect.subject])).toEqual([["p11", "mallory"]]);
      expect(report.projectsWithoutAdministrator.map((entry) => entry.project)).toEqual(["zz-no-admin"]);
      expect(report.explainedByTakeover.map((entry) => entry.subject)).toEqual(["carol"]);
      expect(report.counts).toMatchObject({ projects: 13, revisions: 15, administrators: 14, takeovers: 1 });
      // 30 rows in pages of 3: ten requests, every one after the first carrying the previous page's key.
      expect(scans.length).toBe(10);
      expect(scans.filter((scan) => scan.ExclusiveStartKey !== undefined).length).toBe(scans.length - 1);
      expect(scans.every((scan) => scan.ConsistentRead === true)).toBe(true);
    });

    it("stops with an error rather than loop when a scan returns the key it was given", async () => {
      const client: ReportClient = { send: async () => ({ Items: [], LastEvaluatedKey: { pk: "a", sk: "b" } }) };
      await expect(collectReport(client, TABLE)).rejects.toThrow(/did not advance/);
    });

    it("prints no field beyond the identifiers: not a definition, a binding or a takeover reason", async () => {
      const { client, scans } = fakeTable([
        projectRow("billing", 1, "alice", "2026-01-01T00:00:00.000Z"),
        projectRow("billing", 2, "mallory", "2026-02-01T00:00:00.000Z"),
        adminRow("alice", "billing"),
        adminRow("mallory", "billing", { secret: SECRET }),
        takeoverRow("billing", "somebody", "2026-02-01T00:00:00.000Z"),
        projectRow("orphaned", 1, "dave", "2026-01-01T00:00:00.000Z"),
      ]);
      const report = await collectReport(client, TABLE);
      expect(JSON.stringify(report)).not.toContain(SECRET);
      expect(formatReportTable(report, { env: "e", region: "r" })).not.toContain(SECRET);
      // Nothing secret is even requested: every scan names the attributes it wants.
      for (const scan of scans) expect(scan.ProjectionExpression).toEqual(expect.any(String));
      for (const scan of scans) expect(String(scan.ProjectionExpression)).not.toMatch(/definition|runtimeBinding|reason|setupApproval/);
    });
  });

  describe("table output", () => {
    it("shows the project, subject, grant, revisions and original registrant, and the projects without an administrator", async () => {
      const { client } = fakeTable([
        projectRow("billing", 1, "alice", "2026-01-01T00:00:00.000Z"),
        projectRow("billing", 2, "mallory", "2026-02-01T00:00:00.000Z"),
        adminRow("alice", "billing"),
        adminRow("mallory", "billing"),
        projectRow("orphaned", 1, "dave", "2026-01-01T00:00:00.000Z"),
      ]);
      const text = formatReportTable(await collectReport(client, TABLE), { env: "agentxlivetest123", region: "us-east-1" });
      expect(text).toContain("agentxlivetest123");
      expect(text).toMatch(/billing\s+mallory\s+-\s+-\s+2@2026-02-01T00:00:00\.000Z\s+alice/);
      expect(text).toMatch(/orphaned\s+dave/);
      expect(text).toContain("Suspect administrators: 1");
      expect(text).toContain("Projects without an administrator: 1");
    });

    it("says so plainly when nothing is suspect", async () => {
      const { client } = fakeTable([projectRow("billing", 1, "alice", "2026-01-01T00:00:00.000Z"), adminRow("alice", "billing")]);
      const text = formatReportTable(await collectReport(client, TABLE), { env: "e", region: "r" });
      expect(text).toContain("Suspect administrators: 0");
      expect(text).toContain("Projects without an administrator: 0");
    });
  });

  describe("read-only", () => {
    it("only ever sends Scan to the client when it runs", async () => {
      const { client, commands } = fakeTable([
        projectRow("billing", 1, "alice", "2026-01-01T00:00:00.000Z"), adminRow("alice", "billing"), takeoverRow("billing", "alice", "2026-01-01T00:00:00.000Z", 1),
      ], 1);
      await collectReport(readOnlyClient(client), TABLE);
      expect(commands.length).toBeGreaterThan(0);
      expect(new Set(commands)).toEqual(new Set(["ScanCommand"]));
    });

    const writes = {
      Put: new PutCommand({ TableName: TABLE, Item: { pk: "a", sk: "b" } }),
      Update: new UpdateCommand({ TableName: TABLE, Key: { pk: "a", sk: "b" }, UpdateExpression: "SET x = :x", ExpressionAttributeValues: { ":x": 1 } }),
      Delete: new DeleteCommand({ TableName: TABLE, Key: { pk: "a", sk: "b" } }),
      BatchWrite: new BatchWriteCommand({ RequestItems: { [TABLE]: [{ PutRequest: { Item: { pk: "a", sk: "b" } } }] } }),
      TransactWrite: new TransactWriteCommand({ TransactItems: [{ Put: { TableName: TABLE, Item: { pk: "a", sk: "b" } } }] }),
    };
    it.each(Object.entries(writes))("the script's client refuses a %s command before it reaches DynamoDB", async (_name, command) => {
      const { client, commands } = fakeTable([]);
      await expect(readOnlyClient(client).send(command as never)).rejects.toThrow(/read-only/);
      expect(commands).toEqual([]);
    });

    it("lets Scan, Query and GetItem through", async () => {
      const { client, commands } = fakeTable([projectRow("billing", 1, "alice", "2026-01-01T00:00:00.000Z")]);
      const guarded = readOnlyClient(client);
      await guarded.send(new ScanCommand({ TableName: TABLE }));
      await guarded.send(new GetCommand({ TableName: TABLE, Key: { pk: "PROJECT#billing", sk: rev(1) } }));
      await expect(guarded.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": "x" } }))).rejects.toThrow(/unsupported/);
      expect(commands).toEqual(["ScanCommand", "GetCommand", "QueryCommand"]);
    });

    it("the script's source names no write command", () => {
      const source = readFileSync(new URL("../../scripts/report-suspect-project-admins.ts", import.meta.url), "utf8");
      expect(source).not.toMatch(/\b(PutCommand|UpdateCommand|DeleteCommand|BatchWriteCommand|TransactWriteCommand|PutItemCommand|UpdateItemCommand|DeleteItemCommand|BatchWriteItemCommand|TransactWriteItemsCommand|ExecuteStatementCommand|ExecuteTransactionCommand|BatchExecuteStatementCommand)\b/);
    });
  });

  describe("arguments", () => {
    it("requires --env and --profile, with no default for either", () => {
      expect(() => parseReportArgs([])).toThrow(/--env is required/);
      expect(() => parseReportArgs(["--profile", "p"])).toThrow(/--env is required/);
      expect(() => parseReportArgs(["--env", "e"])).toThrow(/--profile is required/);
      expect(() => parseReportArgs(["--env", "--profile", "p"])).toThrow(/--env requires a value/);
    });

    it("takes --json and an optional --region, and refuses anything else", () => {
      expect(parseReportArgs(["--env", "e", "--profile", "p"])).toEqual({ env: "e", profile: "p", region: "us-east-1", json: false });
      expect(parseReportArgs(["--env", "e", "--profile", "p", "--region", "eu-west-1", "--json"])).toEqual({ env: "e", profile: "p", region: "eu-west-1", json: true });
      expect(() => parseReportArgs(["--env", "e", "--profile", "p", "--apply"])).toThrow(/unknown option/);
      expect(() => parseReportArgs(["--env", "e", "--env", "f", "--profile", "p"])).toThrow(/given twice/);
    });
  });
});
