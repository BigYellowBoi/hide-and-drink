"""OSM layers (venues, POI categories, named streets) from Overpass or a local .osm.pbf extract.

Both sources are normalised to elements: {"id": "node/1", "tags": {...}, "geom": shapely geometry,
"kind": "node" | "way" | "area"}. Layer rules come from data/map-layers.json.
"""

from __future__ import annotations

import re
from collections import defaultdict
from pathlib import Path

import shapely
from shapely.geometry import LineString, MultiPolygon, Point, Polygon
from shapely.ops import polygonize, unary_union

from pipeline.geo import Projector, clip, tidy

KEEP_TAGS = ("addr:housenumber", "addr:street", "addr:suburb", "opening_hours", "website", "cuisine")


# ---------------------------------------------------------------------------
# Tag rules
# ---------------------------------------------------------------------------

def _value_matches(value: str | None, allowed) -> bool:
    if value is None:
        return False
    if allowed == "*":
        return True
    items = {v.strip() for v in value.split(";")}
    return any(a in items for a in allowed)


def rule_matches(tags: dict, rule: dict) -> bool:
    if not all(_value_matches(tags.get(k), v) for k, v in rule.get("all", {}).items()):
        return False
    anyof = rule.get("any")
    return not anyof or any(_value_matches(tags.get(k), v) for k, v in anyof.items())


def layer_matches(tags: dict, layer: dict) -> bool:
    if layer.get("require_name") and not tags.get("name"):
        return False
    if any(rule_matches(tags, r) for r in layer.get("none", [])):
        return False
    return any(rule_matches(tags, r) for r in layer["rules"])


def rule_keys(layers: list[dict]) -> set[str]:
    """First key of each rule's `all`: enough to pre-filter elements cheaply."""
    keys = set()
    for layer in layers:
        for r in layer["rules"]:
            keys.update(r.get("all", {}).keys())
    return keys


def overpass_query(layers: list[dict], area) -> str:
    """One Overpass query fetching every element any layer could match inside the area."""
    minx, miny, maxx, maxy = area.bounds
    bbox = f"{miny:.6f},{minx:.6f},{maxy:.6f},{maxx:.6f}"
    parts = []
    for layer in layers:
        for r in layer["rules"]:
            sel = ""
            for k, v in r.get("all", {}).items():
                if v == "*":
                    sel += f'["{k}"]'
                else:
                    vals = "|".join(re.escape(x) for x in v)
                    sel += f'["{k}"~"(^|;)({vals})(;|$)"]'
            parts.append(f"  nwr{sel}({bbox});")
    body = "\n".join(sorted(set(parts)))
    return f"[out:json][timeout:240];\n(\n{body}\n);\nout geom qt;"


# ---------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------

AREA_HINTS = {"building", "leisure", "amenity", "tourism", "landuse", "shop", "craft", "area"}


def _way_is_area(tags: dict, coords) -> bool:
    if len(coords) < 4 or coords[0] != coords[-1]:
        return False
    if tags.get("area") == "no":
        return False
    if "highway" in tags and tags.get("area") != "yes":
        return False
    return any(k in tags for k in AREA_HINTS)


def from_overpass(body: dict) -> list[dict]:
    out = []
    for el in body.get("elements", []):
        tags = el.get("tags") or {}
        if not tags:
            continue
        oid = f"{el['type']}/{el['id']}"
        if el["type"] == "node":
            out.append({"id": oid, "tags": tags, "geom": Point(el["lon"], el["lat"]), "kind": "node"})
        elif el["type"] == "way" and el.get("geometry"):
            coords = [(p["lon"], p["lat"]) for p in el["geometry"]]
            if len(coords) < 2:
                continue
            if _way_is_area(tags, coords):
                out.append({"id": oid, "tags": tags, "geom": Polygon(coords), "kind": "area"})
            else:
                out.append({"id": oid, "tags": tags, "geom": LineString(coords), "kind": "way"})
        elif el["type"] == "relation" and tags.get("type") in ("multipolygon", "boundary"):
            lines = [
                LineString([(p["lon"], p["lat"]) for p in m["geometry"]])
                for m in el.get("members", [])
                if m.get("type") == "way" and len(m.get("geometry") or []) >= 2
            ]
            polys = list(polygonize(unary_union(lines))) if lines else []
            if polys:
                geom = unary_union(polys)
                out.append({"id": oid, "tags": tags, "geom": geom, "kind": "area"})
    return out


