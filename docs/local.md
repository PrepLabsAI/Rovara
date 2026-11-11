# Running Rovara on your own computer (`rovara up`)

`rovara up` runs Rovara as ONE local Node process: an HTTP server on `127.0.0.1`, the plug-in registry behind it, and a Docker
container for each task's worker. There is no cloud account, no Slack and no GitHub App. This page is the skeleton (lane L4): the
process, the registry wiring, the Docker worker machines and the doctor. Lane L9-wire (below) joins the SQLite store, the task flow, the
sessions, the decisions and the review pages onto it.

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
| A model key | `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`, `OPENROUTER_API_KEY`) in the environment, or `~/.rovara/keys.json`. One OpenRouter key is enough: see "Choosing the model" below. |
| GitHub access | `gh auth login`, or `GH_TOKEN` / `GITHUB_TOKEN`, or `{"github": "<token>"}` in `keys.json`. The first one found wins, in the order key file, environment, `gh` (asked for github.com's token by name). The check sends the token to api.github.com only. The sign-in belongs to the GitHub code host adapter (`resolveCredentials`, `checkAccess`), and `rovara up` registers that adapter as the `code-host` named `github` when it finds one. A `code-host/github` entry in the config replaces it. |

## What lives in `~/.rovara`

The folder is mode `0700` (anything wider is refused, not repaired) and must belong to you. It must not lie inside the folder you
are standing in or inside a git work tree below your home folder: a repository can carry a `.rovara/` with a config in it, and a
config can run code. `workspaces/` is held to the same rule. Every file in it is opened once with `O_NOFOLLOW` and checked and read through that
one handle; a link, a file owned by someone else, or a wrong mode is refused, and no error quotes the file's content.

| File | Mode | What |
| --- | --- | --- |
| `config.json` | 0600 | The plug-in config (`version: 1`, see `docs/ports.md`). Made on first run with no plug-ins. Must not be writable by others. |
| `keys.json` | 0600 (required) | `{"anthropic": "...", "github": "..."}`. Refused if group or others can read it (`chmod 600`). The environment wins over the file. Model keys and the stored GitHub token are read from it through the `secrets` point (`docs/ports.md`). |
| `company-instructions.md` | 0600 (not writable by others) | Optional. The company's standing rules, one bullet each under `## Required` or `## Preferred` (read fresh at every step; its SHA-256 is the rules' version). See `docs/ports.md`, "Company instructions". |
| `audit.db` | 0600 | The append-only, hash-chained copy of the committed audit rows (SQLite; rows cannot be changed or removed; the primary record is the `AUDIT#` rows in `state.db`). See `docs/ports.md`, "Audit trail". |
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
2. Code's defaults and the built-in adapters are registered: SQLite `storage` and `queue` in `~/.rovara/state.db` (defaults; a test can pass `storage: "memory"`), and on
   `worker-machines`: `docker` and `this-machine`.
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
  adapter is registered at each plug-in point. The owner's task, project and session routes are lane L9-wire's (below); any other
  `/v1/...` route is still the older public broker handler (`createBrokerHandler`) over in-memory registries, behind the same login,
  and its per-project memberships are empty.
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

## The task flow on `rovara up` (lane L9-wire)

`rovara up` now runs the wave-1 lanes as one process. Everything below is `packages/broker/src/local/app/`; the lanes it joins know the
ports and not each other, and this is the only place that knows all of them.

| What | Where it comes from |
| --- | --- |
| Records and queue | one SQLite file, `~/.rovara/state.db` (lane L3's adapters, registered as the `storage` and `queue` defaults; a configured plug-in replaces them and must keep the task flow's indexes, `TASK_FLOW_INDEXES`, and set `ttlAttribute` to `indexExpiresAt`, the attribute the records expire by) |
| Task flow | lane L6a over the registry's `storage`, `queue`, `worker-machines`, `admission` and `audit-sink`; a timer (2 s) relays the outbox, dispatches to the worker machine, and sweeps the dispatch rows |
| Sessions | lane L6b; the session is created in the task's own start transaction (`startExtras`), kept current by the store's change feed, and swept on the same timer |
| Decisions | lane L6b's approval gate over the task's workflow document; a plan is approved only with a proof a local page signs for that one request, revision and digest |
| Pages | lane L8's server on its own port (`runtime.pagesUrl`); a page address carries the owner's page session and can approve, so it never leaves the server process: `rovara open [task]` asks the running server to open the page in your browser (`POST /v1/local/pages/open`, which answers `{ opened: true }` and nothing else), and `rovara up` prints only the pages' origin |
| Worker callbacks | `app/callbacks.ts` on the callback listener: events, artifacts, the terminal result, and the repository credential exchange |
| Merge tracking | lane L12 (`app/tracking.ts`): a timer polls the due tracking rows and calls the core's `reconcileTrackingTask`; see "Merge tracking by polling" below |
| Owner routes | `/v1/dev/projects`, `/v1/admin/projects`, `/v1/dev/tasks...` and `/v1/app/sessions...`, behind the session token (the routes the MCP tools and the CLI's `session` commands call); `/v1/app/script-tokens...` (see "Script tokens"); a request with a script token is checked first and reaches only its own closed list |

**Choosing the model (lane L13).** A task step calls one model, chosen by one rule (`chooseLocalModel`, used by the task flow and by `rovara up --check`):

1. The `model` setting in `~/.rovara/config.json` wins, if the key for its provider is there:
   ```json
   { "version": 1, "plugins": [], "model": { "provider": "openrouter", "id": "anthropic/claude-sonnet-4.6" } }
   ```
   `provider` is `anthropic`, `openai`, `openrouter` or the name of a `model-provider` plug-in (see "Model providers" below); `id` is the model as that provider lists it (for OpenRouter, `vendor/model`).
   A provider that speaks several formats takes an optional `"api"` (`anthropic-messages`, `openai-completions` or `openai-responses`); without it, the provider's first format is used. It is read only from your own config (like the rest of the
   config, never from a project), and a project or a task cannot change it. If the setting names a provider with no key, no model is chosen (the step gets no model access) and `rovara up --check` fails and names the key to set: your setting is
   never quietly replaced by another provider.
2. Else the first of the three built-in providers with a key, in the order Anthropic, OpenAI, OpenRouter (a plug-in provider is chosen only by the setting, so adding one never changes what an install uses), with that provider's default model: `claude-sonnet-4-6`, `gpt-5.4`, and for OpenRouter `anthropic/claude-sonnet-4.6` (the same Claude Sonnet as the Anthropic
   default, under OpenRouter's id; it is in the installed Pi model catalog, and a test keeps it there).

With only an OpenRouter key and no setting, tasks run on `anthropic/claude-sonnet-4.6` through OpenRouter. The worker speaks the chat-completions shape to the broker's model proxy (alias `openrouter/<model id>`), and the proxy's OpenRouter rules apply
(`provider.allow_fallbacks` must be `false` if routing is sent at all, no fallback fields, function tools only). `rovara up --check` prints the provider and model a step will use, and what to set when none can be chosen.

**One `rovara up` per state folder** (a lock file, `up.lock`, holds the pid; a lock whose process is gone is replaced). **Worker output** is taken only while an operation runs: an artifact is kept once (the same bytes again are the same artifact, other bytes are refused), nothing but a repeat of the result is taken after the operation ends, and a plan is shown only if its bytes match the digest the approval binds. An artifact name is kept once per operation (Understand and Plan post each name once; a name a later step may post again must be listed as replaceable in `app/callbacks.ts` when that step is wired). The two kinds of signed token (callback capabilities, repository grants) use different keys derived from `callback-key`.

