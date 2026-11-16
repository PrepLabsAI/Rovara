// The Docker socket guard's rule for browser evidence (TE-H1 slice 2, DEC 241a). A part of the guard program in docker-socket-guard-source.ts, kept as text so the broker needs no build step and tests run the very same text.
//
// WITH `policy.browserEvidence` UNSET (or not exactly the shape below) NONE OF THIS IS REACHABLE: every hook in the main program tests `BE !== null` first, and the guard answers every request exactly as it did before (a test
// builds the guard both ways and compares). The owner's broker sets it only when the owner's config gives a project a browser evidence recipe AND `ROVARA_EXECUTOR_IMAGE` names an executor image this machine holds.
//
// What the worker may additionally do, and nothing else: start ONE kind of container, the capture container. Its body is REBUILT by the guard from the fields it understands and compared with ONE shape:
//   - the image is `policy.browserEvidence.image`, the executor image as a pinned id (`sha256:<64 hex>`, never a tag a registry could move), and the command is exactly `node <the capture program> <plan>`, the plan being one argument of
//     base64url letters; no entrypoint, no user of its own, an environment only for a recipe's saved sign-in (one variable of a fixed name, base64url letters), no working directory, no stdin, no label but the guard's;
//   - it joins THE NETWORK NAMESPACE OF ONE OF THE WORKER'S OWN TASK SANDBOXES (`NetworkMode: container:<sandbox>`, a sandbox that exists, carries the guard's own labels and is not a dev container or a service container) and nothing else:
//     no other network, no published port, no link, no extra host, no name server, no mount, no volume, no device, no host namespace, no capability (every one dropped), never privileged;
//   - it runs as the e2e Docker host runs the executor: the pinned seccomp profile (the exact text the broker verified against its digest; the CLI's own compact form of the file), no-new-privileges, a read-only root with one
//     512 MiB tmpfs at /tmp, tini as PID 1, a 1 GiB shared-memory area, 2 GiB of memory (no more swap), 1,024 processes and 2 CPUs, removed when it ends;
//   - at most two at once, named `rovara-be-<12 hex>`, labelled with the guard's owner label and its own class.
// The worker may then start, wait for, read the output of (the attach has no input), inspect and remove a capture container of its own, and inspect the executor image by its id. A capture container takes no command (`exec`).
// Everything is JavaScript with no template strings inside (this file is a template string itself).
export const DOCKER_SOCKET_GUARD_BROWSER_SOURCE = String.raw`
// ---- browser evidence (policy.browserEvidence; unset: nothing below is reachable)
const BE_POLICY = policy.browserEvidence !== undefined && policy.browserEvidence !== null && typeof policy.browserEvidence === "object" ? policy.browserEvidence : null;
const BE = BE_POLICY !== null && typeof BE_POLICY.image === "string" && /^sha256:[a-f0-9]{64}$/.test(BE_POLICY.image) && typeof BE_POLICY.seccomp === "string" && BE_POLICY.seccomp.length > 0 && BE_POLICY.seccomp.length <= 131072 ? BE_POLICY : null;
const BE_CLASS = "browser-evidence";
const BE_NAME = /^rovara-be-[0-9a-f]{12}$/;
const BE_ENTRY = "/opt/agentx/packages/verifier/dist/executor/browser-evidence-entry.js";
const BE_PLAN = /^[A-Za-z0-9_-]{1,16384}$/;
const BE_LABEL = "rovara.browser-evidence";
const BE_MAX = 2;
const BE_TMPFS = "rw,exec,nosuid,nodev,size=512m";
const BE_SANDBOX_NETWORK = /^container:([A-Za-z0-9][A-Za-z0-9_.-]{0,127})$/;
const BE_SIGN_IN_ENV = /^ROVARA_BE_SIGNIN=[A-Za-z0-9_-]{1,1536}$/;

function beNumber(value, expected, name) {
  if (value !== expected) deny(name + " is fixed");
}
function beNothing(value, name) {
  if (!emptyish(value)) deny(name + " is not allowed");
}
// The one environment a capture container may have: the saved sign-in of a recipe that has one, as ONE variable of a fixed name holding base64url letters (never an argument of the command line; the docker CLI takes it from its own environment).
function beEnvironment(value) {
  if (emptyish(value)) return null;
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === "string" && BE_SIGN_IN_ENV.test(value[0])) return [value[0]];
  deny("a capture container's environment is the sign-in and nothing else");
}

// The body of a capture container, rebuilt. Every field is compared with its one value; the worker's own spelling is never passed on.
async function buildBrowserEvidenceBody(text) {
  let body;
  try { body = JSON.parse(text); } catch (error) { deny("the body is not JSON"); }
  if (body === null || typeof body !== "object" || Array.isArray(body)) deny("the body is not an object");
  knownKeys(body, TOP_USED, TOP_ZERO, "container setting");
  if (body.Image !== BE.image) deny("a capture container runs the executor image this install pinned");
  if (!Array.isArray(body.Cmd) || body.Cmd.length !== 3 || body.Cmd[0] !== "node" || body.Cmd[1] !== BE_ENTRY || typeof body.Cmd[2] !== "string" || !BE_PLAN.test(body.Cmd[2])) deny("a capture container runs the capture program with one plan");
  beNothing(body.Entrypoint, "an entrypoint");
  const environment = beEnvironment(body.Env);
  beNothing(body.User, "a user");
  beNothing(body.WorkingDir, "a working directory");
  ["Tty", "OpenStdin", "AttachStdin", "StdinOnce"].forEach(function (key) { if (body[key] !== undefined && body[key] !== null && body[key] !== false) deny("a capture container takes no input"); });
  ["AttachStdout", "AttachStderr"].forEach(function (key) { if (body[key] !== undefined && body[key] !== null && typeof body[key] !== "boolean") deny(key + " is not valid"); });
  beNothing(body.StopSignal, "a stop signal");
  if (body.StopTimeout !== undefined && body.StopTimeout !== null) deny("a stop timeout is not allowed");
  const labels = body.Labels === undefined || body.Labels === null ? {} : body.Labels;
  if (typeof labels !== "object" || Array.isArray(labels)) deny("labels are not valid");
  Object.keys(labels).forEach(function (key) { if (key !== BE_LABEL || labels[key] !== "1") deny("a capture container carries the guard's labels and no other"); });
  const endpoints = body.NetworkingConfig;
  if (endpoints !== undefined && endpoints !== null && !(typeof endpoints === "object" && !Array.isArray(endpoints) && (Object.keys(endpoints).length === 0 || (Object.keys(endpoints).length === 1 && endpoints.EndpointsConfig !== undefined && emptyish(endpoints.EndpointsConfig))))) deny("a capture container has no network settings of its own");

  const host = body.HostConfig;
  if (host === null || typeof host !== "object" || Array.isArray(host)) deny("HostConfig is required");
  knownKeys(host, HOST_USED, HOST_ZERO, "host setting");
  const shared = BE_SANDBOX_NETWORK.exec(typeof host.NetworkMode === "string" ? host.NetworkMode : "");
  if (shared === null) deny("a capture container joins a task sandbox's network and nothing else");
  const target = await ownedFound(shared[1]);
  if (target === undefined || target.class !== "sandbox" || target.name !== shared[1]) deny("that sandbox is not this worker's");
  if (!Array.isArray(host.CapDrop) || host.CapDrop.length !== 1 || String(host.CapDrop[0]).toUpperCase() !== "ALL") deny("a capture container drops every capability");
  if (host.Privileged !== undefined && host.Privileged !== null && host.Privileged !== false) deny("a capture container is never privileged");
  if (!Array.isArray(host.SecurityOpt) || host.SecurityOpt.length !== 2 || host.SecurityOpt[0] !== "no-new-privileges" || host.SecurityOpt[1] !== "seccomp=" + BE.seccomp) deny("a capture container runs under no-new-privileges and the pinned seccomp profile");
  if (host.ReadonlyRootfs !== true || host.Init !== true || host.AutoRemove !== true) deny("a capture container has a read-only root, an init process and is removed when it ends");
  beNumber(host.ShmSize, 1073741824, "the shared memory");
  beNumber(host.Memory, 2147483648, "the memory limit");
  beNumber(host.MemorySwap, 2147483648, "the swap limit");
  beNumber(host.PidsLimit, 1024, "the process limit");
  beNumber(host.NanoCpus, 2000000000, "the CPU limit");
  const tmpfs = host.Tmpfs;
  if (tmpfs === null || typeof tmpfs !== "object" || Array.isArray(tmpfs) || Object.keys(tmpfs).length !== 1 || tmpfs["/tmp"] !== BE_TMPFS) deny("a capture container has one tmpfs at /tmp");
  beNothing(host.Binds, "a mount");
  if (host.MemoryReservation !== undefined && host.MemoryReservation !== null && host.MemoryReservation !== 0) deny("a memory reservation is not allowed");
  if (host.CpuShares !== undefined && host.CpuShares !== null && host.CpuShares !== 0) deny("CPU shares are not allowed");
  const restart = host.RestartPolicy === undefined || host.RestartPolicy === null ? "" : host.RestartPolicy.Name;
  if (restart !== undefined && restart !== "" && restart !== "no") deny("a capture container does not restart");
  const log = host.LogConfig;
  if (log !== undefined && log !== null && !(typeof log === "object" && (log.Type === undefined || log.Type === "" || log.Type === "json-file") && emptyish(log.Config))) deny("a capture container keeps the default log");
  ["Ulimits", "CpusetCpus", "CgroupnsMode", "Isolation", "MaskedPaths", "ReadonlyPaths"].forEach(function (key) { beNothing(host[key], key); });

  const out = {
    Image: BE.image, Cmd: body.Cmd.slice(), Entrypoint: null, Env: environment, User: "", WorkingDir: "", Tty: false, OpenStdin: false, AttachStdin: false, StdinOnce: false,
    AttachStdout: body.AttachStdout === true, AttachStderr: body.AttachStderr === true,
    Labels: {}, NetworkingConfig: { EndpointsConfig: {} },
    HostConfig: { NetworkMode: host.NetworkMode, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges", "seccomp=" + BE.seccomp], Privileged: false, ReadonlyRootfs: true, Init: true, AutoRemove: true,
      ShmSize: 1073741824, Memory: 2147483648, MemorySwap: 2147483648, PidsLimit: 1024, NanoCpus: 2000000000, Tmpfs: { "/tmp": BE_TMPFS }, Binds: [] },
  };
  out.Labels[OWNER] = policy.owner;
  out.Labels[SANDBOX] = BE_CLASS;
  out.Labels[BE_LABEL] = "1";
  return JSON.stringify(out);
}

// The create of a capture container: named, one at a time (so the count is the count when this is made), at most BE_MAX of them.
async function browserEvidenceCreate(request, response, query) {
  Array.from(query.keys()).forEach(function (key) { if (key !== "name") deny("create option " + key + " is not allowed"); });
  const name = query.get("name");
  if (!BE_NAME.test(name)) deny("a capture container has one of the run's names");
  const text = await readBody(request);
  const body = await buildBrowserEvidenceBody(text);
  const turn = createQueue;
  let release = function () {};
  createQueue = new Promise(function (resolve) { release = resolve; });
  await turn;
  try {
    const ownedLabels = {};
    ownedLabels[OWNER + "=" + policy.owner] = true;
    ownedLabels[SANDBOX + "=" + BE_CLASS] = true;
    const owned = await ask("GET", "/containers/json?all=1&filters=" + encodeURIComponent(JSON.stringify({ label: ownedLabels })));
    let count = 0;
    try { count = JSON.parse(owned.body).length; } catch (error) { count = 0; }
    if (count >= BE_MAX) {
      response.writeHead(429, { "content-type": "application/json" });
      return response.end(JSON.stringify({ message: "rovara: too many capture containers at once" }));
    }
    const created = new URLSearchParams();
    created.set("name", name);
    return await forward(request, response, "/containers/create?" + created.toString(), body);
  } finally {
    release();
  }
}

function browserEvidenceImageMayBeInspected(name) {
  return BE !== null && name === BE.image;
}
`;
