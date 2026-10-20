import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

/**
 * A `git` first on PATH that logs every invocation (working directory, GIT_DIR, GIT_ASKPASS presence, arguments) and, when asked, writes settings into the
 * candidate repository's own config immediately before the command named by SHIM_ON runs: the moment an agent's background process would pick, after the worker
 * read the config and before git does. It does not depend on how the worker implements the call.
 *
 * Environment it reads: SHIM_LOG, SHIM_REAL_GIT, SHIM_CANDIDATE (the repository directory), SHIM_ON (a git subcommand), SHIM_CONFIG_SET (lines of `key=value`), SHIM_RESTORE (when set, the settings are removed again once the command ends, so the planted window is that one call), SHIM_SWAP (`path=target`: swap the directory at `path` for a symlink to `target` as the command starts).
 */
const SCRIPT = `#!/bin/sh
{ printf 'BEGIN\\n'; printf 'CWD\\t%s\\n' "$PWD"; printf 'GIT_DIR\\t%s\\n' "\${GIT_DIR-}"; printf 'ASKPASS\\t%s\\n' "\${GIT_ASKPASS:+yes}"; for a in "$@"; do printf 'ARG\\t%s\\n' "$a"; done; } >> "$SHIM_LOG"
MATCHED=
if [ -n "\${SHIM_ON-}" ]; then
  for a in "$@"; do
    if [ "$a" = "$SHIM_ON" ]; then
      MATCHED=yes
      # SHIM_SWAP="<path>=<target>": the directory at <path> is renamed away and replaced by a symlink to <target>, once, as an agent's process would do it.
      if [ -n "\${SHIM_SWAP-}" ] && [ ! -e "\${SHIM_SWAP%%=*}.moved" ]; then
        mv "\${SHIM_SWAP%%=*}" "\${SHIM_SWAP%%=*}.moved" && ln -s "\${SHIM_SWAP#*=}" "\${SHIM_SWAP%%=*}"
      fi
      printf '%s\\n' "$SHIM_CONFIG_SET" | while IFS='=' read -r key value; do
        if [ -n "$key" ]; then "$SHIM_REAL_GIT" config --file "$SHIM_CANDIDATE/.git/config" "$key" "$value"; fi
      done
    fi
  done
fi
if [ -n "$MATCHED" ] && [ -n "\${SHIM_RESTORE-}" ]; then
  "$SHIM_REAL_GIT" "$@"
  STATUS=$?
  printf '%s\\n' "$SHIM_CONFIG_SET" | while IFS='=' read -r key value; do
    if [ -n "$key" ]; then "$SHIM_REAL_GIT" config --file "$SHIM_CANDIDATE/.git/config" --unset-all "$key"; fi
  done
  exit $STATUS
fi
exec "$SHIM_REAL_GIT" "$@"
`;

export type GitInvocation = { cwd: string; gitDir: string; askpass: boolean; args: string[] };

export type GitShim = {
  /** Variables to put on process.env while the shim is in use. */
  environment: Record<string, string>;
  invocations(): Promise<GitInvocation[]>;
  clear(): Promise<void>;
};

export async function installGitShim(root: string): Promise<GitShim> {
  const real = (await execFile("sh", ["-c", "command -v git"])).stdout.trim();
  const bin = join(root, "shim-bin");
  await mkdir(bin);
  await writeFile(join(bin, "git"), SCRIPT);
  await chmod(join(bin, "git"), 0o755);
  const log = join(root, "git-calls.log");
  await writeFile(log, "");
  return {
    environment: { PATH: `${bin}:${process.env.PATH ?? ""}`, SHIM_LOG: log, SHIM_REAL_GIT: real },
    clear: () => writeFile(log, ""),
    invocations: async () => (await readFile(log, "utf8")).split("BEGIN\n").filter(Boolean).map((block) => {
      const lines = block.split("\n").filter(Boolean);
      const field = (name: string) => lines.find((line) => line.startsWith(`${name}\t`))?.slice(name.length + 1) ?? "";
      return { cwd: field("CWD"), gitDir: field("GIT_DIR"), askpass: field("ASKPASS") === "yes",
        args: lines.filter((line) => line.startsWith("ARG\t")).map((line) => line.slice(4)) };
    }),
  };
}

export async function realDirectory(path: string): Promise<string> {
  return realpath(path);
}
