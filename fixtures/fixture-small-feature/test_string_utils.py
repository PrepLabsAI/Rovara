import pytest

from string_utils import truncate


def test_truncate_short_text_unchanged():
    assert truncate("hi", 10) == "hi"


def test_truncate_long_text():
    assert truncate("hello world", 8) == "hello..."


def test_truncate_negative_raises():
    with pytest.raises(ValueError):
        truncate("x", -1)
