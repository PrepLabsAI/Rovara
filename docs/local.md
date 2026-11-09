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
- A worker's callbacks do not come here. They arrive with `Host: host.docker.internal:<port>`, which this server's Host check
  refuses on purpose. They have a listener of their own (see "The callback listener").

## Worker machines (`WorkerMachines`)

### Docker (`docker`)

One container per machine key, named `rovara-worker-<24 hex>` (a hash of company and key), from the worker image. It follows the
EC2 boot script (`packages/worker/ec2/boot.sh`); the differences are on purpose:

| | EC2 | Local Docker |
| --- | --- | --- |
| Worker port | host network, private subnet | the worker publishes nothing; its gateway container publishes it on `127.0.0.1:<random>` only |
| Worker container | Docker defaults | `--cap-drop ALL`, `--security-opt no-new-privileges`, `--pids-limit 4096`, user `1000:1000`, optional `--memory`/`--cpus`, log rotation |
| Docker socket | mounted, `--group-add` the socket's group | **not mounted in the worker.** A socket guard container holds it and the worker reaches the guard over TCP (`DOCKER_HOST`); see "What a worker can reach" |
| Network | host network; `boot.sh` walls sandbox bridges off from the host and the private ranges; a DNS firewall allows the default list plus the project's websites | the worker and its sandboxes are on internal Docker networks with no route and no host address; their one way out is the machine's gateway container, which applies the same list; see below |
| Task commands | sandbox containers: no capabilities, no new privileges, only the workspace mounted (`task-sandbox.ts`) | the same containers, started by the worker through the guard (which rebuilds each one to those rules); `AGENTX_TASK_SHELL` is never set and a spec cannot set it |
| Invocations | KMS-signed token | ES256 token signed with `invoke-key.pem`; the worker checks it for its own workspace, operation and fence, within 60 s |

### What a worker can reach (lane L4b)

Task code is a repository's code, so a local worker is built as if it were hostile. A machine is five containers' worth of walls:

```
 your computer ──127.0.0.1:random──▶ gateway ─(external bridge)─▶ the internet, allow-listed names only
                                      │   │
                  worker network ─────┘   └───── sandbox network
              (internal, no host address)     (internal, no host address)
                worker   socket guard           the task sandboxes (and no one else)
                  │          │ holds /var/run/docker.sock
                  └─ DOCKER_HOST=tcp://rovara-sock:2375
```

- **Two internal networks.** `--internal` removes the route out, and `com.docker.network.bridge.inhibit_ipv4` removes the bridge's
  own address. Without that option a container on an internal network still reaches every service the host (or, on Docker Desktop
  and Colima, the VM) listens on at a wildcard address, through the bridge's gateway address; we saw the VM's sshd answer from an
  internal network. With it, a container reaches only the containers on its own network. Your computer's loopback, your LAN, the
  cloud metadata address and the other workers' networks have no path at all. This needs Docker 23 or newer; an older daemon makes
  a start fail rather than start unwalled. A start also checks a network of that name is as made and replaces it if not.
- **The gateway** (`isolation/egress-gateway-source.ts`, one per machine) is the way out. It is the name server of both networks and
  answers only the allowed names (the default list of a cloud install, `DEFAULT_AGENT_ALLOW_DOMAINS`, without the cloud network's
  own names, plus `allowedDomains` you pass); every other name is NXDOMAIN, as the cloud's DNS firewall does. Port 443 is forwarded by the
  server name in the TLS hello and port 80 by each request's `Host`; the gateway resolves the name itself and connects only to a public
  address (no loopback, private, link-local, shared, metadata, multicast or reserved address; one bad answer refuses the name), so DNS
  rebinding and an address in a hello do nothing. Other ports (ssh, databases) do not leave. A wildcard entry covers subdomains at
  any depth and not the bare domain. As in the cloud, an allowed name is allowed for everything behind it: `*.amazonaws.com` includes
  anyone's bucket, `github.com` includes anyone's repository, and a CDN can host a different site on the same address as an allowed one.
