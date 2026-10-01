# Pi 0.85.1 baseline (spec 050 FR-004)

Runner image `swebench-20261001T182913Z-a4b862f53023` (Pi 0.85.1). One run per row, started from #swe-bench-evals. Kept for reference only: paid regression runs were dropped before launch (FR-004), so runs 7-8 (GLM on SEC-bench) are not part of a gate.

| # | Task | Model | Resolved | Tests / check | Agent time | Cost | Run |
|---|---|---|---|---|---|---|---|
| 1 | SWE-bench Verified `django__django-15957` | Sonnet 4.6 | yes | F2P 4/4, P2P 89/89 | 4m 52s | $0.76 | 5e068fd7 |
| 2 | SWE-bench Verified `sympy__sympy-13878` | Sonnet 4.6 | **no** (resolved in the 2026-09-30 pilot) | F2P 0/1, P2P 19/19 | 5m 01s | $0.64 | e38afc6f |
| 3 | SEC-bench `njs.cve-2022-32414` | Sonnet 4.6 | yes (all three modes) | PoC exit 0, no sanitizer report | 27m 40s | $7.23 | deba2b61 (spec 045 SC-003 run, same runner image) |
| 4 | SEC-bench `gpac.cve-2023-5586` | Sonnet 4.6 | yes (medium, generous; strict fail) | no sanitizer report | 2m 25s | $0.14 | 0eb4d29e |
| 5 | SWE-bench Verified `django__django-15957` | GLM 5.3 | yes | F2P 4/4, P2P 89/89 | 18m 51s | $1.80 (5.1M tokens) | 4c89e1c6 |
| 6 | SWE-bench Verified `sympy__sympy-13878` | GLM 5.3 | yes | F2P 1/1, P2P 19/19 | 11m 36s | $0.71 | 29471952 |