**Models.** A task step is told the install's model route (the `model` setting in the config, else the first of Anthropic, OpenAI and OpenRouter that has a key; see "Choosing the model") and its capability lists `model-access`; the worker asks the broker's model proxy (lane L9a) for a token, bound to its workspace and operation, and the proxy adds the key. The flow requires the worker to list `model.route`, calls `modelProxy.operationEnded` when an operation settles, and grants no budget yet (no run limit exists before a price table). Plan and Understand documents are kept in the `object-storage` point under a retention class that never expires them.

**Projects.** `POST /v1/admin/projects` (the owner) registers a project definition on the store; a repeat of the latest revision is a 200, a change is the next
revision. A code host adapter is not needed to start a task: with none registered a start does not check the repository's host (and no pull request can be opened yet).

**What a worker's result means.** The callback layer reads what the worker saved, never its word: Understand's `intent.json` (checked by `readIntentArtifact`) and the
plan's `plan.md` (kept as a Markdown plan). An unreadable answer blocks the step with a plain reason and the owner can Retry it (`POST /v1/dev/tasks/<id>/workflow/retry`,
`rovara session retry`). A `questions` answer waits for the owner (`POST /v1/app/sessions/<id>/answers`) and Understand runs again with the answers; a plan sent back with
changes is planned again with the owner's words in the prompt.

**Approving.** The session token that logs a tool in is not an approval. `POST /v1/dev/tasks/<id>/workflow/decision` answers that a plan is approved on its page; the owner
runs `rovara open <task>`, which opens the page in their browser, and decides there. No API or MCP answer carries a page address (a test reads every answer of the journey for one).

The server hands the browser a **single-use address**, `/s/once/<code>`, good for 30 seconds and one request; that request is answered with a redirect to the real page address, which only the browser sees. So what appears in the process list while the browser starts holds no page session and is spent as soon as the browser uses it. **What remains (owner decision O1/A1):** on this computer the owner and any program running as the same user are one principal to the operating system. A program that holds the API token (a file in `~/.rovara`) can ask the server to open a page and could also reach the browser or the server's memory; the single-use code narrows the window, it does not remove it. For now the local session is the owner's proof of approval; opening a page is limited to 5 a minute, one at a time.

**The 10-minute laptop test.** `tests/unit/local-up-flow.test.ts` is the journey with the worker simulated: project, task, preparation, Understand, Plan, the plan on the page,
approval, coding, the checks, the code and security reviews, Rovara's own send-backs (twice, then it asks), the draft pull request on a fake code host, a CI fix and a merge of the
base pushed to that pull request, a restart in the middle, a failed step and its Retry, questions and their answers, Stop, a message, the page address from `rovara open`, and the real
Docker adapter (simulated Docker) accepting the job with the real worker's token check. With real Docker it is:

```sh
docker build -f environments/base/Dockerfile -t rovara-worker:local .
export ANTHROPIC_API_KEY=...      # or keys.json; the worker never holds it: its model calls go through the broker's model proxy
rovara up --check && rovara up    # prints the review pages address
curl -s -H "Authorization: Bearer $(cat ~/.rovara/session-token)" -X POST <url>/v1/admin/projects -d @project.json
curl -s -H "Authorization: Bearer $(cat ~/.rovara/session-token)" -X POST <url>/v1/dev/tasks -d '{"requestId":"<uuid>","project":"<name>","instructions":"...","workflow":true}'
rovara open <task-id>             # read the plan, approve it
```

Today the journey runs to a pull request that waits for its merge (see "Not wired yet"). 

## Merge tracking by polling (lane L12)

After the draft pull request is opened, the publish step enrols the task (`WORKFLOW_MERGE_RECOVERY`, `kind: "tracking"`). A laptop has no public address for webhooks (the GitHub adapter reports `events.mode: "poll"`), so `rovara up` **polls**: a
second timer (5 s) looks for tracking rows that are due and calls the merge core's pass (`reconcileTrackingTask`) for each. The pass reads the pull request through the code-host port, keeps one tracking item for it (CI, reviews, draft, branch), takes a draft
**out of draft** and asks the project's reviewers once its counted checks pass (only while the task waits for its merge, nothing being fixed), and asks the deciders: failing CI becomes a coding run (three rounds), a conflict or a branch that is behind becomes a
merge of the base. **It never merges**: a person does, on the code host. A pull request the host shows merged (or closed) is recorded in the workflow, with the `merged` milestone and the task's session line, when the head the host merged is the head Rovara recorded.

- **Milestones and the session.** `fixing`, `stuck`, `pr_ready`, `approved` and `merged` are a row in the task's partition and a line on the task's session, written in the transaction of the change that caused them. There is no one else to tell on a laptop.
- **Cadence and limits.** A row is first due when the pull request opens, then every 60 s; each pass in which nothing changed doubles the wait up to 5 minutes, and a change starts again at 60 s. A pass has a request allowance (32 plus 20 for each further pull
  request); a sweep reads at most 10 rows, 256 requests and 20 s. A failing pass waits 60 s times its failures, up to 15 minutes. A code host that says "slow down" (`HostRateLimitError`) pauses every row until the time it names.
- **The due time is a number.** A tracking row's `nextAttemptAt` is milliseconds since the epoch. The publish step first wrote an ISO text; a row written that way is never due (it is not read as a time). There are none outside builds of this lane, so nothing migrates them.
- **The clock** is the app's (`LocalRuntimeOptions.now`), so a test moves it and a restart picks the schedule up from the rows.

## Pull request comment commands (lane L12, owner decision 66)

A writer's comment on a pull request can approve or send back a plan (`/rovara approve`, `/rovara changes: ...`) or stop the work (`/rovara stop`). A laptop has no webhook, so the app **polls** (every 60 s, with the same rate-limit pause as merge
tracking) the conversation of each thread through the code host's optional `comments` read, and answers with its optional `postComment`.

