# Administration client and projects

Installing the `agentx` executable, registering a project, binding its Slack channel, and the full command surface.

## 1. Install the administration client

Developers work in Slack, or from their AI tool through `agentx mcp`. They can also sign in from
their own machines (`agentx login <url>`, `agentx whoami`, `agentx workspaces`) to see which
projects they can use and what is running in them. Everything else the `agentx` executable does is
administration: installing, upgrading and removing environments, registering projects, binding
Slack channels, choosing how developers sign in, and stopping idle workspaces.

Rovara requires Node.js 22.19 or newer (Node 22 LTS recommended):

```sh
npm ci
npm run build
(cd packages/cli && npm link)
agentx --help
```

If you do not want a global link, replace `agentx` in the examples below with
`npm run agentx --`.

## 2. Register a project and bind its Slack channel

For an environment installed with `agentx init`, pass `--env <name>` to each command below and
skip the deployment file: `init` already wrote that environment's settings. The deployment file is
for the maintainers' own `production` deployment.

Two files configure the administration client. One describes the deployment, at
`~/.agentx/deployment.yaml`, and serves every project:

```yaml
controlPlaneUrl: https://agentx.example.test
auth:
  issuer: https://identity.example.test
  clientId: agentx-client
  audience: agentx-api
```

The other describes a product, at `~/.agentx/projects/<project-name>.yaml`, selected with
`--project`. It holds the repositories, setup steps, readiness checks, CodeBuild gates and
orchestrator instructions, and no workspace ID, session ID, token or repository secret. It no
longer carries `schemaVersion`, `controlPlaneUrl`, `auth` or `environment.image`: the first three
moved to the deployment file, and the worker image is pinned by the release, not by the project.
Registering a file that still has them fails with those field names. In an installed
environment, `agentx project add` writes this file for you. See
[project configuration](project-configuration.md) and the illustrative files in
[`examples/deployment.yaml`](../examples/deployment.yaml) and
[`examples/projects/`](../examples/projects/).

Log in as an administrator, register the immutable revision, then bind the project's channel. For
an environment installed with `agentx init`, add `--env <name>` to each command:

```sh
agentx login --callback-port 8765

agentx admin project register \
  --file "$HOME/.agentx/projects/payments.yaml" \
  --deployment-mode ec2-ebs \
  --launch-template-id <Ec2WorkerLaunchTemplateId> \
  --subnets <Ec2WorkerSubnets>

agentx --project payments admin slack bind --team T0123456789 --channel C0123456789
```

`login` performs OIDC Authorization Code + PKCE, opens the managed login page, receives the
callback at `http://127.0.0.1:8765/callback`, and stores the token in the operating-system
credential store. It must be an account carrying the configured administrator claim, such as
membership in the Cognito `agentx-admin` group. Opening the bare Cognito domain directly is not a
login flow and can return `{"message":"Missing Authentication Token"}`; always start login through
the client. AWS credentials are needed only for deployment, never for these commands.

Project revisions and runtime bindings are immutable. Increment the YAML `revision` before
registering a changed repository, setup or readiness definition. The channel binding names
only the project, so a newly registered revision reaches every new thread without binding again.

For a private GitHub repository, set its `credentialRef` to the GitHub App credential reference
configured on the control plane (the maintainers' deployment uses `github-agentx-sdlc`; in an
installed environment, `project add` fills in its own). The YAML still contains no private key or
installation token.

An administrator can release a thread workspace's idle compute without losing its files:

```sh
agentx admin workspace stop --workspace <workspace-id>
```

An administrator can also stop any workspace's running coding task. The task ends CANCELLED and the
workspace takes the next request:

```sh
agentx admin workspace cancel --workspace <workspace-id>
```

An administrator can also switch a task that a developer shared from an AI tool between view only
and continue, within the project's `developerTasks` settings:

```sh
agentx --env <name> admin task share-mode --task <task-id> --mode view|continue
```

Run `agentx --help` or `agentx <command> --help` for the complete surface: `init`, `deploy`,
`upgrade`, `config list|get|set`, `doctor`, `destroy`, `env list|use|adopt`,
`signin show|enable|disable|check`, `project add`, `channel add`,
`connector add linear|jira|asana|mcp`, `alerts test`, `login`, `logout`, `whoami`, `workspaces`,
`mcp`, `mcp install`, `admin project register`, `admin workspace cancel|stop`,
`admin slack bind|unbind`, `admin credential register|authorize|list`, `admin turns export`, and
`admin task share-mode`. Developer commands are `login <url>`, `whoami`, `workspaces`, `logout`,
`mcp` and `mcp install`. Coding work happens in Slack, or in a developer's AI tool through
`agentx mcp`.

A command's exit code names the kind of failure: 2 for invalid input, 3 when login is required, 4
for forbidden or not found, 5 when the workspace is busy or not ready, 6 when the control plane is
unavailable, 7 for any other Rovara error, and 1 for an unexpected internal error. `agentx doctor`
exits 2 when any check fails.
