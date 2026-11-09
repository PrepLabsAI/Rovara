# Running Rovara on your own computer (`rovara up`)

`rovara up` runs Rovara as ONE local Node process: an HTTP server on `127.0.0.1`, the plug-in registry behind it, and a Docker
container for each task's worker. There is no cloud account, no Slack and no GitHub App. This page is the skeleton (lane L4): the
process, the registry wiring, the Docker worker machines and the doctor. The task flow, the pages and the SQLite store come from
later lanes and plug into what is here.

## Quick start

```sh
rovara up --check     # Docker, the worker image, a model key, GitHub access and the port; each problem comes with its fix
rovara up             # starts on a free port of 127.0.0.1 and prints it; Ctrl-C stops it
```

`rovara up --check` starts nothing and writes nothing. `rovara up` runs the same checks without the GitHub round trip and prints
what is wrong as `note:` lines; it still starts, because Docker is needed only when a task starts.

You need:

| What | How |
| --- | --- |
| Docker | Docker Desktop, or Colima (`brew install colima docker && colima start`). Set `DOCKER_HOST` if the socket is elsewhere. |
| The worker image | `docker build -f environments/base/Dockerfile -t rovara-worker:local .` from a Rovara checkout. Another image: `--worker-image <ref>` or `ROVARA_WORKER_IMAGE`. (No image is published yet.) |
| A model key | `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`, `OPENROUTER_API_KEY`) in the environment, or `~/.rovara/keys.json`. |
| GitHub access | `gh auth login`, or `GH_TOKEN` / `GITHUB_TOKEN`, or `{"github": "<token>"}` in `keys.json`. The first one found wins, in the order key file, environment, `gh` (asked for github.com's token by name). The check sends the token to api.github.com only. |

## What lives in `~/.rovara`

The folder is mode `0700` (anything wider is refused, not repaired) and must belong to you. It must not lie inside the folder you
are standing in or inside a git work tree below your home folder: a repository can carry a `.rovara/` with a config in it, and a
config can run code. `workspaces/` is held to the same rule. Every file in it is opened once with `O_NOFOLLOW` and checked and read through that
one handle; a link, a file owned by someone else, or a wrong mode is refused, and no error quotes the file's content.

| File | Mode | What |
| --- | --- | --- |
| `config.json` | 0600 | The plug-in config (`version: 1`, see `docs/ports.md`). Made on first run with no plug-ins. Must not be writable by others. |
| `keys.json` | 0600 (required) | `{"anthropic": "...", "github": "..."}`. Refused if group or others can read it (`chmod 600`). The environment wins over the file. |
| `session-token` | 0600 | A new random token each start. The login for the local API: `Authorization: Bearer <token>`. |
| `invoke-key.pem` | 0600 | The P-256 key that signs invocations to workers. Kept, so workers that outlive a restart still accept the new process. |
| `workspaces/<id>/` | 0777 under a 0700 parent | One folder per worker machine. See "Workspaces". Tasks write here, so nothing in it is ever read as a config or a plug-in. |

`--state-dir <path>` moves all of it.

## One company, one owner

Code runs as one implicit company (`IMPLICIT_COMPANY_ID`, decision 45.6) and the machine's owner is its identity and its approver
(45.3), through W0's `registerCodeDefaults`: the `local-owner` identity (a valid session is the token above), the `local-owner`
approvers, allow-all admission, no audit sink, and price-table metering with an empty table (usage is recorded as unknown, never
guessed). The company id can be set in the config (`companyId`).

## The registry and the config

Start-up order, and why it matters:

1. The state folder is checked; the config is read from the state folder (or from the path you typed with `--config`).
2. Code's defaults and the built-in adapters are registered: in-memory `storage` and `queue` (defaults), and on `worker-machines`:
   `docker` and `this-machine`.
3. The config's plug-ins are loaded in order. A configured `storage` or `queue` **replaces** the in-memory default; that is how the
   SQLite lane plugs in:
   ```json
   { "version": 1, "plugins": [
     { "point": "storage", "name": "sqlite", "module": "@rovara/plugin-sqlite", "settings": { "path": "state.db" } },
     { "point": "queue", "name": "sqlite", "module": "@rovara/plugin-sqlite" } ] }
   ```
4. `registry.seal()`. After this only `channel` adapters can change, so a plug-in cannot swap the identity or the approvers.
5. The server starts.

**The config is owner-controlled.** Naming a module runs its code with your rights. So it is read only from `~/.rovara` or from a path
you typed, never searched for, and a path inside the folder you are standing in (a repository, a pull request's files) or inside
`workspaces/` is refused. A `./` module must be a file you own that others cannot write, and not under `workspaces/`.
Module names follow `docs/ports.md`: a package name or a `./` path that stays inside the config's folder, never a Node built-in, a URL
or an absolute path.

## The HTTP server

- Binds to `127.0.0.1` only (never a wildcard), on a free random port unless `--port` is given; it checks the bound address.
- Accepts only a loopback peer, a `Host` of `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding), and no foreign `Origin`.
- `GET` and `POST` only; bodies up to 1 MiB; no CORS.
- `GET /healthz` is open and says only `ok` and the version. `GET /v1/local/status` (login required) lists the company and which
  adapter is registered at each plug-in point. Every other `/v1/...` route is the public broker handler (`createBrokerHandler`) over
  in-memory registries, behind the same login (the owner counts as an administrator, so `POST /v1/admin/projects` works; the state is
  in memory only). Its per-project memberships are empty, so the other project routes answer "not found" until the task-flow lane
  gives the owner membership.
- A worker's callbacks arrive with `Host: host.docker.internal:<port>`, which the Host check refuses. Callbacks are lane L6's design
  (a separate listener, or a callback-only allowance); this lane does not serve them.

## Worker machines (`WorkerMachines`)

### Docker (`docker`)

One container per machine key, named `rovara-worker-<24 hex>` (a hash of company and key), from the worker image. It follows the
EC2 boot script (`packages/worker/ec2/boot.sh`); the differences are on purpose:

| | EC2 | Local Docker |
| --- | --- | --- |
| Worker port | host network, private subnet | published on `127.0.0.1:<random>` only (`--publish 127.0.0.1::8080`) |
| Worker container | Docker defaults | `--cap-drop ALL`, `--security-opt no-new-privileges`, `--pids-limit 4096`, user `1000:1000`, optional `--memory`/`--cpus`, log rotation |
| Docker socket | mounted, `--group-add` the socket's group | mounted, group read from the socket by a one-off `stat` in the worker image |
| Task commands | sandbox containers: no capabilities, no new privileges, only the workspace mounted (`task-sandbox.ts`) | the same containers, started by the worker; `AGENTX_TASK_SHELL` is never set and a spec cannot set it. **The network is weaker, see below.** |
| Invocations | KMS-signed token | ES256 token signed with `invoke-key.pem`; the worker checks it for its own workspace, operation and fence, within 60 s |

The worker holds the Docker socket so that it can start the sandboxes, as on EC2. On Linux that is root-equivalent on the host; on Docker
Desktop or Colima it is root inside the VM, and the VM shares your home folder, so a compromised worker could also read
`~/.rovara/keys.json`, `invoke-key.pem` and `~/.ssh`. Task commands themselves run in the sandboxes, not in the worker.

**The sandbox network is weaker than EC2's.** On EC2 `boot.sh` (`wall_off_containers`) blocks the sandbox bridge from 127.0.0.0/8,
the private ranges and the host. Nothing does that here: the worker makes the plain `agentx-task` bridge, shared by every local worker.
A task's commands therefore have the internet and also your computer's loopback services (databases, admin pages, this very server,
other workers' published ports) and your home network, and sandboxes of different workspaces can reach each other. Treat a local
task's code as having your network. A per-worker network behind a firewall or an allow-listing proxy needs a worker change and is the
next step before tasks run through this adapter (an open decision for both owners).

- `start` is idempotent on the key and wakes a stopped container. It refuses an image reference that could be a Docker flag, a key
  or environment name that is not plain, and more than 4 running workers (`maxConcurrentMachines`).
- The environment goes in a `0600` file passed with `--env-file`, deleted right after `docker create` (a crash's leftovers are swept
  after a minute); it is never in the argument list. A spec cannot override the names the worker sets itself
  (`AGENTX_WORKSPACE_ID`, `AGENTX_INVOKE_PUBLIC_KEY`, `AGENTX_CONTROL_PLANE_URL`, `AGENTX_TASK_SHELL`, `PATH`, `HOME`, ...) or use
  `NODE_*`, `LD_*`, `DYLD_*` or `DOCKER_*` names (the worker holds the socket), and values with line breaks are refused. Labels
  cannot use the `rovara.`, `agentx.` or `com.docker.` prefixes. The `docker` program itself sees only PATH, HOME, DOCKER_*, XDG_*,
  SSH_AUTH_SOCK, not your keys.
- Each container carries the state folder it belongs to, a digest of its image, environment and callback address, and a random session
  generation. Starting a key whose container has a different digest (a restart of `rovara up` on a new port, a new image) removes and
  re-creates it, keeping the workspace folder, so callbacks never go to an old address and a token for an earlier container is
  refused. The running workers of another state folder are never counted or stopped.
- Starts are serialized in this process, and waking a stopped worker obeys the same limit as a new one.
- `health` reads `docker inspect` and the worker's `/ping`: `starting` until it answers (up to 2 minutes), then `unhealthy`; `ready`
  or `busy` by its active count; `stopped` after a clean stop; `unhealthy` after a crash exit; `terminated` when the container is gone.
- `deliver` refuses a job for another workspace than the machine's, a job over 1 MiB, and a machine that is not ready; it maps the
  worker's answers to `unauthorized`, `rejected`, `unavailable`.
- `stop` keeps the container and the workspace; `terminate` removes the container, then its task sandboxes (found by the workspace
  label), then the workspace folder, and stops with an error, keeping the folder, if Docker cannot confirm either removal. On a Linux
  host whose user is not 1000 the folder's files belong to the worker's user; removing them fails with a message and they must be
  removed by hand.
- `rovara up` stops the running workers on Ctrl-C and keeps their workspaces.

#### Workspaces

`~/.rovara/workspaces/<24 hex>` is mounted into the worker at the **same path** (the sandboxes it starts through the socket mount it
by path). The worker runs as user 1000, so the folder is mode `0777`; its parent is `0700`, so no other user on the machine reaches it.
On a Linux host whose user is not 1000 that is why the folder needs the open mode. On Docker Desktop and Colima only folders under
your home are shared with the VM, which is where the state folder is.

### This machine (`this-machine`)

A stub. Running the worker beside the broker with no container gives task commands your files and accounts, so it is refused unless
you start with `rovara up --this-machine`; even then it is not built, and every call says so.

## Not in this lane

See the report of lane L4 for the list with file and line. In short: how the model key reaches the worker (the adapter takes a
non-secret `environment` only), the broker's callback listener (workers call `http://host.docker.internal:<port>`, which a loopback
bind does not serve on Linux), the published worker image, the SQLite store and queue, and the task flow and pages.

## Tests

- `tests/unit/local-*.test.ts`, `tests/unit/up-cli.test.ts`: simulated Docker and worker (`tests/support/local/fake-docker.ts`). The
  simulated worker checks tokens with the real `invoke-auth.ts`.
- `tests/integration/local-docker-worker-machines.test.ts`: the same conformance suite against real Docker and a real worker image.
  `ROVARA_LOCAL_DOCKER_IMAGE=<image> vitest run tests/integration/local-docker-worker-machines.test.ts`. It is skipped without
  Docker or the variable, and removes every container and folder it makes.