- **The socket guard** (`isolation/docker-socket-guard-source.ts`, one per machine) is the only container that holds the socket. It lets
  the worker create, start, stop, kill, restart, inspect, read the logs of, run commands in (as the sandbox user, never privileged) and
  remove its own sandboxes, and inspect its own image and sandbox network. It never forwards what the worker sent: it checks every
  field and builds the body it passes on from nothing, under Docker's exact field names (Docker's JSON decoder ignores case and lets
  a later key win, so a name that is not exactly one the guard knows is refused). A sandbox is the worker's image, user 1000, the
  workspace as the only mount (plus tmpfs masks inside it, never executable), the sandbox network and name server, with
  `CapDrop: ["ALL"]`, no-new-privileges, no privileged mode and a process and memory limit forced on it (4096 and 4 GiB when the
  worker names none), and the guard's own labels; "own" is a label the guard puts on every container it creates, which the worker
  cannot set or remove. Host namespaces, devices, ports, links, added hosts, sysctls and every other setting are refused. A command's
  input and output travel over an upgraded connection; the guard reads the start body itself, sends the daemon a request of its own
  making and passes bytes on only after the daemon has answered `101`, so nothing a worker pipelines behind a start ever reaches the
  daemon. Creates are made one at a time, so the limit of 16 sandboxes holds. Everything else is refused: other containers (yours
  included), images, pulls, builds, volumes, networks, events, info, prune, copy. So a project's devcontainer, test services and the
  setup run (which need those) do not work locally yet.
- **The worker never sees the socket**, so `~/.rovara`, `~/.ssh` and the rest of your home folder are not one `docker run -v` away. The
  worker's `sweepWorkspaceContainers` (which removes every other container before a push) also finds no socket and skips; with the raw
  socket on a daemon you share with your own containers it would have removed all of them.

What is still reachable, on purpose or not: the internet by allowed name (above); on Linux the gateway, which has an ordinary bridge to
reach the internet, sits on a bridge whose gateway address is the host, so a gateway bug could reach host services bound to a wildcard
address (the gateway is about 450 lines, runs as an unprivileged user with no capability, a read-only root, IP forwarding off and a 512 MiB limit, and
each of its services answers only peers of the one network it was opened for);
the Docker daemon itself acts on the guard's requests, so a daemon bug is still a bug; and anything an allowed site serves.

#### The callback listener

A worker reports back to the broker (`/v1/internal/workspaces/<id>/operations/<id>/...`). It does not call the owner's server. The
broker serves a second listener (`callback-server.ts`) that answers only `POST /v1/internal/...` for `Host: host.docker.internal:<port>`
and never a browser; the worker's own gateway relays to it, and only the paths the worker calls and only for the worker's own workspace
id. On macOS and Windows (Docker Desktop, Colima) the listener is on `127.0.0.1`: Docker carries `host.docker.internal` to the computer's
loopback, and only the gateway (on an ordinary bridge, never the worker or a sandbox) can use it. On Linux `host.docker.internal` is the
bridge's address, where a loopback listener is not reachable, so the broker also serves a Unix socket in the 0700 `~/.rovara/run`
folder that is mounted read-only into the gateway; nothing listens on any network address and the broker is not open to the LAN. The
gateway tries the socket first and the loopback port second.

- `start` is idempotent on the key and wakes a stopped container. It refuses an image reference that could be a Docker flag, a key
  or environment name that is not plain, and more than 4 running workers (`maxConcurrentMachines`).
