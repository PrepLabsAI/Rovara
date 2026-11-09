// The fake server's container program (test services, slice 3; design test-services.md 4.4 and 7.5). It runs from the WORKER'S OWN image, by image id, like the sealed DNS helper (sealed-dns-helper.ts): `node dist/fake-helper.js`
// with arguments the launcher built from numbers (service-helpers.ts, `fakeHelperArgs`). It has two modes and nothing else:
//   SERVE      `--listen <ipv4> --port <n> --caller <ipv4> --digest <64 hex> --unmatched fail --fixture <file> --ledger <file>`
//              starts the verifier's fake server in replay mode (`startFakeServer`): it listens on the run address and nowhere else, serves ONLY a set that parses and hashes to the digest the plan pinned, answers a request
//              with no recording with an error and counts it, answers only the one caller it was given (any other address gets the fixed 599 and is counted apart), writes every request to its ledger BEFORE it answers,
//              never forwards anything. The control token it needs for its own control paths is made here, kept in memory and given to nobody (the app is never given it, and neither is the worker).
//   SUMMARIZE  `--summarize --ledger <file> --fixture <file> --digest <64 hex> --caller <ipv4>`
//              reads the ledger the server wrote and prints ONE line of JSON with the counts (`FakeLedgerSummary`): the worker runs it by `docker exec` while the server is still up, and builds the usage record from the line
//              alone. The ledger is parsed with the fake's own ledger rules (`parseFakeLedger`: a malformed line, a ledger past its bound or a duplicated request id makes it untrusted), against the pinned set.
// Nothing here takes a secret, a URL or a repository string. It makes no outbound connection (the fake server's core imports nothing that could).
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { z } from "zod";
import { loadFixtureSetV2, parseFakeLedger, startFakeServer, type RunningFakeServer } from "@agentx/verifier/service-mocks";

const DIGEST = /^[a-f0-9]{64}$/u;
/** Where the launcher mounts the verified set, read-only, and where the ledger lives (the helper's own tmpfs). */
export const FAKE_FIXTURE_PATH = "/rovara/fixture.json";
export const FAKE_LEDGER_PATH = "/tmp/fake-ledger.jsonl";
const FILE_PATH = /^\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){0,12}$/u;
/** The most a ledger the summary reads may weigh: the server's own bound is 2,048 lines of at most about 1 KiB each. */
const LEDGER_READ_MAX_BYTES = 4 * 1024 * 1024;

/** The one error of this program; its message is a fixed word and carries no value. */
export class FakeHelperRefused extends Error {
  constructor(readonly reason: "arguments" | "fixture" | "ledger") {
    super(`fake helper refused: ${reason}`);
    this.name = "FakeHelperRefused";
  }
}

export interface FakeServeArguments { listen: string; port: number; callers: string[]; digest: string; unmatched: "fail"; fixture: string; ledger: string }
export interface FakeSummarizeArguments { ledger: string; fixture: string; digest: string; caller: string }

function valuesOf(argv: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let at = 0; at < argv.length; at += 1) {
    if (argv[at] !== `--${name}`) continue;
    const value = argv[at + 1];
    if (value === undefined || value.startsWith("--")) throw new FakeHelperRefused("arguments");
    values.push(value);
  }
  return values;
}
function one(argv: readonly string[], name: string): string {
  const values = valuesOf(argv, name);
  if (values.length !== 1) throw new FakeHelperRefused("arguments");
  return values[0]!;
}
const ipv4 = (value: string): string => (isIP(value) === 4 ? value : (() => { throw new FakeHelperRefused("arguments"); })());
const path = (value: string): string => (FILE_PATH.test(value) && !value.split("/").includes("..") ? value : (() => { throw new FakeHelperRefused("arguments"); })());
const digest = (value: string): string => (DIGEST.test(value) ? value : (() => { throw new FakeHelperRefused("arguments"); })());

/** The arguments of serving, strictly: an unknown flag, a repeated one, a name instead of an address, a wildcard or a policy other than `fail` is refused. */
export function parseServeArguments(argv: readonly string[]): FakeServeArguments {
  const known = new Set(["listen", "port", "caller", "digest", "unmatched", "fixture", "ledger"]);
  for (const token of argv) if (token.startsWith("--") && !known.has(token.slice(2))) throw new FakeHelperRefused("arguments");
  const port = Number(one(argv, "port"));
  const listen = ipv4(one(argv, "listen"));
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || listen === "0.0.0.0") throw new FakeHelperRefused("arguments");
  const callers = valuesOf(argv, "caller").map(ipv4);
  if (callers.length !== 1 || one(argv, "unmatched") !== "fail") throw new FakeHelperRefused("arguments");
  return { listen, port, callers, digest: digest(one(argv, "digest")), unmatched: "fail", fixture: path(one(argv, "fixture")), ledger: path(one(argv, "ledger")) };
}

