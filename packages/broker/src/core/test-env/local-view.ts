// What the local pages, the owner routes, the CLI and the MCP tools show of a project's test environment: the approved revision, the proposal that waits (what changes, how risky, whether a Prove run passed),
// in Rovara's fixed words. Every value shown is one plain line (`shownLine`): text from a repository is never trusted to be safe to show.
import {
  TestEnvironmentBodySchema, projectPk, queryAll, redactText, testEnvApprovalRisk, testEnvDigest, testEnvIsProved, testEnvLessSafeChanges,
  type DecisionRisk, type OrgId, type TestEnvironmentBody,
} from "@agentx/contracts";
import { testEnvChangeLines } from "./change-lines.js";
import type { TestEnvDeps } from "./deps.js";
import { proposalNeedsFreshSignIn, proposalSeedTrust, readApprovedBy, readApprovedTestEnvironment, readProposal, readTestEnvProveReport } from "./environment.js";
import { shownLine } from "./shown-line.js";
import { testEnvironmentEnabled } from "./switch.js";
import { TEST_SERVICES_UNAVAILABLE_WORDS, testServicesEnabled, testServicesUnavailable } from "./test-services-switch.js";

export interface ApprovedEnvironmentView {
  revision: number;
  digest: string;
  approvedAt: string;
  approvedBy?: string;
  tier: string;
  roundBudgetMin: number;
  checks: Array<{ id: string; label: string; kind: string }>;
  nightly: { enabled: boolean; cronUtc: string };
  dependencies: Array<{ id: string; name: string; family: string }>;
  /** The things that decide what an environment can reach, one line each. */
  lines: string[];
}

export interface ProposalView {
  digest: string;
  proposedAt: string;
  risk: DecisionRisk;
  lessSafe: string[];
  /** Every value that changes from the approved revision, `where: before -> after`, most sensitive first. */
  changes: string[];
  proved: boolean;
  /** The revision approving this proposal would make. */
  nextRevision: number;
  expiresAt: string | undefined;
}

export interface TestEnvironmentView {
  project: string;
  enabled: boolean;
  testServices: boolean;
  /** DEC 254z-amend3: test services are switched on but the host cannot run them here, in fixed words ("Test services not available here: ..."). Absent when they run, and when they are switched off. */
  testServicesUnavailable?: string;
  approved: ApprovedEnvironmentView | undefined;
  proposal: ProposalView | undefined;
}

const plain = (value: string, max = 160): string => shownLine(redactText(value).replace(/[\r\n]+/gu, " "), max);

function approvedLines(body: TestEnvironmentBody): string[] {
  return [
    `Tier: ${body.tier}`,
    `Round budget: ${String(body.roundBudgetMin)} minutes`,
    `Selection: ${body.selection.method}`,
    body.nightly.enabled ? `Nightly run: ${plain(body.nightly.cronUtc, 40)} UTC on ${plain(body.nightly.branch, 60)}` : "Nightly run: off",
    ...(body.dependencies ?? []).map((dependency) => `Dependency: ${plain(dependency.name, 60)} (${plain(dependency.family, 40)}, ${dependency.backing.kind})`),
  ];
}

/** The newest stored proposal of the project that has not expired and still reads back, or undefined. */
async function newestProposal(deps: TestEnvDeps, orgId: OrgId, project: string): Promise<{ digest: string; body: TestEnvironmentBody; proposedAt: string; expiresAtMs: number | undefined } | undefined> {
  const rows = await queryAll(deps.store, { pk: projectPk(orgId, project), sk: { op: "beginsWith", prefix: "TESTENV#PROPOSAL#" } });
  const live = rows
    .flatMap((row) => (typeof row["digest"] === "string" && typeof row["proposedAt"] === "string" ? [{ digest: row["digest"], proposedAt: row["proposedAt"], expiresAt: row["expiresAt"] }] : []))
    .sort((left, right) => right.proposedAt.localeCompare(left.proposedAt));
  for (const row of live) {
    const digest = row.digest;
    const body = await readProposal(deps, orgId, project, digest).catch(() => undefined);
    if (body !== undefined) return { digest, body, proposedAt: row.proposedAt, expiresAtMs: typeof row.expiresAt === "number" ? row.expiresAt * 1000 : undefined };
  }
  return undefined;
}

/** The project's environment as the pages and tools show it. Never throws for a damaged row: the part that cannot be read is left out. */
export async function testEnvironmentView(deps: TestEnvDeps, orgId: OrgId, project: string): Promise<TestEnvironmentView> {
  const env = deps.env ?? process.env;
  const enabled = testEnvironmentEnabled(env);
  const unavailable = testServicesUnavailable(env);
  const base: TestEnvironmentView = { project, enabled, testServices: testServicesEnabled(env), ...(unavailable === undefined ? {} : { testServicesUnavailable: TEST_SERVICES_UNAVAILABLE_WORDS[unavailable] }), approved: undefined, proposal: undefined };
  if (!enabled) return base;
  const approved = await readApprovedTestEnvironment(deps, orgId, project).catch(() => undefined);
  let approvedView: ApprovedEnvironmentView | undefined;
  if (approved !== undefined) {
    const body = approved.environment;
    const approvedBy = await readApprovedBy(deps, orgId, project, approved.revision).catch(() => undefined);
    approvedView = {
      revision: approved.revision, digest: testEnvDigest(body), approvedAt: approved.approvedAt, ...(approvedBy === undefined ? {} : { approvedBy: plain(approvedBy, 80) }),
      tier: body.tier, roundBudgetMin: body.roundBudgetMin,
      checks: body.repos.flatMap((repo) => repo.checks.map((check) => ({ id: plain(check.id, 60), label: plain(check.label, 100), kind: check.kind }))),
      nightly: { enabled: body.nightly.enabled, cronUtc: body.nightly.cronUtc },
      dependencies: (body.dependencies ?? []).map((dependency) => ({ id: plain(dependency.id, 60), name: plain(dependency.name, 60), family: plain(dependency.family, 40) })),
      lines: approvedLines(body),
    };
  }
  const found = await newestProposal(deps, orgId, project).catch(() => undefined);
  let proposalView: ProposalView | undefined;
  // A proposal that is already the approved revision is not "waiting".
  if (found !== undefined && (approvedView === undefined || approvedView.digest !== found.digest)) {
    const parsed = TestEnvironmentBodySchema.safeParse(found.body);
    if (parsed.success) {
      const trust = await proposalSeedTrust(deps, orgId, project, found.digest, parsed.data);
      const lessSafe = testEnvLessSafeChanges(approved?.environment, parsed.data, trust);
      const strong = await proposalNeedsFreshSignIn(deps, orgId, project, found.digest).catch(() => true);
      const report = await readTestEnvProveReport(deps, orgId, project, found.digest).catch(() => undefined);
      proposalView = {
        digest: found.digest, proposedAt: found.proposedAt,
        risk: lessSafe.length > 0 || strong ? "high" : testEnvApprovalRisk(parsed.data, trust),
        lessSafe, changes: testEnvChangeLines(approved?.environment, parsed.data), proved: testEnvIsProved(report, found.digest, parsed.data),
        nextRevision: (approved?.revision ?? 0) + 1,
        expiresAt: found.expiresAtMs === undefined ? undefined : new Date(found.expiresAtMs).toISOString(),
      };
    }
  }
  return { ...base, approved: approvedView, proposal: proposalView };
}

