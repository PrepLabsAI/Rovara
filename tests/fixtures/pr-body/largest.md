> Add a tax line to the invoice view model.

<!-- rovara:checks-and-reviews -->
## Code failed · High risk · 11 things to check

**Changed** 300 files, +50,850 -600.
**Proven** 1 of 40 requirements proven. 1 failed. 36 not tested.
**Tested against** Service 0 (recorded fake, recorded 138 days ago, 3 made-up answers). Service 1 (fake written by hand, 3 made-up answers). Service 2 (recorded fake, recorded 138 days ago, 3 made-up answers). Service 3 (fake written by hand, 3 made-up answers). Service 4 (recorded fake, recorded 138 days ago, 3 made-up answers). Service 5 (fake written by hand, 3 made-up answers). Service 6 (recorded fake, recorded 138 days ago, 3 made-up answers). Service 7 (fake written by hand, 3 made-up answers). Service 8 (recorded fake, recorded 138 days ago, 3 made-up answers). Service 9 (fake written by hand, 3 made-up answers). Service 10 (recorded fake, recorded 138 days ago, 3 made-up answers). Service 11 (fake written by hand, 3 made-up answers).
**Reviews** Code review passed after the owner accepted its findings. Security review passed. **The owner accepted 20 review findings.** **The second review did not pass.**
**Risk** High. Changes sensitive paths: db/migrations/001.sql.
  - The code review rated this change high risk.
  - Changes 51450 lines, more than 400.
  - 6 checks failed on the latest code.
  - The owner accepted a code review finding.
**Needs you** The 11 items below, then the normal code review.

### Check these before you approve

1. **6 checks failed.** The code is at fault, not the environment.
   - Type check
   - Package check 6
   - Package check 13
   - Package check 20
   - Package check 27
   - Package check 34
   - a check fails on this change and passed before it
2. **A requirement is not met.**
   - 4: The tax line follows the customer's region.
3. **36 requirements are not tested.**
   - 5: Requirement number 5 of the large change holds for every package.
   - 6: Requirement number 6 of the large change holds for every package.
   - 7: Requirement number 7 of the large change holds for every package.
   - 8: Requirement number 8 of the large change holds for every package.
   - 9: Requirement number 9 of the large change holds for every package.
   - 10: Requirement number 10 of the large change holds for every package.
   - 11: Requirement number 11 of the large change holds for every package.
   - 12: Requirement number 12 of the large change holds for every package.
   - 13: Requirement number 13 of the large change holds for every package.
   - 14: Requirement number 14 of the large change holds for every package.
   - and 26 more
4. **The change adds no test.** Code changed and no test file was added or changed.
5. **6 services were fakes written by hand.** Their answers were not recorded from the real service.
   - Service 1
   - Service 3
   - Service 5
   - Service 7
   - Service 9
   - Service 11
6. **A fake made up answers.** A request with no recording got an answer that was made up.
   - Service 0: 3 requests
   - Service 1: 3 requests
   - Service 2: 3 requests
   - Service 3: 3 requests
   - Service 4: 3 requests
   - Service 5: 3 requests
   - Service 6: 3 requests
   - Service 7: 3 requests
   - Service 8: 3 requests
   - Service 9: 3 requests
   - and 2 more
7. **6 recorded fakes are old.** More than 90 days old (or the date is unknown). Real behaviour may have changed.
   - Service 0: recorded 138 days before this pull request
   - Service 2: recorded 138 days before this pull request
   - Service 4: recorded 138 days before this pull request
   - Service 6: recorded 138 days before this pull request
   - Service 8: recorded 138 days before this pull request
   - Service 10: recorded 138 days before this pull request
8. **Rovara could not compare the tests before and after.** No flag here does not mean no tests were weakened.
   - Test weakening: could not compare (no test report to compare)
9. **The owner accepted 20 review findings.**
   - [code] Finding number 0 about retries in module 0: accepted because Reason 1: accepted after reading src/module0.ts
   - [code] Finding number 1 about retries in module 1: accepted because Reason 2: accepted after reading src/module1.ts
   - [code] Finding number 2 about retries in module 2: accepted because Reason 3: accepted after reading src/module2.ts
   - and 17 more, listed on the task page
