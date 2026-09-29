# QEDly Website Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and ship the QEDly website at `https://qedly.github.io`, with the AgentX docs pulled from a release tag, a Receipts page generated from the site's own QEDly Code pull requests, and build checks that keep every claim true.

**Architecture:** A static Astro site with Starlight for the docs. It lives in the public repository `qedly/qedly.github.io` and is published to GitHub Pages by a GitHub Action. Three build-time scripts feed it: a docs sync from `PrepLabsAI/AgentX` at a pinned tag, a receipts fetch from the GitHub API, and a claims check over the ledger and the built HTML. After Task 2, the site repository is registered as an AgentX project, and later site changes are requested in its Slack channel so each one becomes a receipt.

**Tech Stack:** Node 22, Astro 5 with Starlight, TypeScript, Vitest, `yaml`, `zod`, GitHub Actions, GitHub Pages, AWS CodeBuild (one AgentX gate), `@lhci/cli`, Buttondown.

**Spec:** `specs/042-qedly-site/spec.md` (read it first: the positioning, Appendix A copy deck, and Appendix B claims ledger are inputs to Tasks 3, 7 and 8).

## Owner TODO

This branch (`docs/040-qedly-site`, PR #145, kept as a draft) collects every AgentX-repository change for the launch and merges into mainline once, at launch.

Done:
- [x] GitHub organisation `qedly` and public repository `qedly/qedly.github.io` (2026-09-28)
- [x] npm scope `@qedly` and pointer package `qedly@0.0.1` (2026-09-28)

Needed before Task 2 step 7 (dogfooding):
- [ ] Install the AgentX GitHub App on the `qedly` organisation, for `qedly.github.io` only (Contents and Pull requests, read and write)

Needed before Task 5 (docs sync), and only while AgentX is private:
- [ ] Fine-grained read-only token owned by PrepLabsAI, limited to `AgentX` (Contents: Read, Pull requests: Read), saved as the Actions secret `AGENTX_READ_TOKEN` in `qedly/qedly.github.io` and as `qedly-site/agentx-readonly` in AWS Secrets Manager

Needed before launch (FR-060):
- [ ] Buttondown: create a PrepLabs account and set `SITE.buttondownUser`
- [ ] Trademark search: UK, EU and US, classes 9 and 42, for "QEDly"
- [ ] First public AgentX release, cut after this branch merges so its tag contains the new docs:
  - [ ] publish the first npm version by hand (`docs/releases.md`, one-time owner setup step 3)
  - [ ] turn on automatic publishing (`AGENTX_PUBLISH_ENABLED`)
  - [ ] make `PrepLabsAI/AgentX` public
- [ ] Rebase this branch on mainline before the launch merge

## Execution (owner decision, 2026-09-29)

- **Direct:** Tasks 1, 2, 3, 5, 6, 10 and 11 are built directly, not through QEDly Code. They are the build's plumbing, where a mistake breaks every later task.
- **QEDly Code, from `#qedly-site`:** Tasks 7, 8 and 9 (the pages), and later copy changes. Each merged PR becomes a receipt.
- **When to set up dogfooding:** Task 2 step 7 (App install, project registration, channel) moves to just before Task 7.
- **Tech stack as built:** Astro 7.2 and Starlight 0.42 on Node 22 (qedly/qedly.github.io#2). The current `create-astro` refuses Node 20.

## Global Constraints

- Site URL comes from one setting: `SITE.url = "https://qedly.github.io"` (FR-040).
- Home H1, exactly: "Your AI agent says the tests pass. QEDly makes it prove it." (FR-001)
- Hero line, exactly: "Source-available · Runs in your AWS account · Amazon Bedrock" (FR-001)
- Licence wording, exactly and in one setting: "Source-available (FSL-1.1-ALv2). Every line is readable. Each release becomes Apache 2.0 two years after it ships." (FR-004)
- Banned in copy (FR-003): "10x", "autonomous", "AI engineer", "AI employee", "teammate", "swarm", "army of agents", "software factory", "mission control", "production-ready in minutes", "game-changing", "enterprise-grade", "open source" (for AgentX or QEDly Code).
- Status labels are exactly: Now (QEDly Code, QEDly Checks), Next (Workspace, Passport), Later (Outcomes, Cloud) (FR-005).
- No usage volume, customer counts or productivity multiples (FR-009).
- No cookies; any analytics must be cookieless (FR-043).
- Lighthouse ≥ 95 in all four categories, mobile and desktop (FR-041).
- `noindex` and a disallow-all `robots.txt` until `SITE.launched` is `true` (FR-060).
- Docs come from the AgentX tag in `SITE.docsRelease`; every docs page shows it (FR-030).
- Receipts are generated, never hand-edited; the build fails rather than publish an empty Receipts page (FR-022, edge cases).
- Every PR is merged by a human (FR-021).
- Copy style: plain words, active voice, no em-dash asides, no "not X but Y" framing.

## Review Focus

1. **Quoted competitor wording.** The FAQ answer "How is it different from Devin" may need to quote a banned word ("autonomous software engineer"). A reader expects the quote to be allowed and our own copy to be checked. Test in Task 3: text inside an element with `data-quote` is skipped by the banned-word check, and the same word elsewhere fails.
2. **Docs links that point outside `docs/`.** AgentX docs link to `../README.md#anchor`, `../examples/...` and `../packages/...`. A reader expects each to open the right GitHub file at the documented tag, not a 404 on the site. Test in Task 5: those three shapes, a `connectors/linear.md` sibling link, and an in-page `#anchor`.
3. **A receipt whose requester did not consent.** The Slack user ID must never appear on the site. Test in Task 6: a body with an unknown `U…` ID renders "a QEDly team member", and a known ID renders the consented display name.
4. **Pull requests that are not QEDly Code's.** Hand-written PRs, bot PRs from Dependabot, and unmerged PRs must not count. Test in Task 6: only merged PRs by the configured app login are kept.
5. **The site URL changing later.** Canonical URLs, sitemap entries, Open Graph URLs and `llms.txt` links must all move together. Test in Task 2 (`absoluteUrl`) and Task 10: the llms output is built only from `absoluteUrl`.

---

## File Structure

Site repository `qedly/qedly.github.io`:

| Path | Responsibility |
|---|---|
| `src/config/site.ts` | The one place for URL, licence text, docs tag, repos, app login, launch flag, status labels. |
| `src/data/claims.yaml` | The claims ledger (from spec Appendix B). |
| `src/data/products.ts` | The six products with job line and status. |
| `src/data/consent.yaml` | Slack user ID → consented display name. |
| `src/data/receipts.json` | Generated by `scripts/fetch-receipts.ts`; git-ignored. |
| `src/lib/claims.ts` | Parse and validate the ledger; look up a claim by id. |
| `src/lib/banned.ts` | Find banned words in visible text, skipping `data-quote`. |
| `src/lib/receipts.ts` | Pure receipt building, cache merge and totals. |
| `src/lib/docs.ts` | Pure Markdown transforms for the docs sync. |
| `src/lib/llms.ts` | Build `llms.txt` and `llms-full.txt`. |
| `src/lib/seo.ts` | `robotsTxt`, JSON-LD builders. |
| `scripts/sync-docs.ts` | Download AgentX `docs/` at the tag and write Starlight pages. |
| `scripts/fetch-receipts.ts` | Call the GitHub API and write `receipts.json`. |
| `scripts/check-claims.ts` | Evidence check plus banned-word scan of `dist/`. |
| `scripts/postbuild.ts` | Write `llms.txt`, `llms-full.txt`, `.md` copies, `robots.txt`. |
| `src/components/*.astro` | `Claim`, `Status`, `Receipt`, `ReceiptTotals`, `SlackThread`, `WaitlistForm`, `QedMark`. |
| `src/layouts/Marketing.astro` | Shared head (meta, robots, OG, JSON-LD), header, footer. |
| `src/pages/*.astro` | `index`, `code`, `security`, `receipts`, `roadmap`, `manifesto`, `faq`, `about`. |
| `src/content/docs/` | Starlight docs; `docs/agentx/` is generated by the sync. |
| `public/brand/` | Approved logo files from Task 1. |
| `tests/*.test.ts` | Vitest unit tests, one file per `src/lib` module. |
| `.github/workflows/deploy.yml` | Build and publish to GitHub Pages. |
| `buildspec.yml` | The AgentX CodeBuild gate. |
| `lighthouserc.json` | Lighthouse thresholds. |

AgentX repository (this branch or a follow-up PR): `docs/quickstart.md`, `docs/concepts.md`, `docs/security.md`, `docs/cli.md`, `docs/costs.md`, `docs/troubleshooting.md` (Task 4).

---

### Task 0: Owner prerequisites (no code)

These are owner actions. Tasks 2 onward depend on items 1 to 3.

- [ ] **Step 1:** Create the GitHub organisation `qedly` (free plan) and the public repository `qedly/qedly.github.io`, with no template and a `main` branch.
- [ ] **Step 2:** In the repository settings, go to Pages, set Source to "GitHub Actions" and turn on "Enforce HTTPS".
- [ ] **Step 3:** A fine-grained token can reach only one owner's repositories, so the site uses two:
  - `AGENTX_READ_TOKEN`: a fine-grained token owned by `PrepLabsAI`, limited to `PrepLabsAI/AgentX`, with read-only Contents and Pull requests. The docs sync and the claims check use it. Store it as an Actions secret in `qedly/qedly.github.io`, and in AWS Secrets Manager as `qedly-site/agentx-readonly` for the CodeBuild gate.
  - `SITE_READ_TOKEN`: for the receipts fetch on the site repository. In GitHub Actions this is the built-in `GITHUB_TOKEN`, so there is nothing to create. In CodeBuild the fetch runs without a token, because the repository is public.
- [ ] **Step 3a:** Install the AgentX GitHub App (`agentx-sdlc`) on the `qedly` organisation for the `qedly.github.io` repository only, with Contents and Pull requests read and write. Spec 030 supports one App across several owners, but its live check (030 T005) is still open. This install is its first real use, so verify it in Task 2 step 7.
- [ ] **Step 4:** Create a Buttondown account owned by PrepLabs, note the username, and enable tags `workspace` and `cloud`.
- [ ] **Step 5:** Book the UK, EU and US trademark search for "QEDly" in classes 9 and 42.

### Task 1: Logo system (FR-050)

**Files:**
- Created (site repo, qedly/qedly.github.io#1): `public/brand/wordmark.svg`, `lockup-tagline.svg`, `icon.svg`, `favicon.svg`, `qed-stamp.svg`, `og-template.svg`, each with a `-dark` variant where it applies, plus `icon-512.png`, `icon-dark-512.png`, `README.md` and `scripts/brand/export.py`

**Interfaces:**
- Produces: the files above. Later tasks reference these exact paths. Status: approved 2026-09-28 ("Box the answer"), exported and in review as qedly/qedly.github.io#1.

- [ ] **Step 1: Explore.** Publish one private review page showing four directions. Each direction appears at 16 px, 32 px and 512 px, in the site header, in a mock PR footer, and on light and dark backgrounds. The directions are:
  - (a) the solid ∎ square alone;
  - (b) a Q whose tail is the check stroke;
  - (c) two overlapping circles (people and agents) with ∎ in the overlap;
  - (d) the ∎ inside a stamp ring.
- [ ] **Step 2: Review gate.** Both founders pick one direction and give notes. Do not start Task 7 before this is recorded in the site repository's first issue.
- [ ] **Step 3: Refine.** Produce the chosen direction as a wordmark in a wide, heavy grotesk, locked up with "Q.E.D." beneath it. Check the favicon is legible at 16 px on light and dark backgrounds.
- [ ] **Step 4: Export and commit** the six files (plus dark variants) to `public/brand/`, with a `public/brand/README.md` listing each file's use and minimum size.

```bash
git add public/brand && git commit -m "feat(brand): add approved QEDly mark, wordmark and icons"
```

### Task 2: Scaffold the site and its one settings file

**Files:**
- Create: `package.json`, `astro.config.mjs`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `src/config/site.ts`, `src/lib/seo.ts`, `tests/site.test.ts`, `tests/seo.test.ts`

**Interfaces:**
- Produces: `SITE` (object below), `absoluteUrl(path: string): string`, `type Status = "now" | "next" | "later"`, `STATUS_LABEL: Record<Status, string>`, `robotsTxt(launched: boolean, sitemapUrl: string): string`.

- [ ] **Step 1: Scaffold.**

```bash
npm create astro@latest qedly-site -- --template starlight --no-install --no-git --yes
cd qedly-site && npm install && npm install -D vitest yaml zod tsx @lhci/cli
```

Move the generated files into the repository root and record the exact installed versions in the commit message.

- [ ] **Step 2: Write the failing tests.**

```ts
// tests/site.test.ts
import { describe, expect, it } from "vitest";
import { SITE, absoluteUrl, STATUS_LABEL } from "../src/config/site";

describe("site settings", () => {
  it("builds absolute URLs from the one site URL", () => {
    expect(absoluteUrl("/docs/")).toBe("https://qedly.github.io/docs/");
    expect(absoluteUrl("receipts")).toBe("https://qedly.github.io/receipts");
  });
  it("keeps the licence wording exact", () => {
    expect(SITE.licence).toBe("Source-available (FSL-1.1-ALv2). Every line is readable. Each release becomes Apache 2.0 two years after it ships.");
  });
  it("uses exactly three status labels", () => {
    expect(STATUS_LABEL).toEqual({ now: "Now", next: "Next", later: "Later" });
  });
  it("starts unlaunched", () => {
    expect(SITE.launched).toBe(false);
  });
});
```

```ts
// tests/seo.test.ts
import { describe, expect, it } from "vitest";
import { robotsTxt } from "../src/lib/seo";

describe("robotsTxt", () => {
  it("disallows everything before launch", () => {
    expect(robotsTxt(false, "https://qedly.github.io/sitemap-index.xml")).toBe("User-agent: *\nDisallow: /\n");
  });
  it("allows crawling and names the sitemap after launch", () => {
    expect(robotsTxt(true, "https://qedly.github.io/sitemap-index.xml")).toBe("User-agent: *\nAllow: /\n\nSitemap: https://qedly.github.io/sitemap-index.xml\n");
  });
});
```

- [ ] **Step 3: Run them to verify they fail.** Run: `npx vitest run tests/site.test.ts tests/seo.test.ts`. Expected: FAIL, the modules cannot be resolved.

- [ ] **Step 4: Implement.**

```ts
// src/config/site.ts
export const SITE = {
  url: "https://qedly.github.io",
  name: "QEDly",
  licence: "Source-available (FSL-1.1-ALv2). Every line is readable. Each release becomes Apache 2.0 two years after it ships.",
  docsRelease: "v0.1.0",
  agentxRepo: "PrepLabsAI/AgentX",
  siteRepo: "qedly/qedly.github.io",
  qedlyCodeAppLogin: "agentx-sdlc[bot]",
  buttondownUser: "qedly",
  launched: false,
} as const;

export type Status = "now" | "next" | "later";
export const STATUS_LABEL: Record<Status, string> = { now: "Now", next: "Next", later: "Later" };

export function absoluteUrl(path: string): string {
  return new URL(path.startsWith("/") ? path : `/${path}`, SITE.url).toString();
}
```

```ts
// src/lib/seo.ts
export function robotsTxt(launched: boolean, sitemapUrl: string): string {
  return launched ? `User-agent: *\nAllow: /\n\nSitemap: ${sitemapUrl}\n` : "User-agent: *\nDisallow: /\n";
}
```

Set `site: SITE.url` in `astro.config.mjs` (import `SITE`), and add scripts to `package.json`:

```json
{
  "scripts": {
    "sync:docs": "tsx scripts/sync-docs.ts",
    "fetch:receipts": "tsx scripts/fetch-receipts.ts",
    "build": "npm run sync:docs && npm run fetch:receipts && astro build && tsx scripts/postbuild.ts && tsx scripts/check-claims.ts",
    "test": "vitest run",
    "dev": "astro dev"
  }
}
```

Replace `SITE.docsRelease` and `SITE.buttondownUser` with the real values when Task 0 and the first AgentX release exist.

- [ ] **Step 5: Run the tests to verify they pass.** Run: `npx vitest run`. Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add -A && git commit -m "feat: scaffold Astro and Starlight site with one settings file"
```

- [ ] **Step 7: Dogfood switch-over (owner, with AgentX admin rights).**
  1. Confirm the Step 3a App install: registering a repository owned by `qedly` succeeds, and the first workspace clones and pushes. This closes spec 030 T005 for a second owner.
  2. Register `qedly/qedly.github.io` as the AgentX project `qedly-site`, using `readiness` `npm ci` and `npm test`, and a CodeBuild gate `agentx-qedly-site-build` whose buildspec is added in Task 11.
  3. Create the Slack channel `#qedly-site` and bind it.
  4. From Task 3 onward, request each task in that channel, and have a human review and merge each PR.

### Task 3: Claims ledger and copy checks (FR-002, FR-003, FR-009, FR-013)

**Files:**
- Create: `src/data/claims.yaml`, `src/lib/claims.ts`, `src/lib/banned.ts`, `src/components/Claim.astro`, `scripts/check-claims.ts`, `tests/claims.test.ts`, `tests/banned.test.ts`

**Interfaces:**
- Consumes: `SITE` from Task 2.
- Produces:
  - `type Evidence = { kind: "pr"; repo: string; number: number } | { kind: "file"; repo: string; path: string }`
  - `type Claim = { id: string; text: string; status: Status; evidence: Evidence[] }`
  - `loadClaims(yamlText: string): Claim[]` (throws on invalid entries or duplicate ids)
  - `claimById(claims: Claim[], id: string): Claim` (throws on an unknown id)
  - `BANNED: readonly string[]`
  - `findBanned(html: string): { word: string; context: string }[]`
  - `<Claim id="…" />` renders the claim text, so page copy cannot drift from the ledger.

- [ ] **Step 1: Write the ledger.** Transcribe every row of spec Appendix B into `src/data/claims.yaml` with `status: now`. Add the four "not current" items with `status: next` or `later`. Use this shape:

```yaml
- id: thread-machine
  text: Every thread gets its own isolated, persistent machine in your AWS account.
  status: now
  evidence:
    - { kind: pr, repo: PrepLabsAI/AgentX, number: 134 }
    - { kind: file, repo: PrepLabsAI/AgentX, path: docs/architecture-production.md }
- id: exact-commit-gates
  text: Checks run in your CodeBuild on the exact commit, and the agent holds no CodeBuild credentials.
  status: now
  evidence:
    - { kind: file, repo: PrepLabsAI/AgentX, path: packages/broker/src/codebuild.ts }
    - { kind: file, repo: PrepLabsAI/AgentX, path: specs/004-codebuild-gates/spec.md }
```

- [ ] **Step 2: Write the failing tests.**

```ts
// tests/claims.test.ts
import { describe, expect, it } from "vitest";
import { loadClaims, claimById } from "../src/lib/claims";

const ok = `
- id: a
  text: One.
  status: now
  evidence: [{ kind: pr, repo: PrepLabsAI/AgentX, number: 1 }]
`;

describe("claims ledger", () => {
  it("parses a valid ledger", () => {
    expect(loadClaims(ok)).toEqual([{ id: "a", text: "One.", status: "now", evidence: [{ kind: "pr", repo: "PrepLabsAI/AgentX", number: 1 }] }]);
  });
  it("rejects a current claim with no evidence", () => {
    expect(() => loadClaims("- { id: b, text: Two., status: now, evidence: [] }")).toThrow(/b.*evidence/);
  });
  it("rejects duplicate ids", () => {
    expect(() => loadClaims(ok + ok)).toThrow(/duplicate claim id a/);
  });
  it("throws on an unknown id so a page cannot cite a missing claim", () => {
    expect(() => claimById(loadClaims(ok), "zzz")).toThrow(/unknown claim zzz/);
  });
});
```

```ts
// tests/banned.test.ts
import { describe, expect, it } from "vitest";
import { findBanned } from "../src/lib/banned";

describe("banned words", () => {
  it("finds a banned word in visible text, case-insensitively", () => {
    expect(findBanned("<p>An Autonomous agent.</p>").map((hit) => hit.word)).toEqual(["autonomous"]);
  });
  it("finds multi-word phrases", () => {
    expect(findBanned("<h2>Your software factory</h2>").map((hit) => hit.word)).toEqual(["software factory"]);
  });
  it("skips text inside data-quote elements", () => {
    expect(findBanned('<p>Devin calls itself <q data-quote>an autonomous software engineer</q>.</p>')).toEqual([]);
  });
  it("ignores markup, scripts and attributes", () => {
    expect(findBanned('<div class="teammate"><script>var swarm=1</script>ok</div>')).toEqual([]);
  });
  it("does not match inside longer words", () => {
    expect(findBanned("<p>autonomously is still banned? no: autonomousness</p>")).toEqual([]);
  });
});
```

- [ ] **Step 3: Run to verify they fail.** Run: `npx vitest run tests/claims.test.ts tests/banned.test.ts`. Expected: FAIL, the modules cannot be resolved.

- [ ] **Step 4: Implement.**

```ts
// src/lib/claims.ts
import { parse } from "yaml";
import { z } from "zod";

const EvidenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pr"), repo: z.string(), number: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("file"), repo: z.string(), path: z.string().min(1) }).strict(),
]);
const ClaimSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  text: z.string().min(1),
  status: z.enum(["now", "next", "later"]),
  evidence: z.array(EvidenceSchema),
}).strict();

export type Evidence = z.infer<typeof EvidenceSchema>;
export type Claim = z.infer<typeof ClaimSchema>;

export function loadClaims(yamlText: string): Claim[] {
  const claims = z.array(ClaimSchema).parse(parse(yamlText));
  const seen = new Set<string>();
  for (const claim of claims) {
    if (seen.has(claim.id)) throw new Error(`duplicate claim id ${claim.id}`);
    seen.add(claim.id);
    if (claim.status === "now" && claim.evidence.length === 0) throw new Error(`claim ${claim.id} is current but has no evidence`);
  }
  return claims;
}

export function claimById(claims: Claim[], id: string): Claim {
  const claim = claims.find((entry) => entry.id === id);
  if (!claim) throw new Error(`unknown claim ${id}`);
  return claim;
}
```

```ts
// src/lib/banned.ts
export const BANNED = [
  "10x", "autonomous", "ai engineer", "ai employee", "teammate", "swarm", "army of agents",
  "software factory", "mission control", "production-ready in minutes", "game-changing",
  "enterprise-grade", "open source",
] as const;

function visibleText(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<([a-z0-9]+)\b[^>]*\bdata-quote\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
}

export function findBanned(html: string): { word: string; context: string }[] {
  const text = visibleText(html);
  const hits: { word: string; context: string }[] = [];
  for (const word of BANNED) {
    const pattern = new RegExp(`(?<![a-z0-9])${word.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}(?![a-z0-9])`, "gi");
    for (const match of text.matchAll(pattern)) {
      const start = Math.max(0, (match.index ?? 0) - 40);
      hits.push({ word, context: text.slice(start, (match.index ?? 0) + word.length + 40).trim() });
    }
  }
  return hits;
}
```

```astro
---
// src/components/Claim.astro
import ledger from "../data/claims.yaml?raw";
import { loadClaims, claimById } from "../lib/claims";
const { id } = Astro.props as { id: string };
const claim = claimById(loadClaims(ledger), id);
---
<Fragment set:text={claim.text} />
```

```ts
// scripts/check-claims.ts
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadClaims, type Evidence } from "../src/lib/claims";
import { findBanned } from "../src/lib/banned";
import { SITE } from "../src/config/site";

const token = process.env.AGENTX_READ_TOKEN;
const headers = { Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };

async function resolves(evidence: Evidence): Promise<boolean> {
  const url = evidence.kind === "pr"
    ? `https://api.github.com/repos/${evidence.repo}/pulls/${evidence.number}`
    : `https://api.github.com/repos/${evidence.repo}/contents/${evidence.path}?ref=${SITE.docsRelease}`;
  const response = await fetch(url, { headers });
  if (!response.ok) return false;
  if (evidence.kind === "pr") return Boolean((await response.json()).merged_at);
  return true;
}

async function htmlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => entry.isDirectory() ? htmlFiles(join(dir, entry.name)) : Promise.resolve(entry.name.endsWith(".html") ? [join(dir, entry.name)] : [])));
  return nested.flat();
}

