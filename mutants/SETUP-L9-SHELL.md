# Mutants for SETUP-L9-SHELL (run 2026-11-25; each: edit, the relevant vitest files with --maxWorkers=1, revert; vitest reads src directly, so no tsc -b between runs)
Tests: S = tests/unit/setup-l9-shell-session.test.ts, P = tests/integration/setup-l9-shell-prepare.test.ts, C = tests/contract/setup-l9-shell-lines.test.ts.
Result: 12 mutants (10 listed, #3 in three forms), 12 killed, 0 survivors at the end. #7 first SURVIVED (the quoted line gives the same output as `exec`), so S "a group of programs alone runs exactly as before" now also checks the wrapper sent is the `exec "$@"` one and the session script was never sent; it then kills.

| # | Mutant | Killed by |
|---|--------|-----------|
| 1 | `shellPlan` passes `""` as the state file (separate sessions) | S: venv activation carries, bare source then bare pip, exported variables/functions/unset, "a command that is one program also sees the session", non-exported test, closing removes the file (6 fail) |
| 2 | `refusedCommand` (broker setup-agent) returns false (safety refusal removed) | C: download-and-run refused, secret-shaped refused, confirm leaves a refused shell line out (3 fail) |
| 3 | group clamp removed: `timeoutMs = lineTimeoutMs` | S "a group's time is a limit too" |
| 3b | group early return (`left <= 0`) removed | S "a group's time is a limit too" |
| 3c | per-line `timeoutMs` not passed to the wrapper | S "a line that runs past its own limit", S group limit, P "a line that runs past its time limit" (3 fail) |
| 4 | credentials visible: `env: { ...process.env, ...defaults, ...command.env }` | S "is the container's own environment plus the command's: nothing of this process's credentials" (+ two cd tests, polluted PWD) |
| 5 | `set -e -o pipefail` removed from the session script | S "each line runs under `set -e -o pipefail`" |
| 6 | `set --` removed (the wrapper's words are the line's `$1 $2 $3`) | S "the wrapper's own words are not in the line's environment or its positional parameters" |
| 7 | `shellPlan` sends every command through the shell | S "a group of programs alone runs exactly as before" (after the added wrapper assertion) |
| 8 | `closeShellSession` does nothing | S "closing a session removes its state file" |
| 9 | cwd carried by mistake (state saves `cd -- $PWD`) | S "`cd` does not persist", S "`cd frontend` then `cd backend`"; P "`cd sub && npm ci` ... starts at the root again", P "`cd frontend && npm ci` then `cd backend && npm ci`" (4 fail) |
| 10 | non-exported variables carried (`compgen -v` instead of `compgen -e`) | S "a variable that is not exported does not carry" |
