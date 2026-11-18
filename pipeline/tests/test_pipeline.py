"""Unit tests for the pipeline's pure logic (no network). Run: python3 -m pytest pipeline/tests"""

from __future__ import annotations

import json

import pandas as pd
import pytest
from shapely.geometry import LineString, Point, Polygon, shape
from shapely.prepared import prep

from pipeline import abs as abs_src
from pipeline import fetch, gtfs, osm, to_sql
from pipeline.config import DATA, load_city
from pipeline.geo import Projector, clip, extent

PROJ = Projector("EPSG:7856")
LAYERS = {layer["id"]: layer for layer in json.loads((DATA / "map-layers.json").read_text())["layers"]}
VENUES = LAYERS["venues"]
SQUARE = Polygon([(153.0, -27.5), (153.05, -27.5), (153.05, -27.45), (153.0, -27.45)])


# --- venue rules ---------------------------------------------------------------

@pytest.mark.parametrize("tags", [
    {"amenity": "pub", "name": "The Pub"},
    {"amenity": "bar", "name": "Bar"},
    {"craft": "brewery", "name": "Brew Co"},
    {"amenity": "restaurant", "name": "Licensed", "drink:wine": "served"},
    {"amenity": "restaurant", "name": "Has Bar", "bar": "yes"},
    {"tourism": "hotel", "name": "Hotel Bar", "bar": "yes"},
])
def test_venue_rules_accept_places_serving_alcohol(tags):
    assert osm.layer_matches(tags, VENUES)


@pytest.mark.parametrize("tags", [
    {"amenity": "restaurant", "name": "Dry"},
    {"amenity": "pub"},  # unnamed
    {"shop": "alcohol", "name": "Bottle-O", "drink:beer": "yes", "amenity": "bar"},  # shops excluded
    {"amenity": "bar", "name": "Members", "access": "private"},
    {"tourism": "hotel", "name": "Hotel"},
])
def test_venue_rules_reject_others(tags):
    assert not osm.layer_matches(tags, VENUES)


def test_semicolon_values_match_per_item():
    assert osm.layer_matches({"amenity": "fast_food", "cuisine": "burger;kebab", "name": "K"},
                             LAYERS["osm:cuisine=kebab"])
    assert not osm.layer_matches({"cuisine": "kebabish", "name": "K"}, LAYERS["osm:cuisine=kebab"])


def test_overpass_query_covers_every_rule():
    q = osm.overpass_query([VENUES], SQUARE)
    assert '["amenity"~"(^|;)(bar|pub|biergarten|nightclub|casino|stripclub)(;|$)"]' in q
    assert q.startswith("[out:json]") and q.rstrip().endswith("out geom qt;")


def test_from_overpass_normalises_nodes_ways_and_areas():
    body = {"elements": [
        {"type": "node", "id": 1, "lat": -27.47, "lon": 153.02, "tags": {"amenity": "pub", "name": "P"}},
        {"type": "way", "id": 2, "tags": {"highway": "residential", "name": "A St"},
         "geometry": [{"lat": -27.47, "lon": 153.01}, {"lat": -27.46, "lon": 153.01}]},
        {"type": "way", "id": 3, "tags": {"leisure": "park", "name": "Park"},
         "geometry": [{"lat": -27.47, "lon": 153.0}, {"lat": -27.47, "lon": 153.01},
                      {"lat": -27.46, "lon": 153.01}, {"lat": -27.47, "lon": 153.0}]},
    ]}
    els = {e["id"]: e for e in osm.from_overpass(body)}
    assert els["node/1"]["kind"] == "node"
    assert els["way/2"]["kind"] == "way"
    assert els["way/3"]["kind"] == "area"


def test_point_layer_uses_area_point_and_clips():
    elements = [
        {"id": "way/9", "kind": "area", "tags": {"leisure": "park", "name": "Inside"},
         "geom": Polygon([(153.01, -27.48), (153.02, -27.48), (153.02, -27.47), (153.01, -27.48)])},
        {"id": "node/8", "kind": "node", "tags": {"leisure": "park", "name": "Outside"}, "geom": Point(152.0, -27.0)},
    ]
    feats = osm.build_point_layer(LAYERS["osm:leisure=park"], elements, SQUARE, prep(SQUARE), PROJ)
    assert [f["id"] for f in feats] == ["osm:way/9"]
    assert feats[0]["geometry"].geom_type == "Point"


def test_streets_merge_by_name_with_unique_ids():
    mk = lambda i, name, x: {"id": f"way/{i}", "kind": "way", "tags": {"highway": "residential", "name": name},
                             "geom": LineString([(x, -27.48), (x, -27.47)])}
    elements = [mk(1, "MacDonald Street", 153.01), mk(2, "Macdonald Street", 153.02), mk(3, "A St", 153.03),
                mk(4, "A St", 153.03)]
    feats = osm.build_line_layer(LAYERS["osm:highway (named)"], elements, SQUARE, prep(SQUARE), PROJ, 0)
    ids = sorted(f["id"] for f in feats)
    assert ids == ["osm:street/a-st", "osm:street/macdonald-street", "osm:street/macdonald-street-2"]


