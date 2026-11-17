"""Load the city config, layer definitions and play areas from data/."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CACHE = ROOT / "pipeline" / ".cache"


@dataclass
class City:
    id: str
    config: dict
    layers: list[dict]
    play_areas: dict  # name -> FeatureCollection
    venue_edits: dict

    def layers_from(self, source: str) -> list[dict]:
        return [layer for layer in self.layers if layer["from"] == source]


def load_city(city_id: str, data_dir: Path = DATA) -> City:
    cfg = json.loads((data_dir / "cities" / f"{city_id}.json").read_text())
    layers = json.loads((data_dir / "map-layers.json").read_text())["layers"]
    play_areas = {}
    for name in cfg["play_areas"]:
        play_areas[name] = json.loads((data_dir / "play-areas" / f"{name}.geojson").read_text())
    edits = {"add": [], "exclude": []}
    if cfg.get("venues_file"):
        edits = json.loads((data_dir / cfg["venues_file"]).read_text())
    return City(city_id, cfg, layers, play_areas, edits)
