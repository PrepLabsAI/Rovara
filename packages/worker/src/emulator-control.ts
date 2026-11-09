// The worker's calls to Rovara local AWS's control API (test services, slice 2; the fork's `RovaraControlController`): `POST /_rovara/seed` and `GET /_rovara/ledger/summary`. The control paths answer 403 unless the request
// carries the run's control token, and the token is a secret only the WORKER knows: it is in the emulator's own 0600 env file (service-helpers.ts), in the redactor, and here, in one more 0600 env file for the one call.
// It is never in a sandbox's environment (service-env.ts refuses a variable that holds it), never an argument, never in a log or an error.
//
// How a call is made (the worker cannot reach an `rvi*` bridge itself: the boot firewall drops what comes in from one): a hardened container of the worker's own image on the run's services network runs the probe program
// (service-probe.ts) with `--control GET|POST`. The token comes from that container's environment (`--env-file`), the body of a POST from a file of the run's directory mounted read-only, and the answer comes back on
// standard output. Both files are removed when the call has returned, whatever it did; the container is removed by name when the call failed or timed out, so it cannot outlive the call.
//
// Rules this module keeps, each with a test (tests/unit/worker-emulator-control.test.ts):
//   - FAIL CLOSED. Anything but a 2xx answer, a bad token, a path or method that is not one of the three fixed ones, a body past its limit, a Docker failure: one fixed sentence (`EmulatorControlError`), and nothing
//     of the emulator's answer, the command line or a path is repeated in it.
//   - The token and the body are never an argument. A docker argument is a fixed word, a number, a container name this module made, or the path of a file in the run's directory.
import { randomBytes } from "node:crypto";
import { EMULATOR_CONTROL_PATHS, HELPER_CREDENTIAL_PATTERNS, controlRequestArgs, type HelperFiles, type StartedHelper } from "./service-helpers.js";
import type { ServicesNetwork } from "./run-network.js";
import type { DockerCli } from "./swebench/containers.js";

export type EmulatorControlFailure = "refused" | "failed" | "stopped" | "too_large";
const SENTENCES: Record<EmulatorControlFailure, string> = {
  refused: "The test services' AWS control call was refused here",
  failed: "The test services' AWS control call did not complete",
  stopped: "The test services' AWS control call was stopped",
  too_large: "The test services' AWS control call answered with more than the worker reads",
};

/** The one error of the control calls. `message` is a fixed sentence: nothing the emulator, a project or a Docker call said is in it. */
export class EmulatorControlError extends Error {
  constructor(readonly reason: EmulatorControlFailure) {
    super(SENTENCES[reason]);
    this.name = "EmulatorControlError";
  }
}

/** Where one emulator is and how the worker may talk to it. */
export interface EmulatorControlTarget {
  docker: DockerCli;
  /** The emulator's run network: its name, its gateway and the labels every container of the run carries (the sweep finds a call container by them). */
  network: Pick<ServicesNetwork, "name" | "gateway" | "labelArgs">;
  helper: Pick<StartedHelper, "container" | "address" | "ports">;
  /** The worker's own image (digest or id): the call is made from a container of it. */
  probeImage: string;
  /** The run's directory seam: the token's env file and a request body live there for the one call. */
  files: HelperFiles;
  /** The emulator's control token (the helper's `credentials.controlToken`). */
  controlToken: string;
  signal?: AbortSignal;
}

export const CONTROL_CALL_LIMIT_MS = 10_000;
/** The most a request body may be. A seed document names at most 24 resources, so it is far below this. */
export const CONTROL_REQUEST_BODY_MAX_BYTES = 64 * 1024;
const DOCKER_TIMEOUT_MS = CONTROL_CALL_LIMIT_MS + 5_000;

export interface EmulatorControlRequest {
  path: keyof typeof EMULATOR_CONTROL_PATHS;
  method: "GET" | "POST";
  /** A JSON text (POST only). */
  body?: string;
  /** Print the answer's body (2xx only, at most 256 KiB) and return it. Without it the answer is just "2xx". */
  print?: boolean;
}

/** Makes one control call and returns the answer's body (empty without `print`). Throws `EmulatorControlError` for anything that is not a 2xx answer. */
export async function emulatorControlCall(target: EmulatorControlTarget, request: EmulatorControlRequest): Promise<string> {
  const port = target.helper.ports[0];
  const path = Object.hasOwn(EMULATOR_CONTROL_PATHS, request.path) ? EMULATOR_CONTROL_PATHS[request.path] : undefined;
  if (port === undefined || path === undefined || !HELPER_CREDENTIAL_PATTERNS.emulatorSecret.test(target.controlToken)) throw new EmulatorControlError("refused");
  if ((request.method === "GET" && request.body !== undefined) || (request.body !== undefined && Buffer.byteLength(request.body) > CONTROL_REQUEST_BODY_MAX_BYTES)) throw new EmulatorControlError("refused");
  const aborted = (): boolean => target.signal?.aborted === true;
  if (aborted()) throw new EmulatorControlError("stopped");
  const name = `${target.helper.container}-c${randomBytes(4).toString("hex")}`;
  const envName = `${name}.env`;
  const bodyName = `${name}.body`;
  const written: string[] = [];
  const removeFiles = async (): Promise<void> => { for (const file of written.splice(0)) await target.files.remove(file).catch(() => undefined); };
  const call = (args: string[], timeoutMs: number) => target.docker.run(args, { timeoutMs, ...(target.signal === undefined ? {} : { signal: target.signal }) }).catch(() => ({ exitCode: -1, stdout: "", stderr: "", timedOut: false }));
  try {
    let args: string[];
    try {
      // Everything about the call is checked first, with a stand-in for the files' paths, so a bad address or port is refused before the token is written anywhere.
      const arguments_ = { probeImage: target.probeImage, address: target.helper.address, port, path, method: request.method, name, timeoutMs: CONTROL_CALL_LIMIT_MS - 2_000, ...(request.print === true ? { print: true } : {}) };
      controlRequestArgs(target.network, { ...arguments_, envFile: "/run/stand-in.env", ...(request.body === undefined ? {} : { bodyFile: "/run/stand-in.body" }) });
      written.push(envName);
      const envFile = await target.files.write(envName, `ROVARA_CONTROL_TOKEN=${target.controlToken}\n`, 0o600);
      let bodyFile: string | undefined;
      if (request.body !== undefined) {
        written.push(bodyName);
        // 0644: the probe runs as another user inside its container and reads this one mounted file. It holds resource names only, never a secret.
        bodyFile = await target.files.write(bodyName, request.body, 0o644);
      }
      args = controlRequestArgs(target.network, { ...arguments_, envFile, ...(bodyFile === undefined ? {} : { bodyFile }) });
    } catch {
      throw new EmulatorControlError("refused");
    }
    const result = await call(args, DOCKER_TIMEOUT_MS);
    if (aborted()) {
      await call(["rm", "--force", "--volumes", name], DOCKER_TIMEOUT_MS);
      throw new EmulatorControlError("stopped");
    }
    if (result.exitCode !== 0) {
      const tooLarge = result.exitCode === 2;
      // A call that timed out or failed may have left its container: removed by name (it is `--rm`, so a normal exit leaves nothing).
      await call(["rm", "--force", "--volumes", name], DOCKER_TIMEOUT_MS);
      throw new EmulatorControlError(tooLarge ? "too_large" : "failed");
    }
    return request.print === true ? result.stdout : "";
  } finally {
    await removeFiles();
  }
}
