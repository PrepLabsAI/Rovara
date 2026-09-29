# Feature Specification: The QEDly website (qedly.github.io) and AgentX docs

**Feature Branch**: `docs/040-qedly-site`

**Created**: 2026-09-28

**Status**: Draft

**Input**: Owner request: "We need a URL, a website along with docs that serves as the pitch for customers and users (developers, SEO, CTOs and founders of startups), and a logo." Brand decided 2026-09-28: **QEDly**. AgentX launches as **QEDly Code**, the first QEDly product.

## Context

### The brand in one paragraph

QEDly (said "Q-E-D-lee", from Q.E.D., "which was to be shown") is the workspace where people and AI agents take a product bet from a hunch to a proven result. The line is **"From hunch to proof."** The enemy is orphaned work: output nobody can explain, trace to an approver, or show worked. AgentX is the first chapter, sold as **QEDly Code**. The site sells the whole vision and marks each product's real status. The brand proposal, with the strategy, naming history and architecture, is at https://claude.ai/artifact/B77e9bbASEhncb3Lu9iXnZ.

### What the research found (2026-09-28)

- **Customers.** About 1,500 Hacker News comments from 2025-26, plus Stack Overflow 2025, METR and DORA 2025, show the same pains:
  - review is now the bottleneck;
  - large unchecked AI PRs cause "review fatigue" and "rubber stamping";
  - agents fake passing tests ("you said to only check in when all the tests pass so I disabled testing");
  - people babysit agents and lose context;
  - nobody is clearly accountable ("IDK Claude did that");
  - bills arrive as a surprise;
  - code leaves the company.
  Only 3.1% of developers highly trust AI output, and 81.4% have security or privacy concerns about agents. What they want is "If a single test fails, no PR submissions allowed," a scoped agent identity with an audit trail, and limits enforced "at the harness layer rather than living in a prompt."
- **Competitors.** We read 20 competitor sites, including Devin, Factory, Cursor, Copilot and Agent HQ, Claude Code and Claude Tag, Codex, OpenHands, Warp, Fabro, Nisse, Omnigent, Herdr, Tembo, Ellipsis, CodeRabbit and Qodo.
  - They all sell autonomy, "works while you're away", "any agent", mission control, "@mention it in Slack" and "ship faster".
  - Every one of their stories ends at the pull request.
  - The words "accountable", "provenance" and "receipt" appear on none of them.
  - None leads with "your cloud".
  - The headlines that stand out admit a risk rather than boast. Only Warp publishes a unit cost.
