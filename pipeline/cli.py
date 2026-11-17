"""Command line: build a city pack and/or write its loading migration.

    python3 -m pipeline build brisbane            # data/city-packs/brisbane.geojson
    python3 -m pipeline build brisbane --offline  # rebuild from pipeline/.cache only
    python3 -m pipeline sql brisbane              # supabase/migrations/<now>_city_pack_brisbane.sql
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone

from pipeline import pack as pack_mod
from pipeline import to_sql
from pipeline.config import DATA, ROOT, load_city


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python3 -m pipeline", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="download sources and write data/city-packs/<city>.geojson")
    b.add_argument("city")
    b.add_argument("--osm", choices=["auto", "overpass", "pbf"], default="auto",
                   help="OSM source: Overpass, the city's .osm.pbf extract, or Overpass then extract")
    b.add_argument("--offline", action="store_true", help="use cached downloads only")
    s = sub.add_parser("sql", help="write a migration that loads the pack into Supabase")
    s.add_argument("city")
    s.add_argument("--out", help="migration path (default: supabase/migrations/<utc now>_city_pack_<city>.sql)")
    args = ap.parse_args(argv)

    pack_path = DATA / "city-packs" / f"{args.city}.geojson"
    if args.cmd == "build":
        city = load_city(args.city)
        pack = pack_mod.build(city, osm_source=args.osm, offline=args.offline)
        pack_mod.write(pack, pack_path)
        print(f"wrote {pack_path.relative_to(ROOT)} ({pack_path.stat().st_size / 1e6:.1f} MB)")
        print(pack_mod.summary(pack))
    else:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
        out = ROOT / (args.out or f"supabase/migrations/{stamp}_city_pack_{args.city}.sql")
        to_sql.write(pack_path, out, ROOT)
        layers = json.loads(pack_path.read_text())["pack"]["layers"]
        print(f"wrote {out.relative_to(ROOT)} ({sum(x['count'] for x in layers)} features)")
    return 0
