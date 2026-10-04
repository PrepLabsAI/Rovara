---
type: evidence
workItem: issue-299
---

# Security review: agent checks recognise test commands inside chains and filters

## Security review (gate)

- **Mechanism:** the built-in security-review skill, run over the full branch diff, followed by the-loop's checklist
  (`reference/security.md`).
- **Outcome:** pass. No high- or medium-confidence vulnerability.
- **Findings:** none. The untrusted ingress is the agent's bash command text, and the boundary is `runAgentCommand`. That
  boundary is unchanged: a replay runs only if `matchTestCommand(replay) === replay`, in a directory that
  `containedDirectory` has checked. `scanTestCommands` builds a replay from one validated test's words plus a
  `safeCdPath`-checked directory, so no operator, filter or other part reaches it. The scan fails closed on anything it
  does not tokenise.
- **Checklist:**
  1. Boundaries enforced where the design says: yes, see above.
  2. Untrusted input constrained at ingress: the lexer's allowlist, and the command-injection and path-injection surfaces
     are covered by abuse cases 1–9.
  3. Untrusted content steering privileged behaviour: the replay is still only a listed test runner.
  4. No secrets: none added. Labels and output are redacted as before.
  5. Fail closed: a refused scan, a non-fixpoint replay (`CheckNotRunError`), or an unmeasured before (`unknown`).
  6. Least privilege: unchanged.
  7. Every abuse case has a passing negative test: see [`contract.md`](contract.md) and [`unit.md`](unit.md).
  8. New dependencies: none.
- **Human sign-off:** n/a. The effective risk tier is 3: the default, with no fixed sensitive path touched.
