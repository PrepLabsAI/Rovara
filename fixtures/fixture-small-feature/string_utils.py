"""Small string helpers used across the (imaginary) app."""


def truncate(text, max_len, suffix="..."):
    """Truncate text to max_len characters, appending suffix if truncated."""
    if max_len < 0:
        raise ValueError("max_len must be >= 0")
    if len(text) <= max_len:
        return text
    if max_len <= len(suffix):
        return text[:max_len]
    return text[: max_len - len(suffix)] + suffix
