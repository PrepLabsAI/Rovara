# Team Tasks runtime execution report — 2026-09-20

Objective: MSDLC-OBJ-001@0.3; unchanged digest
`bc902e9dcecec61f32d748ae290dcab417311db1382e5dbcac59bb1887845843`.
Owner approved the runtime plan. Work remains on `codex/charterarc-demo-setup`;
mainline is unchanged. This is synthetic internal setup, not customer validation.

## Current result

| Area | Evidence | Status |
|---|---|---|
| Separate runtime selection | New stack synthesizes; legacy template byte-identical before/after; invalid context/name tests | Locally verified, not deployed |
| Application image | Real linux/arm64 Docker build, image user `agentx`, smoke UID 1000 | Locally verified |
| Real worker preparation | Production prepareWorkspace, source-only Git bundle at exact base; no host credentials | Locally verified with fixture transport, not GitHub private-clone proof |
| API / web / browser | 29 API tests, successful build, 8 Chromium tests | Passed inside final image |
| Safety/regression checks | Wrong base rejected before dependencies, retry preserves edits, symlink containment, <800 MiB storage gate, worker health | Passed locally |
| Project generator | Rejects missing/mismatched runtime, region, account, image, base and unexpected metadata | Locally verified; registration not attempted |
| Full source checks | 176 tests across 33 files, build, lint | Passed before final review |
| AWS activation | Setup session works; CloudFormation GetTemplate denied | Blocked on scoped access |
| Whole-branch review | Fresh reviewer examined 925ad38..96b068b and independently passed 81 focused tests | No Critical, Important or Minor findings; local-code review only |

## Exact identities

- Demo base: `ee25daffed9f59e7c979477c6f0b5a05834c32e3`.
- New baseline branch: `codex/agentx-demo-baseline`, created through GitHub's
  create-ref API and verified at that commit. No existing branch was reset.
- Local image ID: `sha256:458f484dafa37a5456e04f4174d5e38a509694df82aaf7f34f0ae6d9f90892ff`.
- Image size: 797,801,169 bytes; architecture arm64.
- Measured smoke workspace: 125,610,801 bytes, including the deliberately rejected
  source checkout. Approximately 120 MiB; budget 800 MiB.
- Chromium launched: 153.0.8010.12, Playwright browser revision 1243.
- Worker Node 22.23.2; app Node 24.19.0; Python 3.12.14;
  uv output `uv 0.12.5 (aarch64-unknown-linux-gnu)`.
- Toolchain manifest SHA-256:
  `a27838181b6383867cd132ef26dbd9efc45d2d69e8a5f0084c302b55f4d4c197`.

This image ID is not a registry manifest digest. ECR upload and source/build
provenance registration remain cloud-delivery steps. The final image smoke used
no script overlays; earlier diagnostic overlays are explicitly not image proof.
Copied worker/contracts sources and the preparation script were compared against
the committed checkout. Image-build inputs are retained as a Git-tree manifest.

## Corrections established by actual runs

1. Runtime PATH omits `/usr/sbin`; use the absolute `useradd` path during build.
2. Match uv's exact architecture-qualified version output.
3. `uv sync --python .venv/bin/python` recreates the copied venv with external
   interpreter links. Use the pinned version request `--python 3.12.14`, which
   retains copied interpreters and passes the unchanged worker containment scan.
4. Worker NODE_ENV=production omits npm development tools by default. Application
   setup explicitly includes dev dependencies, with lifecycle scripts disabled.

## Decisions made within the approved plan

- Used standard Docker build because this host lacks buildx. Same Dockerfile and
  arm64 platform; real smoke and architecture inspection establish local behavior.
  Cost if wrong: deployment portability still needs AWS proof.
- Implemented pure project validation while the image built. No cloud admission
  or image-completion claim was made early. Cost if wrong: shared commands must
  still pass image integration (they now do).
- Changed uv's interpreter selector for the observed recreation behavior. Cost
  if wrong: containment fails; the policy was not relaxed.
- Included npm dev dependencies for real builds/tests. Cost: larger workspace,
  measured within the unchanged storage limit.

## Evidence retention and remaining gates

Build output, failed diagnostics, final image inspection, final smoke receipt,
OS package inventory, browser version and source test logs are retained in this
plan's ignored execution workspace until the full plan is finished. Do not treat
the author's smoke receipt as qualified CharterArc verification evidence.

The dedicated Colima VM has no host mounts or SSH-agent forwarding and did not
activate the global Docker context. No AWS resource was created or updated in
this runtime implementation turn. The GitHub private key remains outside all
source, images and workers.
The dedicated VM was stopped after verification; its image, disk and receipts
were retained. No user data or unrelated container resources were deleted.

The original frozen control-plane assembly remains the deployment input. A fresh
synthesis changed asset hashes only because source-map paths were relative to a
different output directory. All three JavaScript bundles, map content and resolved
source paths were compared equal; the templates differed only in those asset
identities. Keep the original three-key preparation policy; no new access is
needed merely because of that local output-directory difference.

## Final review dispositions

The reviewer inspected the author's image receipt but did not repeat the image
run. Independently repeated proof is 81 source tests, not AWS or image execution.
No code fixes or deferred minors resulted. These reviewed boundaries stand:

| Boundary retained | Why | Cost / remaining risk |
|---|---|---|
| Live AWS activation and both-app compatibility are unproved | No authorized deployment occurred | Existing-project smoke must pass before activation is accepted |
| Runtime observation truth/freshness remains an operator gate | Generator validates inputs; runbook requires fresh endpoint/version/image reads | Skipping the gate can select stale or wrong runtime metadata |
| No server-side registration attestation added | Bounded approved plan uses administrator admission | Operator mistake remains possible; do not present this as general secure onboarding |
| Completed manifests resume without automatic revalidation | Existing workspace behavior preserves edits; runtime changes require new admission | Reusing a changed runtime without that gate can leave stale readiness |
| Candidate publication and conversation continuity remain #2/#1 | Distinct explicitly tracked contracts | Setup alone cannot prove a complete or follow-up demo |
| Existing PR-URL case sensitivity is unchanged | Unchanged provider behavior already retained in prior review | Case-only URL edge cases remain unsupported |
| Production isolation/durability, IAM posture and model availability are not established | Existing demo boundaries were preserved, no live runtime test | Production or model-access claims would be premature |
| Independent acceptance/customer outcomes are not established | All image/application tests are synthetic executor/environment checks | CharterArc verification and customer validation remain separate work |

Next: grant deployment-preparation access, compare the live template, prepare and
review the exact change set, grant narrowly scoped execution, and activate the
broker. ECR/new runtime access is separate. Then refresh real endpoint metadata,
generate/register the project and prove private clone/readiness. AgentX #1/#2 and
the CharterArc live adapter remain separate dependencies of the complete demo.

Postflight: alignment pass; implemented and locally verified, not delivered or
validated; scope delta none; no objective change; digest matches. Final source
review passed; cloud proof remains pending rather than inferred from local tests.
