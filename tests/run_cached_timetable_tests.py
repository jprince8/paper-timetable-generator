#!/usr/bin/env python3
"""Cache-first RTT fixture generator and test runner.

Default behavior:
- Use existing cached fixture if valid.
- If missing/stale, fetch real RTT-backed data via local app.py endpoints and cache it.
- Run node tests against that fixture.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path


DEFAULT_FIXTURE_TARGETS = [
    {
        "name": "bfr",
        "query_url": (
            "http://127.0.0.1:8080/"
            "?from=CBG&to=BFR&date=2026-04-27&start=10%3A00&end=13%3A00&vias=KGX%3F"
        ),
        "fixture_name": "cbg-bfr-via-kgx-optional-2026-04-27.cached-results.json",
        "env_var": "RTT_FIXTURE_PATH_BFR",
    },
    {
        "name": "lbz",
        "query_url": (
            "http://127.0.0.1:8080/"
            "?from=CBG&to=LBZ&date=2026-04-27&start=10%3A00&end=13%3A00&vias=KGX%2CEUS"
        ),
        "fixture_name": "cbg-lbz-via-kgx-eus-2026-04-27.cached-results.json",
        "env_var": "RTT_FIXTURE_PATH_LBZ",
    },
    {
        "name": "rug_kgx_eus",
        "query_url": (
            "http://127.0.0.1:8080/"
            "?from=RUG&to=KGX&date=2026-04-27&start=09%3A00&end=12%3A00"
            "&rtt_cache=1&vias=EUS&debug_connections=1"
        ),
        "fixture_name": "rug-kgx-via-eus-2026-04-27.cached-results.json",
        "env_var": "RTT_FIXTURE_PATH_RUG_KGX_EUS",
    },
]

def _generate_fixture(query_url: str, cache_dir: Path) -> dict:
    repo_root = Path(__file__).resolve().parents[1]
    seeder_script = repo_root / "tests" / "helpers" / "seed_cached_query_fixture.mjs"
    cmd = [
        "node",
        str(seeder_script),
        "--query-url",
        query_url,
        "--cache-dir",
        str(cache_dir),
    ]
    completed = subprocess.run(
        cmd,
        cwd=repo_root,
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        stderr = completed.stderr.strip()
        stdout = completed.stdout.strip()
        detail = stderr or stdout or f"seeder exited with code {completed.returncode}"
        raise RuntimeError(detail)

    fixture = json.loads(completed.stdout)
    if not _looks_like_expected_fixture(fixture, query_url):
        raise RuntimeError("Seeder produced invalid fixture payload")
    return fixture


def _load_cached_fixture(path: Path) -> dict | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None


def _looks_like_expected_fixture(data: dict, query_url: str) -> bool:
    if not isinstance(data, dict):
        return False
    if data.get("queryUrl") != query_url:
        return False
    if data.get("fixtureVersion") != 3:
        return False
    keys = data.get("requiredRequestKeys")
    if not isinstance(keys, list):
        return False
    if not all(isinstance(item, str) and item for item in keys):
        return False
    return True


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--query-url")
    parser.add_argument("--fixture-name")
    parser.add_argument(
        "--refresh",
        action="store_true",
        default=os.environ.get("REFRESH_RTT_CACHE_FIXTURE", "").strip().lower()
        in {"1", "true", "yes"},
    )
    parser.add_argument("--skip-tests", action="store_true")
    return parser.parse_args()


def _ensure_fixture(
    fixtures_dir: Path,
    cache_dir: Path,
    query_url: str,
    fixture_name: str,
    refresh: bool,
) -> tuple[Path, int]:
    fixture_path = fixtures_dir / fixture_name
    fixture_path.parent.mkdir(parents=True, exist_ok=True)
    cached = None if refresh else _load_cached_fixture(fixture_path)
    if cached and _looks_like_expected_fixture(cached, query_url):
        print(f"Using cached query fixture: {fixture_path}")
        return fixture_path, 0

    if refresh:
        print(f"Refreshing cached query fixture: {fixture_path}")
    else:
        print(f"Cached fixture missing or stale; generating: {fixture_path}")

    try:
        fixture = _generate_fixture(query_url, cache_dir)
    except Exception as exc:  # noqa: BLE001
        print(f"Failed to generate RTT fixture: {exc}", file=sys.stderr)
        return fixture_path, 1

    fixture_path.write_text(json.dumps(fixture, indent=2), encoding="utf-8")
    print(f"Generated RTT fixture: {fixture_path}")
    return fixture_path, 0


def main() -> int:
    args = _parse_args()
    repo_root = Path(__file__).resolve().parents[1]
    fixtures_dir = repo_root / "tests" / "fixtures"
    cache_dir = fixtures_dir / "rtt-query-cache"
    if args.query_url and not args.fixture_name:
        print("--fixture-name is required when --query-url is provided", file=sys.stderr)
        return 2
    if args.fixture_name and not args.query_url:
        print("--query-url is required when --fixture-name is provided", file=sys.stderr)
        return 2

    if args.query_url and args.fixture_name:
        targets = [
            {
                "name": "custom",
                "query_url": args.query_url,
                "fixture_name": args.fixture_name,
                "env_var": "RTT_FIXTURE_PATH",
            }
        ]
    else:
        targets = DEFAULT_FIXTURE_TARGETS

    generated_paths: dict[str, Path] = {}
    for target in targets:
        fixture_path, status = _ensure_fixture(
            fixtures_dir=fixtures_dir,
            cache_dir=cache_dir,
            query_url=target["query_url"],
            fixture_name=target["fixture_name"],
            refresh=args.refresh,
        )
        if status != 0:
            return status
        generated_paths[target["env_var"]] = fixture_path

    if args.skip_tests:
        return 0

    cmd = [
        "node",
        "--test",
        "tests/timetable_connections_previous_stations.test.mjs",
        "tests/timetable_cached_query.test.mjs",
        "tests/timetable_cached_query_lbz.test.mjs",
        "tests/timetable_cached_query_rug_kgx_eus.test.mjs",
    ]
    env = dict(os.environ)
    if "RTT_FIXTURE_PATH_BFR" in generated_paths:
        env["RTT_FIXTURE_PATH_BFR"] = str(generated_paths["RTT_FIXTURE_PATH_BFR"])
        env["RTT_FIXTURE_PATH"] = str(generated_paths["RTT_FIXTURE_PATH_BFR"])
    if "RTT_FIXTURE_PATH_LBZ" in generated_paths:
        env["RTT_FIXTURE_PATH_LBZ"] = str(generated_paths["RTT_FIXTURE_PATH_LBZ"])
    if "RTT_FIXTURE_PATH_RUG_KGX_EUS" in generated_paths:
        env["RTT_FIXTURE_PATH_RUG_KGX_EUS"] = str(
            generated_paths["RTT_FIXTURE_PATH_RUG_KGX_EUS"]
        )
    if "RTT_FIXTURE_PATH" in generated_paths:
        env["RTT_FIXTURE_PATH"] = str(generated_paths["RTT_FIXTURE_PATH"])
    print("Running:", " ".join(cmd))
    completed = subprocess.run(cmd, cwd=repo_root, env=env)
    return completed.returncode


if __name__ == "__main__":
    raise SystemExit(main())