const problems: string[] = [];
for (const claim of loadClaims(await readFile("src/data/claims.yaml", "utf8"))) {
  if (claim.status !== "now") continue;
  for (const evidence of claim.evidence) if (!(await resolves(evidence))) problems.push(`claim ${claim.id}: evidence does not resolve: ${JSON.stringify(evidence)}`);
}
for (const file of await htmlFiles("dist")) {
  if (file.includes(`${join("dist", "docs", "agentx")}`)) continue; // synced product docs are checked in AgentX, not here
  for (const hit of findBanned(await readFile(file, "utf8"))) problems.push(`${file}: banned "${hit.word}" in "${hit.context}"`);
}
if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
console.log("claims check passed");
```

Note: the check skips synced AgentX docs because they document the product, not market it. Task 4 keeps those docs free of banned words anyway.

- [ ] **Step 5: Run the tests.** Run: `npx vitest run`. Expected: PASS.
- [ ] **Step 6: Commit.**

```bash
git add -A && git commit -m "feat: claims ledger, Claim component and copy checks"
```

### Task 4: Missing AgentX docs pages (FR-031), in the AgentX repository

**Files (AgentX repo):**
- Create: `docs/quickstart.md`, `docs/concepts.md`, `docs/security.md`, `docs/cli.md`, `docs/costs.md`, `docs/troubleshooting.md`
- Modify: `README.md` (link each new page from "Implementation documents")

**Interfaces:**
- Produces: six Markdown pages, each starting with one `# Title` line. Task 5 reads the title from it.

