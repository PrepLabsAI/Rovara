// Design review stage: the frozen cases of the design review eval. Each case is a requirements document and a design with the defects
// PLANTED in it (or none, for a clean design), written once and never edited: a change to a case changes every baseline built on it, so add a case instead. Nothing here calls a model.
//
// What a case holds:
//   - `planted`: the defects a good review catches. A finding CATCHES a planted defect when it is a blocker or a major in the defect's section and its words contain one of the defect's keywords (any case).
//     A clean design has no planted defects, so any blocker or major finding on it is a false positive. Nits are never counted either way.
//   - `files`: repository files the Codebase reviewer's packet carries (the design's section 8 names them), served from the case, never from a real repository.
// The quality suite (the quality suite design, runner kind `review`-like, stage `plan_check` for design review) does not exist in this repository yet. When it does, its task-set loader reads `DESIGN_REVIEW_EVAL_CASES`
// as the `design-review@1` set; see run.ts for the port a real model plugs into.
import type { DesignSection } from "./types.js";

export interface PlantedDefect {
  id: string;
  section: DesignSection;
  /** A finding catches the defect when its text contains any of these (case-insensitive). */
  keywords: readonly string[];
}

export interface DesignReviewEvalCase {
  id: string;
  /** One line for the report. */
  title: string;
  requirements: string;
  design: string;
  planted: readonly PlantedDefect[];
  /** Repository files at the pinned base commit, by path, in the repository named `repo`. */
  repo: string;
  files: Readonly<Record<string, string>>;
}

const meta = (paths: readonly string[]): string => `\n## 8. Sources\n\n\`\`\`rovara-design-meta\n${JSON.stringify({ touches: [], repositories: [], services: [], sources: paths.map((ref) => ({ kind: "repo_file", ref })) })}\n\`\`\`\n`;

export const DESIGN_REVIEW_EVAL_CASES: readonly DesignReviewEvalCase[] = [
  {
    id: "retry-no-bound",
    title: "Retry timed-out payments: no upper bound on retries, and no idempotency key",
    requirements: "# Requirements\n\nR1: A payment that times out is retried.\nR2: A payment is never charged twice.\n",
    design: `# Design: retry payments\n\n## 1. Problem and goal\nTimed-out payments are dropped. Retry them (R1) without double charges (R2).\n\n## 2. Current system\nThe charge call throws on a timeout.\n\n## 3. Proposed design\n### 3.1 Retry\nR1: when the charge call times out, call it again with a growing wait.\n### 3.2 Charging\nR2: the retry sends the same amount again.\n\n## 4. Alternatives\nNone.\n\n## 5. Risks\nA slow gateway.\n\n## 6. Impact\nPayments service.\n\n## 7. Open questions\nNone.${meta([])}`,
    planted: [
      { id: "unbounded-retry", section: "§3", keywords: ["upper bound", "unbounded", "no limit", "forever"] },
      { id: "no-idempotency", section: "§3", keywords: ["idempotency", "idempotent", "charged twice", "double charge"] },
    ],
    repo: "payments", files: {},
  },
  {
    id: "ranking-endpoint",
    title: "Partner ranking endpoint: a requirement the design never covers, no rollback for the migration, and a route that already exists",
    requirements: "# Requirements\n\nR1: GET /partners/ranking returns the top partners for a region.\nR2: Partners belong to a region.\nR3: The ranking is cached for five minutes.\n",
    design: `# Design: partner ranking\n\n## 1. Problem and goal\nShow the top partners per region (R1, R2).\n\n## 2. Current system\nThere is no ranking route.\n\n## 3. Proposed design\n### 3.1 Route\nR1: add GET /partners/ranking in src/routes/partners.ts.\n### 3.2 Region\nR2: add a region column to partners and backfill it from the address table.\n\n## 4. Alternatives\nNone.\n\n## 5. Risks\nThe backfill touches every partner row. It runs in one migration.\n\n## 6. Impact\nPartners service and its database.\n\n## 7. Open questions\nNone.${meta(["src/routes/partners.ts"])}`,
    planted: [
      { id: "requirement-uncovered", section: "§3", keywords: ["R3", "appears in no"] },
      { id: "no-rollback", section: "§5", keywords: ["rollback", "roll back", "revert"] },
      { id: "route-exists", section: "§2", keywords: ["already exists", "already has", "existing route"] },
    ],
    repo: "partners", files: { "src/routes/partners.ts": "export const routes = [{ method: 'GET', path: '/partners/ranking', handler: rankingHandler }];\n" },
  },
  {
    id: "token-expiry",
    title: "Session token change: expiry is never checked, and the notifications service reads the old token",
    requirements: "# Requirements\n\nR1: Session tokens are rotated on login.\nR2: An old token stops working.\n",
    design: `# Design: rotate session tokens\n\n## 1. Problem and goal\nRotate tokens on login (R1) and retire the old one (R2).\n\n## 2. Current system\nThe auth service issues a token that lives until the user logs out.\n\n## 3. Proposed design\n### 3.1 Rotation\nR1: issue a new token on every login.\n### 3.2 Retirement\nR2: delete the previous token row when the new one is issued.\n\n## 4. Alternatives\nNone.\n\n## 5. Risks\nNone.\n\n## 6. Impact\nAuth service.\n\n## 7. Open questions\nNone.${meta([])}`,
    planted: [
      { id: "no-expiry", section: "§3", keywords: ["expiry", "expires", "expire"] },
      { id: "other-service-reads-token", section: "§2", keywords: ["notifications service", "other service", "another service"] },
    ],
    repo: "auth", files: {},
  },
  {
    id: "clean-feature",
    title: "A sound design: nothing planted",
    requirements: "# Requirements\n\nR1: The payment page shows the retry count.\n",
    design: `# Design: show the retry count\n\n## 1. Problem and goal\nShow how often a payment was retried (R1).\n\n## 2. Current system\nThe payment record already stores the attempt number.\n\n## 3. Proposed design\n### 3.1 Page\nR1: read the attempt number from the payment record and show it under the amount.\n\n## 4. Alternatives\nA separate counter was rejected: the attempt number is already stored.\n\n## 5. Risks\nNone: a read-only change.\n\n## 6. Impact\nPayment page only.\n\n## 7. Open questions\nNone.${meta([])}`,
    planted: [],
    repo: "web", files: {},
  },
  {
    id: "clean-small",
    title: "A sound, small design: nothing planted",
    requirements: "# Requirements\n\nR1: The refund email names the order.\n",
    design: `# Design: name the order in the refund email\n\n## 1. Problem and goal\nThe refund email does not say which order was refunded (R1).\n\n## 2. Current system\nThe template has no order field.\n\n## 3. Proposed design\n### 3.1 Template\nR1: add the order number to the subject and the first line of the refund email template.\n\n## 4. Alternatives\nNone.\n\n## 5. Risks\nNone.\n\n## 6. Impact\nOne template.\n\n## 7. Open questions\nNone.${meta([])}`,
    planted: [],
    repo: "mailer", files: {},
  },
];
