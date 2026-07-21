import pytest

from calculator import add, average, clamp


def test_add():
    assert add(2, 3) == 5


def test_average():
    assert average([2, 4, 6]) == 4
    assert average([5]) == 5


def test_average_empty_raises():
    with pytest.raises(ValueError):
        average([])


def test_clamp():
    assert clamp(5, 0, 10) == 5
    assert clamp(-1, 0, 10) == 0
    assert clamp(11, 0, 10) == 10
