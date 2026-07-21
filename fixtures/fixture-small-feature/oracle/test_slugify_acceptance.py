"""Hidden acceptance tests — never shown to the agent (see fixtures/README.md)."""

from string_utils import slugify


def test_basic():
    assert slugify("Hello World") == "hello-world"


def test_punctuation_dropped():
    assert slugify("Hello,  World_Again!") == "hello-world-again"


def test_underscores_and_spaces_become_single_hyphen():
    assert slugify("a _ b__c") == "a-b-c"


def test_leading_trailing_stripped():
    assert slugify("  --Already--Slugged--  ") == "already-slugged"


def test_numbers_kept():
    assert slugify("Release 2.0 (beta)") == "release-20-beta"


def test_empty_and_symbol_only():
    assert slugify("") == ""
    assert slugify("!!!") == ""
