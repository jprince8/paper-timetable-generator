#!/usr/bin/env bash

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
PYTHON_CMD="python3"

$PYTHON_CMD "$SCRIPT_DIR/tests/run_cached_timetable_tests.py"
