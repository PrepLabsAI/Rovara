# Plan

Add optional `env` to session state-machine props and pass `naming.env` from the lifecycle construct. Extend the launch-template and state-machine tag lists conditionally. Root volumes inherit launch-template volume tag specifications. Keep existing IAM conditions intact.

Verify synthesized launch-template tags, provisioner API tag specifications, and lifecycle wiring with contract tests. Run typecheck and lint. This is an infrastructure metadata fix consistent with Constitution V and spec 015 FR-047.
