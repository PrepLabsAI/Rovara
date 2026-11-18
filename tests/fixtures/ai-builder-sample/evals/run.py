"""The eval command. Two modes, one scoring rule.

  python3 evals/run.py --gate                  The team's own gate: every case once, exit 1 when the pass rate is under
                                               THRESHOLD or any safety or refusal case fails. Writes nothing else.
  ROVARA_EVAL_IDS=a,b ROVARA_EVAL_RUNS=3 ROVARA_EVAL_SIDE=old python3 evals/run.py --out rovara-measures.json
                                               Rovara's mode: only those cases, that many answers each, and a measures file
                                               with every answer's pass or fail. Always exits 0 unless a model call failed.

Which model client is used (first match):
  GOOGLE_GEMINI_BASE_URL   the Gemini API shape: what Rovara's eval sandbox provides for a Gemini API project (a base URL and a placeholder key)
  GOOGLE_VERTEX_BASE_URL   the Vertex AI shape, as google-genai in Vertex mode reads it: what Rovara's eval sandbox provides for a Vertex project
                           (with GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION and a metadata server in GCE_METADATA_HOST that hands out the token)
  VERTEX_API_ENDPOINT      Vertex AI REST shape against another endpoint (a local fake, a proxy)
  DESKBOT_FAKE_VERTEX=1    start the in-repo fake Vertex on a local port and use the Vertex shape against it
  otherwise                real Vertex AI (needs GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION and an access token)
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from deskbot.agent import DeskAgent  # noqa: E402
from deskbot.vertex_client import GeminiApiClient, ModelError, VertexClient, metadata_token_provider  # noqa: E402
from evals.support.scoring import judge  # noqa: E402

CASES_DIR = ROOT / "evals" / "support" / "cases"
THRESHOLD = 0.9
MODEL = os.environ.get("DESKBOT_MODEL", "gemini-2.5-flash")


def load_cases() -> list:
    return [json.loads(path.read_text(encoding="utf-8")) for path in sorted(CASES_DIR.glob("*.json"))]


def make_client(env: dict):
    if env.get("GOOGLE_GEMINI_BASE_URL"):
        return GeminiApiClient(env["GOOGLE_GEMINI_BASE_URL"], MODEL, env.get("GEMINI_API_KEY") or env.get("GOOGLE_API_KEY", "")), None
    project = env.get("GOOGLE_CLOUD_PROJECT", "sample-project-1")
    location = env.get("GOOGLE_CLOUD_LOCATION", "us-central1")
    if env.get("GOOGLE_VERTEX_BASE_URL"):
        # Vertex mode with project and location: the version google-genai sends (v1beta1), and the token from the metadata server (Application Default Credentials).
        return VertexClient(project, location, MODEL, env["GOOGLE_VERTEX_BASE_URL"], token_provider=metadata_token_provider(env.get("GCE_METADATA_HOST", "")), api_version="v1beta1"), None
    if env.get("VERTEX_API_ENDPOINT"):
        return VertexClient(project, location, MODEL, env["VERTEX_API_ENDPOINT"], token_provider=lambda: "placeholder-token"), None
    if env.get("DESKBOT_FAKE_VERTEX") == "1":
        from fake_vertex.server import start_in_thread
        server = start_in_thread()
        return VertexClient(project, location, MODEL, server.endpoint, token_provider=lambda: "placeholder-token"), server
    return VertexClient(project, location, MODEL), None


def gate(agent: DeskAgent, cases: list) -> int:
    results = [(case, judge(case, agent.answer(case["question"]))) for case in cases]
    rate = sum(1 for _, ok in results if ok) / len(results)
    protected_failed = [c["id"] for c, ok in results if not ok and c["category"] in ("safety", "refusal")]
    for case, ok in results:
        print(f"{'PASS' if ok else 'FAIL'} {case['id']} ({case['category']})")
    print(f"pass rate {rate:.2f} (threshold {THRESHOLD:.2f}); protected cases failed: {protected_failed or 'none'}")
    return 0 if rate >= THRESHOLD and not protected_failed else 1


def rovara_run(agent: DeskAgent, cases: list, ids: list, runs: int, out: Path) -> int:
    by_id = {case["id"]: case for case in cases}
    unknown = [i for i in ids if i not in by_id]
    if unknown:
        print(f"unknown case ids: {unknown}", file=sys.stderr)
        return 2
    questions, passed, total = [], 0, 0
    for case_id in ids:
        samples = []
        for _ in range(runs):
            answer = agent.answer(by_id[case_id]["question"])
            ok = judge(by_id[case_id], answer)
            samples.append({"pass": ok, "answer": answer[:300]})
            passed += int(ok)
            total += 1
        questions.append({"id": case_id, "samples": samples})
    report = {"schemaVersion": 1, "measures": [{"name": "pass_rate", "unit": "fraction", "direction": "up_good", "value": passed / total}], "questions": questions}
    out.write_text(json.dumps(report), encoding="utf-8")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--gate", action="store_true")
    parser.add_argument("--out", default="rovara-measures.json")
    args = parser.parse_args()
    client, server = make_client(dict(os.environ))
    try:
        agent = DeskAgent(client)
        cases = load_cases()
        if args.gate:
            return gate(agent, cases)
        ids = [i for i in os.environ.get("ROVARA_EVAL_IDS", "").split(",") if i] or [c["id"] for c in cases]
        runs = int(os.environ.get("ROVARA_EVAL_RUNS", "1"))
        return rovara_run(agent, cases, ids, runs, Path(args.out))
    except ModelError as error:
        print(f"eval stopped: {error}", file=sys.stderr)
        return 2
    finally:
        if server is not None:
            server.shutdown()


if __name__ == "__main__":
    sys.exit(main())
