# Porting Rovara Code features: how port lanes work

This page is for the people and agents who move Rovara Code features from the private Cloud code into this repository. It
follows owner decisions 41 (the Cloud line), 42a and 42b (the port branch and the gate) and 45 (the port decisions).

## The branches

- `mainline` is what users get. A person merges into it. Nothing else does.
- `code/next` is the public branch the port lands on. It starts as a copy of `mainline`. The controller (the one session named
  in `CONTROLLER.txt`) is the only merger into `code/next`. It merges reviewed lanes without waiting for a person.
- A person merges `code/next` into `mainline`, when wave 1 of the port (the ten-minute path on a laptop) works and passes. One owner
  approves a normal change; both owners approve a change to a plug-in interface (decision 42a).
- A lane is one branch of work, named `port/<name>` (for example `port/guard`). It starts from `code/next`.

## What a lane does

1. Fetch and branch from `code/next`:

   ```sh
   git fetch origin
   git worktree add -b port/<name> ../Rovara-port-<name>-<date> origin/code/next
   ```

2. Port by reading the Cloud code and copying or rewriting it into this tree. Never merge Cloud history and never cherry-pick
   Cloud commits: the history holds names and ids that must stay private.
3. A copied file must not import anything Cloud-only. Replace each such import with the plug-in port the inventory names for it
   (storage, queue, worker machines, admission, audit sink, approvers, identity, metering).
4. Run the port guard on your range before every push, and fix what it prints. Fetch first: a stale `origin/code/next` widens the
   range and re-scans work that is already merged.

   ```sh
   git fetch origin
   npm run port:guard                                  # origin/code/next..HEAD
   npm run port:guard -- --range origin/code/next..HEAD
   ```

5. Run the lane's gates (affected tests, `tsc -b`, lint on changed files, the typecheck) as for any change.
6. Push the lane to the **private** remote only, after checking that the remote is private:

   ```sh
   gh repo view <the private repository> --json visibility -q .visibility    # must print PRIVATE
   git push private HEAD:refs/heads/port/<name>
   ```

   A lane never pushes to this public repository. Nothing in a lane's history is public until the controller moves it.
7. Hand the branch name, the sha and a short summary to the controller.

## What the controller does

It fetches the lane from the private remote, runs the guard again from its own trusted copy (so the guard cannot be weakened by the
lane under review), runs gitleaks and the prospect and customer-name scan, reads the diff, and only then merges the lane into
`code/next` and pushes it here. The `port-guard` job in `.github/workflows/ci.yml` runs on every push to `code/next` and every pull
request into it, over everything `code/next` holds beyond `mainline`. On a pull request the base branch's copy of the guard runs, and a
second strict run turns red on any edit to the guard itself. A run on a push is after the fact: it detects, and the controller's run
before the merge is the one that prevents.

## What the guard refuses (`scripts/port-guard.ts`)

It reads the range's net diff and every commit in the range (a merge commit by what no parent had), so a bad file that a later commit
deletes still fails: history travels with the push. Commit messages, author and committer names and file names are read too. It prints `file:line`, the rule and a label, never the text it matched, and exits 1 on any finding (2 when it
could not run, for instance when gitleaks is missing).