Each page is moved and edited from existing README text, not invented. Sources:

| Page | Source in README.md or code |
|---|---|
| `quickstart.md` | "Install AgentX in your AWS account" (the 12-step `agentx init` run, as of #148) and "Use AgentX" |
| `concepts.md` | "How AgentX is structured", "Working in a thread", "What a thread remembers", "Validate changes and create a pull request" |
| `security.md` | "Connector credentials", "Actions that need your confirmation", the permission-boundary section of `docs/architecture-production.md`, and a "What AgentX does not protect against" section taken from that section's documented limits |
| `cli.md` | `agentx --help` and each subcommand's `--help` output from a build of this commit, plus the exit-code paragraph |
| `costs.md` | the cost-estimate inputs in `packages/cli/src/init/plan.ts`, the `usage.json` fields in `packages/contracts/src/usage.ts`, and the model bake-off table in `specs/015-installer/spec.md` |
| `troubleshooting.md` | "Diagnostics" and the alarm guidance |

`docs/mcp-install.md` (from phase 25b) already exists and goes in the Connectors-and-tools group of the docs sidebar as-is.

- [ ] **Step 1:** Write the six pages from the sources above. Keep the README sections in place and link them to the new pages. Removing duplicated README text is a later cleanup.
- [ ] **Step 2:** Check that every relative link in `docs/` resolves:

```bash
grep -rho "](\(\.\./\)\?[^)#: ]*\.md" docs | sed 's/](//' | sort -u   # review each target exists
```

- [ ] **Step 3:** Check the docs contain none of the banned words (Global Constraints):

```bash
grep -rniE "10x|autonomous|ai engineer|teammate|swarm|software factory|mission control|open source|open-source|enterprise-grade|game-changing" docs || echo "clean"
```

Expected: `clean`.

- [ ] **Step 4:** Run `npm run lint && npm test` in the AgentX repo. Expected: PASS, since only docs changed.
- [ ] **Step 5:** Commit in AgentX with `docs: quickstart, concepts, security, CLI, costs and troubleshooting pages`.

### Task 5: Docs sync from the AgentX tag (FR-030, FR-031, FR-033)

**Files:**
- Create: `src/lib/docs.ts`, `scripts/sync-docs.ts`, `tests/docs.test.ts`
- Modify: `astro.config.mjs` (Starlight sidebar), `.gitignore` (add `src/content/docs/docs/agentx/`)

**Interfaces:**
- Consumes: `SITE.agentxRepo`, `SITE.docsRelease`.
- Produces:
  - `rewriteLink(href: string, fromPath: string, repo: string, tag: string): string`
  - `toStarlightPage(markdown: string, sourcePath: string, repo: string, tag: string): { slug: string; content: string }`
  - `slugFor(sourcePath: string): string`
  - Pages written under `src/content/docs/docs/agentx/`.

- [ ] **Step 1: Write the failing tests.**

```ts
// tests/docs.test.ts
import { describe, expect, it } from "vitest";
import { rewriteLink, slugFor, toStarlightPage } from "../src/lib/docs";

const repo = "PrepLabsAI/AgentX";
const tag = "v0.1.0";

describe("rewriteLink", () => {
  it("sends README anchors to GitHub at the tag", () => {
    expect(rewriteLink("../README.md#configure-codebuild-gates", "docs/project-configuration.md", repo, tag))
      .toBe("https://github.com/PrepLabsAI/AgentX/blob/v0.1.0/README.md#configure-codebuild-gates");
  });
  it("sends examples and source files to GitHub at the tag", () => {
    expect(rewriteLink("../examples/projects/", "docs/project-configuration.md", repo, tag))
      .toBe("https://github.com/PrepLabsAI/AgentX/tree/v0.1.0/examples/projects/");
    expect(rewriteLink("../packages/contracts/src/project.ts", "docs/project-configuration.md", repo, tag))
      .toBe("https://github.com/PrepLabsAI/AgentX/blob/v0.1.0/packages/contracts/src/project.ts");
  });
  it("turns sibling docs into site routes", () => {
    expect(rewriteLink("connectors/linear.md", "docs/project-configuration.md", repo, tag)).toBe("/docs/agentx/connectors/linear/");
    expect(rewriteLink("../openrouter.md#setup", "docs/connectors/jira.md", repo, tag)).toBe("/docs/agentx/openrouter/#setup");
  });
  it("leaves in-page anchors and absolute URLs alone", () => {
    expect(rewriteLink("#fields", "docs/cli.md", repo, tag)).toBe("#fields");
    expect(rewriteLink("https://example.com/x", "docs/cli.md", repo, tag)).toBe("https://example.com/x");
  });
});

describe("toStarlightPage", () => {
  it("moves the H1 into frontmatter and stamps the release", () => {
    const page = toStarlightPage("# Project configuration\n\nSee [Linear](connectors/linear.md).\n", "docs/project-configuration.md", repo, tag);
    expect(page.slug).toBe("project-configuration");
    expect(page.content).toBe("---\ntitle: Project configuration\ndescription: AgentX v0.1.0 documentation\n---\n\n> Documents AgentX v0.1.0.\n\nSee [Linear](/docs/agentx/connectors/linear/).\n");
  });
  it("refuses a page with no H1", () => {
    expect(() => toStarlightPage("no title\n", "docs/cli.md", repo, tag)).toThrow(/docs\/cli.md has no # title/);
  });
});

describe("slugFor", () => {
  it("keeps sub-folders", () => {
    expect(slugFor("docs/connectors/asana.md")).toBe("connectors/asana");
  });
});
```

- [ ] **Step 2: Run to verify they fail.** Run: `npx vitest run tests/docs.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.**

```ts
// src/lib/docs.ts
import { posix } from "node:path";

export function slugFor(sourcePath: string): string {
  return sourcePath.replace(/^docs\//, "").replace(/\.md$/, "");
}

export function rewriteLink(href: string, fromPath: string, repo: string, tag: string): string {
  if (/^[a-z]+:\/\//i.test(href) || href.startsWith("#") || href.startsWith("mailto:")) return href;
  const [path, anchor] = href.split("#", 2);
  const resolved = posix.normalize(posix.join(posix.dirname(fromPath), path));
  const hash = anchor ? `#${anchor}` : "";
  if (resolved.startsWith("docs/") && resolved.endsWith(".md")) return `/docs/agentx/${slugFor(resolved)}/${hash}`;
  const kind = path.endsWith("/") || !posix.extname(resolved) ? "tree" : "blob";
  const trailing = path.endsWith("/") ? "/" : "";
  return `https://github.com/${repo}/${kind}/${tag}/${resolved.replace(/\/$/, "")}${trailing}${hash}`;
}

export function toStarlightPage(markdown: string, sourcePath: string, repo: string, tag: string): { slug: string; content: string } {
  const match = /^# (.+)\n+/.exec(markdown);
  if (!match) throw new Error(`${sourcePath} has no # title`);
  const body = markdown.slice(match[0].length).replace(/\]\(([^)\s]+)\)/g, (_all, href: string) => `](${rewriteLink(href, sourcePath, repo, tag)})`);
  const content = `---\ntitle: ${match[1].trim()}\ndescription: AgentX ${tag} documentation\n---\n\n> Documents AgentX ${tag}.\n\n${body}`;
  return { slug: slugFor(sourcePath), content };
}
```

```ts
// scripts/sync-docs.ts
import { mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SITE } from "../src/config/site";
import { toStarlightPage } from "../src/lib/docs";

const token = process.env.AGENTX_READ_TOKEN;
const headers = { Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
const out = "src/content/docs/docs/agentx";

async function list(path: string): Promise<string[]> {
  const response = await fetch(`https://api.github.com/repos/${SITE.agentxRepo}/contents/${path}?ref=${SITE.docsRelease}`, { headers });
  if (!response.ok) throw new Error(`docs sync: ${path} at ${SITE.docsRelease} returned ${response.status}`);
  const entries = (await response.json()) as { type: string; path: string }[];
  const nested = await Promise.all(entries.map((entry) => entry.type === "dir" ? list(entry.path) : Promise.resolve(entry.path.endsWith(".md") ? [entry.path] : [])));
  return nested.flat();
}

await rm(out, { recursive: true, force: true });
const files = await list("docs");
if (files.length === 0) throw new Error("docs sync: no pages found");
for (const file of files) {
  const raw = await fetch(`https://api.github.com/repos/${SITE.agentxRepo}/contents/${file}?ref=${SITE.docsRelease}`, { headers: { ...headers, Accept: "application/vnd.github.raw" } });
  if (!raw.ok) throw new Error(`docs sync: ${file} returned ${raw.status}`);
  const page = toStarlightPage(await raw.text(), file, SITE.agentxRepo, SITE.docsRelease);
  const target = join(out, `${page.slug}.md`);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, page.content);
}
console.log(`synced ${files.length} docs pages from ${SITE.agentxRepo}@${SITE.docsRelease}`);
```

In `astro.config.mjs`, configure the Starlight sidebar groups:
- Start: `quickstart`
- Concepts: `concepts`, `project-configuration`
- Connectors: `autogenerate: { directory: "docs/agentx/connectors" }`
- Security: `security`
- Reference: `cli`, `costs`, `releases`, `openrouter`, `architecture-production`
- Help: `troubleshooting`

Starlight's built-in Pagefind search provides FR-033 with no extra code.

- [ ] **Step 4: Run tests.** Run: `npx vitest run`. Expected: PASS.
- [ ] **Step 5: Try a real sync** against the current AgentX branch. Temporarily set `docsRelease` to `docs/040-qedly-site` and run `AGENTX_READ_TOKEN=… npm run sync:docs`. Expected: "synced N docs pages". Restore the tag value afterwards.
- [ ] **Step 6: Commit** with `feat: sync AgentX docs from a release tag into Starlight`.

### Task 6: Receipts (FR-020, FR-022, FR-023, US4)

**Files:**
- Create: `src/lib/receipts.ts`, `scripts/fetch-receipts.ts`, `src/data/consent.yaml`, `tests/receipts.test.ts`, `tests/fixtures/receipts-fixture.json`
- Modify: `.gitignore` (add `src/data/receipts.json`)

**Interfaces:**
- Consumes: `SITE.siteRepo`, `SITE.qedlyCodeAppLogin`.
- Produces:
  - `type Gate = { name: string; status: string; seconds: number | null; url: string }`
  - `type Receipt = { number: number; title: string; url: string; commit: string; gates: Gate[]; requester: string; mergedBy: string; mergedAt: string; logsExpired: boolean }`
  - `toReceipt(pr: PullRequest, checkRuns: CheckRun[], consent: Record<string, string>): Receipt`
  - `keepQedlyCode(prs: PullRequest[], appLogin: string): PullRequest[]`
  - `mergeWithCache(fresh: Receipt[], cached: Receipt[]): Receipt[]`
  - `totals(receipts: Receipt[]): { prs: number; gatesRun: number; firstTimePasses: number }`
  - `src/data/receipts.json` (an array of `Receipt`, newest first).

- [ ] **Step 1: Write the failing tests.**

```ts
// tests/receipts.test.ts
import { describe, expect, it } from "vitest";
import { keepQedlyCode, mergeWithCache, toReceipt, totals, type PullRequest } from "../src/lib/receipts";

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  number: 7, title: "Add FAQ page", html_url: "https://github.com/qedly/qedly.github.io/pull/7",
  merged_at: "2026-10-02T10:00:00Z", merge_commit_sha: "abc123", head: { sha: "def456" },
  user: { login: "agentx-sdlc[bot]" }, merged_by: { login: "abhishek255" },
  body: "Adds the FAQ.\n\n---\nRequested in Slack thread https://slack.com/archives/C1/p1 by U0AAA, U0BBB.",
  ...over,
});