10. **The second review disagrees with the first.** Second review (openai/model-b) has 6 blocking findings.
    - Blocking finding 0 about the retry loop (src/module0.ts:1)
    - Blocking finding 1 about the retry loop (src/module1.ts:2)
    - Blocking finding 2 about the retry loop (src/module2.ts:3)
    - Blocking finding 3 about the retry loop (src/module3.ts:4)
    - Blocking finding 4 about the retry loop (src/module4.ts:5)
11. **The order of merging matters.**
    - Merge order line one.
    - Merge order line two.
    - Merge order line three.
    - Merge order line four.

<details>
<summary>Requirements and proof: 1 of 40 proven, 1 failed, 36 not tested</summary>

| Requirement | Evidence | Result |
| --- | --- | --- |
| 1: The invoice page shows subtotal, tax and total. | Unit tests (passed, fails on the original code) | ✅ proven |
| 2: The PDF shows the same three lines. | Integration tests (passed) | ✅ passed |
| 3: An order with no tax shows a zero tax line. | Lint (passed) | ✅ passed |
| 4: The tax line follows the customer's region. | Type check (failed) | ❌ failed |
| 5: Requirement number 5 of the large change holds for every package. | none | ⚠ not tested |
| 6: Requirement number 6 of the large change holds for every package. | none | ⚠ not tested |
| 7: Requirement number 7 of the large change holds for every package. | none | ⚠ not tested |
| 8: Requirement number 8 of the large change holds for every package. | none | ⚠ not tested |
| 9: Requirement number 9 of the large change holds for every package. | none | ⚠ not tested |
| 10: Requirement number 10 of the large change holds for every package. | none | ⚠ not tested |
| 11: Requirement number 11 of the large change holds for every package. | none | ⚠ not tested |
| 12: Requirement number 12 of the large change holds for every package. | none | ⚠ not tested |
| 13: Requirement number 13 of the large change holds for every package. | none | ⚠ not tested |
| 14: Requirement number 14 of the large change holds for every package. | none | ⚠ not tested |
| 15: Requirement number 15 of the large change holds for every package. | none | ⚠ not tested |
| 16: Requirement number 16 of the large change holds for every package. | none | ⚠ not tested |
| 17: Requirement number 17 of the large change holds for every package. | none | ⚠ not tested |
| 18: Requirement number 18 of the large change holds for every package. | none | ⚠ not tested |
| 19: Requirement number 19 of the large change holds for every package. | none | ⚠ not tested |
| 20: Requirement number 20 of the large change holds for every package. | none | ⚠ not tested |
| 21: Requirement number 21 of the large change holds for every package. | none | ⚠ not tested |
| 22: Requirement number 22 of the large change holds for every package. | none | ⚠ not tested |
| 23: Requirement number 23 of the large change holds for every package. | none | ⚠ not tested |
| 24: Requirement number 24 of the large change holds for every package. | none | ⚠ not tested |
| 25: Requirement number 25 of the large change holds for every package. | none | ⚠ not tested |
| 26: Requirement number 26 of the large change holds for every package. | none | ⚠ not tested |
| 27: Requirement number 27 of the large change holds for every package. | none | ⚠ not tested |
| 28: Requirement number 28 of the large change holds for every package. | none | ⚠ not tested |
| 29: Requirement number 29 of the large change holds for every package. | none | ⚠ not tested |
| 30: Requirement number 30 of the large change holds for every package. | none | ⚠ not tested |
| 31: Requirement number 31 of the large change holds for every package. | none | ⚠ not tested |
| 32: Requirement number 32 of the large change holds for every package. | none | ⚠ not tested |
| 33: Requirement number 33 of the large change holds for every package. | none | ⚠ not tested |
| 34: Requirement number 34 of the large change holds for every package. | none | ⚠ not tested |
| 35: Requirement number 35 of the large change holds for every package. | none | ⚠ not tested |
| 36: Requirement number 36 of the large change holds for every package. | none | ⚠ not tested |
| 37: Requirement number 37 of the large change holds for every package. | none | ⚠ not tested |
| 38: Requirement number 38 of the large change holds for every package. | none | ⚠ not tested |
| 39: Requirement number 39 of the large change holds for every package. | none | ⚠ not tested |
| 40: Requirement number 40 of the large change holds for every package. | none | ⚠ not tested |

