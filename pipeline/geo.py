"""Play-area extent, clipping and simplification."""

from __future__ import annotations

import numpy as np
import shapely
from pyproj import Transformer
from shapely.geometry import shape
from shapely.ops import unary_union

PRECISION = 1e-6  # ~0.1 m in degrees


def transform(transformer: Transformer, geom):
    return shapely.transform(geom, lambda xy: np.column_stack(transformer.transform(xy[:, 0], xy[:, 1])))


class Projector:
    def __init__(self, crs: str):
        self.to_m = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
        self.to_deg = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)

    def buffer(self, geom, metres: float):
        return transform(self.to_deg, transform(self.to_m, geom).buffer(metres))

    def simplify(self, geom, metres: float):
        if metres <= 0 or geom.geom_type in ("Point", "MultiPoint"):
            return geom
        return transform(self.to_deg, transform(self.to_m, geom).simplify(metres, preserve_topology=True))

    def distance_m(self, a, b) -> float:
        return transform(self.to_m, a).distance(transform(self.to_m, b))


def play_area_union(play_areas: dict):
    geoms = [shape(f["geometry"]) for fc in play_areas.values() for f in fc["features"]]
    return unary_union(geoms)


def extent(play_areas: dict, projector: Projector, buffer_m: float):
    """Union of the play areas grown by buffer_m: everything in the pack lies inside it."""
    return shapely.set_precision(projector.buffer(play_area_union(play_areas), buffer_m), PRECISION)


def clip(geom, area, prepared=None):
    """Clip to the area. Points are kept or dropped; lines and polygons are cut."""
    test = prepared if prepared is not None else area
    if geom.geom_type == "Point":
        return geom if test.contains(geom) else None
    if not test.intersects(geom):
        return None
    if prepared is not None and prepared.contains(geom):
        out = geom
    else:
        out = geom.intersection(area)
    if out.is_empty:
        return None
    if geom.geom_type in ("Polygon", "MultiPolygon"):
        polys = [g for g in getattr(out, "geoms", [out]) if g.geom_type in ("Polygon", "MultiPolygon")]
        out = unary_union(polys) if polys else None
    elif geom.geom_type in ("LineString", "MultiLineString"):
        lines = [g for g in getattr(out, "geoms", [out]) if g.geom_type in ("LineString", "MultiLineString")]
        out = shapely.line_merge(unary_union(lines)) if lines else None
    return None if out is None or out.is_empty else out


def tidy(geom, projector: Projector, simplify_m: float):
    """Simplify (metres) and round coordinates so the pack stays small and stable."""
    g = projector.simplify(geom, simplify_m)
    g = shapely.set_precision(g, PRECISION)
    return None if g.is_empty else g