describe("keepQedlyCode", () => {
  it("keeps only merged PRs by the app", () => {
    const prs = [pr(), pr({ number: 8, user: { login: "abhishek255" } }), pr({ number: 9, merged_at: null }), pr({ number: 10, user: { login: "dependabot[bot]" } })];
    expect(keepQedlyCode(prs, "agentx-sdlc[bot]").map((entry) => entry.number)).toEqual([7]);
  });
});

describe("toReceipt", () => {
  const runs = [{ name: "agentx-qedly-site-build", conclusion: "success", started_at: "2026-10-02T09:50:00Z", completed_at: "2026-10-02T09:53:30Z", html_url: "https://github.com/r/1" }];
  it("shows a consented display name and never a raw Slack ID", () => {
    expect(toReceipt(pr(), runs, { U0AAA: "Pratik" }).requester).toBe("Pratik");
    expect(toReceipt(pr(), runs, {}).requester).toBe("a QEDly team member");
  });
  it("records each gate with its duration", () => {
    expect(toReceipt(pr(), runs, {}).gates).toEqual([{ name: "agentx-qedly-site-build", status: "success", seconds: 210, url: "https://github.com/r/1" }]);
  });
  it("uses the head commit, which is what the gates checked", () => {
    expect(toReceipt(pr(), runs, {}).commit).toBe("def456");
  });
});

