// SETUP-L9-SHELL (DEC 254zzz562): a saved command is run by a shell, and the lines of one GROUP (a project's setup commands, or its test commands) share one shell SESSION, the way a person's terminal or a CI job's script does:
// `source .venv/bin/activate` on one line is still in effect on the next, so are `export FOO=1`, `nvm use` and a function the line defined (the working directory is not: every line starts at the root).
//
// The shell is bash (not sh, not a login shell), started once PER LINE by the same `bash -c` wrapper that runs every command in a container (`runInContainerGroup`: its own process group, a time limit that stops it there, an abort that
// stops it there). What a line leaves behind is carried to the next line of the session in a small state file in the container's /tmp (see `SHELL_SESSION_SCRIPT`). Why not one long-lived shell process: each line keeps its own
// time limit, its own exit code and output, its own stop-and-confirm sequence, and a preparation that resumes (or a worker that restarts) loses nothing but the state; and every caller of the one runner (`runContainerCommand`) gets
// the session without being rewritten.
//
// What carries over between the lines (like a CI job, DEC 254zzz579): the ENVIRONMENT. Every EXPORTED variable the line set, changed or unset (so an activated virtual environment's PATH and VIRTUAL_ENV, `export FOO=1`, `nvm use`'s PATH), and every
// function it defined. What does not: the working directory (every line STARTS AT ITS COMMAND'S OWN SAVED DIRECTORY, the repository root: `cd sub` on one line does not move the next), variables that were not exported (as in CI, an
// `export` is needed), shell options (`set -e`, `shopt`), traps, aliases, background jobs and open file descriptors. Each line runs under `set -e -o pipefail` (the way a CI `run:` step does): the line fails at its first failing command, and
// `cmd | tail` fails when `cmd` does. A command's own `env` (a project command's #54 variables, a registry's config paths) is for that command only: it is in the line's starting state, so it is not part of what the line "changed".
//
// A group has a time limit as well as a limit per line: a line is not started once the group's time has run out, and no line may run past it.
import { randomUUID } from "node:crypto";
import { shellLineOf, type ProjectCommand } from "@agentx/contracts";

/** The longest a group of lines (the setup commands, or the test commands) may run in all, unless one line's own limit is longer (then that line's). */
export const SHELL_GROUP_TIMEOUT_SECONDS = 2_700;

export interface ShellSession {
  readonly id: string;
  /** Where the session's state lives in the container: a file under /tmp, written by the lines and read by the next. Never output, never logged. */
  readonly stateFile: string;
  /**
   * False until a shell line has run in this session. A session of programs alone (every line one program and its arguments) never needs the shell, so those lines run exactly as they always did; once a shell line has run,
   * every later line runs in the session's shell so it sees what the shell lines left.
   */
  stateful: boolean;
  /** When the group's time runs out (epoch ms), or undefined for a group with no limit of its own. */
  readonly deadlineAt: number | undefined;
  readonly limitSeconds: number | undefined;
  /** The container's exec the state file was written through: where `closeShellSession` removes it. Set by the runner. */
  exec?: (command: readonly string[], options: { timeoutMs?: number }) => Promise<unknown>;
}

/** A new session for one group. `limitSeconds` is the group's time limit (default: none), counted from now. */
export function newShellSession(options: { limitSeconds?: number | undefined; now?: () => number } = {}): ShellSession {
  const id = randomUUID();
  const now = options.now ?? Date.now;
  return {
    id,
    stateFile: `/tmp/agentx-shell-${id}.state`,
    stateful: false,
    deadlineAt: options.limitSeconds === undefined ? undefined : now() + options.limitSeconds * 1_000,
    limitSeconds: options.limitSeconds,
  };
}

/**
 * The group limit for a list of commands: `SHELL_GROUP_TIMEOUT_SECONDS`, or the longest limit of one of the commands when that is longer (a group limit never cuts a line below its own). A group with no shell line has none (undefined):
 * a group of programs alone runs exactly as it always did, with only each line's own limit.
 */
export function groupLimitSeconds(commands: ReadonlyArray<Pick<ProjectCommand, "executable" | "args" | "timeoutSeconds">>): number | undefined {
  if (!commands.some((command) => shellLineOf(command) !== undefined)) return undefined;
  return Math.max(SHELL_GROUP_TIMEOUT_SECONDS, ...commands.map((command) => command.timeoutSeconds));
}

/** Milliseconds left of the group's time, or undefined when it has no limit. Zero or less: out of time. */
export function remainingMs(session: ShellSession | undefined, now: () => number = Date.now): number | undefined {
  return session?.deadlineAt === undefined ? undefined : session.deadlineAt - now();
}