def from_pbf(path: Path, layers: list[dict], area) -> list[dict]:
    """Read a .osm.pbf extract with pyosmium, keeping only elements a layer could match."""
    import osmium
    from shapely import wkb

    keys = rule_keys(layers)
    minx, miny, maxx, maxy = area.bounds
    bbox = shapely.box(minx, miny, maxx, maxy)
    factory = osmium.geom.WKBFactory()
    out = []

    def wanted(tags) -> bool:
        return any(k in tags for k in keys)

    fp = (
        osmium.FileProcessor(str(path))
        .with_locations()
        .with_areas()
        .with_filter(osmium.filter.KeyFilter(*sorted(keys)))
    )
    for obj in fp:
        tags = dict(obj.tags)
        if not wanted(tags):
            continue
        try:
            if obj.is_node():
                if not (minx <= obj.location.lon <= maxx and miny <= obj.location.lat <= maxy):
                    continue
                out.append({"id": f"node/{obj.id}", "tags": tags,
                            "geom": Point(obj.location.lon, obj.location.lat), "kind": "node"})
            elif obj.is_way():
                geom = wkb.loads(factory.create_linestring(obj), hex=True)
                if not geom.intersects(bbox):
                    continue
                coords = list(geom.coords)
                if _way_is_area(tags, coords):
                    continue  # emitted as an area below
                out.append({"id": f"way/{obj.id}", "tags": tags, "geom": geom, "kind": "way"})
            elif obj.is_area():
                geom = wkb.loads(factory.create_multipolygon(obj), hex=True)
                if not geom.intersects(bbox):
                    continue
                oid = f"way/{obj.orig_id()}" if obj.from_way() else f"relation/{obj.orig_id()}"
                if isinstance(geom, MultiPolygon) and len(geom.geoms) == 1:
                    geom = geom.geoms[0]
                out.append({"id": oid, "tags": tags, "geom": geom, "kind": "area"})
        except (RuntimeError, osmium.InvalidLocationError, ValueError):
            continue  # broken geometry at the extract's edge
    return out


# ---------------------------------------------------------------------------
# Layers
# ---------------------------------------------------------------------------

def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def _kind(tags: dict, layer: dict) -> str | None:
    for k in layer.get("kind_keys", []):
        if tags.get(k):
            return tags[k].split(";")[0]
    return None


def build_point_layer(layer: dict, elements: list[dict], area, prepared, projector: Projector) -> list[dict]:
    features = {}
    for el in elements:
        if el["kind"] == "way" or not layer_matches(el["tags"], layer):
            continue
        g = el["geom"]
        point = g if g.geom_type == "Point" else g.point_on_surface()
        point = clip(point, area, prepared)
        if point is None:
            continue
        props = {k: el["tags"][k] for k in KEEP_TAGS if k in el["tags"]}
        kind = _kind(el["tags"], layer)
        if kind:
            props["kind"] = kind
        fid = f"osm:{el['id']}"
        features[fid] = {
            "id": fid,
            "layer": layer["id"],
            "name": el["tags"]["name"],
            "geometry": tidy(point, projector, 0),
            "props": props,
        }
    return list(features.values())


def build_line_layer(layer: dict, elements: list[dict], area, prepared, projector: Projector, simplify_m: float):
    by_name = defaultdict(list)
    for el in elements:
        if el["kind"] != "way" or not layer_matches(el["tags"], layer):
            continue
        by_name[el["tags"]["name"]].append(el)
    features = []
    used: set[str] = set()
    for name, els in sorted(by_name.items()):
        merged = clip(shapely.line_merge(unary_union([e["geom"] for e in els])), area, prepared)
        if merged is None:
            continue
        geom = tidy(merged, projector, simplify_m)
        if geom is None:
            continue
        slug, n = _slug(name) or "unnamed", 1
        while (fid := f"osm:street/{slug}" + (f"-{n}" if n > 1 else "")) in used:
            n += 1
        used.add(fid)
        features.append({
            "id": fid,
            "layer": layer["id"],
            "name": name,
            "geometry": geom,
            "props": {"ways": len(els)},
        })
    return features


def apply_venue_edits(features: list[dict], edits: dict, area, prepared) -> list[dict]:
    excluded = set(edits.get("exclude", []))
    out = [f for f in features if f["id"] not in excluded]
    for add in edits.get("add", []):
        if not str(add["id"]).startswith("manual:"):
            raise ValueError(f"manual venue ids must start with 'manual:': {add['id']}")
        point = clip(Point(add["lon"], add["lat"]), area, prepared)
        if point is None:
            continue
        out.append({
            "id": add["id"],
            "layer": "venues",
            "name": add["name"],
            "geometry": shapely.set_precision(point, 1e-6),
            "props": {"kind": add.get("kind", "restaurant"), "manual": True},
        })
    return out


def build_layers(layers: list[dict], elements: list[dict], area, prepared, projector, simplify_m, venue_edits):
    out = []
    for layer in layers:
        if layer["geometry"] == "line":
            feats = build_line_layer(layer, elements, area, prepared, projector, simplify_m)
        else:
            feats = build_point_layer(layer, elements, area, prepared, projector)
        if layer["id"] == "venues":
            feats = apply_venue_edits(feats, venue_edits, area, prepared)
        out.extend(feats)
    return out