describe("mergeWithCache", () => {
  it("keeps cached gates and marks logs expired when GitHub no longer returns check runs", () => {
    const cached = [{ number: 7, title: "t", url: "u", commit: "c", gates: [{ name: "g", status: "success", seconds: 5, url: "x" }], requester: "r", mergedBy: "m", mergedAt: "2026-10-02T10:00:00Z", logsExpired: false }];
    const fresh = [{ ...cached[0], gates: [] }];
    expect(mergeWithCache(fresh, cached)[0]).toMatchObject({ gates: cached[0].gates, logsExpired: true });
  });
});

describe("totals", () => {
  it("counts PRs, gates and first-time passes", () => {
    const receipt = { number: 1, title: "", url: "", commit: "", requester: "", mergedBy: "", mergedAt: "", logsExpired: false, gates: [{ name: "g", status: "success", seconds: 1, url: "" }] };
    expect(totals([receipt, { ...receipt, number: 2, gates: [{ name: "g", status: "failure", seconds: 1, url: "" }, { name: "g", status: "success", seconds: 1, url: "" }] }]))
      .toEqual({ prs: 2, gatesRun: 3, firstTimePasses: 1 });
  });
});
```

- [ ] **Step 2: Run to verify they fail.** Run: `npx vitest run tests/receipts.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.**

