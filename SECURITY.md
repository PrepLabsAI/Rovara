# Security policy

AgentX runs in your own AWS account and holds credentials for your GitHub, Slack and connectors,
so we treat security reports as our first priority.

## Reporting a vulnerability

Please report a vulnerability privately. Do not open a public issue, pull request or discussion
for it.

- **Preferred:** use GitHub's private reporting. On this repository, open the **Security** tab and
  choose **Report a vulnerability**.
- **Or email:** abhishek2551996@gmail.com and ps06756@gmail.com (both, so one of us sees it).

Please include:

- what an attacker can do, and what they need first (for example, a Slack member in a bound
  channel, a signed-in developer, or access to the AWS account);
- the steps to reproduce it, against the version you tested (`agentx --version`);
- any logs or output, with tokens, secrets and message text removed.

## What happens next

- We aim to reply within a week. We are a small team; if you have not heard back, email us again.
- We confirm or rule out the problem, and tell you how we plan to fix it.
- We fix it in a new release and publish a security advisory that credits you, unless you ask us
  not to.
- Please give us a reasonable time to release a fix before you disclose it publicly. We will agree
  a date with you.

## Supported versions

We fix security problems in the latest release. Upgrade with `agentx --env <name> upgrade`; see
[Running AgentX](docs/day-two.md).

## Scope

In scope: this repository's code, including the CLI, the control plane, the Slack service, the
coding worker, the MCP server, the CloudFormation templates and the release artifacts built from
this repository.

Out of scope:

- the limits AgentX already documents in
  [What AgentX does not protect against](docs/security.md#what-agentx-does-not-protect-against);
- vulnerabilities in AWS, Slack, GitHub, model providers or other third-party services themselves;
- problems that need the AWS account's administrator credentials, which already control the whole
  installation.

If you are unsure whether something is in scope, report it privately anyway.
