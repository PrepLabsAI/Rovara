// The small entry the worker's DNS helper containers load (`@agentx/contracts/dns-helper`): only what setup-dns-watch.ts needs. The helpers (setup-dns-watch-helper.js, sealed-dns-helper.js) run under a
// 128 MB memory limit; the whole barrel (`@agentx/contracts`) takes about 210 MB of RSS to load and got the sealed helper OOM-killed before it bound .2:53 (linux-runtime CI 41791561884, exit 137, oom=true).
// These two modules import only zod. Keep it that way: tests/unit/worker-dns-helper-footprint.test.ts measures the helper's load and pins the limit.
export { agentXError } from "./errors.js";
export { SETUP_BLOCKED_HOSTS_MAX, SetupHostSchema } from "./setup-run.js";