What wasn't tested:
- Mocked service Service 0 is mocked (answered from recorded responses)
- Mocked service Service 1 is mocked (answered from recorded responses)
- Mocked service Service 2 is mocked (answered from recorded responses)
- Mocked service Service 3 is mocked (answered from recorded responses)
- Mocked service Service 4 is mocked (answered from recorded responses)
- Mocked service Service 5 is mocked (answered from recorded responses)
- Mocked service Service 6 is mocked (answered from recorded responses)
- Mocked service Service 7 is mocked (answered from recorded responses)
- Mocked service Service 8 is mocked (answered from recorded responses)
- Mocked service Service 9 is mocked (answered from recorded responses)
- and 2 more not tested
- Service 0: answers were recorded on 2026-07-02; real behaviour may have changed
- Service 0: 3 requests had no recording and got a made-up answer
- Service 1: answers were written by hand, not recorded
- Service 1: 3 requests had no recording and got a made-up answer
- Service 2: answers were recorded on 2026-07-02; real behaviour may have changed
- Service 2: 3 requests had no recording and got a made-up answer
- Service 3: answers were written by hand, not recorded
- Service 3: 3 requests had no recording and got a made-up answer
- Service 4: answers were recorded on 2026-07-02; real behaviour may have changed
- Service 4: 3 requests had no recording and got a made-up answer
- Service 5: answers were written by hand, not recorded
- Service 5: 3 requests had no recording and got a made-up answer
- Service 6: answers were recorded on 2026-07-02; real behaviour may have changed
- Service 6: 3 requests had no recording and got a made-up answer
- Service 7: answers were written by hand, not recorded
- Service 7: 3 requests had no recording and got a made-up answer
- Service 8: answers were recorded on 2026-07-02; real behaviour may have changed
- Service 8: 3 requests had no recording and got a made-up answer
- Service 9: answers were written by hand, not recorded
- Service 9: 3 requests had no recording and got a made-up answer
- Service 10: answers were recorded on 2026-07-02; real behaviour may have changed
- Service 10: 3 requests had no recording and got a made-up answer
- Service 11: answers were written by hand, not recorded
- Service 11: 3 requests had no recording and got a made-up answer
- Requirement 5: Requirement number 5 of the large change holds for every package. (no check or scenario names it)
- Requirement 6: Requirement number 6 of the large change holds for every package. (no check or scenario names it)
- Requirement 7: Requirement number 7 of the large change holds for every package. (no check or scenario names it)
- Requirement 8: Requirement number 8 of the large change holds for every package. (no check or scenario names it)
- Requirement 9: Requirement number 9 of the large change holds for every package. (no check or scenario names it)
- Requirement 10: Requirement number 10 of the large change holds for every package. (no check or scenario names it)
- Requirement 11: Requirement number 11 of the large change holds for every package. (no check or scenario names it)
- Requirement 12: Requirement number 12 of the large change holds for every package. (no check or scenario names it)
- Requirement 13: Requirement number 13 of the large change holds for every package. (no check or scenario names it)
- Requirement 14: Requirement number 14 of the large change holds for every package. (no check or scenario names it)
- Requirement 15: Requirement number 15 of the large change holds for every package. (no check or scenario names it)
- Requirement 16: Requirement number 16 of the large change holds for every package. (no check or scenario names it)
- Requirement 17: Requirement number 17 of the large change holds for every package. (no check or scenario names it)
- Requirement 18: Requirement number 18 of the large change holds for every package. (no check or scenario names it)
- Requirement 19: Requirement number 19 of the large change holds for every package. (no check or scenario names it)
- Requirement 20: Requirement number 20 of the large change holds for every package. (no check or scenario names it)
- Requirement 21: Requirement number 21 of the large change holds for every package. (no check or scenario names it)
- Requirement 22: Requirement number 22 of the large change holds for every package. (no check or scenario names it)
- Requirement 23: Requirement number 23 of the large change holds for every package. (no check or scenario names it)
- Requirement 24: Requirement number 24 of the large change holds for every package. (no check or scenario names it)
- Requirement 25: Requirement number 25 of the large change holds for every package. (no check or scenario names it)
- Requirement 26: Requirement number 26 of the large change holds for every package. (no check or scenario names it)
- Requirement 27: Requirement number 27 of the large change holds for every package. (no check or scenario names it)
- Requirement 28: Requirement number 28 of the large change holds for every package. (no check or scenario names it)
- Requirement 29: Requirement number 29 of the large change holds for every package. (no check or scenario names it)
- Requirement 30: Requirement number 30 of the large change holds for every package. (no check or scenario names it)
- Requirement 31: Requirement number 31 of the large change holds for every package. (no check or scenario names it)
- Requirement 32: Requirement number 32 of the large change holds for every package. (no check or scenario names it)
- Requirement 33: Requirement number 33 of the large change holds for every package. (no check or scenario names it)
- Requirement 34: Requirement number 34 of the large change holds for every package. (no check or scenario names it)
- Requirement 35: Requirement number 35 of the large change holds for every package. (no check or scenario names it)
- Requirement 36: Requirement number 36 of the large change holds for every package. (no check or scenario names it)
- Requirement 37: Requirement number 37 of the large change holds for every package. (no check or scenario names it)
- Requirement 38: Requirement number 38 of the large change holds for every package. (no check or scenario names it)
- Requirement 39: Requirement number 39 of the large change holds for every package. (no check or scenario names it)
- Requirement 40: Requirement number 40 of the large change holds for every package. (no check or scenario names it)

