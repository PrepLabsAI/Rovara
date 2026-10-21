import { readFileSync } from "node:fs";
import { BatchWriteCommand, DeleteCommand, GetCommand, PutCommand, QueryCommand, ScanCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import {
  collectReport,
  formatReportTable,
  main,
  parseReportArgs,
  readOnlyClient,
  type MainDependencies,
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
      const size = Math.min(pageSize, typeof input.Limit === "number" ? input.Limit : pageSize);
      const page = sorted.slice(from, from + size);
      const names = input.ExpressionAttributeNames as Record<string, string> | undefined;
      const values = input.ExpressionAttributeValues as Record<string, unknown> | undefined;
      const items = page.filter((item) => matches(item, input.FilterExpression as string | undefined, names, values))
        .map((item) => project(item, input.ProjectionExpression as string | undefined, names));
      const last = page[page.length - 1];
      return { Items: items, ...(from + size < sorted.length && last !== undefined ? { LastEvaluatedKey: { pk: last.pk, sk: last.sk } } : {}) };
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
      expect(formatReportTable(report, { label: "env e", region: "r" })).not.toContain(SECRET);
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
      const text = formatReportTable(await collectReport(client, TABLE), { label: "env agentxlivetest123", region: "us-east-1" });
      expect(text).toContain("agentxlivetest123");
      expect(text).toMatch(/billing\s+mallory\s+-\s+-\s+2@2026-02-01T00:00:00\.000Z\s+alice/);
      expect(text).toMatch(/orphaned\s+dave/);
      expect(text).toContain("Suspect administrators: 1");
      expect(text).toContain("Projects without an administrator: 1");
    });

    it("says so plainly when nothing is suspect", async () => {
      const { client } = fakeTable([projectRow("billing", 1, "alice", "2026-01-01T00:00:00.000Z"), adminRow("alice", "billing")]);
      const text = formatReportTable(await collectReport(client, TABLE), { label: "env e", region: "r" });
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

    it("allows Scan alone: Query and GetItem are refused too, since the script never uses them", async () => {
      const { client, commands } = fakeTable([projectRow("billing", 1, "alice", "2026-01-01T00:00:00.000Z")]);
      const guarded = readOnlyClient(client);
      await guarded.send(new ScanCommand({ TableName: TABLE }));
      await expect(guarded.send(new GetCommand({ TableName: TABLE, Key: { pk: "PROJECT#billing", sk: rev(1) } }) as never)).rejects.toThrow(/read-only/);
      await expect(guarded.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": "x" } }) as never)).rejects.toThrow(/read-only/);
      expect(commands).toEqual(["ScanCommand"]);
    });

    it("the script's source names no write command", () => {
      const source = readFileSync(new URL("../../scripts/report-suspect-project-admins.ts", import.meta.url), "utf8");
      expect(source).not.toMatch(/\b(PutCommand|UpdateCommand|DeleteCommand|BatchWriteCommand|TransactWriteCommand|PutItemCommand|UpdateItemCommand|DeleteItemCommand|BatchWriteItemCommand|TransactWriteItemsCommand|ExecuteStatementCommand|ExecuteTransactionCommand|BatchExecuteStatementCommand)\b/);
    });

    it("the only CloudFormation command is DescribeStacksCommand, and the script constructs no command but that and Scan", () => {
      const source = readFileSync(new URL("../../scripts/report-suspect-project-admins.ts", import.meta.url), "utf8");
      const imported = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@aws-sdk\/client-cloudformation"/g)].flatMap((match) => match[1]!.split(",").map((name) => name.trim()).filter(Boolean));
      expect(imported).toEqual(["CloudFormationClient", "DescribeStacksCommand"]);
      const sent = new Set([...source.matchAll(/new\s+(\w+Command)\b/g)].map((match) => match[1]));
      expect([...sent].sort()).toEqual(["DescribeStacksCommand", "ScanCommand"]);
    });
  });

  describe("arguments", () => {
    it("requires --profile and exactly one of --env, --stack or --table, with no default for any", () => {
      expect(() => parseReportArgs([])).toThrow(/exactly one of --env, --stack or --table/);
      expect(() => parseReportArgs(["--profile", "p"])).toThrow(/exactly one of --env, --stack or --table/);
      expect(() => parseReportArgs(["--env", "e"])).toThrow(/--profile is required/);
      expect(() => parseReportArgs(["--env", "--profile", "p"])).toThrow(/--env requires a value/);
      expect(() => parseReportArgs(["--env", "e", "--stack", "AgentXControlPlane", "--profile", "p"])).toThrow(/exactly one of/);
      expect(() => parseReportArgs(["--env", "e", "--table", "t-table", "--profile", "p"])).toThrow(/exactly one of/);
      expect(() => parseReportArgs(["--stack", "S", "--table", "t-table", "--profile", "p"])).toThrow(/exactly one of/);
    });

    it("takes --stack (production's legacy control-plane stack) or --table in place of --env", () => {
      expect(parseReportArgs(["--stack", "AgentXControlPlane", "--profile", "p"])).toEqual({ target: { kind: "stack", name: "AgentXControlPlane" }, profile: "p", region: "us-east-1", json: false, pauseMs: 200 });
      expect(parseReportArgs(["--table", "state-table", "--profile", "p"])).toMatchObject({ target: { kind: "table", name: "state-table" } });
      expect(() => parseReportArgs(["--stack", "bad name;", "--profile", "p"])).toThrow(/--stack/);
      expect(() => parseReportArgs(["--table", "a/b", "--profile", "p"])).toThrow(/--table/);
    });

    it("takes --json, --region and --pause-ms, and refuses anything else", () => {
      expect(parseReportArgs(["--env", "e", "--profile", "p"])).toEqual({ target: { kind: "env", name: "e" }, profile: "p", region: "us-east-1", json: false, pauseMs: 200 });
      expect(parseReportArgs(["--env", "e", "--profile", "p", "--region", "eu-west-1", "--json", "--pause-ms", "0"])).toEqual({ target: { kind: "env", name: "e" }, profile: "p", region: "eu-west-1", json: true, pauseMs: 0 });
      expect(() => parseReportArgs(["--env", "e", "--profile", "p", "--pause-ms", "-1"])).toThrow(/--pause-ms/);
      expect(() => parseReportArgs(["--env", "e", "--profile", "p", "--pause-ms", "abc"])).toThrow(/--pause-ms/);
      expect(() => parseReportArgs(["--env", "e", "--profile", "p", "--apply"])).toThrow(/unknown option/);
      expect(() => parseReportArgs(["--env", "e", "--env", "f", "--profile", "p"])).toThrow(/given twice/);
    });
  });

  describe("ordering anomalies", () => {
    it("flags a project whose lowest revision is not its earliest registration, and still judges by the lowest revision", async () => {
      const { client } = fakeTable([
        // Revision 5 was registered first; revision 2 was stored later by someone else.
        projectRow("billing", 5, "alice", "2026-01-01T00:00:00.000Z"),
        projectRow("billing", 2, "mallory", "2026-03-01T00:00:00.000Z"),
        adminRow("alice", "billing"),
        adminRow("mallory", "billing"),
        projectRow("clean", 1, "alice", "2026-01-01T00:00:00.000Z"),
        projectRow("clean", 2, "bob", "2026-01-02T00:00:00.000Z"),
        adminRow("alice", "clean"),
      ]);
      const report = await collectReport(client, TABLE);
      expect(report.orderingAnomalies).toEqual([{
        project: "billing", lowestRevision: 2, lowestRevisionRegisteredAt: "2026-03-01T00:00:00.000Z", lowestRevisionRegistrant: "mallory",
        earliestRevision: 5, earliestRegisteredAt: "2026-01-01T00:00:00.000Z", earliestRegistrant: "alice",
      }]);
      expect(report.suspectAdministrators.map((entry) => entry.subject)).toEqual(["alice"]);
      expect(formatReportTable(report, { label: "env e", region: "r" })).toContain("Ordering anomalies: 1");
    });
  });

  describe("malformed rows", () => {
    it("counts rows it must skip by kind and prints the counts", async () => {
      const { client } = fakeTable([
        projectRow("billing", 1, "alice", "2026-01-01T00:00:00.000Z"),
        adminRow("alice", "billing"),
        { pk: "PROJECT#billing", sk: "REV#oops", entityType: "PROJECT", registeredBy: "x", registeredAt: "t" },
        { pk: "PROJECT#billing", sk: rev(9), entityType: "PROJECT", registeredAt: "t" },
        { pk: "MEMBER#zed", entityType: "MEMBERSHIP", role: "administrator", ownerKey: "zed" },
        { pk: "PROJECT_TAKEOVER#billing", sk: "AT#1", entityType: "PROJECT_OWNERSHIP_TAKEOVER" },
      ]);
      const report = await collectReport(client, TABLE);
      expect(report.skippedRows).toEqual({ revisions: 2, memberships: 1, takeovers: 1 });
      expect(report.suspectAdministrators).toEqual([]);
      expect(formatReportTable(report, { label: "env e", region: "r" })).toMatch(/Skipped malformed rows: 4 \(revisions 2, memberships 1, takeovers 1\)/);
    });

    it("falls back to the owner key in pk for a membership without ownerKey, and to the project in pk for a takeover without projectName", async () => {
      const { client } = fakeTable([
        projectRow("billing", 1, "alice", "2026-01-01T00:00:00.000Z"),
        projectRow("billing", 2, "carol", "2026-02-01T00:00:00.000Z"),
        adminRow("alice", "billing"),
        { pk: "MEMBER#carol", sk: "PROJECT#billing", entityType: "MEMBERSHIP", role: "administrator" },
        { pk: "PROJECT_TAKEOVER#billing", sk: "AT#1", entityType: "PROJECT_OWNERSHIP_TAKEOVER", takenBy: "carol", at: "2026-02-01T00:00:00.000Z" },
        projectRow("search", 1, "alice", "2026-01-01T00:00:00.000Z"),
        projectRow("search", 2, "mallory", "2026-02-01T00:00:00.000Z"),
        adminRow("alice", "search"),
        { pk: "MEMBER#mallory", sk: "PROJECT#search", entityType: "MEMBERSHIP", role: "administrator" },
      ]);
      const report = await collectReport(client, TABLE);
      expect(report.skippedRows).toEqual({ revisions: 0, memberships: 0, takeovers: 0 });
      expect(report.explainedByTakeover.map((entry) => [entry.project, entry.subject])).toEqual([["billing", "carol"]]);
      expect(report.suspectAdministrators.map((entry) => [entry.project, entry.subject])).toEqual([["search", "mallory"]]);
    });
  });

  describe("caveat", () => {
    it("says in the table and in the JSON that the unknown-project and no-administrator lists need a re-run to confirm", async () => {
      const { client } = fakeTable([projectRow("billing", 1, "alice", "2026-01-01T00:00:00.000Z")]);
      const report = await collectReport(client, TABLE);
      expect(formatReportTable(report, { label: "env e", region: "r" })).toMatch(/a scan is not a snapshot.*re-run/is);
      expect(report.notes.join(" ")).toMatch(/not a snapshot/);
    });
  });

  describe("rate limiting", () => {
    it("asks for 400 items a page, pauses between pages but not after the last, and reports progress", async () => {
      const rows: Row[] = [];
      for (let index = 0; index < 5; index += 1) rows.push(projectRow(`p${index}`, 1, "a", "2026-01-01T00:00:00.000Z"));
      const { client, scans } = fakeTable(rows, 2);
      const sleeps: number[] = [];
      const progress: Array<[number, number]> = [];
      await collectReport(client, TABLE, { pauseMs: 200, sleep: async (ms) => { sleeps.push(ms); }, progress: (pages, items) => progress.push([pages, items]) });
      expect(scans.length).toBe(3);
      expect(scans.every((scan) => scan.Limit === 400)).toBe(true);
      expect(sleeps).toEqual([200, 200]);
      expect(progress).toEqual([[1, 2], [2, 4], [3, 5]]);
    });

    /** failures[i] throttles precede the success of request i; the last request ends the scan. */
    function throttling(failures: number[]) {
      let request = 0;
      let attempt = 0;
      let calls = 0;
      const client: ReportClient = {
        send: async () => {
          calls += 1;
          if (attempt < (failures[request] ?? 0)) {
            attempt += 1;
            throw Object.assign(new Error("Throughput exceeds the current capacity"), { name: "ProvisionedThroughputExceededException" });
          }
          attempt = 0;
          request += 1;
          return request < failures.length ? { Items: [], LastEvaluatedKey: { pk: String(request), sk: "x" } } : { Items: [] };
        },
      };
      return { client, calls: () => calls };
    }

    it("waits and retries a throttled page; the run of consecutive throttles resets after a page succeeds", async () => {
      const { client } = throttling([4, 4, 4]);
      const sleeps: number[] = [];
      await expect(collectReport(client, TABLE, { pauseMs: 50, sleep: async (ms) => { sleeps.push(ms); } })).resolves.toBeDefined();
      expect(sleeps.filter((ms) => ms > 50).length).toBeGreaterThan(0);
    });

    it("aborts with a clear message after 5 consecutive throttled pages", async () => {
      const { client, calls } = throttling([9]);
      await expect(collectReport(client, TABLE, { pauseMs: 0, sleep: async () => undefined })).rejects.toThrow(/throttled 5 times in a row.*aborting/is);
      expect(calls()).toBe(5);
    });

    it("does not swallow an error that is not a throttle", async () => {
      const client: ReportClient = { send: async () => { throw Object.assign(new Error("denied"), { name: "AccessDeniedException" }); } };
      await expect(collectReport(client, TABLE, { sleep: async () => undefined })).rejects.toThrow(/denied/);
    });
  });

  describe("main", () => {
    function harness(rows: Row[] = [projectRow("billing", 1, "alice", "2026-01-01T00:00:00.000Z"), adminRow("alice", "billing")]) {
      const table = fakeTable(rows);
      const out: string[] = [];
      const err: string[] = [];
      const cloudFormationConfigs: unknown[] = [];
      const dynamoConfigs: unknown[] = [];
      const describedStacks: string[] = [];
      const deps: MainDependencies = {
        createCloudFormation: (config) => {
          cloudFormationConfigs.push(config);
          return {
            send: async (command) => {
              const name = (command as { constructor: { name: string } }).constructor.name;
              if (name !== "DescribeStacksCommand") throw new Error(`unexpected CloudFormation command ${name}`);
              describedStacks.push((command as { input: { StackName: string } }).input.StackName);
              return { Stacks: [{ Outputs: [{ OutputKey: "StateTableName", OutputValue: TABLE }] }] };
            },
          };
        },
        createDocumentClient: (config) => { dynamoConfigs.push(config); return table.client; },
        out: (text) => out.push(text),
        err: (text) => err.push(text),
        sleep: async () => undefined,
      };
      return { deps, out, err, cloudFormationConfigs, dynamoConfigs, describedStacks, table };
    }

    it("resolves the table from the named environment's control-plane stack", async () => {
      const h = harness();
      await main(["--env", "agentxlivetest123", "--profile", "agentx-test"], h.deps);
      expect(h.describedStacks).toEqual(["agentx-agentxlivetest123-control-plane"]);
      expect(h.out.join("\n")).toContain("env agentxlivetest123");
    });

    it("resolves the table from --stack as given, for production's legacy stack name", async () => {
      const h = harness();
      await main(["--stack", "AgentXControlPlane", "--profile", "prod-readonly"], h.deps);
      expect(h.describedStacks).toEqual(["AgentXControlPlane"]);
    });

    it("skips the stack lookup entirely with --table", async () => {
      const h = harness();
      await main(["--table", TABLE, "--profile", "p"], h.deps);
      expect(h.describedStacks).toEqual([]);
      expect(h.cloudFormationConfigs).toEqual([]);
      expect(h.table.commands.length).toBeGreaterThan(0);
    });

    it("builds its clients with the profile and region, and 3 attempts at most", async () => {
      const h = harness();
      await main(["--env", "e1", "--profile", "my-profile", "--region", "eu-west-1"], h.deps);
      expect(h.dynamoConfigs).toEqual([{ region: "eu-west-1", profile: "my-profile", maxAttempts: 3 }]);
      expect(h.cloudFormationConfigs).toEqual([{ region: "eu-west-1", profile: "my-profile", maxAttempts: 3 }]);
    });

    it("sends only Scan to the table, prints JSON on stdout and progress on stderr", async () => {
      const h = harness();
      await main(["--table", TABLE, "--profile", "p", "--json"], h.deps);
      expect(new Set(h.table.commands)).toEqual(new Set(["ScanCommand"]));
      const parsed = JSON.parse(h.out.join("\n")) as { counts: { projects: number }; target: unknown };
      expect(parsed.counts.projects).toBe(1);
      expect(parsed.target).toEqual({ kind: "table", name: TABLE });
      expect(h.err.join("\n")).toMatch(/page 1.*2 items/);
    });

    it("refuses bad arguments before creating any client", async () => {
      const h = harness();
      await expect(main(["--profile", "p"], h.deps)).rejects.toThrow(/exactly one of/);
      await expect(main(["--env", "e"], h.deps)).rejects.toThrow(/--profile is required/);
      expect(h.cloudFormationConfigs).toEqual([]);
      expect(h.dynamoConfigs).toEqual([]);
    });
  });
});
