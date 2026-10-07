"""
Generate src/data/texasCounties.ts and src/data/texasCities.ts.

    python3 -I scripts/buildTexasPlaces.py

PROVENANCE, because a list of 254 names typed from memory is a list with
mistakes in it that nobody will find for a year.

  Counties  US Census Bureau county FIPS for state 48, as shipped in the
            `addfips` package (addfips/data/counties_2020.csv). 254 rows.
  Cities    City -> county from the `zipcodes` package, which derives from
            USPS/Census ZIP data. Reduced to distinct Texas city names and the
            counties their ZIPs fall in, so "Katy" gives Harris, Fort Bend and
            Waller -- which is the real answer and the reason this file exists.

Both are pinned downloads rather than live fetches; the container has no
general web egress, and a build that silently depends on the internet is a
build that breaks on a Tuesday. To regenerate:

    pip download addfips zipcodes -d /tmp/places --no-deps
    pip install --target /tmp/zips /tmp/places/zipcodes-*.whl
    python3 -I scripts/buildTexasPlaces.py

EVERY CITY'S COUNTY IS CHECKED AGAINST THE CENSUS LIST. The ZIP data spells
two of them wrong -- "De Witt" for DeWitt and "Mclennan" for McLennan -- which
is a tidy demonstration of why the vocabulary is worth having at all. The
Census spelling wins and anything else unrecognised is dropped loudly rather
than carried into the product.
"""
import csv, io, json, os, sys, zipfile

ZIPS_PATH = os.environ.get("ZIPCODES_PATH", "/tmp/zips")
ADDFIPS_WHL = os.environ.get("ADDFIPS_WHL", "/tmp/addfips-pkg/addfips-0.4.2-py3-none-any.whl")
sys.path.insert(0, ZIPS_PATH)
import zipcodes  # noqa: E402

TX_FIPS = "48"


def strip_suffix(name: str) -> str:
    """'Fort Bend County' -> 'Fort Bend', matching how this project writes them."""
    return name[: -len(" County")] if name.endswith(" County") else name


def census_counties() -> list[str]:
    with zipfile.ZipFile(ADDFIPS_WHL) as z:
        raw = z.read("addfips/data/counties_2020.csv").decode("utf-8")
    reader = csv.reader(io.StringIO(raw))
    next(reader)
    names = sorted({strip_suffix(r[2]) for r in reader if r[0] == TX_FIPS})
    if len(names) != 254:
        raise SystemExit(f"expected 254 Texas counties, got {len(names)}")
    return names


def city_counties(counties: list[str]) -> dict[str, list[str]]:
    canon = {c.lower().replace(" ", ""): c for c in counties}
    out: dict[str, set[str]] = {}
    unknown: set[str] = set()
    for rec in zipcodes.list_all():
        if rec.get("state") != "TX":
            continue
        city = (rec.get("city") or "").strip()
        county = strip_suffix((rec.get("county") or "").strip())
        if not city or not county:
            continue
        key = county.lower().replace(" ", "")
        if key not in canon:
            unknown.add(county)
            continue
        out.setdefault(city, set()).add(canon[key])
    if unknown:
        raise SystemExit(f"counties not in the Census list, unresolved: {sorted(unknown)}")
    return {c: sorted(v) for c, v in sorted(out.items())}


HEADER = """/**
 * {what}
 *
 * GENERATED. Do not edit by hand; run `python3 -I scripts/buildTexasPlaces.py`,
 * which documents where every name came from.
 *
 * REFERENCE DATA, NOT A CONSTRAINT. This platform runs any number of programs
 * and nothing in it is Texas-only: the counties field still accepts whatever a
 * program's vocabulary is, and a grant made in Louisiana has to work. These
 * names are offered as suggestions and used to widen a search, never to refuse
 * an entry.
 */

"""


def main() -> None:
    counties = census_counties()
    cities = city_counties(counties)

    counties_what = "\n".join([
        "Every Texas county, as the US Census Bureau spells it.",
        " *",
        " * Without the 'County' suffix, which is how this project has written them",
        " * since the Inspire Change form was seeded.",
    ])
    cities_what = "\n".join([
        "Every Texas city, and the counties it sits in.",
        " *",
        " * A city can span several: Katy is in Harris, Fort Bend AND Waller, which is",
        " * why a search for 'Katy' has to widen to all three rather than guess one.",
        " *",
        " * SERVER-SIDE ONLY. Far too much to ship to a browser, and nothing on a",
        " * screen needs it.",
    ])

    with open("src/data/texasCounties.ts", "w") as f:
        f.write(HEADER.format(what=counties_what))
        f.write("export const TEXAS_COUNTIES: readonly string[] = [\n")
        for c in counties:
            f.write(f"  {json.dumps(c)},\n")
        f.write("];\n")

    with open("src/data/texasCities.ts", "w") as f:
        f.write(HEADER.format(what=cities_what))
        f.write("export const TEXAS_CITY_COUNTIES: Readonly<Record<string, readonly string[]>> = {\n")
        for city, cs in cities.items():
            f.write(f"  {json.dumps(city)}: {json.dumps(cs)},\n")
        f.write("};\n")

    print(f"src/data/texasCounties.ts  {len(counties)} counties")
    print(f"src/data/texasCities.ts    {len(cities)} cities")


main()