- The environment goes in a `0600` file passed with `--env-file`, deleted right after `docker create` (a crash's leftovers are swept
  after a minute); it is never in the argument list. A spec cannot override the names the worker sets itself
  (`AGENTX_WORKSPACE_ID`, `AGENTX_INVOKE_PUBLIC_KEY`, `AGENTX_CONTROL_PLANE_URL`, `AGENTX_SANDBOX_NETWORK`, `AGENTX_TASK_SHELL`, `PATH`, `HOME`, ...) or use
  `NODE_*`, `LD_*`, `DYLD_*` or `DOCKER_*` names (they decide how the worker loads code and where its Docker calls go), and values with line breaks are refused. Labels
  cannot use the `rovara.`, `agentx.` or `com.docker.` prefixes. The `docker` program itself sees only PATH, HOME, DOCKER_*, XDG_*,
  SSH_AUTH_SOCK, not your keys.
- Each container carries the state folder it belongs to, a digest of its image, environment, website list and callback port, and (the
  worker) a random session generation. Starting a key whose digest differs (a restart of `rovara up` on a new port, a new image) removes
  the worker, its gateway and its guard and makes them again, keeping the workspace folder, so callbacks never go to an old address and a
  token for an earlier container is refused. A stopped machine is woken only when its helpers are as made and the gateway came back on
  the addresses the worker and guard were given; otherwise it is rebuilt. The running workers of another state folder are never counted
  or stopped. A start that fails halfway removes what it made.
- Starts are serialized in this process, and waking a stopped worker obeys the same limit as a new one.
- `health` reads `docker inspect` and the worker's `/ping`: `starting` until it answers (up to 2 minutes), then `unhealthy`; `ready`
  or `busy` by its active count; `stopped` after a clean stop; `unhealthy` after a crash exit; `terminated` when the container is gone.
- `deliver` refuses a job for another workspace than the machine's, a job over 1 MiB, and a machine that is not ready; it maps the
  worker's answers to `unauthorized`, `rejected`, `unavailable`.
- `stop` keeps the containers, networks and workspace; `terminate` removes the worker, gateway and guard, then its task sandboxes (found
  by the guard's owner label), its three networks, then the workspace folder, and stops with an error, keeping the folder, if Docker cannot confirm either removal. On a Linux
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

### Model calls: the worker holds no key (lane L9a, provisional until Pratik agrees, owner decision 58)

The broker serves a small model proxy on the same callback listener (`packages/broker/src/local/model-proxy/`). A worker is given the proxy's
address (`AGENTX_MODEL_PROXY_URL`, an address, not a secret) and asks the broker for a token with its callback capability
(`GET /v1/internal/model-access`). The token lasts 15 minutes, is good for one workspace and one operation, and names the models the broker chose for
that operation. The worker sends its model calls to `<proxy>/v1/messages`, `/v1/responses` or `/v1/chat/completions` with the token where a key would
go; the proxy reads the real key from the `model-keys` port (the environment, then `keys.json`), calls Anthropic, OpenAI or OpenRouter, passes the
answer back, and records what it used through the `metering` port. The egress gateway relays only those three routes and the token request, stamps
the worker's own workspace on each, and removes any such header the worker sent, so a token taken from one worker is refused from another.

- The key is never in the worker's environment, in a log, in an event or in an answer. A provider's error text is shortened and scrubbed before
  the worker sees it, and an answer that contains the key is cut off. A spec's environment may not carry a model key, a provider's address or
  AWS credentials (`DockerWorkerMachines` refuses them).
- A task budget is held in the proxy, and held before the money is spent: with a price table (`metering` adapter) and a budget on the operation's grant, each call's
  worst case is reserved against the budget before the call is forwarded, in the same step as the check, and settled to what the call really used afterwards. The
  worst case is the call's output limit (64,000 tokens when it names none) plus an input of ONE token to each byte of the request (no tokenizer produces more tokens
  than bytes; capped at 2,000,000 tokens, since a request of base64 pictures is far bigger in bytes than in tokens). That is a high bound on purpose: it can refuse a
  call a little earlier than the real cost would, never later. Parallel calls therefore cannot get past the budget or the per-operation cap (8 calls). A call that
  does not fit beside the calls running now but would fit alone is answered 429 with `Retry-After: 2` (`budget_held`), and its reservation is tried again when the
  worker retries; a budget that is spent, or that cannot pay for the call even alone, is answered with the 422 `budget_exceeded` the worker reads as "the task's
  budget is spent". A call that did not finish cleanly (the worker cut it off, the stream broke, the time ran out) or whose provider reported no usage is charged that
  worst case. A model with no price, or priced in another currency than the budget, cannot be held to the budget and is refused. Code's default price table is
  empty, so a budget needs a price table first.
