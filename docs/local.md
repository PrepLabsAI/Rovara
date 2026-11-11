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
approvers, allow-all admission, no audit sink, and price-table metering (a model is priced by its provider's table, else by the catalog's list price, else its usage is recorded as unknown, never
guessed; see "What a task costs"). The company id can be set in the config (`companyId`).

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
  included), other images, builds, volumes, networks, info, prune and copy, except what a project's dev container needs (next
  section). A project's test services need Docker calls that are still refused (see "Not in this lane").
- **A project's dev container** (`isolation/docker-socket-guard-source.ts`, the `devcontainer` policy; setting up a project, below). When the owner lists
  registries, the guard also lets the worker pull and inspect an image from one of those registries, read the events of its own
  containers, and create, attach to, start, run commands in and remove a dev container. It is **an image that is ready to run**: a Dockerfile, a build section
  or features need a build, whose instructions the guard cannot read, so the worker refuses them on a laptop with one fixed sentence (they work on a cloud
  worker).
  - **Where the list comes from, and where it is on by default.** `ROVARA_DEVCONTAINER_REGISTRIES=a.example,b.example` is the list (`0` turns dev containers off). With nothing set, the
    default list (`mcr.microsoft.com`, `docker.io`, `ghcr.io`, `public.ecr.aws`, `quay.io`) is used **only when Docker runs in a virtual machine** that this computer reaches through its own socket
    (Colima, Docker Desktop on macOS or Windows), or the daemon says it is Docker Desktop or rootless: there a container's root cannot be root on your computer. On a **rootful Linux Docker host, and whenever
    this cannot be told, there is no default**: a dev container needs the variable set on purpose, because root in a container writing into the workspace folder is root on that host (it could leave a setuid file or files you cannot delete).
  - **What the list is, and is not.** It controls where pulls come from (a name on the list, never an address or a private registry), **not what the images contain**: anyone can publish to docker.io, ghcr.io and quay.io. The daemon makes
    the pull, so pulls **bypass the websites list** of the egress gateway, and a compromised worker can choose which public repository and tag to pull, or fill the disk. A dev container is the repository's own choice of image and holds the
    same trust as the repository's code, which is why it is held to the rules below.
  - **When a registry is listed, these dev container rules are the guard's floor.** A create whose image is not the worker's own is a dev container, so a compromised worker that wants a weaker container than a sandbox can have exactly this one:
    it may run as root inside the container (most dev container images need it), with Docker's default capabilities minus `MKNOD` and `NET_RAW`, and **no-new-privileges always on** (so `sudo` and other setuid programs gain nothing inside it). The
    sandbox's own stricter rules (every capability dropped, user 1000) still hold for the worker's image.
  Why this is safe, rule by rule:
  - *The daemon pulls, so the registry is the one place a name can reach.* The reference must be a plain name (a registry, a lower-case path, a tag or a digest) on
    the owner's list; an address, `localhost`, a port-only name, a space, a backslash or an option is refused, and a pull passes on the reference and the
    platform and nothing else (no import, no `changes`, no message). The list is the owner's: it comes from the environment of `rovara up`, never from a project.
  - *The create is built from nothing*, as a sandbox's is, under Docker's exact field names. A dev container is always on the machine's sandbox network
    with the sandbox name server (a request for another network is refused, not obeyed), never privileged, never in a host namespace, with no device, no port,
    no link, no added host, no sysctl and the memory and process limits forced. It keeps Docker's default capabilities minus `MKNOD` and `NET_RAW`; the only one
    it can add is `SYS_PTRACE`, and its security option is always `no-new-privileges` (forced; the worker's own check of the started container accepts exactly that one).
    It carries the guard's labels, which the worker cannot set or remove, so the guard recognises it as its own.
  - *Mounts are the workspace folder itself, at its own path, and the worker's mask volumes.* A bind of any other path is refused, and so is a path **below** the
    workspace: a link a task makes inside the workspace could point a deeper path anywhere on your computer, and the guard cannot resolve links the daemon will.
    The dev container tool would also mount the repository folder on its own, so the worker gives the tool the project's config with its workspace mount and
    folder set to the workspace and the repository at their own paths (`--override-config`, written in the worker's own hidden folder); the project's own
    `workspaceMount`/`workspaceFolder` are not used, and its other settings (`image`, `postCreateCommand`, `remoteUser`) are. Each mask volume of the worker over its own
    folders becomes an empty read-only tmpfs mount over the same folder: no volume is ever made, and the worker's folders stay hidden.
  - *Everything after the create goes through the owner label.* The guard asks the daemon itself whether a container is its own before any start, attach,
    command, log or removal; the events it reads are filtered by that label (the guard adds the filter), so no other container of the daemon is named in an answer;
    a command may name any plain user, `root` included (the worker itself runs one as root to prepare the container) and is never privileged; an attach takes the options a `docker run` uses and no body, and bytes pass only after the daemon
    said `101`. `docker cp` into a container stays refused (the worker's file tools then use a sandbox of their own for the dev container, as they already do when the copy is refused).
  With the list empty the guard answers exactly as before. The same worker code starts a dev container on a cloud worker as before (no override, the build allowed).
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

### Test services and saved environments on the Docker worker (both off by default)

**Test services** (`ROVARA_TEST_SERVICES=1`). With a registry to take the service images from (`ROVARA_TEST_SERVICES_REGISTRY`, and `ROVARA_TEST_SERVICES_CATALOG_ENV`, default `local`) and a signed service catalog this release
trusts (`ROVARA_SERVICE_CATALOG_DIR`, else `./service-catalog`: `catalog.json` and `catalog.sig.json`), `rovara up` pulls the catalog's images by digest on the host (only what the catalog pins; images you already had are
never removed) and starts the worker with test services configured. The worker then makes an internal Docker network per run, starts the pinned images on it, and runs a sealed check sandbox on that network alone. It can do this because
the Docker socket guard (`packages/broker/src/local/isolation`) gains narrow rules, only for installs that turned services on. The guard accepts only these shapes: networks named `rovara-svc-<hex>` on `172.30.<slot>.0/24`, internal, with the
run's labels; catalog helpers from exactly the pulled references, as a fixed non-root user; worker-image programs from files shipped in the worker image; the sealed check sandbox; and the resolver guard. The resolver guard is the one root
container with NET_ADMIN: it runs from the worker's pinned image with one of two fixed commands, in the namespace of the worker's own check sandbox. Run files (including per-run passwords, mode 0600, short-lived) live in
`<state folder>/test-services/<worker>`, which sandboxes never mount. The guard never mounts a path the worker could have changed: a file that goes into a service container is opened without following links, must be a plain file of the run folder (4 MiB at most), and is copied by the guard into its own folder, and the container gets the copy. A service container runs only as a non-root user and group of the same number, never the Docker socket's group; a worker program's environment never carries node options, shell start files or preloads. The guard makes each run network itself without an address on the host's side (so a container on it has no route to a service of the host or the VM), and refuses a network that has one. The guard keeps its copies of run files for an hour after the last use and then removes them. IPv6 is off in service containers and in the sealed check sandbox. Service containers together may not ask for more than three quarters of the machine's memory. A project's dev container is never joined to a run network, and each kind of container (task sandbox, dev container, service container) is told apart by the guard's own labels and held to its own rules for a command and an attach: a service container takes a command only as its own non-root user and no input on an attach. `rovara up` refuses to start test services when the host already has an address in `172.30.0.0/16`, the range the run networks use. Builds, pulls, volumes, copies and project images are still refused. **This release ships no catalog signing key**, so until the project names one, test services fail closed
with a clear sentence: nothing is pulled, the worker offers none, and a run that needs them is refused. Proved on Colima against real Docker (internal network, no route out, a non-listed image refused, the sealed sandbox reaches only its helpers);
not run on native Linux or Docker Desktop.

**Saved environments** (`ROVARA_SAVED_ENVIRONMENTS=1`). The image registry is one container of the registry image, named `rovara-image-registry-<hash of the state folder>` and labelled `rovara.local.registry=1`. It is published on
127.0.0.1 only, on a port Docker picks, with its images under `<state folder>/registry`, and started when first used; `rovara up` never touches a container of that name that it did not label. The registry has no authentication, so it is dormant for workers: the adapter refuses to be made with worker access, and the hosted product accepts only the hosted registry's own logins (`HostedSavedEnvRegistryAuthSchema`). Until the worker's socket guard has a rule for image build, push and pull (the build uses a privileged builder container the guard cannot inspect),
the adapter reports `workerPush` and `workerPull` as false: no image is built or pulled, and tasks set up fresh. The environment key also needs a recursive tree listing the code host port does not have yet, so no rebuild is queued.

**The nightly run and the local scheduler.** `rovara up` registers a timer inside its own process as the `scheduler` adapter (`createIntervalScheduler`, in `@agentx/local-adapters`). It runs UTC five-field crons and "every N minutes",
checks every 20 seconds, keeps its schedules in the state database so a restart keeps them, and delivers a fire missed while `rovara up` was not running once, late, if it is within an hour (older ones are dropped). It never runs a rule
differently from what it said: another time zone, or a cron that sets both the day of the month and the day of the week, is refused when the environment is approved. A project's nightly run exists only when `ROVARA_NIGHTLY_HEALTH=1` is set
and the test environment is not turned off (`ROVARA_TEST_ENVIRONMENT=0`). At each fire the core decides, from what is stored then, whether a model-free full run starts (the project has an approved environment with the nightly on, the default
branch moved since the last recorded run, no run is in flight, and fewer than 20 hours have passed). This install cannot start that run yet, so a fire is answered "unavailable" and nothing is charged or claimed; the schedule is kept so
nothing has to move when it can.

**A project's test environment** is proposed with `rovara test-env propose <project> <file>`, read with `rovara test-env show <project>` and approved on its page (`rovara test-env open <project>`): the page shows every value that changes, the
risk, and whether a Prove run passed, and offers Approve only for a proposal that was proved. Approving is your own act on the page, with a proof the page signs for exactly one request, revision and digest; the API token and the CLI cannot do
it. A task that starts afterwards pins the approved revision.

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
| How we work | the project's `.rovara/playbook.yaml`, read through the code host at the default branch's head (`core/playbook`), and the company's `company-instructions.md`, are put in front of every step as one block in the worker's system prompt (`core/instructions`, at the dispatch); the page `/how-we-work/<project>`, `rovara playbook` and `/v1/app/projects/<project>/how-we-work` read it. See `docs/how-we-work.md` |
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

**Models.** A task step is told the model route the install's per-step rule chose for it (with nothing set, the install's model: the `model` setting in the config, else the first of Anthropic, OpenAI and OpenRouter that has a key; see "Choosing the model" and "The model each step uses") and its capability lists `model-access`; the worker asks the broker's model proxy (lane L9a) for a token, bound to its workspace and operation, and the proxy adds the key. The flow requires the worker to list `model.route`, calls `modelProxy.operationEnded` when an operation settles, and grants a budget only when a run limit is held (see "What a task costs"). Plan and Understand documents are kept in the `object-storage` point under a retention class that never expires them.

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
- **Lessons:** `/rovara lesson <n> wrong`, `right` or `retire` marks or retires the n-th lesson in the pull request's "Lessons used" list (see "Lessons"). It cannot approve a lesson. A host without `comments` offers no comment way of approving.

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

## Lessons

Rovara learns from finished work: a merged or closed task is reflected on once, by the model your steps use and on your own key, and what it learns is kept as short typed advice (a title, a body of at most 600
characters, a scope, code citations that are checked against the repository) under the project. **It is on by default, in `Suggest` mode: every lesson waits for your approval on the lessons page, and none goes live by itself.** The reflection runs on your own model account, so it spends there. `ROVARA_LESSONS=0` turns it off (only exactly `0` does). While it is off nothing is reflected, loaded or sent to an agent and no model call is made; the lessons page still shows what exists. The switch covers the whole `rovara up` process, not one project; a project can still be set to `Off` or `Collect` in its own settings.

- **Capture** (`local/app/lessons.ts`, `lessons-sources.ts`): the `merged` and `closed` milestones put one message of ids on the `lessons-reflect` queue; the timer's lessons pass takes it, takes a lease on the task's outcome (so it is
  reflected on once, and never run again after a model call may have been billed), reads the task's record and asks for at most three lessons. What it reads: the request and your send-backs' reasons (a member's words), the approved plan and
  the reviews' findings (an agent's words: advice, never your correction), and the review comments on the task's merged pull requests, a member's only when the code host says the author is a person with write or admin standing there.
  Anything else keeps the class `outsider`, which is removed before the model sees it. Not captured here: "remember this" notes and a person's fix-up commits (no source for them on a laptop yet).
- **What happens to a lesson:** a project that never chose a mode runs as `Suggest`: every lesson waits for you. A project set to `On` with the Standard preset lets a low-risk lesson from a member's own correction go live **on trial** for 14 days; everything else waits for you.
  The mode, the preset and the approval levels are items in the store (`LESSONSET#...`, `MODE`) that a hosted install reads too; there is no settings page yet.
- **Approval is yours, on the page.** `/lessons` lists the lessons (`rovara open lessons`). Approve's form is bound to the lesson's own text and version; the page signs a proof for exactly that, and the `approvers` point verifies it
  (`kind: "lesson"`) before the library's approval runs. Only the page's own proof counts: a comment can never approve. A tier-2 lesson (it reaches reviewers or checks) needs two people: on a laptop you are the only one, so it goes through the sole-owner exception, which is recorded as such. Retire and Wrong
  need no proof, but they are your act on your page. The API token an assistant holds only reads: approving, retiring, marking a lesson and switching the lessons file all answer 403 with the way to the page (`rovara open lessons`).
- **Loading:** when a step's invocation is built (understand, plan, code, review), `TaskFlowDeps.learned` asks the loader for the lessons that fit the task (keywords and cited paths, plus the embedder when `ROVARA_LESSONS_EMBEDDER=local`),
  records what it loaded and gives the worker a `learnedContext`; the worker checks every citation against the task's base commit and reports which lessons reached its prompt (`learnedLoadReport`), which `callbacks.ts` applies to the load record.
- **The pull request** says which lessons the task used under "Lessons used": the count, and for a repository the host says is private the titles with the number a comment names (`/rovara lesson 2 wrong`).
  A lesson from a restricted source is only counted. With lessons on and none used yet the section says "None used yet"; with lessons off it says so. The numbers are the list as it was written into the description, kept: a later round, or a lesson retired since, does not change what a number means.
  A writer's comment acts as that writer, never as you: `wrong` and `right` are marked for the person the identity point says the account is (an account it does not know does nothing), and `retire` only records a request, which the lessons page shows beside the lesson until you press Retire there (retiring cannot be undone).
- **Lessons in the repository:** per repository, off by default. The lessons page has a switch for each repository (`rovara open lessons` opens it in a new page session; switching **on** needs a page opened in the last ten minutes) that lets the weekly pass propose `.rovara/lessons.md` in one pull request containing only lessons
  learned from that repository's own review comments. The code host needs `commitFiles`, `deleteBranch`, `pathKind` and `changeRequestForBranch`. A code host that cannot say who opened a pull request is still handled: Rovara's old pull request is found by its branch name and the commit it left, and closed before a new one opens.
- **Routes** (same paths as a hosted install): all reads: `GET /v1/app/projects/<p>/lessons`, `.../lessons/<id>/history`, `.../lessons/repo`, `GET /v1/app/tasks/<task>/lessons`. The writes on the same paths (`POST .../retire`, `POST .../lessons/repo`, `POST .../feedback`) answer 403.
- **Not here:** the team record (a hosted install's lake of source rows), the weekly digest's delivery, replay of past tasks, the nightly re-reflection of reverted tasks (nothing in `rovara up` calls the revert detector yet; `lessons.noteReverted` is the seam),
  and the suggested rules of the older learning loop (they belong to How we work).

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
`agentx_get_session`, `agentx_tell_session_agent` (saved as a note and, when a step is running, given to it), `agentx_stop_session`, `agentx_comment_on_session` (refused: one owner) and `agentx_get_diagnosis` (read only: see "Fix with agent"; `rovara diagnosis <task>` is the command). These answer "That is not on this install yet" because their features are not in Code yet:

| Tool or command | Waits on |
| --- | --- |
| `agentx_list_agents`, `agentx_run_agent` | custom agents |
| `agentx_list_approvals`, `agentx_open_approval` | approvals of connected systems and step gates; a plan waiting for you shows as a session that needs you |
| `agentx_share_task`, `agentx_get_task_people`, `agentx_set_task_person`, `agentx_take_task_ownership` | channels and task people |
| `agentx_review_workflow_candidate`, `agentx_send_workflow_back`, `agentx_resolve_review_findings`, `agentx_retry_workflow_publish`, `agentx_keep_pull_request`, `agentx_open_pull_request` | the owner-side review and publish controls |
| `agentx_get_pr_feedback`, `agentx_decide_pr_feedback` | pull request feedback review |
| `agentx_continue_task` | a task's budget |
| `rovara session merge` | the local Merge button, which is not built (see "Not wired yet"); the core's `prepareMerge` and `pressMerge` exist |
| `rovara session link`, `rovara home`, `rovara lessons` | linking a session to a ticket by hand, the web feed, lessons (a task started from a ticket is linked by intake: see "Tickets that ask for work") |

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
- **What is kept.** The request item holds ids and a state and never the question. The answer is kept 30 days (`ASK#<id>`), with the owner's words redacted, and is shown only to the person who asked. Each Ask is audited (`task.asked`: ids, never the words) and its usage is recorded against the task's cost (a response that says nothing of what it used is charged the most it could have cost). Before it spends, an Ask asks the install's `admission` for a `model.call` with an estimate (the default allows everything; a company's budgets plug in there), and the reservation is **settled** with the usage (or the estimate, when the call said nothing of its use) as soon as the provider may have been paid, whatever happens to the answer next (an empty answer, a failing write, a timeout or abort after the send), and given back only when nothing was sent (no model, no credential, a request the guard refused). A failure that is Rovara's own (no model, a request the guard refused) gives the rate slots back. `ROVARA_ASK=0` turns Ask off: its routes answer "not found" as if they did not exist; it is on unless set to `0`.

## Fix with agent: a diagnosis of a task's error

A task that is blocked or has failed shows a **Fix with agent** button on its page (`rovara open <task>`). Pressing it asks an AI model to read the error's data and say what it thinks went wrong, with suggestions. It is read-only: **it changes nothing**, and a suggestion (retry the step, tell the agent something, start a new task, a setting to look at, steps outside Rovara) is text. What it suggests, you do with the page's own forms (Retry, the plan's decision) or in your own terminal.

- **Who pays.** You do, on your own model key: Rovara never pays for a diagnosis. With no key, or with a model whose price Rovara does not know, the button is not shown and the page says why (a model with no price is refused, never guessed: its spending limit cannot be held). The price is the catalog's, else a `model-provider` plug-in's own table, and only in dollars (a table in another currency is not read as dollars: the model counts as unpriced). A price of zero is no price, **except** for a model the plug-in marks `"free": true`: that is the plug-in's own word that the model costs nothing, so it runs at a zero rate and its cap never binds. The button is also not shown when the most the call could cost, for this much error data on this model, is over the spending limit (the proxy's own worst case: one token to each byte of the request plus the output limit), so a press is never spent on a call that could only be refused. The model is the one your steps use (the `model` setting, else the first provider with a key).
- **How the call is made.** Through the local model proxy, as a one-shot operation of its own (`core/diagnosis`, `local/diagnosis-model.ts`, `local/model-proxy/one-shot.ts`): the broker mints a token for that one call, the proxy checks the request with the same guard a worker's call passes (no tools, nothing kept at the provider), holds the call to a spending cap of `DIAGNOSIS_LIGHT_BUDGET_USD` (0.25 dollars) priced from the model's own rates before any key is read, reads your key from the `model-keys` port, signs the call, meters what it used through the `metering` port against the task, and cuts the key from the answer. The token and the operation end with the call. Before it spends, a diagnosis asks the install's `admission` for a `model.call` with an estimate (the default allows everything), and the reservation is **settled** with the usage (or the estimate, when the call said nothing of its use) as soon as the provider may have been paid, whatever happens to the answer next (no suggestion survived, the write failed, a timeout or abort after the send), and given back only when nothing was sent (no model, no price, a refusal before the proxy forwards). Ask holds its allowance the same way.
- **What it is given.** The rules, then the error's data, each part in a tag only this install can name: the task's title, the failure's message, the block reason's sentence, the step's status lines and the names of failed checks, and the project's non-secret settings. Everything in the data is untrusted (redacted, one line, inert) and the rules say so. A secret is never read.
- **What comes back is read again.** The answer is turned into a closed set of suggestions (an unknown kind or field drops the suggestion whole; a settings change off the allow-list is dropped), every free-text field is redacted, one line and inert, and at most 8 are kept. Nothing a model says is ever applied. A **settings change** is shown as text only: a laptop's code settings are fixed, so "Apply this change" has nowhere to go, and `POST /v1/app/diagnoses/<id>/propose` answers that.
- **Who can start one.** Only you, on the page, in your browser session: the form is bound to the error as the page showed it and to that one press. A tool with the API token (the CLI, an MCP client) can read, never start: `POST /v1/app/diagnoses` answers where to press the button. If the error changed since the page was drawn (the task moved on), the press is refused as stale.
- **Reading it.** `rovara diagnosis <task>` and the MCP tool `agentx_get_diagnosis` (`GET /v1/dev/tasks/<id>/diagnosis`; `GET /v1/app/diagnoses/<id>` for one by id) say whether Fix with agent is offered for the task's error and what it found. What it found is an AI model's words: shown as plain text and handed over as information, never as instructions.
- **Limits.** 10 diagnoses an hour for you and 50 a day for a project; the same error answers the existing diagnosis for an hour and spends nothing (a failed one lets the error be asked again, with "Try again"). A diagnosis that nobody answered in 15 minutes reads as failed.
- **What is kept.** The result's `costCents` is always 0: the cost is metered by the proxy against the task, not written on the record. The hosted product's rows (`DIAGNOSIS#<id>`: the request with the context text only while it waits, the result for 30 days, the person link and its index, `DIAGNOSISOPEN`, `DIAGNOSISRATE`). The audit records `diagnosis.started` and `diagnosis.proposed` carry ids, fixed words and counts, never the error's or the answer's text, and commit with the change they record (`audit-sink`).
- **Switch.** `ROVARA_DIAGNOSIS=0` turns it off: the routes answer "not found" as if they did not exist and the page has no such part; it is on unless set to `0`.
- **Not built.** The deeper look that reads the repositories with a read-only worker run, and "Apply this change" for a setting (both answer "not on this install yet"); errors of a project's setup check, a connector or a model's access (no setup check or connector health exists here to read again).

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

## Browser and API checks (E2E)

The committed source of a coding run (`candidate-export`, `candidate-build-source`, `baseline-source`) is kept on the object-storage point for a task whose approved plan needs these checks, so a round has the exact code to run from; any other task's uploads are answered and nothing is kept. A worker reads its round's admission and uploads its evidence through the same callbacks. When a candidate's
checks end, the build step verifies the round from what was stored (`core/e2e/verification.ts`) and the checks pass only on a round the broker judged itself.

What does not run on a laptop yet, and why:

- **A round cannot start.** Starting one needs a qualified runtime: a Linux ARM64 host whose operating system and kernel are recorded in a registration that an administrator issued a challenge for, a pinned executor image, and the project's approved E2E setup (targets, accounts, mocks).
  Cloud's registration is for an EC2 host (`deploymentMode: ec2-ebs`); a Docker worker on a Mac is a different kernel, and the worker compares its host with the admitted runtime before it builds anything. This install has no runtime registration and no project setup approval, so the
  authority has no `currentSelection` and every round is refused as unverifiable. Nothing is skipped silently: a task whose plan needs the checks stays at the checks.
- **The committed source of a larger code base** does not fit the default object storage of `rovara up` (objects kept as documents, about 290 KB each). A task that does not need the checks is not affected. A task that does stops at its checks with one fixed sentence, and the run's result is not lost. Kept sources stay until deleted. Name the folder object storage (`@agentx/local-adapters/object-storage`) for the `object-storage` point to hold up to the export bound.
- **The plan with an E2E section** comes from the structured plan (a plan the planner wrote in the structured format); a Markdown plan has none.
- **AI navigation steps** are charged through Cloud's spend ledger; Code has no dollar cap on them yet.

## Tickets that ask for work, and what is written back (`rovara intake`)

A ticket in a tracker can start a task, and a task writes its progress back to that ticket. A ticket **never approves anything**: the plan still waits for you on its page, like every plan.

- **Sign in to the tracker.** `rovara up` registers a tracker when it finds your sign-in, read through the `secrets` socket each time it is used (never kept): **Linear** with `LINEAR_API_KEY` (or an entry `linear` in `<state folder>/keys.json`); **Jira** with `JIRA_SITE_URL` (an `https` address on `atlassian.net`; a token is never sent anywhere else), `JIRA_EMAIL` and `JIRA_API_TOKEN` (or an entry `jira`). A `tracker` plug-in of the same name in the config replaces the built-in one.
- **Say which accounts are yours.** In the config, `linkedAccounts` lists your own tracker accounts in the neutral outside-account shape: `{ "provider": "linear", "tenant": "", "accountId": "<your Linear user id>" }`, or `{ "provider": "jira", "tenant": "acme.atlassian.net", "accountId": "<your Jira account id>" }`. A ticket starts a task only when its tracker's own history says an account listed there made the act that asked (a label put on it, or an assignment). Nothing else is believed: not the ticket's words, not a name or an email. With none listed, every ticket waits for you.
- **Name where a project's work is asked for** (the project's intake rule): `rovara intake add <project> linear --label rovara` (or `jira`, or `--assigned` for tickets assigned to the account Rovara signs in with: with your own key that is every ticket you assign to yourself, and each starts a task), `rovara intake clear <project>`. Up to eight places a project; `rovara up` reads each on a timer (every 2 minutes by default, at most 60 reads an hour a place; there is no webhook on a laptop), backs off when a read fails, and shows a failing place with its code in `rovara intake list`.
- **What waits for you.** A ticket nobody linked asked for, an automation's, or one made right after Rovara changed it waits, with the reason. `rovara intake list <project>` shows them; `rovara intake start <project> <id>` starts one (the task is yours, and the start goes through the same admission and limits as any start); `rovara intake dismiss <project> <id>` drops one. The MCP tools `agentx_get_intake`, `agentx_start_intake_ticket` and `agentx_dismiss_intake_ticket` do the same; start and dismiss are acts to take only when you asked for them.
- **The ticket is data.** Its words are redacted, made inert (no mention, link, image or hidden character) and cut, and ride in the task's request under a line that says who wrote them and that they are information only. The same ticket is one item however often it is read. A poll never starts a ticket again once its task has ended, even if you put the label on again (only a delivery from a tracker's hook, which a laptop has none of, is a new ask); file a new ticket to ask again.
- **What is written back** (`rovara intake updates <project>`): a comment on the ticket the task started from at five moments (the work started, the plan is ready for review, a pull request opened, merged, closed), with the title and the pull request's link and nothing else (no plan, code or summary). Comments are on, and Rovara says plainly where they can be seen: a comment is internal only where the tracker has internal comments (Jira Service Management); a Linear comment, with the pull request's link, is visible to everyone who can see the ticket (turn comments off with `--comments off` if the ticket is wider than the repository). Moving the ticket's status (`--status on`, to the project's own status names, `In Progress` / `In Review` / `Done` by default) is off until you turn it on. Only the ticket intake started this task from is written to; a comment is internal where the tracker can tell; at most 12 writes a task and 120 an hour a tracker. A tracker that refuses a write (its sign-in may only read) is noted and never fails the task. A Linear ticket's pull request says `Fixes <KEY>`, which Linear's own GitHub integration closes the issue on.
- **Where it is stored.** Tickets, sources, claims and settings are rows in the document store under Cloud's key layout (see `docs/ports.md`, "Tracker intake and write-back"). The routes are under `/v1/app/projects/<project>/intake` (a POST where Cloud uses a PUT, because `rovara up` answers GET and POST only).

