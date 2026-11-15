# File details

`ChangeRequestFile.entry` is optional. Absent means "the host could not tell", never "an ordinary file". Both sides must be known. The base side is the compare API's merge base; renames use `previousPath`. Unknown modes, directories, truncated trees and failed metadata reads leave the field absent. Rate limits in these two port reads throw `HostRateLimitError`; existing provider calls retain their prior `RUNTIME_UNAVAILABLE` errors.

Callers may pass `{ expectedHead }` to `changedFiles` using the same classified head on every page. A different current head omits all types and avoids tree reads. Status/type contradictions also omit metadata: added paths must exist only at head, removed paths only at base, and modified/renamed paths on both sides. This is a best-effort consistency check; it does not pin the files endpoint or make multiple GitHub calls atomic. Compare resolves the current base branch, rather than relying on the PR record's possibly stale base SHA.

`instructionFiles` is optional. It lists matching repository paths and their entry types at a full commit id. A truncated tree or more than `max` matches sets `complete: false`; `max` defaults to 500 and accepts nonnegative safe integers. Read failures and unknown matching entry types throw. Symbolic links are listed by their own paths, without resolving targets. A regular directory is not a file result.

The shared `AI_INSTRUCTION_PATH_RULES` list is exported from contracts. Matching is case-insensitive at any depth, with whole path segments. One leading `./` is accepted. Backslashes are ordinary filename characters: `weird\dir/AGENTS.md` matches, while the single segment `packages\api\AGENTS.md` does not. Empty segments and traversal segments are rejected. The list includes the requested filenames (`AGENTS.md`, `AGENTS.override.md`, `AGENT.md`, `CLAUDE.md`, `CLAUDE.local.md`, `GEMINI.md`, `WARP.md`, `SKILL.md`, `.cursorrules`, `.windsurfrules`, `.clinerules`, `.goosehints`), `.github/copilot-instructions.md`, and all descendants of `.cursor`, `.claude`, `.windsurf`, `.clinerules`, `.continue`, `.agents`, `.codex`, `.openhands`, `.kilocode`, `.amazonq`, `.kiro`, `.gemini`, `.roo`, `.cline`, `.trae`, `.junie`, `.rovara`, `.github/instructions`, `.github/prompts` and `.github/chatmodes`. No additional locations were added.

## Request counts

For a nonempty page with two distinct, uncached revisions, `changedFiles` performs five data requests: files page, pull request, compare, head tree and merge-base tree. With both trees cached it performs three: files, pull request and compare. No PR/compare answer is cached, so a moved branch cannot leave a stale revision pair. Empty pages make only the files request. The real-client HTTP test asserts eight total requests cold (one installation lookup and two permission-specific token mints in addition to the five data requests) and three warm. Token expiry, installation changes and provider-specific authorization may add requests.

`instructionFiles` makes one tree data request cold (three total on a fresh App client: installation, token, tree). A cache hit makes no tree request, but rechecks repository authorization: one fresh installation lookup in the App client. Company binding is checked on every read. The tests separately assert the cold and warm counts.

The per-adapter cache keeps at most eight complete trees, keyed by scope, repository URL and commit SHA. Failures and truncated listings are not cached. Results are indexed once, so a changed-file page does not rescan the tree for each path. Tests cover a 99,000-entry tree and a bounded 1,000-file port-page simulation; GitHub itself pages files in groups of 100.

## Coverage limits

Local tests use GitHub fixtures and a loopback HTTP server; they never contact an outside host. The fake models exact renames, not Git similarity scoring. The change classifier does not consume these additions yet. Other code-host providers may omit both optional additions. Tree content is immutable, but authorization remains live; there is no persistence or cross-instance cache.