- **Product truth.** An audit of `origin/mainline` at 9f1e839 (PR #144), refreshed at d7d214b after installer phase 15d2 (#148) and the MCP server phase 25b (#149), is summarised in the claims ledger (Appendix B). Only claims with evidence may be stated as current fact.

## Positioning

- **Big idea:** everyone else sells an agent that works. QEDly sells the proof that it did.
- **Signature device:** the **∎** (the end-of-proof "tombstone"). It ends every PR summary QEDly Code writes and every receipt on the site, and it is the brand mark. The site explains it once, in "What the little black square means".
- **Headline:** "Your AI agent says the tests pass. QEDly makes it prove it."
- **Voice:** precise, warm and a little dry. It admits risk before it promises anything. The manifesto is "Show your work."
- **Readers:**
  - The CTO or founder is afraid of an unexplained outage and a runaway bill. They get: who asked, who approved, what checked it, the cost per task, and that it runs in their account.
  - The tech lead is afraid of becoming a full-time reviewer. They get: only green PRs reach review, the thread remembers everything, and `@qedly stop` ends a runaway task.
  - The security lead is afraid of code leaving and of agents with broad access. They get: the agent never holds CodeBuild credentials, per-operation single-repository tokens, no force-push, and tool text cannot approve an action.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A CTO understands QEDly in ten seconds and finds proof (Priority: P1)

A startup CTO arrives from a link or a search. From the hero alone they can say what QEDly is and what makes it different. One scroll later they have seen a real receipt, and within two clicks they can deploy or join a waitlist.

**Why this priority**: the buyer decides whether the rest of the site gets read. If the hero fails, nothing else matters.

**Independent Test**: show the home page for ten seconds to five people who fit the profile, then ask what QEDly does and how it differs from other coding agents.

**Acceptance Scenarios**:

1. **Given** a first-time visitor on a laptop or phone, **When** the home page loads, **Then** the headline, subhead, the "Deploy QEDly Code" action and the "See the receipts" action are visible without scrolling.
2. **Given** the visitor scrolls once, **When** they reach the ∎ section, **Then** they see a real QEDly Code pull request summary with its gate results, requester and commit, linked to the public PR.
3. **Given** the visitor wants the wider vision, **When** they open Roadmap, **Then** each product shows its status (Now, Next, Later) and Workspace and Cloud offer a waitlist.

---

### User Story 2 - A developer goes from the README to a working install (Priority: P1)

A developer finds AgentX on GitHub or Hacker News. The README tells them AgentX is QEDly Code and links to qedly.github.io. The QEDly Code page and the quickstart take them from nothing to a working Slack bot.

**Why this priority**: developers are the adoption channel, and the source-available release is the launch.

**Independent Test**: a developer who has never seen AgentX follows only the site's quickstart and reaches a first Slack reply from their own deployment.

**Acceptance Scenarios**:

1. **Given** the AgentX README, **When** a developer reads its first screen, **Then** it says "AgentX is QEDly Code, the first product from QEDly" and links to `qedly.github.io/code` and `qedly.github.io/docs`.
2. **Given** the quickstart, **When** it is followed on a clean AWS account, **Then** every command, prerequisite and cost statement matches the released `agentx init`.
3. **Given** any docs page, **When** it is opened, **Then** it shows the release version it documents, and no link on it returns 404.

---

### User Story 3 - A security lead gets specifics, not adjectives (Priority: P2)

A platform or security lead opens the Security page to decide whether to veto. They find exactly what the agent can and cannot touch, where credentials live, what is logged, and what QEDly does not protect against.

**Why this priority**: this reader holds a veto, and an honest security page is how self-hosted tools earn trust.

**Independent Test**: a security engineer reads only the Security page and lists the controls. Each item they list maps to a row in the claims ledger.

**Acceptance Scenarios**:

1. **Given** the Security page, **When** it is read, **Then** it covers: the orchestrator's lack of code tools, workers without CodeBuild credentials, per-operation single-repository GitHub tokens, no force-push and no merge, the action gate that ignores tool output, KMS-signed worker invocations, the permission boundary and its documented limits, turn records and their retention, and the data that leaves the account (model inference through Bedrock).
2. **Given** the page's "What QEDly does not protect against" section, **When** it is compared with `docs/` and the permission-boundary limits, **Then** it states the same limits without softening them.

---

### User Story 4 - Anyone can inspect the receipts (Priority: P2)

A skeptic reads "This site was built by QEDly Code" and opens the Receipts page. It lists every pull request that QEDly Code opened on the site repository: the Slack request, the checks that ran on the exact commit, the result, and the human who merged it.

**Why this priority**: it turns our thinnest point (little public usage) into the strongest demonstration in the category.

**Independent Test**: pick any receipt at random, follow its link, and confirm on GitHub that the PR, commit and check runs match.

**Acceptance Scenarios**:

1. **Given** the site build, **When** it runs, **Then** it reads the site repository's merged PRs from the GitHub API and renders one receipt per PR authored by the QEDly Code GitHub App.
2. **Given** a receipt, **When** it is shown, **Then** it has the PR title and link, the commit, each gate with its status and duration, the merge time, and the merging human. The Slack requester is shown as a display name only if that person has consented; otherwise it reads "a QEDly team member".
3. **Given** a PR that a person wrote by hand, **When** the page renders, **Then** that PR is excluded, and the page counts receipts only from QEDly Code.

---

### User Story 5 - Search engines and AI assistants read the site well (Priority: P3)

People searching "self-hosted AI coding agent", "AI agent CI gates", "Claude Tag alternative" or "Devin alternative self-hosted", and AI assistants asked the same questions, find accurate QEDly pages.

**Why this priority**: it compounds after launch, but it does not block launch.

**Independent Test**: validate the sitemap, structured data and llms.txt, and fetch any docs page as Markdown.

**Acceptance Scenarios**:

1. **Given** any page, **When** it is fetched, **Then** it has a unique title and description, a canonical URL, an Open Graph image, and structured data where relevant (`SoftwareApplication` on QEDly Code, `FAQPage` on the FAQ).
2. **Given** `/llms.txt`, **When** it is fetched, **Then** it links to every docs page. Every docs page also has a `.md` copy, and `/llms-full.txt` bundles the docs for the current release.

### Edge Cases

- **The site is ready before the public release.** The site is deployed with `noindex` and is not announced until the launch gate (FR-060) passes.
- **A custom domain is added later.** If the owners later buy a domain such as qedly.com, it is set as the GitHub Pages custom domain. GitHub then redirects `qedly.github.io` to it, so existing links and search rankings carry over.
- **A documented feature changes after release.** The docs come from a release tag, so the site keeps documenting the release people can install until the next tag.
- **The GitHub API rate-limits the build.** The receipts step uses an authenticated token and caches the last good result. The build fails rather than publishing an empty Receipts page.
- **A receipt's check run was deleted by GitHub retention.** The receipt keeps the result recorded at build time and marks the link "check log expired".
- **A claim stops being true.** The claims ledger check (FR-013) fails the build.

## Requirements *(mandatory)*

### Messaging and claims

- **FR-001**: The home hero MUST read, in order: the H1 "Your AI agent says the tests pass. QEDly makes it prove it."; the subhead (Appendix A); the actions "Deploy QEDly Code" and "See the receipts"; and the line "Source-available · Runs in your AWS account · Amazon Bedrock".
- **FR-002**: Every factual statement about what QEDly Code does today MUST appear in the claims ledger (Appendix B) with its evidence. A statement about a planned product MUST carry that product's status label.
- **FR-003**: Copy MUST NOT use: "10x", "autonomous", "AI engineer", "AI employee", "teammate", "swarm", "army of agents", "software factory", "mission control", "production-ready in minutes", "game-changing", "enterprise-grade", or "open source" to describe AgentX or QEDly Code.
- **FR-004**: The licence MUST be described as "Source-available (FSL-1.1-ALv2). Every line is readable. Each release becomes Apache 2.0 two years after it ships." The phrase lives in one site setting, so a licence change touches one place.
- **FR-005**: Product status MUST use exactly three labels, shared by the Roadmap and every product mention: **Now** (QEDly Code, QEDly Checks), **Next** (Workspace, Passport), **Later** (Outcomes, Cloud).
- **FR-006**: The ∎ MUST appear as the brand mark in the header and favicon, at the end of every receipt, and in the section "What the little black square means". That section explains it in one paragraph.
- **FR-007**: The name MUST be written "QEDly" (QED in capitals) everywhere in copy, and the About page and the FAQ MUST say it is pronounced "Q-E-D-lee". The logo is "Box the answer": QED in a drawn box with "ly" outside (files in the site repository under `public/brand/`).
- **FR-008**: Limits MUST be stated as principles where true, and the principle wording in Appendix A is fixed: never merges ("A person does"), PRs only on request, Slack as the only surface ("It lives where your team already talks").
- **FR-009**: The site MUST NOT state usage volume, customer counts or productivity multiples. It MAY state specific, verifiable figures from the claims ledger.

### Pages at launch

- **FR-010**: Launch pages MUST be: Home, QEDly Code, Security, Receipts, Roadmap, Manifesto ("Show your work"), Docs, FAQ, and About (the story of the name and the founders). Compare pages and the blog MAY follow after launch.
- **FR-011**: Home MUST follow the section order in Appendix A.
- **FR-012**: QEDly Code MUST show a recorded or scripted Slack thread with the request, working progress, gates passing, a PR opened with its ∎ summary, and a follow-up in the same thread. It MUST also show the install path and the monthly infrastructure estimate that `agentx init` prints, labelled as an estimate that excludes model tokens.
- **FR-013**: The build MUST fail if a page contains a claim marked `current` in the ledger whose evidence reference no longer resolves, or if a banned word from FR-003 appears.

### Receipts and dogfooding

- **FR-020**: The site repository MUST be public, and it MUST be registered as an AgentX project with at least one CodeBuild gate that builds the site, runs the link check and runs the claims check.
- **FR-021**: Site changes after the initial scaffold SHOULD be made through QEDly Code from the site's Slack channel. A human MUST merge every PR.
- **FR-022**: The Receipts page MUST be generated at build time from the GitHub API. It MUST NOT be hand-edited. It shows per-receipt data (US4) and running totals: PRs, gates run, and gates passed on the first attempt.
- **FR-023**: The home "Receipts" section MUST show the running totals and the three most recent receipts.

### Docs

- **FR-030**: AgentX's `docs/` directory at a release tag is the source of truth. The site build MUST pull it at the tag named in one site setting, and every docs page MUST show that version.
- **FR-031**: The launch docs MUST contain: Quickstart (`agentx init`), Concepts (threads, workspaces, the orchestrator and workers, gates, PR lifecycle), Connectors (GitHub, Linear, Jira, Asana), Project configuration, Security, CLI reference, Costs and usage records, Releases, and Troubleshooting.
- **FR-032**: Before launch, the AgentX repository MUST:
  - replace "open source" with the licence wording from FR-004 in `README.md` and `docs/connectors/*.md`;
  - fix or remove README links to docs that do not exist (`docs/project-configuration.md`, `docs/architecture-deployed-demo.md`, `docs/validation/agentx-foundation.md`);
  - update stale statements (microVM storage, the classifier-model prompt in init).
  These fixes are in the same branch as this spec.
- **FR-034**: The launch PR MUST open the README with the QEDly Code pointer from US2. It is left out until then because it links to the site and names the brand before the trademark search clears.
- **FR-033**: Docs search MUST work offline in the static build.

### Build, hosting and discovery

- **FR-040**: The site MUST be a static Astro site with Starlight for the docs, in the public repository `qedly/qedly.github.io`, inside the GitHub organisation `qedly` (to be claimed). A GitHub Action publishes it to GitHub Pages at `https://qedly.github.io` with HTTPS enforced. Canonical URLs, the sitemap and Open Graph URLs MUST come from one site setting, so adding a custom domain later is a one-line change.
- **FR-041**: Pages MUST meet a Lighthouse score of at least 95 for performance, accessibility, best practices and SEO, on mobile and desktop.
- **FR-042**: The site MUST ship `sitemap.xml`, `robots.txt`, per-page Open Graph images, structured data (US5), `/llms.txt`, `/llms-full.txt`, and a `.md` copy of every docs page.
- **FR-043**: The site MUST set no cookies. If it measures traffic at launch, the measurement MUST be cookieless.
- **FR-044**: The waitlist forms for Workspace and Cloud MUST add the email to a Buttondown list owned by PrepLabs, tagged with the product the visitor chose. They MUST show a confirmation on the page and set no cookies on the site.
- **FR-045**: Themes MUST cover light and dark modes, and the docs and the marketing pages MUST share one theme.

### Brand assets

- **FR-050**: The logo system MUST be designed and approved before the site's visual build: the ∎ mark, the wordmark and the "Q.E.D." lock-up, the favicon and app icon at 16, 32 and 512 px, the PR summary footer, and the Open Graph template. Each is shown in light and dark.
- **FR-051**: QEDly Code's PR summaries MUST end with the ∎ footer (a separate AgentX change, tracked as its own issue) before the Receipts page ships.

### Launch gate

- **FR-060**: The site MUST stay `noindex` and unannounced until every one of these holds:
  1. The trademark search (UK, EU, US; classes 9 and 42) has cleared.
  2. The first public AgentX release exists: the CLI on npm (`@charterarc/agentx` or its renamed package), both images on ECR Public, and the repository public. On 2026-09-28 none of these exist: npm returns 404 and there are no version tags.
  3. FR-032 is merged and the FR-034 pointer is ready in the launch PR.
  4. The Receipts page lists at least 20 QEDly Code PRs.

### Key Entities

- **Claim**: one statement the site makes about the product. It has its text, a status (`current`, `next` or `later`), an evidence reference (file path, PR or measurement), and the pages that use it.
- **Receipt**: one merged PR from QEDly Code on the site repository. It has the title, link, commit, gates (name, status, duration), requester display name or placeholder, the merging human, and the merge time.
- **Product**: one QEDly product, with its name, one-line job and status label.
- **Docs release**: the AgentX release tag the docs are built from.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: At least 4 of 5 target readers (CTOs or founders of 20-200 engineer startups) can say what QEDly does and name one difference from other coding agents after ten seconds on the home page.
- **SC-002**: A developer new to AgentX reaches a first Slack reply from their own deployment by following only the site's docs, with no step missing or wrong.
- **SC-003**: The launch build contains zero claims marked `current` without evidence, zero banned words, and zero broken internal links. The build checks enforce all three.
- **SC-004**: Lighthouse scores at least 95 in all four categories on the home, QEDly Code and one docs page, on mobile and desktop.
- **SC-005**: At launch, the Receipts page lists at least 20 QEDly Code PRs, each linked to a public PR whose checks match the receipt.
- **SC-006**: In the first 30 days after launch, the site records waitlist signups for Workspace and Cloud, and referrals from the AgentX repository, so the team can judge whether the funnel works. There is no target yet; the first month sets the baseline.

## Assumptions

- The site launches at `qedly.github.io` with no custom domain (owner decision, 2026-09-28). The owners claim the GitHub organisation `qedly` and the npm name `qedly`. qedly.com was listed at $100 on Spaceship on 2026-09-28; the owners accept that someone else may buy it. This spec does not buy or register anything.
- The site lives in its own public repository, because receipts must be clickable by anyone while the AgentX repository is private. Docs stay in the AgentX repository, so they change in the same PR as the code.
- GitHub Pages hosting is free for a public repository. Cloudflare Pages remains an option if per-PR previews become necessary.
- The open-source repository keeps the AgentX name at launch, with the QEDly Code pointer. Whether to rename the repository and CLI is a separate owners' decision.
- The home-page Slack demo uses a real recorded thread from the site's own channel, with members' consent.

## Out of Scope

- Compare pages, blog, changelog feed, pricing page, and the QEDly Cloud product.
- Renaming the `agentx` CLI, npm package or repository.
- Any feature work in AgentX other than FR-032 and the ∎ PR footer (FR-051).

## Appendix A: Home page copy deck

1. **Hero**
   - H1: "Your AI agent says the tests pass. QEDly makes it prove it."
   - Subhead: "QEDly is where people and AI agents take work from a hunch in Slack to a proven result. Every change is checked on the exact commit, approved by a person, and kept on the record. It starts today with QEDly Code, running in your own AWS account."
   - Actions: "Deploy QEDly Code", "See the receipts".
   - Line: "Source-available · Runs in your AWS account · Amazon Bedrock".
2. **What the little black square means.** "Mathematicians end a proof with ∎. Every pull request QEDly Code opens ends with one too: the checks it passed on that exact commit, who asked for it, and the thread where it started." A real PR summary is shown underneath.
3. **A thread, start to finish.** The Slack demo: request, progress, gates, PR, follow-up.
4. **Three things QEDly Code will never do.**
   - "Grade its own homework. Checks run in your CodeBuild, on the exact commit, where the agent has no credentials."
   - "Merge. It opens the pull request when you ask. A person merges it."
   - "Take orders from a ticket. Text inside an issue can't approve an action; only the people in the thread can."
5. **Receipts.** "This website was built by QEDly Code." Running totals and the three latest receipts.
6. **For the people who sign off.**
   - "Every thread gets its own isolated, persistent machine in your AWS account."
   - "Every coding task records its tokens and estimated cost."
   - "Every reply that used a tool has an audit view."
   - "Destructive actions always ask first."
7. **Code is the first chapter.** Workspace, Passport, Outcomes and Cloud with their status labels, and the waitlist.
8. **Show your work.** An excerpt of the manifesto, signed by both founders.
9. **FAQ.** Questions answered:
   - What does QEDly mean and how do I say it?
   - What does source-available mean?
   - What does it cost to run?
   - Which models does it use?
   - Does my code leave my account?
   - How is it different from Claude Tag, Devin or Copilot's coding agent?
10. **Install.** The install command again, and the footer.

## Appendix B: Claims ledger (current claims, evidence at `origin/mainline` d7d214b, refreshed 2026-09-29)

| Claim (site wording) | Evidence |
|---|---|
| Ask in Slack; no developer machine has to stay online. | README §3; PR #16 |
| Every thread gets its own isolated, persistent machine in your AWS account. | PRs #89-#97, #134; `docs/architecture-production.md` |
| A fresh machine is ready in about two minutes, and an idle one resumes in about the same. | PR #105 (2 min 13 s prepare, 2 min 15 s resume); PR #94 |
| Idle machines stop after five minutes; the files and the conversation stay. | PRs #95, #105 |
| Follow-ups in the thread see the earlier discussion and the earlier edits. | PR #30; README "What a thread remembers" |
| The orchestrator cannot read, edit or run your code; only an isolated worker can. | `packages/orchestrator/src/orchestrator.ts`; README l.26-31; constitution principle I |
| Checks run in your CodeBuild on the exact commit, and the agent holds no CodeBuild credentials. | `packages/broker/src/codebuild.ts` (`sourceVersion: input.commit`); spec 004 FR-006, FR-008 |
| No pull request is created or moved until every configured gate passes. | `packages/broker/src/aws/broker.ts` `assertCodeBuildGatesPassed`; spec 004 FR-010, FR-011 |
| GitHub tokens are minted per operation and limited to one repository. | README l.773; `packages/broker/src/github-app.ts` |
| It never force-pushes and never merges. | README l.776-778 |
| Text inside an issue can't approve an action; destructive actions always ask. | README l.486-498; PRs #56, #63, #64 |
| Every coding task records its tokens and estimated cost. | PR #28; `packages/contracts/src/usage.ts` |
| Every reply that used a tool has an audit view. | PRs #44, #65 |
| Anyone in the channel can stop a running task. | PR #142 (live check pending: verify before launch) |
| Runs your repository's own devcontainer. | PRs #125, #132 |
| A task that repeats the same failing call stops itself. | PR #130; spec 033 |
| One command sets up the whole deployment and shows a cost estimate first. | PRs #98, #73, #139; `packages/cli/src/init/plan.ts` |
| Setup ends when someone mentions the bot in the new channel and gets a threaded reply: the admin user, first project, connectors, alerts and monthly budget are part of the same run. | PR #148; README "Install AgentX in your AWS account" steps 8-12 |
| Hand a task to QEDly Code from Claude Code, Codex or Cursor, and follow it to a pull request. | PR #149; `docs/mcp-install.md`; spec 025 (verify live before launch) |
| Developers sign in with Slack or their company's sign-in, with no AWS credentials. | PR #143; README "Install AgentX in your AWS account" |
| Model choice is measured: in our 65-case test, run three times, Claude Sonnet 4.6 passed 58 of 65 at about $0.025 per turn. | `specs/015-installer/spec.md` l.527-536 |
| GitHub, Linear, Jira and Asana, from the thread. | `packages/gateway/src/{github,linear,jira,asana}.ts` |

Claims that are NOT current and may appear only with a status label:
- OpenRouter in production: merged but not verified live, so it is not on the hero line.
- `agentx destroy`.
- The Workspace, Passport, Outcomes and Cloud products.