- Each operation may have three live tokens (minting a fourth ends the oldest). Only the worker's own function tools are served: a tool the provider would run
  (web search, code execution, MCP, computer use, file search) is refused, as it is in Cloud's guard, and so is a `tool_choice` that names one.
- A spec's environment may not carry a model key, a provider's address, any `AWS_*` name except `AWS_REGION` and `AWS_DEFAULT_REGION` (not secret; the setup agent reads them), or a proxy variable (`HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, `NO_PROXY`).
- Budgets are kept in memory, per operation: a restarted broker starts every operation's spend at zero, and a new operation of the same task starts at zero too, so the
  task flow must pass the task's REMAINING budget in the grant it describes (not its full budget). A spend record is freed when the proxy sees its operation has ended
  (`modelProxy.operationEnded(operationId)`, which the task flow calls when an operation settles, frees it at once). Both budget limits are remaining gaps until a
  durable ledger exists.
- Tool definitions are checked wherever they travel: the top-level `tools`, lists nested in Responses `input` items, Anthropic `messages` and `system` (a `tool_addition` may
  only hold a `tool_definition`), and `include` on the Responses route may only be `reasoning.encrypted_content`. These are Cloud's guard rules (`rovara-guard.ts`, fix/0512-guard-tool-types) case for case.

Wiring checklist for the task flow (nothing below happens until it is wired): pass `modelGrants` (`capabilityModelGrants`) to `startLocalRuntime`; list `"model-access"` in the
dispatch capability's `extraActions`; put `localRoute(...).workerRoute` in the invocation payload as `modelRoute`; give the grant the task's REMAINING budget; call
`runtime.modelProxy.operationEnded(operationId)` when an operation settles; give the folder object storage a folder on a local disk (it needs hard links, and says so with
`FolderHardLinksUnsupportedError` when the file system has none).
- Not here: Bedrock (it needs the computer's AWS sign-in; list it in the 51 gaps) and design-review key slots.
- The task flow turns it on: its dispatch lists the `model-access` action in the worker's capability and gives `startLocalRuntime` a
  `modelGrants` source (`capabilityModelGrants`) that says which models and what budget an operation has (`localRoute` makes a model's route).

## Not in this lane

See the report of lane L4 for the list with file and line. In short: the published worker image, the SQLite store and queue, and the task flow and pages. Devcontainers,
test services and the setup run need Docker calls the guard refuses; they are not available locally until each is given a place in
the guard's rules.

## Tests

- `tests/unit/local-*.test.ts`, `tests/unit/up-cli.test.ts`: simulated Docker and worker (`tests/support/local/fake-docker.ts`). The
  simulated worker checks tokens with the real `invoke-auth.ts`.
- `tests/integration/local-docker-worker-machines.test.ts`: the same conformance suite against real Docker and a real worker image.
  `ROVARA_LOCAL_DOCKER_IMAGE=<image> vitest run tests/integration/local-docker-worker-machines.test.ts`. It is skipped without
  Docker or the variable, and removes every container and folder it makes.
- `tests/unit/local-isolation.test.ts`: the allow-list, and the gateway and the guard programs driven as libraries (the same text that
  runs in the containers).
- `tests/integration/local-sandbox-isolation.test.ts` (same variable, and an image with `node`, `curl` and `docker`): a malicious
  repository's view. From inside a sandbox, and inside the worker, it tries your loopback and LAN services, the broker, another
  worker, the metadata address, and every way to ask Docker for more than a sandbox, and checks each is refused, and that allowed sites,
  the worker's callbacks and its own sandboxes work.
