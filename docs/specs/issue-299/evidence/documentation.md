---
type: evidence
workItem: issue-299
---

# Documentation: agent checks recognise test commands inside chains and filters

## Capability docs

None changed, and none was minted. `docs/capabilities/capabilities.md` has no pages yet, and the agent check's current
behaviour lives in `specs/051-agent-verification/spec.md` (D-19 added) and in the user doc below. Minting a capability
page for agent verification covers all of spec 051, not just this item, so the PR briefing suggests it as a follow-up
rather than starting it here.

| Capability doc | What changed | History row |
|----------------|--------------|-------------|
| — | none (no page exists; see above) | — |

## Documentation

| Document | What changed |
|----------|--------------|
| `docs/project-configuration.md` (agent checks section) | Which agent commands count: tests inside chains and filters, every `cd` mapped in a dev container, the refusals, and when the agent's own run is the before (#299). It used to say pipes, `;` and `&&` chains are never checked. |
| `specs/051-agent-verification/spec.md` | D-19, amending P-6, D-11 and D-14. |