```ts
// src/lib/receipts.ts
export type PullRequest = {
  number: number; title: string; html_url: string; merged_at: string | null; merge_commit_sha: string | null;
  head: { sha: string }; user: { login: string }; merged_by: { login: string } | null; body: string | null;
};
export type CheckRun = { name: string; conclusion: string | null; started_at: string | null; completed_at: string | null; html_url: string };
export type Gate = { name: string; status: string; seconds: number | null; url: string };
export type Receipt = { number: number; title: string; url: string; commit: string; gates: Gate[]; requester: string; mergedBy: string; mergedAt: string; logsExpired: boolean };

export function keepQedlyCode(prs: PullRequest[], appLogin: string): PullRequest[] {
  return prs.filter((entry) => entry.merged_at && entry.user.login === appLogin);
}

function requesterOf(body: string | null, consent: Record<string, string>): string {
  const ids = /Requested in Slack thread \S+ by ([U0-9A-Z, ]+)\./.exec(body ?? "")?.[1]?.split(",").map((id) => id.trim()) ?? [];
  const named = ids.map((id) => consent[id]).filter((name): name is string => Boolean(name));
  return named.length ? named.join(", ") : "a QEDly team member";
}

export function toReceipt(pr: PullRequest, checkRuns: CheckRun[], consent: Record<string, string>): Receipt {
  const gates = checkRuns.map((run) => ({
    name: run.name,
    status: run.conclusion ?? "pending",
    seconds: run.started_at && run.completed_at ? Math.round((Date.parse(run.completed_at) - Date.parse(run.started_at)) / 1000) : null,
    url: run.html_url,
  }));
  return { number: pr.number, title: pr.title, url: pr.html_url, commit: pr.head.sha, gates, requester: requesterOf(pr.body, consent), mergedBy: pr.merged_by?.login ?? "unknown", mergedAt: pr.merged_at ?? "", logsExpired: false };
}

export function mergeWithCache(fresh: Receipt[], cached: Receipt[]): Receipt[] {
  const byNumber = new Map(cached.map((receipt) => [receipt.number, receipt]));
  return fresh.map((receipt) => {
    const old = byNumber.get(receipt.number);
    return receipt.gates.length === 0 && old && old.gates.length > 0 ? { ...receipt, gates: old.gates, logsExpired: true } : receipt;
  });
}

export function totals(receipts: Receipt[]): { prs: number; gatesRun: number; firstTimePasses: number } {
  return {
    prs: receipts.length,
    gatesRun: receipts.reduce((sum, receipt) => sum + receipt.gates.length, 0),
    firstTimePasses: receipts.filter((receipt) => receipt.gates.length > 0 && receipt.gates.every((gate) => gate.status === "success")).length,
  };
}
```

```ts
// scripts/fetch-receipts.ts
import { readFile, writeFile } from "node:fs/promises";
import { parse } from "yaml";
import { SITE } from "../src/config/site";
import { keepQedlyCode, mergeWithCache, toReceipt, type CheckRun, type PullRequest, type Receipt } from "../src/lib/receipts";

const token = process.env.SITE_READ_TOKEN;
const headers = { Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
const target = "src/data/receipts.json";
const allowEmpty = process.env.RECEIPTS_ALLOW_EMPTY === "1";

async function get<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`receipts: ${url} returned ${response.status}`);
  return response.json() as Promise<T>;
}

const cached: Receipt[] = await readFile(target, "utf8").then(JSON.parse).catch(() => []);
try {
  const prs: PullRequest[] = [];
  for (let page = 1; ; page += 1) {
    const batch = await get<PullRequest[]>(`https://api.github.com/repos/${SITE.siteRepo}/pulls?state=closed&per_page=100&page=${page}`);
    prs.push(...batch);
    if (batch.length < 100) break;
  }
  const consent = (parse(await readFile("src/data/consent.yaml", "utf8")) ?? {}) as Record<string, string>;
  const fresh: Receipt[] = [];
  for (const pr of keepQedlyCode(prs, SITE.qedlyCodeAppLogin)) {
    const runs = await get<{ check_runs: CheckRun[] }>(`https://api.github.com/repos/${SITE.siteRepo}/commits/${pr.head.sha}/check-runs`);
    fresh.push(toReceipt(pr, runs.check_runs, consent));
  }
  const receipts = mergeWithCache(fresh, cached).sort((a, b) => b.mergedAt.localeCompare(a.mergedAt));
  if (receipts.length === 0 && !allowEmpty) throw new Error("receipts: no QEDly Code PRs found; refusing to publish an empty Receipts page (set RECEIPTS_ALLOW_EMPTY=1 before launch)");
  await writeFile(target, JSON.stringify(receipts, null, 2));
  console.log(`wrote ${receipts.length} receipts`);
} catch (error) {
  if (cached.length === 0 && !allowEmpty) throw error;
  console.warn(`receipts: using ${cached.length} cached receipts: ${(error as Error).message}`);
  await writeFile(target, JSON.stringify(cached, null, 2));
}
```

`src/data/consent.yaml` starts empty (`{}`). Add a person only after they agree in writing.

- [ ] **Step 4: Run tests.** Run: `npx vitest run`. Expected: PASS.
- [ ] **Step 5: Commit** with `feat: receipts from the site's own QEDly Code pull requests`.

### Task 7: Layout, brand mark and Home (FR-001, FR-006, FR-007, FR-011, FR-023, FR-045)

**Files:**
- Create: `src/styles/tokens.css`, `src/layouts/Marketing.astro`, `src/components/QedMark.astro`, `src/components/Status.astro`, `src/components/SlackThread.astro`, `src/components/Receipt.astro`, `src/components/ReceiptTotals.astro`, `src/pages/index.astro`, `src/data/products.ts`, `tests/products.test.ts`
- Modify: `astro.config.mjs` (Starlight `customCss: ["./src/styles/tokens.css"]`, logo `public/brand/icon.svg`)

**Interfaces:**
- Consumes: Task 1 brand files; `SITE`, `STATUS_LABEL`; `<Claim>`; `receipts.json`, `totals`.
- Produces: `PRODUCTS: { name: string; job: string; status: Status; waitlist?: "workspace" | "cloud" }[]`; `Marketing` layout props `{ title: string; description: string; path: string; jsonLd?: object }`.

- [ ] **Step 1: Write the failing test** for product statuses (FR-005):

