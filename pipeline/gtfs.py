"""Stations from a GTFS feed: platforms grouped into stations, modes from the routes that stop there."""

from __future__ import annotations

import re
import zipfile
from pathlib import Path

import pandas as pd
import shapely
from shapely.geometry import LineString, Point
from shapely.ops import unary_union

from pipeline.geo import Projector, clip, tidy

# GTFS route_type -> mode (basic and extended types)
ROUTE_MODES = {0: "tram", 1: "metro", 2: "rail", 3: "bus", 4: "ferry", 5: "tram", 11: "bus", 12: "rail"}
MODE_PRIORITY = ["rail", "metro", "tram", "ferry", "bus"]

_SUFFIX = re.compile(
    r"\s+(busway station|bus station|railway station|train station|station|ferry terminal|terminal|"
    r"interchange|light rail)$",
    re.I,
)


def base_name(name: str) -> str:
    """'Roma Street busway station' -> 'roma street'; used to merge stations across modes."""
    n = name.strip()
    while True:
        m = _SUFFIX.search(n)
        if not m:
            return n.lower()
        n = n[: m.start()]


def _extended(rt: int) -> str | None:
    # Extended route types: 100-199 rail, 400-499 metro, 700-799 bus, 900-999 tram, 1000/1200 ferry
    for lo, hi, mode in ((100, 199, "rail"), (400, 499, "metro"), (700, 799, "bus"), (200, 299, "bus"),
                         (900, 999, "tram"), (1000, 1099, "ferry"), (1200, 1299, "ferry")):
        if lo <= rt <= hi:
            return mode
    return ROUTE_MODES.get(rt)


def stop_modes(zip_path: Path) -> tuple[pd.DataFrame, dict[str, set[str]]]:
    """stops.txt plus, per stop_id, the set of modes of routes that actually call there."""
    with zipfile.ZipFile(zip_path) as z:
        stops = pd.read_csv(z.open("stops.txt"), dtype=str, keep_default_na=False)
        routes = pd.read_csv(z.open("routes.txt"), dtype=str, usecols=["route_id", "route_type"])
        trips = pd.read_csv(z.open("trips.txt"), dtype=str, usecols=["trip_id", "route_id"])
        route_mode = {r: _extended(int(t)) for r, t in zip(routes.route_id, routes.route_type)}
        trip_mode = {t: route_mode.get(r) for t, r in zip(trips.trip_id, trips.route_id)}
        modes: dict[str, set[str]] = {}
        seen: set[tuple[str, str]] = set()
        for chunk in pd.read_csv(z.open("stop_times.txt"), dtype=str, usecols=["trip_id", "stop_id"],
                                 chunksize=1_000_000):
            for trip, stop in zip(chunk.trip_id, chunk.stop_id):
                mode = trip_mode.get(trip)
                if mode and (stop, mode) not in seen:
                    seen.add((stop, mode))
                    modes.setdefault(stop, set()).add(mode)
    return stops, modes


def candidate_stations(stops: pd.DataFrame, modes: dict[str, set[str]], layer: dict) -> list[dict]:
    """Parent stations, plus unparented stops of non-bus modes (grouped by name), with their modes."""
    wanted = set(layer["modes"])
    parent_only = set(layer.get("parent_stations_only_for", []))
    loc = stops.get("location_type", pd.Series([""] * len(stops)))
    parent_col = stops.get("parent_station", pd.Series([""] * len(stops)))

    parents = stops[loc == "1"]
    child_modes: dict[str, set[str]] = {}
    for stop_id, parent in zip(stops.stop_id, parent_col):
        if parent:
            child_modes.setdefault(parent, set()).update(modes.get(stop_id, set()))

    out = []
    for _, p in parents.iterrows():
        m = (child_modes.get(p.stop_id, set()) | modes.get(p.stop_id, set())) & wanted
        if m:
            out.append({"id": p.stop_id, "name": p.stop_name, "lon": float(p.stop_lon),
                        "lat": float(p.stop_lat), "modes": m})

    # Unparented platforms (some feeds have no parent stations), for modes that don't require one.
    loose: dict[str, list] = {}
    for _, s in stops[(loc != "1") & (parent_col == "")].iterrows():
        m = modes.get(s.stop_id, set()) & (wanted - parent_only)
        if m:
            loose.setdefault(s.stop_name, []).append((s, m))
    for name, group in loose.items():
        lon = sum(float(s.stop_lon) for s, _ in group) / len(group)
        lat = sum(float(s.stop_lat) for s, _ in group) / len(group)
        ms = set().union(*(m for _, m in group))
        out.append({"id": group[0][0].stop_id, "name": name, "lon": lon, "lat": lat, "modes": ms})
    return out