def test_manual_venues_and_excludes():
    feats = [{"id": "osm:node/1", "layer": "venues", "name": "Gone", "geometry": Point(153.02, -27.47), "props": {}}]
    edits = {"exclude": ["osm:node/1"],
             "add": [{"id": "manual:sushi", "name": "Sushi Bar", "lon": 153.02, "lat": -27.47}]}
    out = osm.apply_venue_edits(feats, edits, SQUARE, prep(SQUARE))
    assert [f["id"] for f in out] == ["manual:sushi"]
    with pytest.raises(ValueError):
        osm.apply_venue_edits([], {"add": [{"id": "bad", "name": "x", "lon": 0, "lat": 0}]}, SQUARE, None)


def test_include_keeps_untagged_venues_and_clashes_fail():
    els = [{"id": "node/7", "kind": "node", "tags": {"amenity": "restaurant", "name": "Dry but licensed"},
            "geom": Point(153.02, -27.47)},
           {"id": "node/8", "kind": "node", "tags": {"amenity": "restaurant", "name": "Dry"},
            "geom": Point(153.03, -27.47)}]
    feats = osm.build_point_layer(VENUES, els, SQUARE, prep(SQUARE), PROJ, frozenset({"osm:node/7"}))
    assert [f["id"] for f in feats] == ["osm:node/7"]
    with pytest.raises(ValueError):
        osm.apply_venue_edits([], {"include": ["osm:node/7"], "exclude": [{"id": "osm:node/7"}]}, SQUARE, None)


def test_unmatched_edits_are_reported():
    feats = [{"id": "osm:node/1"}]
    edits = {"include": ["osm:node/1", {"id": "osm:node/2", "note": "x"}], "exclude": ["osm:node/3"]}
    assert osm.unmatched_edits(feats, edits) == {"include": ["osm:node/2"], "exclude": ["osm:node/3"]}


def test_overpass_query_fetches_included_ids():
    q = osm.overpass_query([VENUES], SQUARE, frozenset({"osm:node/5", "osm:node/12", "osm:way/9"}))
    assert "node(id:5,12);" in q and "way(id:9);" in q


def test_brisbane_venue_edits_drop_old_blind_tiger():
    edits = load_city("brisbane").venue_edits
    assert "osm:node/4821933306" in osm.edit_ids(edits["exclude"])


# --- GTFS -------------------------------------------------------------------------

def test_base_name_strips_mode_suffixes():
    assert gtfs.base_name("Roma Street busway station") == "roma street"
    assert gtfs.base_name("South Bank ferry terminal") == "south bank"
    assert gtfs.base_name("Central station") == "central"


def _stops(rows):
    cols = ["stop_id", "stop_name", "stop_lat", "stop_lon", "location_type", "parent_station"]
    return pd.DataFrame(rows, columns=cols).astype(str).replace("None", "")


def test_stations_from_parents_and_merge_across_modes():
    stops = _stops([
        ("place_rom", "Roma Street station", -27.4650, 153.0190, "1", ""),
        ("1", "Roma Street platform 1", -27.4650, 153.0190, "0", "place_rom"),
        ("place_rombs", "Roma Street busway station", -27.4660, 153.0200, "1", ""),
        ("2", "Roma Street busway stop A", -27.4660, 153.0200, "0", "place_rombs"),
        ("3", "George St stop 5", -27.47, 153.02, "0", ""),  # plain bus stop: not a station
        ("4", "Loose Ferry", -27.48, 153.03, "0", ""),  # ferry stop without a parent
    ])
    modes = {"1": {"rail"}, "2": {"bus"}, "3": {"bus"}, "4": {"ferry"}}
    cands = gtfs.candidate_stations(stops, modes, LAYERS["stations"])
    assert sorted(c["name"] for c in cands) == ["Loose Ferry", "Roma Street busway station", "Roma Street station"]
    merged = gtfs.merge_stations(cands, 300, PROJ)
    roma = next(m for m in merged if m["name"] == "Roma Street station")
    assert roma["modes"] == {"rail", "bus"} and roma["members"] == ["place_rom", "place_rombs"]
    assert gtfs.merge_stations(cands, 0, PROJ).__len__() == 3


def test_route_lines_group_by_short_name_and_clip():
    a = LineString([(152.99, -27.47), (153.02, -27.47)])
    b = LineString([(153.02, -27.47), (153.04, -27.47)])
    routes = [
        {"route_id": "R1", "short": "BRIP", "long": "Brisbane City - Ipswich", "mode": "rail", "color": "27855a",
         "lines": [a]},
        {"route_id": "R2", "short": "BRIP", "long": "Brisbane City - Ipswich", "mode": "rail", "color": "",
         "lines": [b]},
        {"route_id": "F1", "short": "F1", "long": "", "mode": "ferry", "color": "zz", "lines": [b]},
    ]
    feats = gtfs.build_line_layer(LAYERS["gtfs:lines"], routes, SQUARE, prep(SQUARE), PROJ, 0)
    by_id = {f["id"]: f for f in feats}
    assert sorted(by_id) == ["gtfs:line/ferry/f1", "gtfs:line/rail/brip"]
    rail = by_id["gtfs:line/rail/brip"]
    assert rail["props"]["color"] == "#27855A" and rail["props"]["route_ids"] == ["R1", "R2"]
    assert rail["geometry"].bounds[0] >= 153.0  # clipped to the square
    assert "color" not in by_id["gtfs:line/ferry/f1"]["props"]