export function parseSummarizeArguments(argv: readonly string[]): FakeSummarizeArguments {
  const known = new Set(["summarize", "ledger", "fixture", "digest", "caller"]);
  for (const token of argv) if (token.startsWith("--") && !known.has(token.slice(2))) throw new FakeHelperRefused("arguments");
  return { ledger: path(one(argv, "ledger")), fixture: path(one(argv, "fixture")), digest: digest(one(argv, "digest")), caller: ipv4(one(argv, "caller")) };
}

/** Starts the fake server for a set. `readFile` is the file seam (tests). Throws `FakeHelperRefused` for a set that is not the pinned one. */
export async function serveFake(args: FakeServeArguments, readFile: (path: string) => Buffer = readFileSync): Promise<RunningFakeServer> {
  let set: ReturnType<typeof loadFixtureSetV2>;
  try {
    // Parsed and held to the digest by the fake server again; this first read only turns a bad file into one fixed refusal.
    set = loadFixtureSetV2(JSON.parse(readFile(args.fixture).toString("utf8")) as unknown, args.digest);
  } catch {
    throw new FakeHelperRefused("fixture");
  }
  return startFakeServer({ mode: "replay", bindAddress: args.listen, port: args.port, callers: args.callers, ledgerPath: args.ledger, fixtureSet: set, expectedDigest: args.digest, unmatched: args.unmatched });
}

// ---- the summary

/**
 * What the summary says. `trusted` is false for a ledger that has a malformed line, is past its bound, or could not be read at all: its counts are then zero and mean nothing. The counts are exact here and are made
 * coarse (buckets) by the worker before they go anywhere.
 */
export const FakeLedgerSummarySchema = z
  .object({
    schemaVersion: z.literal(1),
    trusted: z.boolean(),
    matched: z.number().int().min(0).max(10_000),
    unmatched: z.number().int().min(0).max(10_000),
    synthesized: z.number().int().min(0).max(10_000),
    faults: z.number().int().min(0).max(10_000),
    foreign: z.number().int().min(0).max(10_000),
  })
  .strict()
  .superRefine((summary, context) => {
    if (!summary.trusted && (summary.matched > 0 || summary.unmatched > 0 || summary.synthesized > 0 || summary.faults > 0 || summary.foreign > 0)) context.addIssue({ code: "custom", path: ["trusted"], message: "an untrusted ledger says nothing" });
  });
export type FakeLedgerSummary = z.infer<typeof FakeLedgerSummarySchema>;

/** The summary of a ledger. Never throws for a ledger it cannot read: that is an untrusted summary with nothing counted. */
export function summarizeFakeLedger(args: FakeSummarizeArguments, readFile: (path: string) => Buffer = readFileSync): FakeLedgerSummary {
  const untrusted: FakeLedgerSummary = { schemaVersion: 1, trusted: false, matched: 0, unmatched: 0, synthesized: 0, faults: 0, foreign: 0 };
  try {
    const bytes = readFile(args.ledger);
    if (bytes.length > LEDGER_READ_MAX_BYTES) return untrusted;
    const set = loadFixtureSetV2(JSON.parse(readFile(args.fixture).toString("utf8")) as unknown, args.digest);
    // The program is still running to be asked: it is this process's caller (`docker exec`) that has checked the container is.
    const ledger = parseFakeLedger({ bytes, appAddress: args.caller, helperStillRunning: true, fixtureSet: set });
    if (!ledger.trusted) return untrusted;
    const cap = (value: number): number => Math.min(10_000, value);
    return { schemaVersion: 1, trusted: true, matched: cap(ledger.counted.matched + ledger.counted.additions), unmatched: cap(ledger.counted.unmatched + ledger.counted.sinkholed), synthesized: cap(ledger.counted.synthesized), faults: cap(ledger.counted.faults), foreign: cap(ledger.foreign) };
  } catch {
    return untrusted;
  }
}

/** Parses the one line the summary printed. Anything else (an empty line, extra text, a count past its bound) is undefined: unreadable, never "no calls". */
export function parseFakeLedgerSummary(stdout: string): FakeLedgerSummary | undefined {
  try {
    const lines = stdout.split("\n").filter((line) => line !== "");
    if (lines.length !== 1) return undefined;
    const parsed = FakeLedgerSummarySchema.safeParse(JSON.parse(lines[0]!));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--summarize")) {
    process.stdout.write(`${JSON.stringify(summarizeFakeLedger(parseSummarizeArguments(argv)))}\n`);
    return;
  }
  const server = await serveFake(parseServeArguments(argv));
  const end = (): void => { void server.close().finally(() => process.exit(0)); };
  process.on("SIGTERM", end);
  process.on("SIGINT", end);
}

if (process.argv[1]?.endsWith("fake-helper.js")) {
  main().catch(() => { process.exit(1); });
}
