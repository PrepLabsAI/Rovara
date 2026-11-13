# Report adapters

`parseReportParts(text, hint = "auto")` is the worker's in-process adapter entry point. `REPORT_ADAPTERS` is a closed table of `format`, `family`, `parts`, `sniff`, and `parse`. Specific JSON rows precede generic Jest/Vitest JSON. A recognised but malformed format does not fall through to another parser. JSON never reaches an XML row. Inputs are bounded to 8 MiB; test reports to 50,000 results.

`parseTestReport` remains the compatibility entry point: it returns only the tests part. JUnit, Jest/Vitest and Go retain their prior output. The serialized evidence tests part has no format discriminator, and still passes the existing v1 writer and reader schemas. Measures are never represented as test counts.

`readReportPartsFile` reads an explicitly named report through the existing contained, fresh, bounded file reader. It additionally refuses intermediate symlinks and invalid UTF-8. It reports missing, unsafe, stale, too large, unreadable, malformed, or newer input with fixed codes. It never guesses `rovara-measures.json` or changes a customer's command. TE-F3 and later callers choose the approved path and supply the round start time.

## Measures file version 1

A `rovara-measures.json` file has:

- `schemaVersion: 1`.
- `measures`: 1–50 entries containing `name` (1–80 characters), `unit` (1–20 characters), `value`, and `direction` (`up_good` or `down_good`).
- Each entry may include nonnegative `spread` and integer `count` (0–100,000,000).
- Optional file-level `eval_set_hash`: lowercase 64-digit SHA-256 of an eval set, for the TE-F3 cache key.

The entry schema derives its labels, direction, value and spread constraints from A2a's exported `EvidenceMeasureSchema`. Values are finite and within ±1e12; spread is finite and within 0–1e12. Negative zero is refused. All known-version objects are strict, and unknown keys are never assigned to an object. Unknown positive integer versions return `newer`; malformed data returns `unreadable`. A file contains only the head-side observations: the producer must obtain a real baseline before writing evidence `base`/`head` comparisons. `count` and `eval_set_hash` are file provenance, not invented evidence fields.

## New format coverage

TRX reads `UnitTestResult` directly under `TestRun/Results`, with `testName`, `outcome`, `duration`, `startTime` and `endTime`. `Passed`, `Failed` and `NotExecuted` map to pass, fail and skip; other outcomes are errors. Counts come from entries, never summary counters. The scanner accepts namespace prefixes, comments and CDATA, bounds nesting and attributes, and has no DTD, entity expansion, resolver or external I/O. Only the existing fixed XML character entities are decoded once. Test definitions, source-file joins, attachments, nested data-driven results and run-level diagnostic details are outside this initial coverage.

CTRF reads `results.tests`, with `name`, `filepath`, `status`, `duration`, `start` and `stop`. A flaky/retried row contributes its final status once; retry attempts do not inflate counts. Unknown statuses count as errors. Summary counters and suite clocks are not treated as per-test data. Attachments, steps and tool extensions are outside this initial coverage. New adapter text preserves the reported identity internally and uses `inertEvidenceText` at the evidence display boundary. A label changed for display is marked `unlisted` and carries no per-test proof, so it cannot match a different test.

TRX and CTRF preserve per-test epoch clocks in `startTimeMs` and `endTimeMs` when supplied and valid. Duration alone never establishes a start time. Go/Jest timing metadata is returned separately from legacy test objects so their old output remains unchanged.

The TE-IF4 fixtures live in `tests/fixtures/report-adapters/`; their table test and boundary tests cover all six formats. Golden legacy output was captured from pinned TE-B3 before implementation.

Sources: [CTRF specification](https://github.com/ctrf-io/ctrf/blob/main/spec/ctrf.md), [VSTest TRX writer](https://github.com/microsoft/vstest/blob/main/src/Microsoft.TestPlatform.Extensions.TrxLogger/ObjectModel/TestResult.cs), [Jest assertion fields](https://github.com/jestjs/jest/blob/main/packages/jest-types/src/TestResult.ts).