</details>

<details>
<summary>Checks: 34 of 40 passed, 6 failed</summary>

Result: Code failed.

| Check | Command | Result |
| --- | --- | --- |
| Type check | `npm run typecheck` | ❌ failed |
| Package check 6 | `npm run check:6` | ❌ failed |
| Package check 13 | `npm run check:13` | ❌ failed |
| Package check 20 | `npm run check:20` | ❌ failed |
| Package check 27 | `npm run check:27` | ❌ failed |
| Package check 34 | `npm run check:34` | ❌ failed |
| Unit tests | `npm test` | ✅ passed |
| Integration tests | `npm run test:integration` | ✅ passed |
| Lint | `npm run lint` | ✅ passed |
| Package check 0 | `npm run check:0` | ✅ passed |
| Package check 1 | `npm run check:1` | ✅ passed |
| Package check 2 | `npm run check:2` | ✅ passed |
| Package check 3 | `npm run check:3` | ✅ passed |
| Package check 4 | `npm run check:4` | ✅ passed |
| Package check 5 | `npm run check:5` | ✅ passed |
| Package check 7 | `npm run check:7` | ✅ passed |
| Package check 8 | `npm run check:8` | ✅ passed |
| Package check 9 | `npm run check:9` | ✅ passed |
| Package check 10 | `npm run check:10` | ✅ passed |
| Package check 11 | `npm run check:11` | ✅ passed |
| Package check 12 | `npm run check:12` | ✅ passed |
| Package check 14 | `npm run check:14` | ✅ passed |
| Package check 15 | `npm run check:15` | ✅ passed |
| Package check 16 | `npm run check:16` | ✅ passed |
| Package check 17 | `npm run check:17` | ✅ passed |
| Package check 18 | `npm run check:18` | ✅ passed |
| Package check 19 | `npm run check:19` | ✅ passed |
| Package check 21 | `npm run check:21` | ✅ passed |
| Package check 22 | `npm run check:22` | ✅ passed |
| Package check 23 | `npm run check:23` | ✅ passed |
| Package check 24 | `npm run check:24` | ✅ passed |
| Package check 25 | `npm run check:25` | ✅ passed |
| Package check 26 | `npm run check:26` | ✅ passed |
| Package check 28 | `npm run check:28` | ✅ passed |
| Package check 29 | `npm run check:29` | ✅ passed |
| Package check 30 | `npm run check:30` | ✅ passed |
| Package check 31 | `npm run check:31` | ✅ passed |
| Package check 32 | `npm run check:32` | ✅ passed |
| Package check 33 | `npm run check:33` | ✅ passed |
| Package check 35 | `npm run check:35` | ✅ passed |

