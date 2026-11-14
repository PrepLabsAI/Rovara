# Offline SageMaker contract helpers (SM-A)

`findSageMakerContract` accepts classified file contents for **one model**. A caller
must identify its response fixtures, inference source and output schemas; this
module neither walks a repository nor executes code. It picks the first supported
fixture, then inference file, then schema, preserving caller order within a class.
Every supplied file receives an indexed reason. More than 64 files refuses the
entire batch. Individual files are limited to 65,536 characters, paths to 2,048,
and parsed shapes to 256 nodes and 12 levels below the root.

Fixtures are JSON response bodies, not SDK envelopes. They supply observed types,
not inferred numeric ranges. Array elements must have the same shape; empty
arrays cannot establish an item type. Values are discarded. Each shape node keeps
its source kind, path and escaped JSON pointer. Inference pointers identify the
function return followed by the field path.

Inference support is deliberately a literal-only subset: a single return in a
top-level `output_fn`, or `predict_fn` when no `output_fn` is defined. JSON-like
Python dict/list/scalar literals, `True`, `False`, `None`, and unescaped
single-quoted strings are supported. Dynamic expressions, conditional returns,
decorators and triple-quoted strings are unsupported. Nothing is evaluated.
An unsupported `output_fn` never falls back to its intermediate `predict_fn`.

Output schemas support `type` (object, array, number, integer, string, boolean,
null), `properties`, `required`, `items`, `minimum` and `maximum`. Every other
keyword refuses that candidate, including references, enums and compositions.
Optional properties remain marked optional; the generator includes all declared
properties. Missing or unsupported inputs produce `No contract found` with reasons.

`generateSageMakerMock` produces a version 1 document validated by
`SageMakerMockConfigSchema`. It has typical, edge, low-score and high-score
responses, plus a null empty-response exercise. The empty response states whether
it conforms to the contract. Numeric scenarios use declared bounds, or synthetic
0/1 bounds where unspecified (adjusted to any declared one-sided bound); these are
not model predictions or inferred score limits. Strings are synthetic `example`
values, never copied fixture data. Degenerate contracts can yield identical cases.
The error cases are 424, 429 and timeout. Independent rates default to zero, are
between zero and one, and sum to at most one. Fixed latency defaults to zero and
accepts integer milliseconds from zero through 60,000. No timer or random sampler
runs here. The later stand-in owns execution semantics.

All generated documents carry `made_by_rovara` / `Made by Rovara` using the shared
trust vocabulary. These helpers have **no runtime callers**, storage, record kind,
proof authority, backing selection or engine wiring. O34 persistence and proof
exclusion belong to separate lanes under the approved boundary. A later consumer
must apply those rules before enabling generated responses. Paths and field names
are untrusted metadata and must pass through the shared inert renderer if displayed.