- **A thread** is where the owner says a task's plan is posted: a form on the task's page (`rovara open <task>`: "Where the plan is posted", with the session's form token): the API token gets 403, because attaching lets a comment decide the plan. It names an issue or pull request of the task's own project, and **one open task per thread**: a thread another open task has is refused, and where several tasks would answer a comment Rovara decides nothing and says so.
  The task's own pull requests are read too, whether or not a thread is attached.
- **The code host only fetches.** A comment is text, author, created and updated times, the change request it is on, and (through `standing`) its author's permission. **Every safety check is Rovara's**
  (`core/pr-commands/handler.ts`, `core/pr-commands/comment-checks.ts`): the right thread, written after the version being decided was posted, never edited (the host's `updatedAt` moved), the right command for the answer
  (`approve <version>` approves and must name the version that waits: Rovara posts a notice with the short digest, e.g. `/rovara approve 3f2a9c00`, and a bare or older one is refused and told which version waits; `changes:` asks for changes, and an `approve` comment is no proof of a request for changes), not a bot's, not Rovara's own reply (its hidden marker), a writer, and used once. The Approvers seam
  makes the checks again from a second read when the decision is made.
- **What a comment cannot do.** It cannot approve a high-risk plan (the owner's page session only), reject (the session only), or merge. Asking for changes by comment is allowed (decision 62).
- **Not wired:** `/rovara lesson` (no lessons on this install) answers so. A host without `comments` offers no comment way of approving.

## Proof (lane L12)

When a run's checks are recorded for a candidate (a coding run's check report, or a rerun of the checks), the broker keeps the **evidence** of that run (`local/app/evidence.ts`, Cloud's `keepEvidenceAfterChecks`): the worker's `evidence-raw.json` (a rerun of the checks
asks for it; a coding run saves none, and the pack then says "test details were not captured"), the synthetic-data guard over everything, then one **pack** per task and candidate, plus the output tails, in the `object-storage` point. Objects there are write-once: the
tails are content-addressed, and the pack is the one object a re-check of the same code replaces (the documented `overwrite` opt-in). Keeping evidence is informational: a fault or a slow store (6 s at most) only means there is none. The local **proof page**
(`/proof/<task>`, linked from the plan page) lists the recorded checks, the reviews, the risk the broker judged and the pack's test counts and "not tested" list, in the broker's words; with no pack it says so.

## The task page and the pull request's description (lane L12)

- **Rovara asks.** While a step is blocked, the plan page (`/plan/<task>`) shows why, in Rovara's fixed words: the block's reason, the reason it asks instead of acting (`send-back-limit`, `unclear-fault`, ...) and what failed. **Retry** on the page runs the
  step again through the session control (audited, on the session's timeline, once for the form's token). A page for an older revision of the task is refused as stale.
- **Questions.** Understand's questions are on the same page, with a form for the answers (the same function as `POST /v1/app/sessions/<id>/answers`).
- **The pull request.** Its state (draft or ready, checks, reviews, the branch, someone else's push, "changed outside Rovara"), what Rovara is doing about it (fixing failing checks, round n of 3) and, when it is ready, "Ready to merge. Rovara never merges by
  itself". The sessions use the same words (`step`, and a status of "checking" or "ready to merge").
- **The description.** It opens saying it could not list the changed files, with the risk **high** and the reason "Rovara has not yet checked which files changed against the code host". Within a tracking pass of the push, the changed files are read **from the code host**
  (the files between the base and the checked head, with the host's counts) and the description is rewritten (only if nobody edited it) to list them; the risk is judged from those files and can then be below high. What the worker reported in `workspace.diff` is never believed:
  the proof page shows it only as "reported by the worker, not checked", and it can never lower the risk. A host that cannot list the files leaves the risk high and is asked again. It has a **Lessons used** section that says none were used (lessons are not on this install).
- **Structured plans.** The Plan step asks the worker for Cloud's plan document: a ranked claim tree with evidence, the decisions the owner should make (each with its options and Rovara's recommendation), the notes on what does not change and the risks, and, for a coding plan, the checks it proposes. The worker reads the answer and asks once more when it cannot be read; the broker reads it again (`core/plan/answer.ts`), credits the owner's own request as the plan's "why", and keeps the canonical JSON in the object-storage point under Cloud's key (`private/<owner>/<workspace>/plan-documents/<artifact>.json`). An answer that still cannot be read is sent back to the planner once by itself (Rovara's own second run), then blocks planning with the problems kept for **Retry planning** (`planUnreadable`). The code a plan cites is read from the code host of each repository after the plan is committed, and shown on the page (`PLAN_EVIDENCE#<artifact>`); a host that is not set up leaves those places "unavailable". An install whose worker cannot read a structured plan can ask for Markdown plans (`planFormat: "markdown"`).
- **The plan check.** A coding plan is read by a second step before the owner sees it (Cloud's plan critic): a read-only step in a conversation of its own that answers with a verdict and points. What it writes is advice: it reaches a planner only inside a labelled block, bounded and redacted, and it can never approve a plan. A blocking point sends the plan back to the planner once (the planner is told the points, and the revised plan is checked once more); everything else, and the second check whatever it says, goes to the owner with the critique on the page ("A second model's check"). A check that cannot run, or answers with no readable block, never holds a plan back: the page says the plan was not checked. A check that could not read the rules it applies stops with Retry plan check. A laptop runs every step on its one model, so the page says the model that wrote the plan checked it (Cloud picks a different model when the project allows several; the choice function is ported, `rovara-code/critic.ts`). The tasks follow Rovara Code's own sequence (`core/plan/program.ts`: plan, plan check, coding, checks, reviews, pull request); its review step names no automatic send-back rounds because the build step's own fixing (at most twice, then asks) stays as it was.
- **Rovara's own check of the plan.** Fixed rules (`developer/plan-quality.ts`) read the parsed coding plan: a claim nothing proves, a check that only reads files, a check command that will not run, an expectation the dry run contradicts, a plan too long for one screen. What the planner can fix sends the plan back once, unseen, with the findings; what is left is kept beside the plan (`<document>.quality.json`) and shown on the page ("Rovara's check of this plan", with the plan on one screen). The page and the MCP plan route read the same record; a plan with none reads as not checked, never as clean. A repository's own CI checks join the planner's proposals when the install's code host can give a read-only view of the workflow files (`ciDefinitionReader`; the CodeHost port has no directory listing yet, so none is wired).
- **The dry run of a plan's proposed checks.** While it plans, the worker tries each proposed check on the unchanged code and reports only a fixed class per check (passed, failed, could not run, not run, not checked), never output; the broker reads the report only for the exact plan text it names and attributes each result by the command's digest. A check that could not run, or that did not do what the plan said it would on the current code (`expectOnBase`), is a finding the planner is told once; the results are kept in the plan's check record and shown beside each check on the page ("Checks it adds"). A check that was not tried says so and is never read as a pass. On a laptop without the browser-and-API (E2E) executor image set up, the worker cannot run the sandbox the dry run needs, so "not tried" is the normal outcome there: the page says none of the proposed checks were tried on the current code, and the dry run is a bonus where the image is configured. When a proposed check later fails, a result that was already "failed" or "could not run" on the unchanged code tells Rovara's own fixing the fault is not the change's: it asks, saying the original code also fails, instead of sending the change back on a guess. Not wired: Cloud's check of must-not-change scenarios on the running app before the owner is asked (it needs the browser and API checks, which come with the E2E lane); the worker's side is present.
- **The owner's answers.** The plan page lists each decision of the plan that waits, Rovara's recommendation chosen, and **Approve** or **Ask for changes** sends the answer to every one. The answers are checked against the options the document offered; the coding run is told them as binding, and a revised plan is told the changed ones. A plan with no decisions shows no form. Not done: closing a plan that says no change is needed (the page's "Close as answered"), and the comments the owner sends with a decision reaching the planner (Code keeps page comments under `PAGE_COMMENT#`, Cloud under `COMMENT#`).

## Ordered work and parts built side by side

A coding plan can list the pieces of the work and what each waits for (a "work breakdown": 1 to 8 pieces in the task's one repository, at most 12 dependency links). Approving the plan approves its graph: the decision binds the graph's digest,
read by Rovara from the stored plan the approval's own digest names (every surface that approves gets the same digest, so none can bind a graph the person was not shown), and the engine records the approval. A plan whose graph is invalid,
names another repository than the one the task is pinned to, is refused at approval. (A task on the older workflow version 1.0.0 would also need an install switch, `workflowDependenciesEnabled` of the task flow; `rovara up` has no setting for it because it only starts tasks on version 1.1.0, so ordered work is always allowed there.)

- **The coding run carries the graph.** `core/build-step/start.ts` sends the worker the graph, the approval it was bound by, the progress cursor and, for a retry, the checkpoints to resume from (`workflowDependencies` in the payload, kept on the operation record). The worker must list `task.workflowDependencies`; one that does not is refused the step.
- **Parts side by side.** `rovara up` starts tasks on workflow version 1.1.0, so a plan's independent parts are built together on the task's one machine: up to 3 at once, held to the free slots of the owner (`task.charge`: the flow's `limits`, 10 a person and 100 in all by default; the task holds one slot itself). When the room is less than the plan could use, the operation's first timeline line says why ("Running parts one at a time: 10 of 10 of your workspaces are in use."). A worker that does not list `task.workflowParallelParts` is sent the plan without the setting and builds the parts one after another, when it can take over the progress so far; otherwise the step is refused.
- **Checkpoints are acknowledged before the worker goes on.** Each part's start and end arrives as a `progress` event; `core/work-breakdown/progress.ts` judges it against the approved run (the operation, the sequence number, the item and the tree it starts from; the run's first tree is read from the code host for the base commit the task recorded) and writes it into the task's workflow before the batch is acknowledged. A checkpoint that does not continue the approved run is refused (`CALLBACK_FORBIDDEN`).
- **The result must be the approved run's.** A successful coding run's `workflowDependenciesResult` must name this operation, graph and approval, hold exactly the acknowledged items in the plan's order and bind the final combined candidate and its tree. Anything else blocks the step (the sentences are in `core/work-breakdown/results.ts`); a coding run of an approved plan that carries no graph is refused too (a CI, conflict or feedback fix is the one run that carries none).
- **A stopped run is resumed, not repeated.** A run that failed, was lost or was stopped (the owner's Stop) marks every part still running as unknown, written with the block. Retry resumes from the parts acknowledged as built; a send-back runs the whole plan again over the code the workspace holds.
- **The plan page** (`/plan/<task>`) lists the parts in the order they run and where each stands ("waiting", "being built", "built", "failed", "stopped, will be checked again").

Milestones (`core/milestones`): a milestone ("questions", "plan_ready", "pr_ready", "merged", ...) is a row in the task's partition and a line on its session, written in the change's transaction. After the commit the handlers an adapter registered
(`app.milestones.register`) are told; one that failed is told again by the timer's sweep, up to 5 times. None is registered by default on a laptop.

**Not part of Rovara Code:** complex work (stacked milestone pull requests, step gates) and a per-company workspace limits setting. The limits are the flow's fixed ones.

## The CLI and the MCP tools on `rovara up`

`--env local` names the `rovara up` running on this computer. There is no sign-in to make: the CLI and the MCP server read where `rovara up` listens (`server.json`, no secret) and the login for the owner's routes (`session-token`, mode 0600) from its state
folder at each call, so a restart is picked up and no token is ever written into an MCP entry.

```sh
rovara --env local session start "Add a /health endpoint" --project payments --workflow quick
rovara --env local sessions
rovara --env local mcp install --client claude-code      # the entry runs `rovara --env local mcp`; it holds no token
```

The tools keep Cloud's neutral names (H3). What works here: `agentx_whoami`, `agentx_list_projects`, `agentx_start` (and `agentx_start_task`, `agentx_start_workflow`), `agentx_get_task`, `agentx_get_plan`, `agentx_wait_for_task`, `agentx_list_tasks`
(`project` and `status` are honoured), `agentx_decide_workflow` (refused: a plan is approved on its page, see "Approving"), `agentx_answer_task_questions`, `agentx_retry_workflow`, `agentx_cancel_task`, `agentx_close_task`, `agentx_list_sessions`,
`agentx_get_session`, `agentx_tell_session_agent` (saved as a note and, when a step is running, given to it), `agentx_stop_session` and `agentx_comment_on_session` (refused: one owner). These answer "That is not on this install yet" because their features are not in Code yet:

| Tool or command | Waits on |
| --- | --- |
| `agentx_list_agents`, `agentx_run_agent` | custom agents |
| `agentx_list_approvals`, `agentx_open_approval` | approvals of connected systems and step gates; a plan waiting for you shows as a session that needs you |
| `agentx_share_task`, `agentx_get_task_people`, `agentx_set_task_person`, `agentx_take_task_ownership` | channels and task people |
| `agentx_review_workflow_candidate`, `agentx_send_workflow_back`, `agentx_resolve_review_findings`, `agentx_retry_workflow_publish`, `agentx_keep_pull_request`, `agentx_open_pull_request` | the owner-side review and publish controls |
| `agentx_get_pr_feedback`, `agentx_decide_pr_feedback` | pull request feedback review |
| `agentx_continue_task` | a task's budget |
| `rovara session merge` | the local Merge button, which is not built (see "Not wired yet"); the core's `prepareMerge` and `pressMerge` exist |
| `rovara session link`, `rovara home`, `rovara lessons` | tracker write-back, the web feed, lessons |

## Script tokens

A script token lets the owner's own scripts and CI on this computer read their tasks and start tasks on chosen projects without the owner's session token. It is a scoped, expiring, revocable credential, stored only as a hash and shown once.

- **A token reaches only a closed list**: `POST /v1/dev/tasks` (start, on a project the token names), `GET /v1/dev/tasks?project=<one of its projects>` and `GET /v1/dev/tasks/<id>` (read, for a task of one of its projects). Everything else, including every decision, approval,
  session, page, project, token and merge route, answers one fixed refusal before anything is read. **A script token is never an approval proof** (L7A-1). It acts as the owner, only while the owner still holds the role it was made with (else it is revoked for good),
  and the task it starts always has the client "Script token", whatever the body says.
- **Making one is on a page**: `rovara token create` asks the running `rovara up` to open the script tokens page in your browser, on a NEW page session; the page's form works only for a session opened in the last 10 minutes and once per form. The API session token (the one an
  AI tool may hold) cannot make a token: a long-lived credential must not be makeable by a program's credential. The secret is on the answer to that one form post, never in an address, a redirect, a file, a log or the audit trail.
- **Listing and revoking** work with the API session token (`rovara token list`, `rovara token revoke <id>`, `GET /v1/app/script-tokens`, `POST /v1/app/script-tokens/<id>/revoke`): they show names and hints and only end a credential.
- **Limits**: a token lives 30 days unless you choose 1 to 90, a person keeps at most 10 live tokens and makes at most 10 an hour, a token may make 60 requests a minute and start 20 tasks an hour (120 and 20 across all of one person's tokens).
- **Audit**: making, revoking and the first use each day, and each task a token starts, go through the audit sink (`script_token.created`, `script_token.revoked`, `script_token.used`), staged in the same transaction as the change.
- **Off switch**: `ROVARA_SCRIPT_TOKENS=0` in the environment of `rovara up` turns the feature off (no token authenticates, the page and routes do not exist). Starting with the switch off also REVOKES every live token (audited), so turning it back on never revives one.
- **Keys**: Cloud's (`scriptTokenKey`, `orgScriptTokensKey`, the rate rows under `ORG#<company>#SCRIPT_TOKEN_RATE`...). Differences: the record also keeps `personId`, and `amr` may be `local`; Cloud's reader strips the first and its sign-in list does not have the second.

## Chat and notices (a `channel` adapter)

A chat tool is an ordinary `channel` adapter, like any other plug-in: Rovara core names none. With one set up, three things work on a laptop. Without one, none of this runs and nothing is queued.

- **Notices.** When a task moves into a state that asks someone to act (needs you, ready to merge, failed) or ends, the person is told in their chat: one message at most every 15 minutes per place, with everything pending in one list. Each row is checked again before it is sent (the session still stands in that state, the person may still read it), and a muted person or one with no place chosen is told nothing. A session's followers are told when it fails or ends. A task started from a chat is also told in the conversation it started from (every member of a bound space can read the task titles and status words told there, so bind only spaces whose members may see them), even where the chat may not message first. The message holds the task's title and Rovara's status words, never the plan, and no address: a page address carries your session, so the footer says `rovara open`.
- **Starting work.** A message that mentions the bot, from a linked account in a space bound to a project, starts a task on that project as you (the same start as `rovara session start`, with the plan still waiting for you on its page).
- **Cards.** The card code (`postApprovalCard`, the decision path through the sink) is a seam for a host with an https task address; a laptop's page address is http and carries your session, so `rovara up` posts no card and every press ends at "not open". A card for an approval is a pointer to the task page. Nothing said or pressed in a chat approves anything: the kinds that ask for a sign-in (a plan, an admin change) are sent with no buttons, and any press is checked against the card Rovara posted (this conversation, this revision, this content digest, still open) and then handed to the approval gate as a credential of the chat's own method, `chat-<channel>`. Code's approvers do not offer that method, so the gate refuses it; an approvers plug-in that names it takes the decision for the kinds that allow it, and a high-risk approval, a rejection and a plan are never decided from a chat on Code's rules.

**Everything that changes who can act as you is on one page**, `rovara chat`, which opens the chat page on a new page session (the form works for a session opened in the last 10 minutes, once per form): link a chat account (message the bot in a bound space; it answers an account it does not know with a one-use code, valid for 10 minutes, shown only to that account; you paste it on the page, which shows the workspace and the whole account id, and confirm only if that is your own account. An account of another workspace, such as a guest from a shared channel, gets no code), bind a space to a project, choose where you are told, mute. None of these is reachable with the API session token an AI tool may hold. That token can read what is set up: `rovara chat status`, `GET /v1/app/channel` (adapters, linked accounts with the account id masked, bound spaces) and `GET /v1/app/me/notifications` (where you are told, whether muted, and the channels that can be named).

Stored rows, all under the company scope: `NOTIFY_PREFS#<company>` and `NOTIFY_SENT#<company>` (the person's places and mute, and when each was last told), `NOTIFY_PENDING` (the queue), `ORG#<company>#CHANNEL_LINK#<channel>/<tenant>`, `ORG#<company>#DEVELOPER_CHANNEL_LINKS#<person>`, `ORG#<company>#CHANNEL_LINK_CODE#<hash>`, `ORG#<company>#BINDING#<channel>/<tenant>` (and `ORG#<company>#CHANNEL_TENANTS`, the tenants a space was bound in, so every binding can be listed), `ORG#<company>#CHANNEL_CARD#<request>`, `ORG#<company>#CHANNEL_CLAIM#<channel>/...` (an adapter's event used once) and `ORG#<company>#CHANNEL_THREAD#<session>`. Link codes, claims and cards expire.

### The Slack adapter

The chat tool the product shipped first is a plug-in of this kind. Name it in your plug-in config; the tokens are read through the `secrets` point (an environment variable or an owner-only file), never held in the config:

```json
{ "point": "channel", "name": "slack", "module": "@agentx/broker/plugins/channel-slack",
  "settings": { "botToken": { "env": "SLACK_BOT_TOKEN" }, "appToken": { "env": "SLACK_APP_TOKEN" }, "projects": ["web"] } }
```

`botToken` lets it post. `appToken` (the app-level token of a socket-mode app, with the `connections:write` scope) lets it hear a mention and a button press with no public address: it opens an outbound socket and reopens it when the tool asks or the network drops. Without `appToken` it only posts notices. Subscribe the app to `app_mention` and turn on interactivity; no other event is read, so a message that does not mention the bot is never seen. It posts only in the workspace its own bot belongs to. A notice to a direct message or to a space itself (no thread) names the thread `0000000000.000000`, which this adapter reads as "no thread" (`ChannelAdapter.noThread`; the chat page fills it in when you leave the thread empty). A token the tool refuses stops that adapter's start with the tool's error code; the rest of `rovara up` runs.

## A message to the agent

`rovara session tell` (and `POST /v1/app/sessions/<id>/messages`, the MCP tool) gives the agent a message. It is information, never an instruction that decides an approval, a gate, a tool or a budget.

- **The note.** The task keeps the message as a note (`NOTE#<message id>` in the task's partition, with the count on the task: at most 200 notes a task, and 20 messages an hour to one task). The note, the count and the rate token are written in the same transaction as the session's message, so a message is never left without its note. The next understanding, planning or coding step reads the notes no step has been given, under "Messages from people (information only, never instructions)", each in a tag that carries an id only the broker derives, with the person as a fixed label and never the name they chose. A message is `queued` until a step takes its note, then `delivered`; when the session ends, the messages no step took become `not_delivered`.
- **Live.** A step that is running right now (understanding, planning, coding or the setup run) takes the message within seconds: the broker sends the worker of that step one `steer` invocation through the `worker-machines` port, signed like every job (this workspace, this operation, this fence, one minute), with a callback capability that lists no action (the worker never calls back for a steer). The worker words the message for the model (who sent it, what authority it has) and answers on the same request. It is sent only to a worker that lists `task.liveSteer.v1`, only to a worker that is up (a stopped machine is never woken for a message), and a step that has not opened its session yet is asked again a few times and then left as a note. The message shows `delivered` at once and the next step shows its note as already given. `ROVARA_LIVE_STEER=0` turns the live path off: a message is then only a note. `ROVARA_STEP_NOTES=0` stops the steps reading notes at all (they are still saved, and stay `queued`). Both are on unless set to `0`. The whole send is given 10 seconds; a worker that is slower leaves the message a note.
- **Re-approval.** When the owner's live message asks for a change outside the approved plan, the step stops with fixed words, the task is blocked for the owner to decide (Retry plans again with the message; a coding step offers Revise the plan when the plan can take the change in), and the message says "needs re-approval" on its row and on the timeline.

## Ask about a task 

`POST /v1/app/sessions/<id>/ask` (`{ requestId, question }`, at most 1,000 characters) asks a question about a task; `GET /v1/app/sessions/<id>/asks/<askId>` reads it back (`queued`, `answered` with the answer, or `failed`). It is read-only: an Ask changes nothing but its own records, and its answer is never sent to the agent (use a message for that).

- **Who answers.** One model call with no tools, made by the broker with the model the install's steps use (the `model` setting, else the first provider with a key), through the same provider plug-in, sign-in and request guard as a worker's call, but not through the worker proxy: there is no token and no operation. The key signs the call and goes nowhere else; an answer that holds it is thrown away. With no model set up, an Ask says so before anything is spent.
- **What it is given.** The rules, then the task's own data for the web tier: the request, the status, the latest document, the decisions, the owner's messages (each by a fixed person label, with their authority), the check names with the tails of failures, and the changed files and patches when the install can read them. Every text is redacted, made inert and put in a tag that carries an id only the broker derives; the whole context is at most 60 KB and the answer at most 1,200 output tokens.
- **Limits.** 20 questions an hour for the owner on one task, 100 a day for a task, and 30 an hour for the owner across every task, one question at a time (the lock lets go with the answer and expires on its own after 15 minutes). A closed task cannot be asked about. A repeat of the same request is the same Ask and costs nothing.
- **What is kept.** The request item holds ids and a state and never the question. The answer is kept 30 days (`ASK#<id>`), with the owner's words redacted, and is shown only to the person who asked. Each Ask is audited (`task.asked`: ids, never the words) and its usage is recorded against the task's cost (a response that says nothing of what it used is charged the most it could have cost). Before it spends, an Ask asks the install's `admission` for a `model.call` with an estimate (the default allows everything; a company's budgets plug in there), and the reservation is settled with the usage or given back. A failure that is Rovara's own (no model, a request the guard refused) gives the rate slots back. `ROVARA_ASK=0` turns Ask off: its routes answer "not found" as if they did not exist; it is on unless set to `0`.

## Revise the plan, follow, peek, close (slices 3 to 5)

- **Revise the plan.** `POST /v1/app/sessions/<id>/revise-plan` (`{ requestId, expectedRevision }`). When coding stopped for the owner's live message (blocked with the reason that offers it, and the stop kept the message ids), one press sends the task back to planning with the owner's words as the change to make, in one transaction conditional on the blocked revision; the revised plan still waits for the owner's approval on the page, which alone starts coding again. The messages then say "plan being revised". A repeat of the same request is the same press.
- **Follow and presence.** `POST /v1/app/sessions/<id>/follow`, `POST .../unfollow` (the hosted `DELETE .../follow` is not served: this install's HTTP server takes GET and POST only) and `POST .../presence`. The owner follows without an item, so a laptop answers `following: true` and writes nothing; the session's view shows who is looking (a heartbeat counts for 90 seconds). The keys are the hosted product's, and the level of a person is a seam (`level`) for an adapter with members.
- **Peek.** While a task's worker is up, an Ask is given a read-only look at the working tree: one `peek` invocation through the `worker-machines` port to a worker that lists `task.peek.v1`, with a filler where a capability goes (it opens nothing), and no command, path or budget in it. A machine that is stopped is never woken for it, and any failure is no diff section.
- **Close.** `POST /v1/app/sessions/<id>/close` (`{ requestId }`) closes the session's task as `POST /v1/dev/tasks/<id>/close` does, and answers the session, ended. It goes through the session control like a stop (the request, a timeline line and an audit step in one transaction); `discardUnpublished` is refused, since this install has no unpublished-work check.

## The second review by another AI company

An **added** second opinion on a task's code from a model of a different AI company than the one that wrote it. It runs inside the same REVIEW operation as an extra code review (no new step, hold or row) and never replaces the first reviews:
it is stored beside the workflow (`task.secondOpinion`), never in it, so a second review's PASS cannot clear a first review's FINDINGS and a FAILED one cannot fail it.

- **Modes** (`review.otherCompany`): `off` (the default: the review is exactly what it was), `shadow` (recorded and shown on the task page as "Second opinion (not blocking)", never on the pull request) and `on` (its blocking findings hold the step like the first
  review's: Rovara sends the code back to coding, within the same two-round limit). `on` needs evidence for the chosen model: a replay run that passes the quality bar and a shadow window counted from your own tasks (on the page, under "Evidence"); a model without it runs as shadow and the page says so.
- **Who reviews.** The picker lists the models this install can serve (the providers with a key, from the installed catalog; a model of an unknown maker is greyed out, so is one from the same company as the code), with an estimated cost per review and up to three
  suggestions. Nobody chose: the top suggestion is the default and the page says "Using default: ... (change)". You may choose a primary and a backup; a chosen model that stops qualifying is never swapped for another, nothing runs, and a notice says why.
- **What it sees.** Only the change, unless you choose "same as the first reviewer" (the connected sources, lessons and step instructions).
- **Cost.** The second reviewer's calls go through the same local model proxy under their own aliases (`<provider>/<model>`): the operation's token may call those aliases and no others, and the model proxy's fallback is not asked for. Admission is the `Admission` port's
  answer (allow-all on a laptop); a refusal is "did not run: budget"; an allowance the port holds back is kept on the operation and given back when the operation ends. **Spend cap:** the second reviewer's routes carry a cap of their own in the model proxy, per operation, priced at the model's catalog rates
  (ten typical reviews, and never less than three of the most one call can be assumed to cost); a call that could not fit under it is refused as a spent budget, and a model with no catalog price is not used. **A second opinion counts only when the model proxy saw a call on its alias for that operation** (otherwise "no answer"; a broker restart in the middle of the review loses what the proxy saw, which never blocks).
  On `on`, a review that did not run is flagged on the task page and the pull request, and the owner acknowledges it on the task's page (an acknowledgement is written only with its audit record). Rovara does not merge on this computer, so the acknowledgement releases a merge hold only where one exists (a hosted merge card); on a laptop check the pull request's second-review line before you merge. Nothing blocks the task itself.
- **Where it is.** The local page `/second-review` (`rovara open second-review`) and the plan page's "Second review" section. `rovara second-review` and the MCP tool `agentx_get_second_review` READ the state; choosing the model, the mode, withdrawing and recording evidence and acknowledging are the
  owner's acts in the browser (the API token is refused, as for approving a plan, and `POST /v1/admin/second-review/replay|verdict` answers 403 too: that token is held by every local tool). Lowering the mode, withdrawing and the evidence need a page session opened within ten minutes (`rovara open second-review` and `rovara second-review evidence` open a fresh one). A verdict the owner withdrew is never written again, and replacing evidence that holds with evidence that does not, while blocking is on, is a lowering that asks the Approvers port.
- **Keys.** The settings and evidence are stored under the shared key layout (`ORG#<company>/SECONDREVIEW#SETTINGS`, `#PROJECT#<name>`, `#VERDICT#<model>`, `#REPLAY#<run>`, `#MODECHANGE#<id>`, `#NOTICE`, `#TRACK#<model>#...`), so a company that moves between Code and Cloud keeps them. The track record is kept from the store's change feed.
- **Lowering the mode** goes through the `Approvers` port's requirement for a `setting` request: with Code's default (the owner) it applies at once, audited; an approvers adapter that needs a different person turns it into a proposal that person approves with a proof the port verifies.
- **Not done here:** the merge press itself (Code's merge card is not wired on `rovara up`, so `mergeWait` is offered to whoever builds the merge dependencies), the decision card for the notice (the card routes are not mounted on a laptop; `secondReviewNoticeItemsFor` is ready), and per-operation model records (every step runs on the install's one chosen model, so that is the model the second reviewer must differ from).

## Not wired yet

- **Merge from `rovara up`.** A person merges a draft pull request on the code host (or with their proof); merge tracking never presses Merge (owner decision 1). The owner's own Merge button on the local page is not built;
  a merge made on the host is seen by the next tracking pass and recorded (see "Merge tracking by polling").
- **A GitHub client for the laptop.** No `GitHubCodeHostProvider` exists for a personal token or `gh` (L7A-4): Cloud's client is a GitHub App client. Until one passes
  `runGitHubClientConformance`, no `code-host` adapter is registered, and a worker's clone credential is the owner's token itself, given only for a repository on github.com over https and only to clone (no push credential is given yet; lane L11 brings a scoped one).
- **A budget on the model proxy.** The task flow grants a step the install's model (see "Choosing the model") and no budget: the flow has no run limit before a price table exists, and Code's price table is empty. See "Model calls" below; `operationEnded` is called when an operation settles.
- **Ask, Revise the plan and Close in the CLI, in the MCP tools and on the local page** are not wired: the routes above are what they will call (the tools, commands and a page form are built separately). Stop and redirect (the owner stops a coding step to give a new instruction) is not ported.
- **Lessons** answer "nothing there". **Design review** runs (see "Design review" below); its CLI and MCP surfaces are not built yet. **Notifications** and chat need a `channel` adapter (see "Chat and notices"); none is set up by default.
- **A CLI sign-in to the local runtime** is `--env local` (see "The CLI and the MCP tools on `rovara up`").

### Design review

A Full task whose design needs decisions before code can have the design read by fresh-context reviewers (Elephant-Goldfish Model prompts, Apache 2.0: `THIRD_PARTY_NOTICES.md`). It is **off** until the install turns it on and the project asks for it:

- **The switch.** Start `rovara up` with `ROVARA_DESIGN_REVIEW=1` (Cloud's `DESIGN_REVIEW_ENABLED=1` works too). Without it no task enters the stage.
- **The project's setting** (mode `auto`, `always` or `never`; tier `light`, `standard` or `thorough`; allow skipping; the cost cap per task; who approves a high-risk design) is the `designReview` field of the project's playbook document, Cloud's item (`PROJECT_PLAYBOOK#<project>`), written by `writeDesignReviewSetting` (`core/design-review/playbook-store.ts`). A project with no setting, or one that cannot be read, is **Off**. A company lock or policy item a hosted install wrote is read and held; on a laptop the company is the owner, so a company with no policy item allows design review.
- **The path.** Understand's reading (`design.needed` and its reasons) and the setting decide (`mode.ts`); A person's `design first` (the task record's `designFirst`) turns it on whatever the setting says, and the start reads the prefix (only while the stage is on; with the switch off the text is left as it came). A review forces the Full path (requirements, design, coding plan) and adds the plan-check step to the workflow's sequence. The design is written in a fixed eight-section template; one that does not read blocks the step, and Retry asks again.
- **A round.** The broker builds each reviewer's packet (the design and the approved requirements; repository files at the pinned commit are not read yet), stores it, gives each reviewer a model key of its own (one model-proxy token per reviewer, one-shot, a 60-minute life, its own spend record and a budget that is its ceiling of the review's cap) and starts one plan-check operation that carries the binding. The worker fetches its packet from `GET /v1/internal/design-review/packet?slot=` (only a capability with the `design-review-packet` action, only for a slot of the stored binding) and runs every reviewer in a session of its own. The broker re-reads every answer, verifies each reviewer (`digest_only`: the proxy keeps no first-call record), checks every citation against the packet that reviewer was given, adds its own findings and records the round with the measured spend. Nothing a worker or a model writes sets a severity, a tier or an approver.
- **The planner.** With findings to answer, the planner runs again in its own operation (fixed, contested, asked or declined, each with evidence); a changed design is reviewed in a second round. Two rounds at most.
- **Approval.** The design waits at the owner's approval with the review's facts. The tier is worked out by code from the areas the design touches, the open blockers and how much of the review ran (`riskTierOf("approve_design")`), and the approval goes through the **approval gate and the `approvers` port**, so a high-risk design needs the strong proof the plug-in names. A design with an open blocker is approved only with a one-line reason; the approval leaves a record under the design's digest for the pull request's Proof section.

**The price.** The cost hold is the owner's to answer. A review that would cost more than its limit, or whose model has no price here, waits on the plan page with the choices: run it anyway (only when no price is known), raise the limit, run a lighter tier, or skip (when the project allows it). Each choice is an approval through the approval gate and the `approvers` port, never a default, and is also written to the decision history under the card it answers. A model with no price table cannot be held to a budget by the ledger (an unpriced call is recorded as unknown), so a review the owner accepted with "price unknown" is COUNTED at an assumed price for each reviewer's key: $15 per million input tokens and $75 per million output tokens by default. That is an assumption, not a bound for every model: a model dearer than that can cost more than the limit the owner saw, and the hold says so in one line. State another figure with `ROVARA_UNPRICED_REFERENCE_PRICE=<input>,<output>` (dollars per million tokens); a dearer figure holds the limit tighter, but a call is reserved at the worst case it could cost, so at the default limit a figure near $150 and $600 leaves no room even for one reviewer call. Each reviewer turn is limited to 16,000 output tokens so that one call fits. The cost ledger still records the calls as unknown. If the owner does not choose, a line on the task's session reminds them after a day and after three days, and a review waiting a week is parked (nothing runs or spends, its keys are released) until the owner picks it up again; a review parked for thirty days is closed as not decided, and the task is closed the way closing it by hand does (its slot, workspace, machine and admission go back). A review that cannot start for another reason ends as not run, and the task's page and the pull request's Proof section say so in a plain line ("Design review did not run: ...").

**Reading a review from a tool.** `GET /v1/dev/tasks/<task>/design-review`, the MCP tool `agentx_get_design_review` and `rovara design-review status <task>` say how a review stands: its status line, the findings (model words, shown as plain data), the cost hold's choices by label with the note about the assumed price, the planner's questions, whether it is paused and whether a blocker needs a reason. They carry no approval offer, proof or form. The owner's acts stay on the task's page: a cost choice, the answers to the questions and picking a paused review up again are refused over the API (a POST to `/design-review/choice`, `/answers` or `/resume` answers that they are the owner's own acts on the page), and `rovara design-review open <task>` opens the page in the browser without printing its address.

Not built yet: repository, meta-repository and MCP-item readers for the reviewers' packets (they are given the design and the requirements only), and the approver rules beyond the owner (a hosted adapter narrows who may decide).

### Model providers (lane P5, item K2, owner decisions 60 and 61)

A model provider is a plug-in of the `model-provider` point (`packages/contracts/src/ports/model-provider.ts`). Its name is its provider id, which is open text. It states:

| What | Values |
| --- | --- |
| name, address | `https://host[/base]`; plain `http` only for this computer; no user name, query or fragment |
| sign-in | `bearer-key`, `named-header` (`x-api-key`, `api-key`), `aws-sigv4` (region, service), `google-oauth`, `microsoft-entra` (scope), `none` (an address on this computer only) |
| request format, per entry | `anthropic-messages`, `openai-completions` (chat), `openai-responses`; an optional path override; the `vertex` variant of messages |
| capabilities, per format | forced tool choice, parallel tool calls, how reasoning is controlled, reasoning returned, prompt caching, usage in the stream |
| prices | per million tokens, keyed by the provider's model id; they reach the `metering` port as `<provider>/<model>` |
| `credential()` (optional) | the AWS credential, Google token or Entra token, resolved at each call |

Code registers `anthropic`, `openai` and `openrouter` as defaults, with the addresses, sign-in and format the proxy always used. A module for a company's own gateway is a few lines
(`modelProviderPlugin({...})`, `packages/broker/src/plugins/model-provider/plugin.ts`); the config entry names it (`{ "point": "model-provider", "name": "company-gateway", "module": "./gateway.mjs",
"settings": { "address": "...", "defaultModel": "...", "prices": {...} } }`), and the settings may change only the name, address, default model and prices. Its key is the provider's entry in `keys.json`
or an environment variable (the three built-ins keep `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`; any other provider reads `ROVARA_MODEL_<ID>_API_KEY`, hyphens becoming underscores, so a provider called `linear` can never read `LINEAR_API_KEY`), never the config. `rovara up` refuses to start with a provider that is not well formed (an `http` address to another machine, a sign-in header
the proxy owns, the vertex variant on another format, a price of 0, an `aws-sigv4` provider whose address is not https `*.amazonaws.com` in its region, an id that belongs to another part of Rovara such as `github` or
`linear`, a plug-in that moves a built-in provider's id to another address or sign-in) and names the provider and the rule. A price of 0 is refused unless the model is marked `"free": true` (and then every price is 0), so a task budget cannot be passed by accident.

**Which credential is used** (the same for every provider, tested): (1) sign-in `none` has none; (2) the key store's entry for the provider (the environment variable, then `keys.json`) always wins; (3) the provider's own `credential()` is used only
when the key store has no entry. A model choice asks only the provider that could be chosen (the `model` setting's, else the default order of the three built-ins) for a credential, never every installed provider.

- **Bedrock** is `bedrockModelProviderPlugin()` (provider id `amazon-bedrock`): SigV4 for service `bedrock`, Claude through the messages format on `/anthropic/v1/messages`, open models through chat completions on
  `/openai/v1/chat/completions`. **It never signs with the AWS identity your shell happens to have, unless you say so.** The settings must name exactly one identity: `"profile": "<a named AWS profile>"` (give it only
  `bedrock:InvokeModel*`; that is what we recommend), or `"roleArn": "<a role>"` (assumed for a 15-minute session; the default chain is used only to call AssumeRole), or `"allowAmbientAwsCredentials": true` (the default
  chain, whatever this shell has). With none of them Rovara refuses to start and says which to set. An `amazon-bedrock` entry in `keys.json` holding `{"accessKeyId","secretAccessKey","sessionToken"?}` wins over all
  three. The credential provider is built once and the credential cached until a minute before it expires. `rovara up --check` says which identity Bedrock will use. Bedrock models are **unpriced unless you set `prices`**,
  and a task with a budget is refused for an unpriced model. A missing SDK module is reported as "AWS credential module missing". A "signature expired" answer is reported as "check your computer's clock". The paths and the
  capability rows (Claude on Bedrock does not honour a forced tool choice) are from the research (designs-2026-10-30/MODEL-PROVIDER-FORMATS-RESEARCH.md) and have not been tried on a live account.
- **Open checks (staging or a live account, nothing built depends on them being true).** (1) Does Bedrock's Claude really refuse a forced `tool_choice` (`any` or `tool`)? The row says it does not honour one; if it does, set
  `forcedToolChoice: true` for the messages format. (2) Does Vertex accept a model id with `@` sent as `%40` in the path (`claude-...@2025...:rawPredict`)? One live call. (3) Is a clock skew of more than five minutes
  reported by AWS in words the clock-skew message catches (`Signature expired`, `RequestTimeTooSkewed`)? Also: whether `/anthropic/v1/messages` on `bedrock-runtime` wants an `anthropic-version` header or body field, and whether Bedrock accepts the `store: false` field Rovara now sends on every chat-completions call (if it answers 400, drop the field for that provider).
- **Claude on Google Cloud** is the messages format with `variant: "vertex"`: `address` is the models collection, the call goes to `<address>/<model>:rawPredict` (`:streamRawPredict` when streaming), the model leaves the body
  and `anthropic_version: "vertex-2023-10-16"` enters it. Google and Microsoft sign-ins send an access token as a bearer token; refreshing it is the plug-in's `credential()`, not the proxy's (no refresher ships in Code).
- **Calls are always stateless.** The proxy forwards `store: false` on every Responses and chat-completions call, whatever the worker asked, and `previous_response_id` and `conversation` are not allowed fields, so the full history
  is sent every time and nothing depends on state kept at the provider.
- **Same rules for every provider.** The request guard (field allow-lists, function tools only, header bans, `anthropic-beta` allow-list, no redirects, key cut from answers) runs before a provider is looked at; a
  provider's capability row can only add a refusal (a forced tool choice at a provider that ignores it is answered 400 by name, not dropped), and the SigV4 secret key and session token are cut from answers like a key.
- A model the worker's catalog does not know (a gateway's own model) runs with the worker's conservative defaults for an unlisted routed model.
- `rovara up --check` does not load plug-ins (naming a module runs its code): for a `model` setting that names a configured `model-provider` it says the sign-in is checked when `rovara up` starts.

### Model calls: the worker holds no key (lane L9a, provisional until Pratik agrees, owner decision 58)

The broker serves a small model proxy on the same callback listener (`packages/broker/src/local/model-proxy/`). A worker is given the proxy's
address (`AGENTX_MODEL_PROXY_URL`, an address, not a secret) and asks the broker for a token with its callback capability
(`GET /v1/internal/model-access`). The token lasts 15 minutes, is good for one workspace and one operation, and names the models the broker chose for
that operation. The worker sends its model calls to `<proxy>/v1/messages`, `/v1/responses` or `/v1/chat/completions` with the token where a key would
go; the proxy reads the real key from the `model-keys` port (the environment, then `keys.json`) or the provider's own credential, signs the call as the provider's sign-in says, calls the provider (Anthropic, OpenAI and OpenRouter, or any `model-provider` plug-in), passes the
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
- Not here: design-review key slots. Bedrock is a `model-provider` plug-in (below).
- The task flow turns it on: its dispatch lists the `model-access` action in the worker's capability and gives `startLocalRuntime` a
  `modelGrants` source (`capabilityModelGrants`) that says which models and what budget an operation has (`localRoute` makes a model's route).


## Not in this lane (L4)

See the report of lane L4 for the list with file and line. In short: the published worker image. Devcontainers, test services and the setup run need Docker calls the
guard refuses; they are not available locally until each is given a place in the guard's rules.

## Tests

- `tests/unit/local-up-flow.test.ts`: the whole `rovara up` journey on SQLite with a fake worker (see "The 10-minute laptop test" above).
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

## GitHub on a laptop: your own token

With no GitHub App, Rovara reaches GitHub as **you**, with your personal token (port lane L11, `plugins/code-host/github/token-client.ts`). It opens pull requests, reads reviews and checks, replies in review threads and, only after you press Merge, merges.

- **Make a fine-grained token.** GitHub gives a short-lived, one-repository credential only to an App, so there is none for a personal token: the credential a task's worker clones and pushes with **is your token**, the same for clone and for push. A fine-grained personal token (GitHub, Settings, Developer settings) limited to the repositories of your Rovara projects, with Contents and Pull requests set to read and write, keeps that to those repositories.
- **A token that reaches every repository is not given to a worker unless you say so.** A classic token and the one the GitHub CLI holds (`gh auth login`) reach every repository you can, whatever scopes they list (`repo`, `read:org`, `gist`, ...). Rovara uses them for its own reads and pull requests, but refuses to hand one to a worker as the clone or push credential. To accept that risk, set `"allowBroadTokenForWorker": true` in `~/.rovara/config.json`. `rovara up --check` warns about such a token and names its wide scopes.
- **A worker's credential comes from the code host.** The local app resolves a worker's clone or push credential through the registered GitHub code host, so the rules here always apply (its address rules first: github.com over https, plain characters). The grant of a clone covers a clone; the grant of a publication or of a push to an open pull request (lane L10) covers a push to that one repository, and the code host's `issueGitCredential` applies its push checks (a registered repository, a token that cannot reach every repository, push permission). A push credential must expire within the hour. With the personal-token adapter (lane L11) the push credential is the owner's own fine-grained token, handed out for 50 minutes by Rovara's reckoning (the token itself lives as long as the owner made it), and nothing re-reads the branch after the operation ends until the tracking timer runs (see the head check below); a broker-side git relay (the broker pushes and the worker never holds a push credential) is the later fix.
- **A pull request changed outside Rovara is said so.** Until merge tracking runs on a timer (lane L12), reading a task's page reads the host's head of each open pull request Rovara opened and compares it with the head Rovara recorded (`checkPullRequestHeads`, at most every 15 seconds). A different head marks the pull request "changed outside Rovara" on the page, and `recordedHeadOf` (what merge tracking is given as the head Rovara pushed) then answers nothing for it, so tracking reads the head as someone else's and never takes the pull request out of draft. A head that cannot be read marks nothing.
- **Only your projects' repositories.** A token can see more than you registered. Rovara uses it only for the repositories of registered projects, and refuses any other before a request carrying the token is made. (Checking that a repository exists, to register it, is the one read that may name a repository not yet registered.)
- **The expiry Rovara states is its own.** A worker credential must expire inside an hour, and a classic token has no expiry, so Rovara hands the token out for at most 50 minutes at a time and asks again (sooner if GitHub says the token itself expires sooner). That limits how long one copy is used. It is not a GitHub-side limit.
- **Rovara's comments are yours.** GitHub shows a reply Rovara posts as your account. Each reply is one line, a blank line and a hidden marker (`<!-- rovara-reply -->`). Rovara leaves out of review feedback only the comments written by your account in exactly that shape. If it cannot read your login, the feedback read fails instead of guessing.
- **Where the token goes.** Rovara's own requests send it to `https://api.github.com` only, never follow a redirect and have a time limit. A task's worker sends it to `github.com` over git; its git refuses redirects and its credential helper answers only for `github.com` and the host of the address it was told to use. `rovara up --check` tests the token once with `GET /user`.
- **Follow-up for both owners (decision 51).** The better design is a broker-side git relay: the worker never holds the token, and the broker adds the credential only for the one granted repository and refuses pushes outside Rovara's own working branches. Until it exists, the rules above are what limit a token in a worker.