/** Removes the session's state file from the container, best effort (a container that is gone has nothing left to remove). */
export async function closeShellSession(session: ShellSession | undefined): Promise<void> {
  if (session?.exec === undefined) return;
  const exec = session.exec;
  delete session.exec;
  await exec(["bash", "-c", 'command -p rm -f -- "$1" 2>/dev/null || :', "bash", session.stateFile], { timeoutMs: 10_000 }).catch(() => undefined);
}

/**
 * The shell code that runs one line of a session. It is `eval`ed by the container wrapper in the line's directory with the positional parameters `$1` = this text, `$2` = the state file ("" when the line is not part of a session:
 * nothing is read or written), `$3` = the line. The line itself is `eval`ed here, at the top level, so `cd`, `export`, `source` and function definitions act on this shell, and the line's own `exit` ends it with that status.
 * Nothing is printed by this code. Compatible with bash 3.2 (a developer's Mac) and bash 5.
 */
export const SHELL_SESSION_SCRIPT = String.raw`
__rv_state=$2
__rv_line=$3
__rv_nl=$'\n'
set --
__rv_names() {
  local IFS=$' \t\n' __rv_n
  for __rv_n in $(compgen -e); do
    case $__rv_n in
      __rv_*|__RV_*|BASH*|FUNCNAME|PIPESTATUS|RANDOM|SRANDOM|SECONDS|LINENO|SHLVL|PPID|UID|EUID|GROUPS|OLDPWD|PWD|SHELLOPTS|DIRSTACK|HOSTNAME|HOSTTYPE|MACHTYPE|OSTYPE|COMP_*|COMPREPLY|EPOCH*|IFS|OPTIND|OPTARG|OPTERR|HISTCMD|_) continue ;;
    esac
    printf '%s\n' "$__rv_n"
  done
}
__rv_vars() {
  local IFS=$' \t\n' __rv_n
  for __rv_n in $(__rv_names); do declare -p "$__rv_n" 2>/dev/null; done
}
__rv_funcs() {
  local IFS=$' \t\n' __rv_n
  for __rv_n in $(compgen -A function); do
    case $__rv_n in __rv_*) continue ;; esac
    declare -f "$__rv_n"
  done
}
__rv_save() {
  { set +x +v; } 2>/dev/null
  [ -z "\${__rv_saved-}" ] || return 0
  __rv_saved=1
  [ -n "$__rv_state" ] || return 0
  set +e +u +o pipefail
  local IFS=$' \t\n' __rv_n __rv_entry __rv_delta= __rv_now_names __rv_now_vars __rv_now_funcs
  __rv_now_vars=$(__rv_vars)
  if [ "$__rv_nl$__rv_now_vars$__rv_nl" != "$__rv_base_vars" ]; then
    for __rv_n in $(__rv_names); do
      __rv_entry=$(declare -p "$__rv_n" 2>/dev/null) || continue
      case "$__rv_base_vars" in
        *"$__rv_nl$__rv_entry$__rv_nl"*) ;;
        *) __rv_delta="$__rv_delta$__rv_entry$__rv_nl" ;;
      esac
    done
    __rv_now_names="$__rv_nl$(__rv_names)$__rv_nl"
    for __rv_n in $__rv_base_names; do
      case "$__rv_now_names" in
        *"$__rv_nl$__rv_n$__rv_nl"*) ;;
        *) __rv_delta="$__rv_delta""unset $__rv_n$__rv_nl" ;;
      esac
    done
  fi
  __rv_now_funcs=$(__rv_funcs)
  if [ "$__rv_nl$__rv_now_funcs$__rv_nl" != "$__rv_base_funcs" ]; then
    for __rv_n in $(compgen -A function); do
      case $__rv_n in __rv_*) continue ;; esac
      __rv_entry=$(declare -f "$__rv_n")
      case "$__rv_base_funcs" in
        *"$__rv_nl$__rv_entry$__rv_nl"*) ;;
        *) __rv_delta="$__rv_delta$__rv_entry$__rv_nl" ;;
      esac
    done
  fi
  [ -n "$__rv_delta" ] || return 0
  ( umask 077; printf '%s' "$__rv_delta" >> "$__rv_state" ) 2>/dev/null
  return 0
}
if [ -n "$__rv_state" ]; then
  if [ -f "$__rv_state" ]; then
    . "$__rv_state" 2>/dev/null
  fi
  __rv_base_vars="$__rv_nl$(__rv_vars)$__rv_nl"
  __rv_base_names="$(__rv_names)"
  __rv_base_funcs="$__rv_nl$(__rv_funcs)$__rv_nl"
  trap '{ set +x +v; } 2>/dev/null; __rv_save' EXIT
fi
set -e -o pipefail
eval "$__rv_line"
{ set +x +v; } 2>/dev/null
set +e +o pipefail
__rv_save
`.replaceAll("\\${", "${");
