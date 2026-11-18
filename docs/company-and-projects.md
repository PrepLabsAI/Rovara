# Companies and projects

This guide describes company and project actions available through the Rovara Code API and CLI.

These steps work once your Rovara administrator sets `COMPANY_SIGNIN=enabled`. Until then, the API reports that a feature is not available yet.
<!-- Source: packages/broker/src/aws/broker.ts; packages/broker/src/aws/developer-identity.ts. -->

## Sign in with GitHub

If your Rovara administrator enables GitHub sign-in with `agentx signin enable github`, choose GitHub on the company sign-in page. GitHub sign-in also requires `COMPANY_SIGNIN=enabled`. To join a company, use a company invite or have an owner or admin pre-approve your verified GitHub email. Signing in with GitHub does not connect a GitHub organization or select repositories; see the GitHub connection steps below.
<!-- Source: packages/cli/src/signin/commands.ts; packages/broker/src/developer/providers.ts; packages/broker/src/aws/developer-routes.ts; PrepLabsAI/Rovara#831; PrepLabsAI/Rovara#834; PrepLabsAI/Rovara#846. -->

## Create or join a company

A Rovara administrator can create a single-use company invite code with `agentx admin company-invite create`. Sign in, then use the code with `POST /v1/dev/company` to create a company. After the company is created, sign in again to enter it.
<!-- Source: packages/cli/src/main.ts; packages/broker/src/developer/company-invites.ts; packages/broker/src/aws/developer-routes.ts; PrepLabsAI/Rovara#823. -->

A live company owner or admin can pre-approve a teammate as a member. The invite link works once. The owner or admin chooses how long it lasts, from 1 to 720 hours. A teammate uses the link to sign in and join; invites cannot directly grant the admin role during the pilot.
<!-- Source: packages/broker/src/aws/developer-routes.ts; packages/broker/src/developer/company-invites.ts; PrepLabsAI/Rovara#829. -->

## Connect GitHub and create projects

A company owner or admin can connect GitHub through the API. For a GitHub User installation, the person claiming the connection must use the same GitHub account. For a GitHub Organization installation, the person must be an active organization admin.
<!-- Source: packages/broker/src/github-connect-routes.ts; PrepLabsAI/Rovara#830; PrepLabsAI/Rovara#832. -->

Project creation is available to a company owner or admin once GitHub is connected. A Rovara administrator (the person who runs your Rovara installation) can create projects too. A project can include several repositories, or you can create one project per repository. Above 8 selected repositories, Rovara preselects separate projects. You can select at most 32 repositories at a time. Company-created project names are unique within that company.
<!-- Source: packages/broker/src/aws/developer-routes.ts; packages/broker/src/repo-choice.ts; PrepLabsAI/Rovara#837; PrepLabsAI/Rovara#847; PrepLabsAI/Rovara#849. -->

## Add Rovara to Slack and link a channel

A company owner or admin adds Rovara to a Slack workspace through the company Slack API. Then an owner, admin, or admin of a project can link that project to a channel in the connected workspace. If Rovara is not in a private channel, invite it there and check the link again. Linking a different channel replaces the project's current channel; unlinking affects new work, while already-running threads continue.
<!-- Source: packages/broker/src/aws/slack-company-install.ts; packages/broker/src/aws/slack-channel-link.ts; PrepLabsAI/Rovara#865; PrepLabsAI/Rovara#866. -->

## Roles and membership

- **Owner:** can make or change owners, manage members, connect GitHub, create projects, change the company AI model and disconnect GitHub when no project still uses it.
- **Admin:** can manage members, connect GitHub, create projects, and change the company AI model. An admin cannot change an owner's role.
- **Member:** can read the company AI model and use projects they have access to.
- **Project admin:** can administer the project they were granted access to, including archiving and restoring it.

Only an owner can make or change an owner's role. Nobody can change their own role, and at least one company owner must remain. Changing a role or removing a member requires a fresh confirmation. A regular project user can preview archive or restore but cannot apply the change.
<!-- Source: packages/broker/src/company-member-routes.ts; PrepLabsAI/Rovara#830; PrepLabsAI/Rovara#832; PrepLabsAI/Rovara#835; PrepLabsAI/Rovara#839. -->

## Archive and restore

Use the project lifecycle API to preview an archive or restore before confirming it. Archiving stops new work and stops a running task at its next round. It deletes nothing. Restore makes the project available for new work again. A company owner or admin, or that project's admin, can apply either action. Archiving is not available yet for a company whose tasks have not moved to Rovara's new task engine.
<!-- Source: packages/broker/src/project-lifecycle-routes.ts; PrepLabsAI/Rovara#839. -->

## Company AI model and spending limits

Any company member can read the company's AI model. An owner or admin can choose a model from the offered list. If the company does not choose one, Rovara uses the default for the installation. If a chosen model is no longer offered, new tasks are refused until an owner or admin chooses another.
<!-- Source: packages/broker/src/company-engine-model-routes.ts; PrepLabsAI/Rovara#835. -->

Rovara stores a per-task limit on a project when a project admin saves one, but tasks do not use that setting yet. If your company has set a per-task cap, a project limit cannot be higher than it. The Code API does not provide a company monthly spending limit.
<!-- Source: packages/broker/src/aws/project-settings.ts; packages/broker/src/core/cost/limits.ts; PrepLabsAI/Rovara#835. -->
