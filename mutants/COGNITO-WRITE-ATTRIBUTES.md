# Mutants for COGNITO-WRITE-ATTRIBUTES (copy of the builder's list; mutants 2, 3, 5, 9 were run by the Sonnet pre-review, the rest are NOT run)
Command used: `9d-heavy.sh <node 22.23.2> node_modules/vitest/vitest.mjs run tests/contract/identity-stack.test.ts --maxWorkers=1` (base: 17 passed). Each mutant was applied to infra/lib/identity.ts and reverted with git checkout; tree left clean.
Run with: `HEAVY` slot, `npx vitest run --maxWorkers=1 tests/contract/identity-stack.test.ts tests/contract/named-templates.test.ts -t "identity"`.
1. Drop `writeAttributes` from the client (all attributes writable again). Expect: "lets the app client write every standard attribute except the two verified flags..." and the published-template test fail; the named-templates identity pin fails on the stripper's WriteAttributes assertion.
2. `emailVerified: true` always (the verified flag writable). Expect: the denied-list test and the exact-list test fail.
   **RUN 2026-11-25 (Sonnet pre-review): KILLED. 3 failed (exact-list test, IdP test, published-template test).**
3. `phoneNumberVerified: true` always. Expect: same two tests fail.
   **RUN 2026-11-25 (Sonnet pre-review): KILLED. 3 failed (same three tests).**
4. `email: false` (email dropped from the list: Cognito would refuse "Invalid write attributes", required attribute omitted). Expect: the `toContain("email")` / exact-list tests fail.
5. `writable()` returns true for every name (a provider-less stack lets the verified flags through). Expect: default-list test fails.
   **RUN 2026-11-25 (Sonnet pre-review), applied as `=> true` for both verified flags (email_verified writable without an IdP): KILLED. 3 failed (exact-list, IdP, published-template).**
6. The IdP rule ignored (`idpMapped` never read). Expect: "keeps the attributes a federated identity provider maps writable" fails.
7. The IdP rule over-broad: `email_verified` mapped also opens `phone_number_verified`. Expect: the IdP test fails (`not.toContain("phone_number_verified")`).
8. `props.idpMappedAttributes` not passed to the client (prop dead). Expect: the IdP test fails.
9. Remove `keepOriginal: { email: true }`. Expect: "makes the pool verify a new email..." and the published-template test fail; the named-templates identity pin fails on the stripper.
   **RUN 2026-11-25 (Sonnet pre-review): KILLED. 2 failed (verify-before-update test, published-template test).**
10. `keepOriginal: { email: true, phone: true }`. Expect: the exact-array assertions (`["email"]`) fail.
11. Add `signInAliases: { email: true, preferredUsername: true }` (a pool-replacing change). Expect: "changes nothing that would replace the pool" fails (AliasAttributes / UsernameAttributes pinned).
12. `generateSecret: true`. Expect: the replacement-sensitivity test and the PKCE-client test fail.
13. Add a custom attribute (`customAttributes`). Expect: the replacement-sensitivity test fails (Schema pinned undefined).
14. Add a second client (`pool.addClient("Other")`). Expect: "exactly one client" assertions fail (also the stripper).
15. Remove `autoVerify: { email: true }`. Expect: CDK throws at synth for keepOriginal (or the AutoVerifiedAttributes assertion fails).
16. Named-templates stripper: skip the client assertion (`WriteAttributes` left but not asserted) . Expect: reviewer reads the stripper: it must `expect` both before `delete`.
