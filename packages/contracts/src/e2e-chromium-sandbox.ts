import { z } from "zod";

/** The file the executor writes into its out directory once it has looked at Chromium's renderer processes. */
export const E2E_CHROMIUM_SANDBOX_FILE = "chromium-sandbox.json" as const;

/** What the executor read from `/proc/<pid>` for one Chromium process of its container. */
export const ChromiumSandboxProcessSchema = z.object({
  pid: z.number().int().positive(),
  /** How many PID namespaces the process is a member of below the reader's: the `NSpid:` line has this many entries. */
  nsPidDepth: z.number().int().min(1).max(32),
  /** The `Seccomp_filters:` line: how many seccomp filters are attached. Docker's own profile is one of them, Chromium's renderer policy another. */
  seccompFilters: z.number().int().min(0).max(1_024),
  /** The `uid_map` text, whitespace-normalised: it differs between the container's user namespace and a namespace Chromium created. */
  uidMap: z.string().max(512),
}).strict();
export type ChromiumSandboxProcess = z.infer<typeof ChromiumSandboxProcessSchema>;

/**
 * The raw facts, never a verdict: `evaluateChromiumSandbox` is the one place they are judged, by the executor when it decides whether to go on and by the
 * registrar when it re-derives a qualification probe from the retained bytes.
 */
export const ChromiumSandboxAttestationSchema = z.object({
  schemaVersion: z.literal("e2e-executor-chromium-sandbox/v1"),
  runId: z.string().uuid(),
  groupId: z.string().min(1).max(80),
  browser: ChromiumSandboxProcessSchema,
  renderers: z.array(ChromiumSandboxProcessSchema).max(64),
}).strict();
export type ChromiumSandboxAttestation = z.infer<typeof ChromiumSandboxAttestationSchema>;

export type ChromiumSandboxVerdict = Readonly<{ sandboxed: true } | { sandboxed: false; reason: string }>;

/**
 * Chromium's sandbox is on when every renderer process has what a `--no-sandbox` renderer lacks: a seccomp filter beyond the ones the browser (and so the
 * container) already has, a PID namespace of its own, and a user namespace of its own. At least one renderer must have been observed, or nothing was shown.
 */
export function evaluateChromiumSandbox(attestation: ChromiumSandboxAttestation): ChromiumSandboxVerdict {
  const { browser, renderers } = attestation;
  if (renderers.length === 0) return { sandboxed: false, reason: "no-renderer-observed" };
  const pids = renderers.map((renderer) => renderer.pid);
  if (new Set(pids).size !== pids.length || pids.includes(browser.pid)) return { sandboxed: false, reason: "renderer-list-is-not-distinct-from-the-browser" };
  if (renderers.some((renderer) => renderer.seccompFilters <= browser.seccompFilters)) return { sandboxed: false, reason: "renderer-has-no-extra-seccomp-filter" };
  if (renderers.some((renderer) => renderer.nsPidDepth <= browser.nsPidDepth)) return { sandboxed: false, reason: "renderer-shares-pid-namespace" };
  if (renderers.some((renderer) => renderer.uidMap === browser.uidMap)) return { sandboxed: false, reason: "renderer-shares-user-namespace" };
  return { sandboxed: true };
}
