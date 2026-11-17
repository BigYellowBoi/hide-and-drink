"""Build a city pack: every layer, clipped to the buffered play area, as one GeoJSON file."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path


from shapely.geometry import mapping
from shapely.prepared import prep

from pipeline import abs as abs_src
from pipeline import gtfs, osm
from pipeline.config import CACHE, City
from pipeline.fetch import download, post_json
from pipeline.geo import Projector, extent

PACK_SCHEMA = 1


def build(city: City, *, osm_source: str = "auto", offline: bool = False, log=print) -> dict:
    cfg = city.config
    cache = CACHE / city.id
    projector = Projector(cfg["projected_crs"])
    area = extent(city.play_areas, projector, cfg["buffer_m"])
    prepared = prep(area)
    simplify_m = cfg.get("simplify_m", 0)
    features: list[dict] = []
    sources: list[dict] = []

    # Transit
    gtfs_layers = city.layers_from("gtfs")
    if gtfs_layers:
        meta = download(cfg["gtfs"]["url"], cache / "gtfs.zip", offline=offline)
        sources.append({"name": cfg["gtfs"]["name"], "licence": cfg["gtfs"]["licence"], **meta})
        log("gtfs: reading stops and stop_times")
        stops, modes = gtfs.stop_modes(cache / "gtfs.zip")
        for layer in gtfs_layers:
            if layer["geometry"] == "line":
                log(f"gtfs: reading shapes for {layer['id']}")
                routes = gtfs.route_shapes(cache / "gtfs.zip", set(layer["modes"]))
                features += gtfs.build_line_layer(layer, routes, area, prepared, projector, simplify_m)
            else:
                features += gtfs.build_layer(layer, stops, modes, area, prepared, projector)

    # OSM venues and categories
    osm_layers = city.layers_from("osm")
    if osm_layers:
        elements, meta = _osm_elements(city, osm_layers, area, cache, osm_source, offline, log)
        sources.append({"name": cfg["osm"]["name"], "licence": cfg["osm"]["licence"], **meta})
        features += osm.build_layers(osm_layers, elements, area, prepared, projector, simplify_m,
                                     city.venue_edits)

    # ABS boundaries
    for layer in city.layers_from("abs"):
        dataset = cfg["abs"]["datasets"][layer["dataset"]]
        fc, meta = abs_src.fetch(dataset, area, cache / f"abs-{layer['dataset']}.geojson", offline=offline)
        sources.append({"name": dataset["name"], "licence": cfg["abs"]["licence"], **meta})
        features += abs_src.build_layer(layer, dataset, fc, area, prepared, projector, simplify_m)

    features.sort(key=lambda f: (f["layer"], f["id"]))
    keys = [(f["layer"], f["id"]) for f in features]
    if len(set(keys)) != len(keys):
        dupes = sorted({k for k in keys if keys.count(k) > 1})
        raise ValueError(f"duplicate feature ids: {dupes[:5]}")
    counts = {layer["id"]: 0 for layer in city.layers}
    for f in features:
        counts[f["layer"]] += 1
    empty = [k for k, n in counts.items() if n == 0]
    if empty:
        log(f"warning: empty layers: {', '.join(empty)}")

    return {
        "type": "FeatureCollection",
        "pack": {
            "schema_version": PACK_SCHEMA,
            "city": city.id,
            "label": cfg.get("label", city.id),
            "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "play_areas": cfg["play_areas"],
            "buffer_m": cfg["buffer_m"],
            "extent": mapping(area),
            "layers": [
                {"id": layer["id"], "label": layer["label"], "geometry": layer["geometry"],
                 "from": layer["from"], "count": counts[layer["id"]]}
                for layer in city.layers
            ],
            "sources": sources,
        },
        "features": [
            {
                "type": "Feature",
                "id": f["id"],
                "geometry": mapping(f["geometry"]),
                "properties": {"layer": f["layer"], "name": f["name"], **f["props"]},
            }
            for f in features
        ],
    }


def _osm_elements(city, layers, area, cache, source, offline, log):
    cfg = city.config["osm"]
    if source in ("auto", "overpass") and cfg.get("overpass_urls"):
        try:
            log("osm: querying Overpass")
            body, meta = post_json(cfg["overpass_urls"], {"data": osm.overpass_query(layers, area)},
                                   cache / "overpass.json", offline=offline)
            return osm.from_overpass(body), {**meta, "via": "overpass"}
        except (RuntimeError, FileNotFoundError) as e:
            if source == "overpass" or not cfg.get("pbf_url"):
                raise
            log(f"osm: Overpass unavailable, falling back to extract ({str(e).splitlines()[-1].strip()})")
    meta = download(cfg["pbf_url"], cache / "osm.pbf", offline=offline, max_age_h=24 * 7)
    log("osm: reading extract")
    return osm.from_pbf(cache / "osm.pbf", layers, area), {**meta, "via": "pbf"}



def write(pack: dict, path: Path) -> None:
    """One feature per line so diffs between pack builds stay readable."""
    path.parent.mkdir(parents=True, exist_ok=True)
    head = {k: v for k, v in pack.items() if k != "features"}
    lines = [json.dumps(f, ensure_ascii=False, separators=(",", ":")) for f in pack["features"]]
    body = json.dumps(head, ensure_ascii=False, indent=2)[:-2]
    path.write_text(body + ',\n  "features": [\n' + ",\n".join(lines) + "\n  ]\n}\n")


def summary(pack: dict) -> str:
    rows = [f"  {layer['id']:<26} {layer['count']:>5}" for layer in pack["pack"]["layers"]]
    return "\n".join(rows)