```ts
// tests/products.test.ts
import { describe, expect, it } from "vitest";
import { PRODUCTS } from "../src/data/products";

describe("products", () => {
  it("carries the spec's statuses exactly", () => {
    expect(PRODUCTS.map((product) => [product.name, product.status])).toEqual([
      ["QEDly Code", "now"], ["QEDly Checks", "now"], ["QEDly Workspace", "next"],
      ["QEDly Passport", "next"], ["QEDly Outcomes", "later"], ["QEDly Cloud", "later"],
    ]);
  });
  it("offers waitlists only for Workspace and Cloud", () => {
    expect(PRODUCTS.filter((product) => product.waitlist).map((product) => product.waitlist)).toEqual(["workspace", "cloud"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**, then implement `src/data/products.ts` using the "What it does" lines from the brand proposal's product table.

- [ ] **Step 3: Build the layout.** `Marketing.astro` renders:
  - `<meta name="robots" content={SITE.launched ? "index,follow" : "noindex,nofollow"}>`;
  - the canonical URL from `absoluteUrl(path)`;
  - Open Graph tags;
  - optional JSON-LD;
  - a header with the `wordmark.svg` logo, nav (QEDly Code, Security, Receipts, Roadmap, Docs, GitHub) and the action "Deploy QEDly Code" linking to `/docs/agentx/quickstart/`;
  - a footer carrying `SITE.licence` and the "Q-E-D-lee" line.

  Colour and type tokens go in `tokens.css`. Light values sit on `:root`, with dark overrides under `@media (prefers-color-scheme: dark)` and `[data-theme="dark"]`, which Starlight also uses, so docs and marketing share one theme.

- [ ] **Step 4: Build Home** in the Appendix A order, with copy verbatim from the copy deck. Every product fact comes from `<Claim id="…">`, never from typed text. The receipts section shows `ReceiptTotals` and the three newest `Receipt` entries. Each `Receipt` ends with the ∎ from `QedMark`.

- [ ] **Step 5: Check.** Run `npm test && npm run build` with `RECEIPTS_ALLOW_EMPTY=1`. Expected: PASS, including "claims check passed". Then open `dist/index.html` at 390 px and 1280 px widths and confirm the H1, subhead and both actions are visible without scrolling.

- [ ] **Step 6: Commit** with `feat: layout, brand mark and home page`.

### Task 8: QEDly Code, Security, Receipts, Manifesto, FAQ and About pages (FR-010, FR-012, US3)

**Files:**
- Create: `src/pages/code.astro`, `src/pages/security.astro`, `src/pages/receipts.astro`, `src/pages/manifesto.astro`, `src/pages/faq.astro`, `src/pages/about.astro`

**Interfaces:**
- Consumes: `Marketing`, `Claim`, `SlackThread`, `Receipt`, `ReceiptTotals`, `receipts.json`, `jsonLd` builders from Task 10 (write the page first and add JSON-LD in Task 10).

- [ ] **Step 1: QEDly Code.**
  - A `SlackThread` replay of the recorded site-channel thread, with members' consent: request, progress, gates, PR with ∎, follow-up.
  - Install steps linking to the quickstart.
  - The monthly infrastructure estimate that `agentx init` prints, labelled "Estimate from `agentx init`. Model tokens are extra."
- [ ] **Step 2: Security.** One section per control in US3 scenario 1, each built from a ledger claim. Then "What QEDly does not protect against", copied from AgentX `docs/security.md` at the docs tag. Do not rewrite it.
- [ ] **Step 3: Receipts.** "This website was built by QEDly Code." Totals, then every receipt newest first, each linking to its PR and gate logs, and marking "check log expired" when `logsExpired` is true.
- [ ] **Step 4: Manifesto, FAQ, About.**
  - Manifesto: "Show your work", with both founders' names at the end.
  - FAQ: the six questions from Appendix A item 9. Wrap any quoted competitor wording in `<q data-quote>`.
  - About: the story of the name from the brand proposal, and the founders.
- [ ] **Step 5: Check.** Run `npm test && RECEIPTS_ALLOW_EMPTY=1 npm run build`. Expected: PASS.
- [ ] **Step 6: Commit** with `feat: QEDly Code, Security, Receipts, Manifesto, FAQ and About pages`.

### Task 9: Roadmap and waitlist (FR-005, FR-044)

**Files:**
- Create: `src/pages/roadmap.astro`, `src/components/WaitlistForm.astro`, `src/lib/waitlist.ts`, `tests/waitlist.test.ts`

**Interfaces:**
- Produces: `waitlistAction(user: string): string` and `waitlistFields(email: string, tag: "workspace" | "cloud"): URLSearchParams`.

- [ ] **Step 1: Confirm Buttondown's current embed endpoint and tag field** in Buttondown's documentation, then fix the expected strings below to match it. The expected shape is `https://buttondown.com/api/emails/embed-subscribe/<user>` with fields `email` and `tag`.
- [ ] **Step 2: Write the failing test.**

```ts
// tests/waitlist.test.ts
import { describe, expect, it } from "vitest";
import { waitlistAction, waitlistFields } from "../src/lib/waitlist";

describe("waitlist", () => {
  it("posts to the PrepLabs Buttondown list", () => {
    expect(waitlistAction("qedly")).toBe("https://buttondown.com/api/emails/embed-subscribe/qedly");
  });
  it("tags the product the visitor chose", () => {
    expect(waitlistFields("a@b.co", "cloud").toString()).toBe("email=a%40b.co&tag=cloud");
  });
});
```

- [ ] **Step 3: Run to verify it fails, implement, run to pass.**

```ts
// src/lib/waitlist.ts
export function waitlistAction(user: string): string {
  return `https://buttondown.com/api/emails/embed-subscribe/${encodeURIComponent(user)}`;
}
export function waitlistFields(email: string, tag: "workspace" | "cloud"): URLSearchParams {
  return new URLSearchParams({ email, tag });
}
```

- [ ] **Step 4: Build the form.** `WaitlistForm.astro` renders an `<form>` with a labelled email input and a submit button. On submit, a small inline script does two things:
  - calls `fetch(waitlistAction(SITE.buttondownUser), { method: "POST", mode: "no-cors", body: waitlistFields(email, tag) })`;
  - then replaces the form with "Check your inbox to confirm your place on the waitlist."

  If `fetch` throws (offline), it shows "That didn't send. Check your connection and try again." and keeps the typed email. Without JavaScript, the form posts normally to Buttondown. No cookies are set by the site.
- [ ] **Step 5: Build Roadmap** from `PRODUCTS`, grouped Now, Next, Later, with a `WaitlistForm` under Workspace and Cloud.
- [ ] **Step 6: Commit** with `feat: roadmap and Buttondown waitlist`.

### Task 10: Discovery: sitemap, Open Graph, JSON-LD, llms.txt (FR-042, US5)

**Files:**
- Create: `src/lib/llms.ts`, `scripts/postbuild.ts`, `tests/llms.test.ts`
- Modify: `src/lib/seo.ts` (JSON-LD builders), `tests/seo.test.ts`, `astro.config.mjs` (add `@astrojs/sitemap`)

**Interfaces:**
- Produces:
  - `buildLlmsTxt(pages: { title: string; path: string; summary: string }[]): string`
  - `buildLlmsFull(pages: { title: string; markdown: string }[]): string`
  - `softwareApplicationLd(): object`
  - `faqLd(items: { q: string; a: string }[]): object`

- [ ] **Step 1: Write the failing tests.**

```ts
// tests/llms.test.ts
import { describe, expect, it } from "vitest";
import { buildLlmsTxt, buildLlmsFull } from "../src/lib/llms";

describe("llms.txt", () => {
  it("lists docs with absolute URLs from the site setting", () => {
    expect(buildLlmsTxt([{ title: "Quickstart", path: "/docs/agentx/quickstart/", summary: "Install AgentX." }]))
      .toBe("# QEDly\n\n> QEDly is where people and AI agents take work from a hunch to a proven result. QEDly Code is the first product.\n\n## Docs\n\n- [Quickstart](https://qedly.github.io/docs/agentx/quickstart.md): Install AgentX.\n");
  });
  it("bundles full docs in order", () => {
    expect(buildLlmsFull([{ title: "A", markdown: "one" }, { title: "B", markdown: "two" }])).toBe("# A\n\none\n\n# B\n\ntwo\n");
  });
});
```

Add to `tests/seo.test.ts`:

```ts
import { softwareApplicationLd, faqLd } from "../src/lib/seo";
it("describes QEDly Code as a SoftwareApplication at the site URL", () => {
  expect(softwareApplicationLd()).toMatchObject({ "@type": "SoftwareApplication", name: "QEDly Code", url: "https://qedly.github.io/code" });
});
it("builds FAQPage structured data", () => {
  expect(faqLd([{ q: "How do I say it?", a: "Q-E-D-lee." }])).toEqual({ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: [{ "@type": "Question", name: "How do I say it?", acceptedAnswer: { "@type": "Answer", text: "Q-E-D-lee." } }] });
});
```

- [ ] **Step 2: Run to verify they fail, then implement.**

```ts
// src/lib/llms.ts
import { absoluteUrl } from "../config/site";

export function buildLlmsTxt(pages: { title: string; path: string; summary: string }[]): string {
  const lines = pages.map((page) => `- [${page.title}](${absoluteUrl(page.path.replace(/\/$/, ".md"))}): ${page.summary}`);
  return `# QEDly\n\n> QEDly is where people and AI agents take work from a hunch to a proven result. QEDly Code is the first product.\n\n## Docs\n\n${lines.join("\n")}\n`;
}

