"""Conformance harness mechanics, proven offline with the fake engine.

The fake scripts simulate what a competent engine would do, so these tests
verify the *harness* (materialization, runner subprocess, oracle grading) —
not engine intelligence.
"""

from pathlib import Path

from agentx_runner.conformance.harness import load_fixture, run_fixture

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures"

FIXED_CALCULATOR = '''"""A tiny calculator module."""


def add(a, b):
    return a + b


def average(values):
    if not values:
        raise ValueError("average() of empty sequence")
    return sum(values) / len(values)


def clamp(value, low, high):
    if low > high:
        raise ValueError("low must be <= high")
    return max(low, min(value, high))
'''

DONE = {
    "type": "done",
    "result": {"branch": "agentx/fix", "summary": "fixed", "test_evidence": "pytest"},
}


def test_failing_test_fixture_passes_when_engine_fixes_the_bug() -> None:
    fixture = load_fixture(FIXTURES / "fixture-failing-test")
    outcome = run_fixture(
        fixture,
        engine="fake",
        model=None,
        timeout_sec=120,
        engine_config={
            "script": [
                {"write_file": {"path": "calculator.py", "content": FIXED_CALCULATOR}},
                {"commit": {"branch": "agentx/fix", "message": "fix average()"}},
                {"emit": DONE},
            ]
        },
    )
    assert outcome.status == "PASS", outcome.detail


def test_failing_test_fixture_fails_when_engine_does_nothing() -> None:
    fixture = load_fixture(FIXTURES / "fixture-failing-test")
    outcome = run_fixture(
        fixture,
        engine="fake",
        model=None,
        timeout_sec=120,
        engine_config={
            "script": [
                # commits an irrelevant file without fixing the bug
                {"write_file": {"path": "NOTES.md", "content": "looked at it\n"}},
                {"commit": {"branch": "agentx/fix", "message": "notes only"}},
                {"emit": DONE},
            ]
        },
    )
    assert outcome.status == "FAIL"
    assert "oracle failed" in outcome.detail


def test_missing_branch_is_fail() -> None:
    fixture = load_fixture(FIXTURES / "fixture-failing-test")
    outcome = run_fixture(
        fixture,
        engine="fake",
        model=None,
        timeout_sec=120,
        engine_config={"script": [{"emit": DONE}]},  # claims a branch it never made
    )
    assert outcome.status == "FAIL"
    assert "does not exist" in outcome.detail


def test_hidden_oracle_fixture_graded_with_hidden_tests() -> None:
    fixture = load_fixture(FIXTURES / "fixture-small-feature")
    slugify_impl = (
        "import re\n\n\n"
        "def slugify(text):\n"
        '    text = re.sub(r"[ _]+", "-", text.lower())\n'
        '    text = re.sub(r"[^a-z0-9-]", "", text)\n'
        '    text = re.sub(r"-+", "-", text)\n'
        '    return text.strip("-")\n'
    )
    fixture_src = (FIXTURES / "fixture-small-feature" / "string_utils.py").read_text()
    outcome = run_fixture(
        fixture,
        engine="fake",
        model=None,
        timeout_sec=120,
        engine_config={
            "script": [
                {
                    "write_file": {
                        "path": "string_utils.py",
                        "content": fixture_src + "\n\n" + slugify_impl,
                    }
                },
                {"commit": {"branch": "agentx/slugify", "message": "add slugify"}},
                {
                    "emit": {
                        "type": "done",
                        "result": {
                            "branch": "agentx/slugify",
                            "summary": "added slugify",
                            "test_evidence": "pytest",
                        },
                    }
                },
            ]
        },
    )
    assert outcome.status == "PASS", outcome.detail


def test_spec_fixture_yields_review_with_captured_spec() -> None:
    fixture = load_fixture(FIXTURES / "fixture-ambiguous-task")
    outcome = run_fixture(
        fixture,
        engine="fake",
        model=None,
        timeout_sec=120,
        engine_config={
            "script": [
                {"emit": {"type": "spec", "markdown": "## Plan\nAssumptions: ..."}},
                {"emit": DONE},
            ]
        },
    )
    assert outcome.status == "REVIEW"
    assert outcome.spec_markdown is not None and "Assumptions" in outcome.spec_markdown


def test_engine_failure_is_fail_with_reason() -> None:
    fixture = load_fixture(FIXTURES / "fixture-failing-test")
    outcome = run_fixture(
        fixture,
        engine="fake",
        model=None,
        timeout_sec=120,
        engine_config={"script": [{"crash": "engine exploded"}]},
    )
    assert outcome.status == "FAIL"
    assert "engine crashed" in outcome.detail
