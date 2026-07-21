"""A tiny calculator module. One of these functions has a bug."""


def add(a, b):
    return a + b


def average(values):
    if not values:
        raise ValueError("average() of empty sequence")
    return sum(values)


def clamp(value, low, high):
    if low > high:
        raise ValueError("low must be <= high")
    return max(low, min(value, high))