- Tested on head commit 4c1d9e07
- Test proof: 1 check fails on the original code and passes now

- Checks by kind: check 0 ✓ (test details not read) · check 1 ✓ (test details not read) · check 2 ✓ (test details not read) · check 3 ✗ (test details not read) · check 4 ✓ (test details not read) · check 5 ✓ (test details not read) · check 6 ✓ (test details not read) · check 7 ✓ (test details not read) · check 8 ✓ (test details not read) · check 9 ✓ (test details not read) · check 10 ✗ (test details not read) · check 11 ✓ (test details not read) · and 28 more
- Changed lines covered by tests: no coverage report

Code failed checks · Run by Rovara, not sealed

Checked in the agent's sandbox (not sealed)

Checks: 40 (34 passed, 6 failed)
- Tests: check 0: passed
- Tests: check 1: passed
- Tests: check 2: passed
- Tests: check 3: failed
- Tests: check 4: passed
- Tests: check 5: passed
- Tests: check 6: passed
- Tests: check 7: passed
- Tests: check 8: passed
- Tests: check 9: passed
- Tests: check 10: failed
- Tests: check 11: passed
- and 28 more checks

Not tested:
- Service 0 is mocked (answered from recorded responses)
- Service 1 is mocked (answered from recorded responses)
- Service 2 is mocked (answered from recorded responses)
- Service 3 is mocked (answered from recorded responses)
- Service 4 is mocked (answered from recorded responses)
- Service 5 is mocked (answered from recorded responses)
- Service 6 is mocked (answered from recorded responses)
- Service 7 is mocked (answered from recorded responses)
- Service 8 is mocked (answered from recorded responses)
- Service 9 is mocked (answered from recorded responses)
- and 2 more

</details>

<details>
<summary>Test setup: sandbox, 6 old recorded fakes, 6 hand-written fakes, Service 0 recorded fake, recorded 138 days ago, Service 2 recorded fake, recorded 138 days ago, Service 4 recorded fake, recorded 138 days ago, Service 6 recorded fake, recorded 138 days ago, Service 8 recorded fake, recorded 138 days ago, Service 10 recorded fake, recorded 138 days ago</summary>

- Environment: sandbox, approved test environment revision 7. Test data: synthetic.
- Integration tests ran against: Service 0, Service 2, Service 4, Service 6, Service 8 and Service 10 (recorded fake, +3 made-up answers), Service 1, Service 3, Service 5, Service 7, Service 9 and Service 11 (hand-written fake, +3 made-up answers).
- Full evidence (screenshots, API samples, video, logs): Rovara task page (sign-in needed): https://rovara.example/t/482

</details>

<details>
<summary>Reviews: 2 passed after accepted findings, 20 findings accepted, second review has 6 blocking findings</summary>