def test_water_polygons_from_areas_only():
    river = Polygon([(152.99, -27.48), (153.06, -27.48), (153.06, -27.47), (152.99, -27.47)])
    elements = [
        {"id": "relation/1", "kind": "area", "tags": {"natural": "water", "water": "river", "name": "River"},
         "geom": river},
        {"id": "way/2", "kind": "way", "tags": {"natural": "water"}, "geom": LineString([(153.0, -27.46), (153.01, -27.46)])},
        {"id": "way/3", "kind": "area", "tags": {"leisure": "park"}, "geom": river},
    ]
    feats = osm.build_polygon_layer(LAYERS["osm:water"], elements, SQUARE, prep(SQUARE), PROJ, 0)
    assert [f["id"] for f in feats] == ["osm:relation/1"]
    assert feats[0]["geometry"].bounds[0] >= 153.0 and feats[0]["props"] == {"natural": "water", "water": "river"}


# --- ABS --------------------------------------------------------------------------

def test_abs_names_drop_state_disambiguation():
    ds = {"code_field": "sal_code_2021", "name_field": "sal_name_2021", "id_prefix": "abs:sal"}
    fc = {"features": [
        {"properties": {"SAL_CODE_2021": "1", "sal_name_2021": "Albion (Brisbane - Qld)"},
         "geometry": {"type": "Polygon", "coordinates": [[[153.0, -27.5], [153.01, -27.5], [153.01, -27.49], [153.0, -27.5]]]}},
        {"properties": {"sal_code_2021": "2", "sal_name_2021": "Paddington (Qld)"},
         "geometry": {"type": "Polygon", "coordinates": [[[153.0, -27.5], [153.01, -27.5], [153.01, -27.49], [153.0, -27.5]]]}},
    ]}
    feats = abs_src.build_layer({"id": "abs:suburbs_localities"}, ds, fc, SQUARE, prep(SQUARE), PROJ, 0)
    assert [f["name"] for f in feats] == ["Albion", "Paddington"]
    assert feats[0]["id"] == "abs:sal:1"


# --- geometry, config, SQL -------------------------------------------------------------

def test_extent_is_buffered_play_area():
    city = load_city("brisbane")
    area = extent(city.play_areas, PROJ, 2000)
    inner = shape(city.play_areas["brisbane-inner"]["features"][0]["geometry"])
    assert area.contains(inner)
    assert 1900 < PROJ.distance_m(inner.exterior, Point(area.exterior.coords[0])) < 2100


def test_extent_includes_coverage_circles():
    city = load_city("brisbane")
    area = extent(city.play_areas, PROJ, 2000, city.config["coverage"])
    assert area.contains(Point(152.9526, -27.4452))  # Blind Tiger, The Gap
    assert not extent(city.play_areas, PROJ, 2000).contains(Point(152.9526, -27.4452))


def test_cache_is_not_reused_for_another_request(tmp_path):
    path = tmp_path / "reply.json"
    fetch.store_reply(path, fetch.request_key({"bbox": [1, 2, 3, 4]}), {"ok": 1}, {"url": "u"})
    body, meta = fetch.cached_reply(path, fetch.request_key({"bbox": [1, 2, 3, 4]}), offline=False, max_age_h=24)
    assert body == {"ok": 1} and meta == {"url": "u"}
    assert fetch.cached_reply(path, fetch.request_key({"bbox": [0, 2, 3, 4]}), offline=False, max_age_h=24) is None
    with pytest.raises(FileNotFoundError):
        fetch.cached_reply(path, fetch.request_key({"bbox": [0, 2, 3, 4]}), offline=True, max_age_h=24)


def test_clip_cuts_lines_and_drops_points_outside():
    line = LineString([(152.9, -27.47), (153.02, -27.47)])
    assert clip(line, SQUARE).bounds[0] == pytest.approx(153.0)
    assert clip(Point(152.0, -27.0), SQUARE) is None


def test_question_sources_have_layers():
    questions = json.loads((DATA / "questions.json").read_text())
    sources = {o["source"] for q in questions["types"] for o in q["options"] if "source" in o}
    assert sources <= set(LAYERS), sources - set(LAYERS)


def test_migration_sql_uses_safe_dollar_quote():
    pack = {"type": "FeatureCollection", "features": [{"name": "$pack$ bar"}],
            "pack": {"city": "x", "built_at": "now", "layers": [{"id": "venues", "count": 1}]}}
    sql = to_sql.migration_sql(pack, "data/city-packs/x.geojson")
    assert "$pack_$" in sql and sql.count("$pack_$") == 2