def merge_stations(cands: list[dict], merge_m: float, projector: Projector) -> list[dict]:
    """Merge stations with the same base name within merge_m (e.g. Roma Street rail + busway)."""
    def rank(c):
        return min(MODE_PRIORITY.index(m) for m in c["modes"])

    cands = sorted(cands, key=lambda c: (rank(c), c["id"]))
    merged: list[dict] = []
    for c in cands:
        target = None
        if merge_m > 0:
            for m in merged:
                if base_name(m["name"]) == base_name(c["name"]) and projector.distance_m(
                    Point(m["lon"], m["lat"]), Point(c["lon"], c["lat"])
                ) <= merge_m:
                    target = m
                    break
        if target:
            target["modes"] |= c["modes"]
            target["members"].append(c["id"])
        else:
            merged.append({**c, "modes": set(c["modes"]), "members": [c["id"]]})
    return merged


def build_layer(layer: dict, stops, modes, area, prepared, projector: Projector) -> list[dict]:
    stations = merge_stations(candidate_stations(stops, modes, layer),
                              layer.get("merge_same_name_within_m", 0), projector)
    features = []
    for s in stations:
        point = clip(Point(s["lon"], s["lat"]), area, prepared)
        if point is None:
            continue
        props = {"modes": sorted(s["modes"], key=MODE_PRIORITY.index), "gtfs_stop_ids": sorted(s["members"])}
        features.append({
            "id": f"gtfs:{s['id']}",
            "layer": layer["id"],
            "name": s["name"],
            "geometry": tidy(point, projector, 0),
            "props": props,
        })
    return features


# ---------------------------------------------------------------------------
# Lines: one feature per route (grouped by mode + short name), from shapes.txt
# ---------------------------------------------------------------------------

def route_shapes(zip_path: Path, wanted_modes: set[str]) -> list[dict]:
    """Routes of the wanted modes with their distinct shapes as LineStrings."""
    with zipfile.ZipFile(zip_path) as z:
        routes = pd.read_csv(z.open("routes.txt"), dtype=str, keep_default_na=False)
        trips = pd.read_csv(z.open("trips.txt"), dtype=str, keep_default_na=False,
                            usecols=lambda c: c in ("route_id", "shape_id"))
        routes["mode"] = [_extended(int(t)) for t in routes.route_type]
        routes = routes[routes["mode"].isin(wanted_modes)]
        shape_ids: dict[str, set[str]] = {}
        for r, s in zip(trips.route_id, trips.get("shape_id", pd.Series([""] * len(trips)))):
            if s and r in set(routes.route_id):
                shape_ids.setdefault(r, set()).add(s)
        needed = set().union(*shape_ids.values()) if shape_ids else set()
        pts: dict[str, list] = {}
        for chunk in pd.read_csv(z.open("shapes.txt"), dtype=str, chunksize=1_000_000,
                                 usecols=["shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"]):
            chunk = chunk[chunk.shape_id.isin(needed)]
            for sid, lat, lon, seq in zip(chunk.shape_id, chunk.shape_pt_lat, chunk.shape_pt_lon,
                                          chunk.shape_pt_sequence):
                pts.setdefault(sid, []).append((int(seq), float(lon), float(lat)))
    lines = {sid: LineString([(x, y) for _, x, y in sorted(p)]) for sid, p in pts.items() if len(p) >= 2}
    out = []
    for _, r in routes.iterrows():
        geoms = [lines[s] for s in sorted(shape_ids.get(r.route_id, ())) if s in lines]
        if geoms:
            out.append({"route_id": r.route_id, "short": r.get("route_short_name", ""),
                        "long": r.get("route_long_name", ""), "mode": r["mode"],
                        "color": r.get("route_color", ""), "lines": geoms})
    return out


def build_line_layer(layer: dict, routes: list[dict], area, prepared, projector: Projector,
                     simplify_m: float) -> list[dict]:
    """Group routes by (mode, short name), union their shapes, clip to the area."""
    groups: dict[tuple[str, str], list[dict]] = {}
    for r in routes:
        key = (r["mode"], r["short"] or r["long"] or r["route_id"])
        groups.setdefault(key, []).append(r)
    features = []
    for (mode, short), rs in sorted(groups.items()):
        merged = clip(shapely.line_merge(unary_union([g for r in rs for g in r["lines"]])), area, prepared)
        if merged is None:
            continue
        geom = tidy(merged, projector, layer.get("simplify_m", simplify_m))
        if geom is None:
            continue
        color = next((r["color"] for r in rs if re.fullmatch(r"[0-9A-Fa-f]{6}", r["color"] or "")), "")
        long_names = sorted({r["long"] for r in rs if r["long"]})
        props = {"mode": mode, "route_ids": sorted(r["route_id"] for r in rs)}
        if color:
            props["color"] = f"#{color.upper()}"
        if long_names and long_names[0] != short:
            props["long_names"] = long_names
        features.append({
            "id": f"gtfs:line/{mode}/{re.sub(r'[^A-Za-z0-9]+', '-', short).strip('-').lower()}",
            "layer": layer["id"],
            "name": short,
            "geometry": geom,
            "props": props,
        })
    return features