| Rule | What fails |
| --- | --- |
| `cloud-path` | A path under an `org/`, `spend/`, `audit/`, `team-record/` or `devices/` directory (any case); a contracts file named `org*`, `spend*`, `audit*` or `team-record*` (two exceptions: the key scheme `org-scoped-keys`, and the audit-sink port, `audit-sink.ts` and `audit-sink.test.ts`, which is a Code interface that Cloud fills with its audit ledger, while the ledger, its verifier and its outbox stay Cloud-only); `packages/ui`, `packages/web`, `packages/audit-verifier`, `packages/model-proxy`, `packages/design-tokens`; a new file in `packages/cli/src/upgrade` (public's own six files stay); a Cloud CDK stack (`audit-*`, `team-record-*`, `org-*`, `spend-*`, `web-app`, `cloud-identity`, `custom-domain*`, `edition-env`); `docs/enterprise`, `docs/audit-ledger`; any `vendor/` folder (Cloud keeps its pinned copy of Code in one) and any `packages/cloud-*` package |
| `cloud-import` | A TypeScript or JavaScript file in the range that imports any of those, by relative path, package name (`@agentx/ui`, `@agentx/web`, `@rovara/audit-verifier`, any `@agentx/cloud-*` package, or one of the same name under the product's other scope) or package subpath, in `import`, `export ... from`, `import()`, `require`, a side-effect import or a test mock; also a `package.json`, `tsconfig*.json` or workflow file that names one of those packages |
| `cloud-aws` | The AWS line (decision 72, O2): only four generic adapters (DynamoDB storage, SQS queue, S3 objects, Secrets Manager secrets) may be public, in one package (`packages/aws-adapters`). Refused: a NEW file under an `aws/` directory (Cloud's handlers; Code's existing files there may still be edited), a NEW file under `infra/` (Cloud's CDK), any file in the adapters package outside those four, and an import of an AWS SDK client or library off the list, or of the CDK, in the adapters package or in a NEW file (the install flow under `packages/cli/src/` may use any client: it talks to the customer's own account). The Bedrock model-provider plug-in may import the one STS client the data names (a sanctioned AWS adapter), tests are not read when an import is only text inside a string, and the env-detect fixture paths are not read at all. The list is data, `scripts/boundary-allowlist.json`, which Cloud's boundary check reads too. The guard reads that file from beside itself (or `--boundary <file>`), never from the checkout it judges, and stops if it is missing; CI copies the base branch's file next to the trusted guard with no fallback. The data may also excuse one known finding on a commit that is already public (commit sha, rule and file together) |
| `stray-file` | An editor, merge or sed leftover: a name ending in `-E` or `-e` (macOS `sed -i -E` backup), `.orig`, `.rej`, `.bak`, `~`, `.swp`, `.swo`, `.tmp`, `,v`, `#` (and kin), `.DS_Store`, `._name`, `#name#`, `name copy.ts`. Such a copy can hold raw Cloud source under a name no other rule reads, so it fails even before its content is looked at; `cloud-import`, `private-name` and `secret` also read it, as does any added text that reads as TypeScript/JavaScript whatever its name |
| `build-detector` | Any TypeScript or JavaScript file with the internal build-system detector's name in its path, its test included. It is an optional plug-in package, never core (decision 45.11) |
| `private-name` | On an added line (read in ASCII: look-alike letters, full-width forms and zero-width characters are folded, and a name broken over the lines of one added hunk is matched), in a file name, a commit message or an author name: prospect and customer names, internal build-system names and the other protected words, matched against a salted hash list (no name is written anywhere in the repository; words and runs of two or three adjacent words are hashed and compared, so `a b`, `a_b`, `aB` and `ab` all match; most single names also match glued inside a longer word, such as a user name), a private branch name (an integration branch with its four digits, the Cloud integration branch, or a Cloud lane branch `prefix/name`; also written `%2F`, with a backslash, with spaces around the slash, or split over lines; not a `/cc/` URL segment, the Creative Commons shorthand or a folder called after the prefix), in any added line, file name or commit message, the staging account id, any 12-digit account id inside an ARN, in an ECR registry host or in an `account`/`accountId` field, an API Gateway host, a host under the product's dev domain, or the private repository's name. AWS documentation placeholder accounts (`123456789012`, `111122223333`, `222222222222`, `000000000000`, and the fixture ids `999988887777` and `210987654321`) and placeholder API ids (`abc`, `abc123`, `example`, `examplehost`, `test`) pass. Fixtures should use `examplehost` |
| `link` | A symlink or a submodule |
| `scan-bypass` | An inline allow comment for gitleaks, or a `.gitleaks.toml` / `.gitleaksignore` file (the guard scans with its own default config and ignores both) |
| `guard-files` | An edit to `scripts/port-guard.ts`, `scripts/boundary-allowlist.json`, its tests, the CI workflow or the `port:guard` script in a `package.json`. These need the controller's eyes; the guard's own lane passes `--allow-guard-edits`, and so does CI, which cannot judge its own checkout |
| `secret` | Anything gitleaks finds in the range's patches (text mode, merges included, with the guard's own config), plus a second scan of the lines the range adds to every file, written under a neutral name (gitleaks's default config skips files by name: lockfiles, images, archives, `node_modules/`, vendor directories, `go.mod` and more), and a third of what each merge commit's own resolution added. Without gitleaks the guard fails; it never passes unscanned |

Renames are followed (`git diff -M`). A file the range moves is judged as the file it was, the way a modified file is: it is not a "new file" for `cloud-aws`, a file that was already under `aws/` stays what it was, and only the lines the move really changed are read as added (private names, secrets, imports). A move into an `aws/` or Cloud-only place from outside it, and a copy (the original stays), are still new. An entry in `scripts/port-guard-accepted.json` follows its file to the new path and still holds across a change that only rewrites module specifiers, package names and the own-path header comment (in place or when moved) from the accepted blob; any other edit makes it `accepted-stale`. Git pairs a delete with an add only when the content is at least half alike, and stops pairing above 10,000 changed files, so a pairing that does not happen is only stricter.

What it cannot see: a Cloud-only dependency built from a computed string, a Cloud-only idea copied under another file name, text
inside a real binary file (an image or archive is only scanned for secrets, not for names), a name written with letters from an
alphabet the guard does not map, and a name nobody put on the list. Review still reads the diff. Merging `mainline` into `code/next` is a sync, not a lane: the controller does it directly after its own run,
because the strict pull request run would flag everything mainline brought along.

`tests/contract/port-guard-tree.test.ts` runs the same path and import rules over the whole tree, so Cloud-only code that arrived some
other way also fails the suite.

## The extended name list (controller only)

The built-in list is hashes, so it cannot be read back from the repository, but a short common word could still be guessed. The
controller keeps a longer list outside the repository, one regular expression per line (`#` starts a comment), and points the guard
at it with `PORT_GUARD_PRIVATE_NAMES=/path/to/file`. Those patterns get the same ASCII folding, split-over-lines and line-ending
handling; the patterns run on every added line, so avoid nested quantifiers, and lines are trimmed (`\s` for a deliberate space, `\x23` for a leading `#`). When the variable is not set the guard prints one note line saying the extended list was not loaded; that is not an error.
Never write a name, even in pieces, in a test, a comment or this page: tests use invented names on an injected list.

## Rules that never bend

- No key-shaped strings in the repository, in a test, a fixture or a comment. Build fake tokens at run time. GitHub push protection
  refuses key-shaped strings; never bypass it. Report the type, file and line instead.
- No AWS account ids, internal hostnames, ARNs with real account numbers or staging URLs. The guard knows the staging id, ARN and ECR
  account ids, `account`/`accountId` fields and API Gateway hosts; the rest is for the reviewer.
- Changing the allowlists in the guard (for example another contracts file Code keeps) changes the Cloud line and needs both owners.
