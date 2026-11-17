# Data pipeline

Builds a **city pack**: every map layer the game needs, clipped to the city's play areas plus a
buffer, as one GeoJSON file (`data/city-packs/<city>.geojson`), then a migration that loads it into
PostGIS (`public.city_packs`, `public.map_features`).

```bash
pip install -r pipeline/requirements.txt
python3 -m pipeline build brisbane     # download, clip, merge, tag; writes the pack
python3 -m pipeline sql brisbane       # writes supabase/migrations/<utc now>_city_pack_brisbane.sql
python3 -m pytest pipeline/tests       # unit tests (no network)
```

Downloads are cached in `pipeline/.cache/` (git-ignored, refreshed after 24 h; the OSM extract after
7 days). `--offline` rebuilds from the cache only. `--osm overpass|pbf` forces an OSM source; the
default tries Overpass and falls back to the city's `.osm.pbf` extract.

## What goes in

Everything is data; the code only knows the source types.

| File | What it controls |
| --- | --- |
| `data/cities/<city>.json` | Play areas to cover, buffer, CRS, simplification, source URLs and licences |
| `data/map-layers.json` | Layers: OSM tag rules, GTFS modes, ABS datasets. A layer id equals the `source` string used by question options in `data/questions.json` |
| `data/venues/<city>.json` | Hand edits on top of OSM: licensed restaurants to `add`, feature ids to `exclude` |
| `data/play-areas/*.geojson` | Play areas; the pack covers their union grown by `buffer_m` |

Sources for Brisbane:

- **Transit**: TransLink SEQ GTFS. Platforms are grouped into their parent station; a station's
  modes come from the routes that actually call there. Same-name stations within 300 m merge
  (Roma Street rail + busway). Plain bus stops are not stations. `gtfs:ferry stops` keeps ferry
  terminals unmerged for matching/tentacles.
- **Venues**: OSM, anywhere serving alcohol: bars, pubs, beer gardens, nightclubs, casinos,
  strip clubs, breweries/wineries/distilleries, plus restaurants, cafes, clubs and hotels tagged
  with `bar=yes`, `alcohol=*` or `drink:*`. Shops are excluded. Each venue carries `kind` and
  address tags. Hosts curate per game in the lobby.
- **Categories**: OSM layers for matching and tentacles (parks, museums, cinemas, ...), as points;
  named streets as lines merged by name.
- **Boundaries**: ABS suburbs and localities (ASGS 2021) and LGAs (ASGS 2025), from the ABS
  ArcGIS services. Names drop ABS disambiguation (`Albion (Brisbane - Qld)` becomes `Albion`).

Overpass endpoints may refuse cloud IPs; the BBBike Brisbane extract is the fallback.

## Pack format

A GeoJSON FeatureCollection, one feature per line. Top-level `pack` holds the city, build time,
extent, per-layer counts and source provenance (URL, retrieval time, ETag, SHA-256, licence).
Each feature has a stable `id` (`osm:node/123`, `gtfs:place_censta`, `abs:sal:30329`,
`manual:...`) and `properties.layer`, `properties.name` plus layer-specific fields.

## Updating a pack

Rebuild, review the diff of `data/city-packs/<city>.geojson`, then write a **new** migration with
`python3 -m pipeline sql <city>` (never edit an applied one). `_load_city_pack` replaces the city's
features in one transaction. Clients read it with `rpc('get_city_pack', { p_city, p_layers })`.

Licences: OSM data is ODbL (attribute "© OpenStreetMap contributors" on the map); TransLink GTFS and
ABS boundaries are CC BY 4.0.