export function buildLlmsFull(pages: { title: string; markdown: string }[]): string {
  return pages.map((page) => `# ${page.title}\n\n${page.markdown}\n`).join("\n");
}
```

```ts
// add to src/lib/seo.ts
import { absoluteUrl, SITE } from "../config/site";
export function softwareApplicationLd(): object {
  return { "@context": "https://schema.org", "@type": "SoftwareApplication", name: "QEDly Code", applicationCategory: "DeveloperApplication", operatingSystem: "AWS", url: absoluteUrl("/code"), license: SITE.licence };
}
export function faqLd(items: { q: string; a: string }[]): object {
  return { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: items.map((item) => ({ "@type": "Question", name: item.q, acceptedAnswer: { "@type": "Answer", text: item.a } })) };
}
```

`scripts/postbuild.ts` does four things:
1. Reads each file in `src/content/docs/docs/agentx/**/*.md`: the title from frontmatter, the summary from the first paragraph.
2. Copies each file to `dist/docs/agentx/<slug>.md` with the frontmatter removed.
3. Writes `dist/llms.txt` and `dist/llms-full.txt` from the two builders.
4. Writes `dist/robots.txt` from `robotsTxt(SITE.launched, absoluteUrl("/sitemap-index.xml"))`.

Pass `jsonLd={softwareApplicationLd()}` on `/code` and `jsonLd={faqLd(items)}` on `/faq`. The per-page Open Graph image uses `public/brand/og-template.svg`, rendered to PNG at build time. If the renderer adds weight, a static PNG per page is acceptable.

- [ ] **Step 3: Run tests and build.** Run `npm test && RECEIPTS_ALLOW_EMPTY=1 npm run build`. Expected: PASS. `dist/llms.txt`, `dist/robots.txt` (disallow all) and `dist/docs/agentx/quickstart.md` exist.
- [ ] **Step 4: Commit** with `feat: sitemap, structured data, llms.txt and Markdown docs copies`.

### Task 11: Deploy, the CodeBuild gate and Lighthouse (FR-020, FR-040, FR-041)

**Files:**
- Create: `.github/workflows/deploy.yml`, `buildspec.yml`, `lighthouserc.json`

- [ ] **Step 1: The deploy workflow.**

```yaml
# .github/workflows/deploy.yml
name: Deploy
on:
  push: { branches: [main] }
  workflow_dispatch:
permissions: { contents: read, pages: write, id-token: write, pull-requests: read, checks: read }
concurrency: { group: pages, cancel-in-progress: false }
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - uses: actions/cache@v4
        with: { path: src/data/receipts.json, key: receipts-${{ github.run_id }}, restore-keys: receipts- }
      - run: npm ci && npm test
      - run: npm run build
        env: { AGENTX_READ_TOKEN: "${{ secrets.AGENTX_READ_TOKEN }}", SITE_READ_TOKEN: "${{ secrets.GITHUB_TOKEN }}" }
      - uses: actions/upload-pages-artifact@v3
        with: { path: dist }
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment: { name: github-pages, url: "${{ steps.deployment.outputs.page_url }}" }
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 2: The gate.** The CodeBuild project `agentx-qedly-site-build` gets `AGENTX_READ_TOKEN` from Secrets Manager `qedly-site/agentx-readonly`. The receipts fetch there runs unauthenticated, which is enough for a public repository at gate frequency.

```yaml
# buildspec.yml
version: 0.2
env:
  secrets-manager:
    AGENTX_READ_TOKEN: qedly-site/agentx-readonly
phases:
  install:
    runtime-versions: { nodejs: 22 }
    commands: [npm ci]
  build:
    commands:
      - npm test
      - RECEIPTS_ALLOW_EMPTY=1 npm run build
      - npx lhci autorun
```

- [ ] **Step 3: Lighthouse thresholds.**

```json
{
  "ci": {
    "collect": { "staticDistDir": "dist", "url": ["/index.html", "/code/index.html", "/docs/agentx/quickstart/index.html"], "settings": { "preset": "desktop" } },
    "assert": { "assertions": { "categories:performance": ["error", { "minScore": 0.95 }], "categories:accessibility": ["error", { "minScore": 0.95 }], "categories:best-practices": ["error", { "minScore": 0.95 }], "categories:seo": ["error", { "minScore": 0.95 }] } }
  }
}
```

The SEO category penalises `noindex`. Before launch, the SEO assertion is expected to fail only on the "Page is blocked from indexing" audit. Add `"audits:is-crawlable": "off"` under `assertions` until `SITE.launched` is `true`, and remove that line in the launch PR. Run the mobile preset too: add a second `lighthouserc.mobile.json` with `"preset"` removed (mobile is the default), and run `npx lhci autorun --config=lighthouserc.mobile.json`.

- [ ] **Step 4: Verify.** Push to `main`. Expected:
  - the Deploy workflow succeeds;
  - `https://qedly.github.io` serves the home page with `noindex`;
  - the next QEDly Code PR shows the `agentx-qedly-site-build` gate on its commit.
- [ ] **Step 5: Commit** with `ci: deploy to GitHub Pages, CodeBuild gate and Lighthouse thresholds`.

### Task 12: Follow-ups in AgentX and the launch PR (FR-034, FR-051, FR-060)

**Files (AgentX repo):**
- Create: an issue and then `specs/043-qed-pr-footer/spec.md`
- Modify at launch: `README.md` (pointer); site `src/config/site.ts` (`launched: true`, `docsRelease` real tag), `lighthouserc.json` (remove the `is-crawlable` exemption)

- [ ] **Step 1: The ∎ PR footer as its own AgentX feature.** Open an issue with the spec 043 description. Today `slackAttributedBody` in `packages/broker/src/aws/broker.ts` appends "Requested in Slack thread … by …" when the publication starts, before gates run. The footer must list each gate's result on the exact commit, so it has to be written, or the PR body updated, in the publication callback after `assertCodeBuildGatesPassed`. The existing contract tests in `tests/contract/slack-control-plane.test.ts` (around line 1263) and `tests/contract/cloud-handlers.test.ts` (around line 560) pin the current body and must be updated in that feature's TDD cycle. Keep the product name out of the footer until the trademark clears. Use `∎ Checked: <gate> passed on <short sha>.`
- [ ] **Step 2: The launch PR**, opened only when FR-060 items 1-4 hold:
  1. Set `SITE.launched = true` and `SITE.docsRelease` to the first public tag.
  2. Remove the Lighthouse `is-crawlable` exemption.
  3. Add the FR-034 README pointer in AgentX: "AgentX is QEDly Code, the first product from [QEDly](https://qedly.github.io). Docs: [qedly.github.io/docs](https://qedly.github.io/docs/agentx/quickstart/)."
- [ ] **Step 3: Verify after merge.**
  - `curl -s https://qedly.github.io/robots.txt` shows `Allow: /`.
  - The home page has `index,follow`.
  - The Receipts totals show at least 20 PRs.
  - A random receipt matches GitHub.

---

## Self-review

- **Spec coverage:**
  - FR-001 and 011: Task 7.
  - FR-002, 003, 009 and 013: Task 3.
  - FR-004: Task 2.
  - FR-005: Tasks 2, 7 and 9.
  - FR-006 and 007: Tasks 1 and 7.
  - FR-008: Task 7 (copy verbatim from Appendix A).
  - FR-010 and 012: Task 8.
  - FR-020 and 021: Tasks 2 (step 7) and 11.
  - FR-022 and 023: Tasks 6 and 7.
  - FR-030 to 033: Tasks 4 and 5.
  - FR-032: already on branch `docs/040-qedly-site`.
  - FR-034 and 060: Task 12.
  - FR-040: Tasks 2 and 11.
  - FR-041: Task 11.
  - FR-042: Task 10.
  - FR-043: Task 9 (no cookies), plus no analytics at launch.
  - FR-044: Task 9.
  - FR-045: Task 7.
  - FR-050: Task 1.
  - FR-051: Task 12 (as its own spec).
  - US1 to US5: Tasks 7, 5 and 4, 8, 6 and 8, and 10 respectively.
  - SC-001 (the ten-second test with five readers) is a manual check after Task 7 and before launch. SC-006 needs Buttondown's subscriber count and GitHub referral traffic, both read by hand in the first month.
- **Types:** `Status`, `Claim`, `Evidence`, `Receipt`, `Gate`, `PullRequest` and `CheckRun` are defined once. Later tasks use the same names.
- **Placeholders:** Task 9 Step 1 asks to confirm Buttondown's endpoint against its documentation before the test is trusted. That is a verification step, not missing content.
