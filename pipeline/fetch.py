"""Download sources into pipeline/.cache with provenance (retrieved time, ETag, size)."""

from __future__ import annotations

import hashlib
import json
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

USER_AGENT = "hide-and-drink-pipeline/1 (private game companion)"


def _meta_path(path: Path) -> Path:
    return path.with_name(path.name + ".meta.json")


def request_key(request) -> str:
    """Stable hash of what a cached reply was asked for (query, area), stored next to it."""
    return hashlib.sha256(json.dumps(request, sort_keys=True).encode()).hexdigest()


def cached_reply(path: Path, key: str, *, offline: bool, max_age_h: float | None):
    """(body, meta) from the cache if it answers this exact request and is fresh enough, else None.

    A reply cached for a different request (another area or layer set) is never reused: that is
    how a grown play area used to keep the old area's stations and suburbs until the cache aged out.
    """
    meta_file = _meta_path(path)
    if not (path.exists() and meta_file.exists()):
        if offline:
            raise FileNotFoundError(f"{path} not cached; run without --offline")
        return None
    meta = json.loads(meta_file.read_text())
    if meta.get("request_sha256") != key:
        if offline:
            raise FileNotFoundError(f"{path} was cached for a different query or area; run without --offline")
        return None
    age_h = (time.time() - path.stat().st_mtime) / 3600
    if offline or max_age_h is None or age_h < max_age_h:
        return json.loads(path.read_text()), _public(meta)
    return None


def store_reply(path: Path, key: str, body, meta: dict) -> dict:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(body))
    _meta_path(path).write_text(json.dumps({**meta, "request_sha256": key}, indent=2))
    return meta


def _public(meta: dict) -> dict:
    return {k: v for k, v in meta.items() if k != "request_sha256"}


def download(url: str, path: Path, *, offline: bool = False, max_age_h: float = 24) -> dict:
    """Fetch url to path unless a fresh cached copy exists. Returns provenance metadata."""
    meta_file = _meta_path(path)
    if path.exists() and meta_file.exists():
        meta = json.loads(meta_file.read_text())
        age_h = (time.time() - path.stat().st_mtime) / 3600
        if offline or age_h < max_age_h:
            return meta
    if offline:
        raise FileNotFoundError(f"{path} not cached; run without --offline")
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".part")
    sha = hashlib.sha256()
    with requests.get(url, stream=True, timeout=120, headers={"User-Agent": USER_AGENT}) as r:
        r.raise_for_status()
        with tmp.open("wb") as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)
                sha.update(chunk)
        meta = {
            "url": url,
            "retrieved_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "last_modified": r.headers.get("Last-Modified"),
            "etag": r.headers.get("ETag"),
            "bytes": tmp.stat().st_size,
            "sha256": sha.hexdigest(),
        }
    tmp.replace(path)
    meta_file.write_text(json.dumps(meta, indent=2))
    return meta


def post_json(urls: list[str], data: dict, path: Path, *, offline: bool = False, max_age_h: float = 24):
    """POST a form to the first working URL (Overpass mirrors) and cache the JSON reply."""
    key = request_key(data)
    hit = cached_reply(path, key, offline=offline, max_age_h=max_age_h)
    if hit:
        return hit
    errors = []
    for url in urls:
        try:
            r = requests.post(url, data=data, timeout=300, headers={"User-Agent": USER_AGENT})
            r.raise_for_status()
            body = r.json()
        except (requests.RequestException, ValueError) as e:
            errors.append(f"{url}: {e}")
            continue
        meta = {
            "url": url,
            "retrieved_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "osm_base": body.get("osm3s", {}).get("timestamp_osm_base"),
        }
        return body, store_reply(path, key, body, meta)
    raise RuntimeError("all Overpass endpoints failed:\n  " + "\n  ".join(errors))


def get_json(url: str, params: dict) -> dict:
    r = requests.get(url, params=params, timeout=120, headers={"User-Agent": USER_AGENT})
    r.raise_for_status()
    return r.json()
