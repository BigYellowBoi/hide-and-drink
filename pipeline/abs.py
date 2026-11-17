"""ABS boundaries (suburbs/localities, LGAs) from the ABS ArcGIS REST services."""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

from shapely.geometry import shape

from pipeline.fetch import get_json
from pipeline.geo import Projector, clip, tidy

PAGE = 1000
# ABS disambiguates repeated names: "Paddington (Qld)", "Albion (Brisbane - Qld)". Players say "Albion".
_STATE_SUFFIX = re.compile(r"\s*\((?:[^()]* - )?(?:NSW|Vic\.|Qld|SA|WA|Tas\.|NT|ACT|OT)\)$")


def fetch(dataset: dict, area, cache: Path, *, offline: bool = False) -> tuple[dict, dict]:
    """All boundary polygons intersecting the area's bounding box, as GeoJSON (cached)."""
    meta_file = cache.with_name(cache.name + ".meta.json")
    if cache.exists() and (offline or meta_file.exists()):
        return json.loads(cache.read_text()), json.loads(meta_file.read_text())
    if offline:
        raise FileNotFoundError(f"{cache} not cached; run without --offline")
    minx, miny, maxx, maxy = area.bounds
    features, offset = [], 0
    while True:
        page = get_json(dataset["url"] + "/query", {
            "where": "1=1",
            "geometry": f"{minx},{miny},{maxx},{maxy}",
            "geometryType": "esriGeometryEnvelope",
            "inSR": 4326,
            "spatialRel": "esriSpatialRelIntersects",
            "outFields": f"{dataset['code_field']},{dataset['name_field']}",
            "outSR": 4326,
            "returnGeometry": "true",
            "resultOffset": offset,
            "resultRecordCount": PAGE,
            "f": "geojson",
        })
        if "error" in page:
            raise RuntimeError(f"ABS query failed: {page['error']}")
        batch = page.get("features", [])
        features.extend(batch)
        if len(batch) < PAGE and not page.get("exceededTransferLimit"):
            break
        offset += len(batch)
    fc = {"type": "FeatureCollection", "features": features}
    meta = {"url": dataset["url"], "retrieved_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(fc))
    meta_file.write_text(json.dumps(meta, indent=2))
    return fc, meta


def _prop(props: dict, field: str):
    # ArcGIS may change field-name case between editions.
    for k, v in props.items():
        if k.lower() == field.lower():
            return v
    return None


def build_layer(layer: dict, dataset: dict, fc: dict, area, prepared, projector: Projector, simplify_m: float):
    features = []
    for f in fc["features"]:
        if not f.get("geometry"):
            continue
        code = _prop(f["properties"], dataset["code_field"])
        name = _prop(f["properties"], dataset["name_field"])
        geom = clip(shape(f["geometry"]).buffer(0), area, prepared)
        if geom is None:
            continue
        geom = tidy(geom, projector, simplify_m)
        if geom is None:
            continue
        features.append({
            "id": f"{dataset['id_prefix']}:{code}",
            "layer": layer["id"],
            "name": _STATE_SUFFIX.sub("", str(name)),
            "geometry": geom,
            "props": {"code": str(code), "abs_name": str(name)},
        })
    return features
