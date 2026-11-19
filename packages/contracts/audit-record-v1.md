# Audit record v1

`@agentx/contracts/audit-record-v1` provides the public-safe, commitment-only
capture subset of the existing offline `AuditRecordV1` format. It does not change
the laptop audit sink or its existing hash chain. Historical verifier formats
remain separate. This module was implemented in public Code; the Cloud mirror
and its tests/fixture are pinned by `contracts/shared/audit-v1.sha256.json`.

The existing hash domains remain `rovara-audit-record-v1\n` and
`rovara-audit-genesis-v1\n`. Record hashing includes every JSON field except
`hash`, including `prevHash`. Canonical JSON sorts object keys by UTF-16 code
units, preserves array order, accepts safe integers and refuses lossy values.
The parser checks the hash, exact keys and source/company consistency.

An event ID is `aev1.<install>.<source-kind>.<company>.<event-ID-commitment>`.
Install and company identifiers allow only letters, digits, underscore and dash
(1–64 characters). Source kind is `code` or `cloud`; the final component is 64
lowercase hex characters. Dots, IAM wildcards and storage-key delimiters cannot
appear in a component. Install IDs identify deployments permanently, never a
mutable hostname or table name. Provisioning must prevent reassignment.

Commitments use the existing `SHA256(salt || canonical({subject, fields}))`
format with at least 16 random bytes of salt. Capture must supply a stable random
per-event salt, persist it atomically with the erasable source, and reuse it on
every retry. Salt generation, storage and erasure are responsibilities of the
capture adapter. Salt and original personal data must never enter locked records,
pending delivery or receipts. A newly generated salt on retry changes identity
and is invalid capture behavior. The actor kind remains person/agent/system;
actor ID, present target and original facts are salted commitments. An absent
target is explicitly `{kind: "none", id: "none"}`. There is no sign-in proof.

The independently calculated golden fixture covers a record hash, genesis and a
detail commitment. The mapping of private hosted sources and hosted delivery/job
state belongs to Cloud. Parsing a record or matching a digest authenticates no
sender and proves no durable append. This package provides no delivery acceptance
or replay interface. v1 refuses every delivery authenticated as ReplayRole
regardless of body or claims, with no writes. Recovery is limited to the original
relay resending its retained pending item. A successful-replay origin-proof
design comes later to the controller.