## Connections, context sources and registered MCP servers

A **connection** is a key the owner gives Rovara for a tracker (Linear, Jira), an MCP server at a public address, or a monitoring service (Sentry, Datadog, Grafana, PagerDuty, Vercel). A project's **context
sources** are read-only systems a stage may ask while it understands, plans, checks the plan or reviews (never while the code is written). A **registered MCP server** is one on the owner's own network.

- **Adding, changing, checking and removing a connection, ticking a source's tools, approving a server and confirming a source are the owner's acts on the Connections and Sources pages** (`rovara open connections`), in
  a page session opened in the last ten minutes (decision 66). The API token that a tool may hold reads (`GET /v1/dev/connections`, `/v1/dev/context-sources?project=`, `/v1/dev/mcp-servers`; `rovara connections`; the
  `agentx_list_connections` and `agentx_get_context_sources` MCP tools) and every write is refused with the page message. A key typed on the page goes to one file only you can read (see `docs/ports.md`, "Connection
  secrets") and is never shown again, put in a record, an audit event, a log line or an answer.
- **A source is proposed, then confirmed.** The Sources page lists the tools a connection or an approved server offers, with what Rovara checked on each (its own hint that it only reads, a name that sounds like a change,
  a schema that takes an address). A tool that does not say it only reads needs the owner's confirmation ("I confirm it only reads"); a vendor connection that may be sent code is flagged for a second look. One owner decides:
  the person who proposed a change confirms it, after reading what it asks. The change is checked again against the server as it is when it is confirmed, and a tool that changes afterwards is off until ticked again.
- **What a stage reads is data.** A stage with sources is dispatched with the `context-tools` capability and `contextSources: true`, only on a worker that lists `task.contextSources.v1`; a stage with none, and Build,
  get neither. The worker's calls go to `GET /v1/internal/context-tools` and `POST /v1/internal/context-tools/call` through its own gateway, which stamps its workspace; the broker checks the capability, the stamp, the
  fence and that the operation is the workspace's live one. Every call is checked again (the stage, the ticked tool and its hash, the allowance of calls and bytes, small arguments with no code, no credential and no
  address off the source's host, a time limit), and the answer is cleaned, cut, framed as untrusted text and recorded as a citation. A source's text is kept only as its retention allows and a `live_only` text is
  deleted when the task is closed.
- **Reaching a server.** A connection's public address is checked before every request and the connection is pinned to the addresses checked. A registered server on your network is reached only inside the ranges the
  operator names (`ROVARA_PRIVATE_MCP_CIDRS`, with `ROVARA_VPC_CIDRS` for the network Rovara itself is in: on a laptop that is the ranges of the Docker networks Rovara makes for a worker, its gateway and its sandboxes, and any private range of your own that must never be probed. A private range that overlaps it stops `rovara up`); with none named every private server is refused, and an address that is this machine, link-local, a metadata
  address or inside Rovara's own network is never called.
- **Not here.** Servers that Rovara would run from a package (`stdio`) need an MCP host; Code runs none, so they are off (`ROVARA_STDIO_MCP_SERVERS=1` with `MCP_HOST_URL` and `MCP_HOST_TOKEN` names a host an operator
  runs, over https). The gateway's own runner for such servers stays out of Code until it can run them inside Docker under the rules of "What a worker can reach". Monitoring connections are saved, checked and listed.
  Their tools are **not yet usable by an agent on a laptop**: the five connector types are registered (`BUILT_IN_CONNECTOR_TYPES`), but the local task flow does not call the connector engine, and the per-company credential
  registry (`connections/registry.ts`) that those connectors read their settings and key through is not wired into it. They are also not yet a kind of context source.

## Automation (hidden): chains, triggers, automatic runs and custom agents

Work that starts with no one at the keyboard (an event or a schedule starts it) is built in the core and **kept hidden**. It is off unless the owner switches it on when `rovara up` starts: `ROVARA_AUTOMATION=on` in the environment of that process (or the runtime's `automation` option). The switch is read from the process the owner runs and from nowhere else: no route, API token or page changes it, so an assistant cannot turn unattended paid work on.

- **Off (the default).** Nothing of it exists for the rest of the install: no route is mounted (the commands answer as they did before), the `/automation` page is not found, a tick does nothing, an event or a schedule fire starts nothing, and nothing is counted or asked of `Admission`.
- **On.** The routes are `/v1/app/agents`, `/v1/app/chains`, `/v1/app/triggers` and `/v1/app/chain-runs` (JSON, for the owner's own tools), and the page is `rovara open automation`. A trigger is made OFF. **Turning it on is the owner's act on the page**, for exactly what it is now (its target, project, event or schedule, hook and hourly limit): the page signs a proof over that, the `Approvers` port checks it, and a change to the trigger afterwards makes the proof stale. The API token is told where to go (403). A chain's gate is decided the same way, with a proof for the answer it gives (continue or stop). A trigger is turned on for the version of its chain or agent as it is: a publish or an archive turns its triggers off, and one that missed it is turned off at its next event. Turning a trigger off, stopping a run and starting a chain run are open to the owner's token, as starting a task is.
- **Every unattended start goes through one door** (`core/automation/run-seam.ts`): the switch, then a check that a dollar cap is enforced (see next point), then `Admission` (action `automation.run`, keyed by the request's own id, before anything is written, carrying the run's dollar limit as its estimate), then the install's starter. The reservation is recorded with the run, settled when the run's task ends (with what the install says it cost) and given back on every path where no run was made.
- **Work that can use a model is started only where a dollar cap is enforced, whether or not the run names a limit** (a run with no limit has nothing holding it at all; only a model-free automatic job is let through). **What counts as enforcing is the adapter's own declaration: the registered admission must say `enforcesCost: true`.** A missing value, `false` and any other value count as not enforcing, and the adapter's name is never read, so an adapter that ignores the estimate (an allow-list, a logger) cannot switch unattended spend on by accident. On a plain install the default admission allows everything and Code has no per-task dollar cap of its own yet, so nothing starts on its own (and a trigger is not turned on): the page says why. A chain step reserves only its own share of the run's limit (an equal share per agent step, never more than the run has left; a step with no cost figure counts at the whole share it was granted). A run's minutes are held for chain steps (the step's timeout, which stops the task) and for every other unattended run (a sweep that stops the task); the time a task waits for the owner's answer is not counted, and a retry never starts beside a task that may still run. A refusal starts nothing and takes nothing. On top of that: the trigger's allowance for the hour, the company's for the day, one start per event (or per schedule slot), no start for what Rovara itself did, no second start for the same subject within the guard window, no overlap of a schedule with its last run, a chain's concurrent runs, a run's step count and traversals, and a project's monthly cap on automatic runs (the cap of 0 pauses them all).
- **It never approves anything.** The starter here starts a Rovara Code task for the project, as the owner, in the human-gated workflow: the task stops at its plan until the owner approves it on its page. An event's own words go in as a marked line of information, never as the request. No automation file imports a decision, a merge or a review module, and the only place a proof is checked is `core/automation/authority.ts` (held by `tests/unit/automation-boundaries.test.ts`).
- **A custom agent cannot be wider than the project's rules.** An `agent` step has the read-only workspace tools at most (the recipe contract's own limit); a coding recipe's `build` step has the tools Rovara Code's own has, no more, so a custom agent is not read-only, it is never given more than its kind of step gets; a connector tool the project's action policy denies cannot be granted, and one it says to ask about is added to the agent's always-ask list (a policy only adds); a grant that writes is refused (no tool bridge, so no person's approval per change is possible yet); the autonomy is held to the guardrails' ceiling; a recipe names no host, so it cannot widen the sandbox's network. An unattended run uses a published version of an active agent only.
- **Stored keys** are the shared layout, unchanged (`AGENT#`, `CHAIN#`, `CHAIN_RUN#`, `TRIGGER#`, `AUTOMATIC_RUNS#`, `AGENT_GUARDRAILS`, ...). Code-only rows: `AUTOMATION_PROOF` (a used proof) and `CHAIN_STEP_TASK#<task>` (a step's task back to its run).
- **Not on this install yet** (each is refused in words, never started some other way): a custom agent's run (it needs the agent-run bridge: the connector tool routes, the write gate and the skill registry), a model-free automatic job through the task flow, vendor webhooks (a laptop has no address a vendor can reach), schedule triggers in a time zone other than UTC (the local scheduler runs UTC only; it is refused when the trigger is made or turned on), and a CLI or an MCP tool for any of it.

## What a task costs

**The price table.** A model's price is looked up in one place (`core/cost/price-table.ts`) and everything that needs a price asks it: the cost ledger, the second review's spend cap, the models page and the per-step model rule. In order: (1) the `prices` of the model's own `model-provider` plug-in (per million tokens, keyed by the provider's model id), which is the price a cost is recorded and shown at, so a negotiated or gateway price is stated once; (2) the installed catalog's list price (US dollars) for `anthropic`, `openai`, `openrouter` and `amazon-bedrock` (a Bedrock inference profile is priced as its model). A model neither knows is **unpriced**, and unpriced is never free: its usage is recorded as unknown (the cost line says "N calls not priced"), and a catalog price of zero counts as no price, because a budget would pass every call of it. Two things make a model free: OpenRouter's `<model>:free` variants, by a built-in rule (priced at exactly zero, so they run under a limit and their calls are kept at no cost), and a plug-in's own `"free": true` for a model the catalog lists no price for. A plug-in may not call a model free that the catalog prices (`rovara up` refuses to start and says which), and **a budget never assumes less than the catalog's list price**: for a held limit, the second review's cap and a diagnosis's cap, the price is the dearer of the plug-in's and the catalog's, component by component, so a slip in a plug-in's table (dollars where micros belong) cannot make a paid model cost nothing under a budget. A price in another currency than dollars is no price to a dollar cap. Cache tokens are counted at their own price where one is listed, else at the plain input price, which can over-count and never hides spend.

**The estimate.** When a coding plan is stored, the task gets `runEstimate`: from the project's last twenty runs of that path once there are five (the p50 and p80 by nearest rank, each rounded up to fifty cents), else the default for the path (quick $1 to $3, full $4 to $10, other $2 to $5). The run limit is twice the high end (never above $1,000). It is shown to tools (`runEstimate` on the task, `agentx_get_task`), feeds the plan's risk tier (a plan expected to cost more than $25 is at least medium) and the session's cost line. Closing a task records what it cost (from the cost ledger) for the next estimate, once; a run with a call that had no price is marked and never teaches the estimator, which would otherwise think runs cheap.

**The run limit** is held by default (`ROVARA_RUN_LIMIT=0` turns it off): each task's model calls are held to its limit on the model proxy. Planning has an allowance of its own before a plan carries an estimate ($2 for a quick task, $6 for a full one), and after that the task may spend the planning allowance plus the run limit in all. **What a worker's call costs is kept in the task's cost ledger** (the proxy records through the app's meter, which prices the call and writes the ledger entry once), and the ledger is what the task has spent: each step's token is given the limit less that spend, so a retry, a send-back and the next step are held to what is LEFT of the task, not to the whole limit again. A token made again for the same step (a worker asks for a fresh one every fifteen minutes) takes back what the proxy already holds for that step, so a step's own spend is counted once. The plan page's "Spent so far", the session's cost line and the record a close keeps for the next estimate read the same ledger. A spend in another currency leaves nothing, so the proxy refuses rather than guess. **With a run limit held, a model with no price in dollars is not used**: the proxy answers a budgeted call to it `403 model_not_priced` (its own error type), the per-step rule does not offer it (a step it would have run ends before any machine starts, saying which model has no price and how to fix it), the owner cannot set it on the models page, and the model runtime reads that refusal like a model an account may not use. A gateway with no price table, or a local model, needs `prices` (a local model: `"free": true`) or `ROVARA_RUN_LIMIT=0`.

What the limit does not hold: it is one allowance per token, taken when the token is made, so calls of one step that run in parallel are held to it together (a reservation per call), but two steps of one task at the same moment would each start from the same remaining figure (a task runs one step at a time). A design review's reviewer slots and a diagnosis have ceilings of their own and are not stopped by the task's limit; their priced calls are written to the task's ledger when they carry the task, so they count against what the next step may spend. A task whose plan is not a coding plan has no estimate, and stays at the planning allowance for its whole life. A call whose record could not be kept still counts against its own step, but not against the next one. Budgets, top-ups, who pays and the stops they cause stay in the hosted product; on this install the `Admission` and `Metering` seams are where they plug in.

## The model each step uses

Each workflow step runs on a model the install's rule chooses as the step is handed to a worker (`core/model-selection`, one choice function shared with the hosted product): understand and plan (one setting), plan check, build, code and security review (one setting), pull request feedback. The choice is kept on the operation (`modelChoice`, with the stage, the route, the thinking level, the reason and any fallback), so a repeat delivery sends the same model, the model proxy's token names exactly that route, a plan check and a review say which model they checked, and the second review reads which model wrote the code. A step with no model of its own (running the checks) and a design-review round (which carries its own models) keep the install's model.

- **With nothing set**, every step runs on the install's model, as before, and a plan check or review says it is the same model. The owner may ask checking steps nobody set to use **the strongest model of a different AI company** than the step they check (when the install can call one; else another model of the same company, else the same model, said so); that is the hosted product's default for reviews, and is a choice here because it can raise the cost.
- **The owner's setting** is on the models page (`rovara open models`; `rovara models open`): per step group, a model, a thinking level, a backup used when the first cannot be called, and a rule that a checking step differ from the step it checks (another model, or another AI company). A checking step cannot be set to the model of the step it checks. A less-safe change (a weaker model for a check, a new AI company, the same model as the step it checks) is made only when this install's approval rules let the owner approve their own change. Every change is the owner's act on the page, in a page session opened within the last ten minutes, against the revision the page was drawn at (a stale page changes nothing), and is audited in the same transaction. **The API token, the CLI and the MCP tools only read it**: `GET /v1/dev/model-selection`, `rovara models`, `agentx_get_model_selection`; a write over the API is refused with the page's words.
- **A model a call to which was refused** (not enabled for the account, or not priced under a held limit) is remembered for 30 minutes and left out of default choices; a model the owner chose is never quietly replaced (its backup is used, or the step says why it cannot run).
- The setting is kept as the hosted product's company policy row (`ORG#<company>#SETTINGS` / `MODEL_SELECTION_POLICY`, same attributes); Code adds one attribute, `reviewDefault` (written with every change made here), which the hosted reader ignores. A row that does not carry it reads as the host's default for it: `install-model` on a laptop; a host whose rule is different-company passes that in. The record of refused models is the hosted row `SETTINGS` / `MODEL_USABILITY` (`failed#<model>` attributes only; no availability probe). Left in the hosted product: locks, per-project choices, the sources a company brings (its own keys, endpoints, an AWS role), a person's own plan, the second-person confirmation of a less-safe change and the preview of a change across projects.

## Not wired yet

- **Merge from `rovara up`.** A person merges a draft pull request on the code host (or with their proof); merge tracking never presses Merge (owner decision 1). The owner's own Merge button on the local page is not built;
  a merge made on the host is seen by the next tracking pass and recorded (see "Merge tracking by polling").
- **A GitHub client for the laptop.** No `GitHubCodeHostProvider` exists for a personal token or `gh` (L7A-4): Cloud's client is a GitHub App client. Until one passes
  `runGitHubClientConformance`, no `code-host` adapter is registered, and a worker's clone credential is the owner's token itself, given only for a repository on github.com over https and only to clone (no push credential is given yet; lane L11 brings a scoped one).
- **Ask, Revise the plan and Close in the CLI, in the MCP tools and on the local page** are not wired: the routes above are what they will call (the tools, commands and a page form are built separately). Stop and redirect (the owner stops a coding step to give a new instruction) is not ported.
- **Design review** runs (see "Design review" below); its CLI and MCP surfaces are not built yet. **Notifications** and chat need a `channel` adapter (see "Chat and notices"); none is set up by default.
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
  three. The credential provider is built once and the credential cached until a minute before it expires. `rovara up --check` says which identity Bedrock will use. Bedrock models are priced from the catalog's list price (an inference profile as its model) unless you set `prices`,
  and a task with a budget is refused for a model that has no price. A missing SDK module is reported as "AWS credential module missing". A "signature expired" answer is reported as "check your computer's clock". The paths and the
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
  worst case. A model with no price, or priced in another currency than the budget, cannot be held to the budget and is refused (`403 model_not_priced` for no price). A price comes from the model's provider table, else the catalog (see "What a task costs").
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


## Setting a project up (the setup agent)

`rovara setup-agent start <project>` (or the "Set up this project" button on `/setup/<project>`, which `rovara setup-agent open <project>` opens in your browser) asks Rovara to run the
project's setup and test commands in a setup sandbox, read the errors and try again, inside fixed limits (40 commands, 3 tries of the same failing step, 45 minutes, about $4 of model use, 5 website asks),
and to end with a **proposal**: the setup commands, test commands and other suggestions it found, each with the file and line it came from. A run is a task with `purpose: "setup_agent"`: it starts through the task flow
(your access, the admission seam, the open-workspace limits), prepares its own workspace, and is paid for by your model key through the model proxy. It needs a model key and `ROVARA_SETUP_AGENT` not `0`.

- **One run per project**, its limits fixed when it starts. Stop (`rovara setup-agent stop`) ends it; what the worker reports as it stops is kept as a partial, unproven proposal. The task flow's own cancel stops the worker's machine, so on a
  laptop a stopped run keeps only what it had reported by then. The run's workspace, machine and slot are given back when it ends.
- **A run never grants anything.** The worker's callback (`setup-agent`) is one action for a RUNNING setup operation: it reports commands (kept once per position, redacted again, at most 400), asks for a website and polls for
  the owner's next command. The company, project and task come from the authenticated operation, never from the body, and a person is never named by the worker.
- **Websites.** A name a command could not reach becomes an ask only after the broker's own checks: addresses, private names, paste, shortener, tunnel, webhook and open-hosting names are refused without a card and only counted. On a laptop the run shares the machine's
  sandbox network and name server (the Docker guard allows no network or helper of its own), so **no blocked website is reported**: a command that needs a site the list lacks just fails. A host ask from a worker that does report one (a cloud worker) is an
  ask row you decide on the page; approving it adds the name to the websites that **project's** machines may reach (the page lists what you allowed, with the date, and "Take it back" removes one from the next machines) **when one next starts** (`extraAllowedDomains`; a machine that is already running is not touched, and another project's never sees it).
- **A command you type** is the owner's own act on the page (a signed page session, never a script token or the API login): one plain line of at most 1,000 characters, one at a time, at most 20 a run, refused if the redactor would change it. It runs in the sandbox, as
  typed, and its result is shown to the agent as data.
- **Using what it found.** "Use this setup" first re-reads every citation from the code host at the commit the run read (an item whose quote is not there is left out, and a re-read that could not finish is not a pass). It then stores the confirmed setup and test
  commands as a **candidate** revision of the project (the next number, written but not made the project's latest, so no task can start on it) and starts a check on a **new workspace** with exactly those commands. Only when that check passed does the page offer the approval, and
  the approval is the owner's page session through the approval gate and the Approvers seam, bound to the digest of those commands and the candidate revision. Approving moves the project to the candidate in the decision's transaction (and only if the project is still at the
  revision you looked at); rejecting removes it. While one waits, another new revision of that project is refused. Only setup and test commands are applied this way: a repository, dev container, source, intake trigger and secret are shown and left to your own settings.
- **The project's setup check** (`rovara setup-agent check`, and the last panel of the page): runs the project's setup and test commands at its latest revision on a fresh workspace. The status is derived on every read (unchecked, outdated, checking, failed with the step that failed, ready);
  the check's workspace and machine are closed when it ends. A task of a project whose last check **failed** is refused at its start, naming the step (a setup run is let through, since it is how the setup gets fixed; a new revision of the project outdates the check); a project nobody checked starts as it always did.
- **Dev containers** (the project's `devcontainer` setting) work on the local Docker worker for an image that is ready to run, from a registry on your list (see "What a worker can reach").
- **Stored like Cloud's** (`SETUP_DRAFT#<project>` rows: `AGENT`, `JOURNAL#...`, `CMD#...`; `SETUP_HOST_ASK#<host>`, the open-asks counter and the company index in the project and company partitions). Different: the setup proposal row is `SETUP_DRAFT#<project>`/`APPLY` (Cloud keeps its marker with the test environment), and the project check mark is on the project's own record.

Settings: `ROVARA_SETUP_AGENT=0` turns the setup agent off (every route, the page and the worker's callback answer as an unknown path); `ROVARA_DEVCONTAINER_REGISTRIES` is above.

## Not in this lane (L4)

The published worker image is not built here. Test services (their networks and helpers) need Docker calls the
guard still refuses; they are not available locally until each is given a place in the guard's rules.

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
