from report import build_report


def test_report_shape():
    out = build_report([("emea", "widget", 2), ("emea", "gadget", 5)])
    assert "== emea ==" in out
    assert out.index("gadget: 5") < out.index("widget: 2")  # sorted by units desc
    assert "total: 7" in out


def test_empty_rows():
    assert build_report([]) == ""
