"""Generates a plain-text sales report. Works, but nobody ever profiled it."""


def build_report(rows):
    """rows: list of (region, product, units) tuples."""
    report = ""
    for region in sorted({r[0] for r in rows}):
        report += f"== {region} ==\n"
        region_rows = [r for r in rows if r[0] == region]
        for _, product, units in sorted(region_rows, key=lambda r: (-r[2], r[1])):
            report += f"  {product}: {units}\n"
        report += f"  total: {sum(r[2] for r in region_rows)}\n\n"
    return report


def main():
    rows = [
        ("emea", "widget", 120),
        ("emea", "gadget", 340),
        ("apac", "widget", 95),
        ("amer", "gadget", 410),
        ("amer", "widget", 15),
    ]
    print(build_report(rows), end="")


if __name__ == "__main__":
    main()
