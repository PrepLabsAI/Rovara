# Mutant evidence: GATEWAY-PHASE-2, Code half (pr/gateway-phase-2-20261125)

Each mutant was applied singly, in place, to one product line, the test named was run (`vitest run`, one worker), and the file was restored with `git checkout --`. Run at the head before this file.

| # | Mutant | Result | Killed by (first failing test) |
|---|--------|--------|---|
| C1 | the output has another name than `DeployedCodeSha` | survived at first (the test imported the constant), KILLED after the test wrote the name out | "names the Code commit, with the service its settled gate reads ..." |
| C2 | a context that is not a 40-hex commit is accepted | KILLED | "a context that is not a 40-hex commit stops the synth" |
| C3 | `ServiceArn` is written even without the context | KILLED | "names the Code commit ... and nothing else is new" |
| C4 | the template comparison ignores the Resources section | KILLED | "catches a changed, added or removed resource ..." |
| C5 | the comparison lets any output go | KILLED | "catches an output that goes (other than DeployedCloudSha) ..." |
| C6 | `DeployedCloudSha` is written again beside `DeployedCodeSha` | KILLED | "names the Code commit ... and nothing else is new" |

Result: 6 of 6 killed (C1 after one test fix).