Reviews: code review passed after the owner accepted its findings; security review passed
Owner accepted 20 review findings:
- [code] Finding number 0 about retries in module 0 — accepted: Reason 1: accepted after reading src/module0.ts
- [code] Finding number 1 about retries in module 1 — accepted: Reason 2: accepted after reading src/module1.ts
- [code] Finding number 2 about retries in module 2 — accepted: Reason 3: accepted after reading src/module2.ts
- [code] Finding number 3 about retries in module 3 — accepted: Reason 4: accepted after reading src/module3.ts
- [code] Finding number 4 about retries in module 4 — accepted: Reason 5: accepted after reading src/module4.ts
- [code] Finding number 5 about retries in module 5 — accepted: Reason 6: accepted after reading src/module5.ts
- [code] Finding number 6 about retries in module 6 — accepted: Reason 7: accepted after reading src/module6.ts
- [code] Finding number 7 about retries in module 7 — accepted: Reason 8: accepted after reading src/module7.ts
- [code] Finding number 8 about retries in module 8 — accepted: Reason 9: accepted after reading src/module8.ts
- [code] Finding number 9 about retries in module 9 — accepted: Reason 10: accepted after reading src/module9.ts
- [code] Finding number 10 about retries in module 10 — accepted: Reason 11: accepted after reading src/module10.ts
- [code] Finding number 11 about retries in module 11 — accepted: Reason 12: accepted after reading src/module11.ts
- [code] Finding number 12 about retries in module 12 — accepted: Reason 13: accepted after reading src/module12.ts
- [code] Finding number 13 about retries in module 13 — accepted: Reason 14: accepted after reading src/module13.ts
- [code] Finding number 14 about retries in module 14 — accepted: Reason 15: accepted after reading src/module14.ts
- [code] Finding number 15 about retries in module 15 — accepted: Reason 16: accepted after reading src/module15.ts
- [code] Finding number 16 about retries in module 16 — accepted: Reason 17: accepted after reading src/module16.ts
- [code] Finding number 17 about retries in module 17 — accepted: Reason 18: accepted after reading src/module17.ts
- [code] Finding number 18 about retries in module 18 — accepted: Reason 19: accepted after reading src/module18.ts
- [code] Finding number 19 about retries in module 19 — accepted: Reason 20: accepted after reading src/module19.ts
Reviewed by anthropic/model-a
Second review (openai/model-b): 6 blocking findings
- Blocking finding 0 about the retry loop (src/module0.ts:1)
- Blocking finding 1 about the retry loop (src/module1.ts:2)
- Blocking finding 2 about the retry loop (src/module2.ts:3)
- Blocking finding 3 about the retry loop (src/module3.ts:4)
- Blocking finding 4 about the retry loop (src/module4.ts:5)

</details>

<details>
<summary>What Rovara used: 30 lessons</summary>

Rovara used 30 lessons from this project's record. Tell Rovara when one did not help.

1. Lesson 0: a rule about module 0 that is worth remembering ([not helpful](https://rovara.example/t/482?lesson=0))
2. Lesson 1: a rule about module 1 that is worth remembering ([not helpful](https://rovara.example/t/482?lesson=1))
3. Lesson 2: a rule about module 2 that is worth remembering ([not helpful](https://rovara.example/t/482?lesson=2))
4. Lesson 3: a rule about module 3 that is worth remembering ([not helpful](https://rovara.example/t/482?lesson=3))
5. Lesson 4: a rule about module 4 that is worth remembering ([not helpful](https://rovara.example/t/482?lesson=4))
6. Lesson 5: a rule about module 5 that is worth remembering ([not helpful](https://rovara.example/t/482?lesson=5))
7. Lesson 6: a rule about module 6 that is worth remembering ([not helpful](https://rovara.example/t/482?lesson=6))
8. Lesson 7: a rule about module 7 that is worth remembering ([not helpful](https://rovara.example/t/482?lesson=7))
9. Lesson 8: a rule about module 8 that is worth remembering ([not helpful](https://rovara.example/t/482?lesson=8))
10. Lesson 9: a rule about module 9 that is worth remembering ([not helpful](https://rovara.example/t/482?lesson=9))
and 20 more

</details>

Fixes ENG-900
<!-- /rovara:checks-and-reviews -->

<details>
<summary>Plan and record</summary>

> 1. Add a tax line to the invoice view model.
> 2. Render it on the invoice page and in the PDF template.
> 3. Cover zero-tax orders.

Requested by: Priya N.
Plan approved by: Priya N.
Audit record: https://rovara.example/audit/482

Rovara session: https://rovara.example/t/482

</details>

Opened by Rovara after the approved plan, checks and reviews. A person must approve it and a person merges it.