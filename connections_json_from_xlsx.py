#!/usr/bin/env python3

import json
import re
from pathlib import Path

from openpyxl import load_workbook


INPUT_FILE = Path("data/connections.xlsx")
OUTPUT_FILE = Path("data/connections.json")
MATRIX_SHEET = "matrix"
DEFINITIONS_SHEET = "definitions"


def base_location(name):
    return re.sub(r"\([^)]*\)$", "", str(name).strip())


def station_list(value):
    if value is None:
        return None
    parts = [part.strip() for part in str(value).split(",")]
    parts = [part for part in parts if part]
    return parts or None


def parse_duration(value):
    if value is None:
        return None

    text = str(value).strip()
    if not text or text.upper() == "X":
        return None

    mode = "Underground"
    if text.upper().endswith("W"):
        mode = "walk"
        text = text[:-1].strip()

    try:
        minutes = int(float(text))
    except ValueError:
        return None

    return {
        "durationMinutes": minutes,
        "mode": mode,
    }


def add_direction_fields(target, definition):
    previous = definition.get("previousStations")
    next_ = definition.get("nextStations")

    if previous:
        target["previousStations"] = previous
    if next_:
        target["nextStations"] = next_


def main():
    wb = load_workbook(INPUT_FILE, data_only=True)

    matrix_ws = wb[MATRIX_SHEET]
    definitions_ws = wb[DEFINITIONS_SHEET]

    definitions = {}

    for row in definitions_ws.iter_rows(min_row=2, values_only=True):
        location, previous, next_ = row[:3]
        if location is None:
            continue

        definitions[str(location).strip()] = {
            "previousStations": station_list(previous),
            "nextStations": station_list(next_),
        }

    headers = [
        cell.value if cell.value is None else str(cell.value).strip()
        for cell in matrix_ws[1][1:]
    ]

    output = {}

    for row in matrix_ws.iter_rows(min_row=2, values_only=True):
        origin = row[0]
        if origin is None:
            continue

        origin = str(origin).strip()
        origin_base = base_location(origin)

        origin_entry = {}
        add_direction_fields(origin_entry, definitions.get(origin, {}))

        connections = {}

        for target, raw_duration in zip(headers, row[1:]):
            if target is None:
                continue

            parsed_duration = parse_duration(raw_duration)
            if parsed_duration is None:
                continue

            target = str(target).strip()
            target_base = base_location(target)

            connection_entry = {}
            add_direction_fields(connection_entry, definitions.get(target, {}))
            connection_entry.update(parsed_duration)

            connections.setdefault(target_base, []).append(connection_entry)

        if connections:
            origin_entry["connections"] = connections
            output.setdefault(origin_base, []).append(origin_entry)

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)

    with OUTPUT_FILE.open("w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    print(f"Wrote {OUTPUT_FILE}")


if __name__ == "__main__":
    main()