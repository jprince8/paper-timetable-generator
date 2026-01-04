from flask import Flask, request, jsonify, send_file
import io
import json
import os
import re
import requests

from pdf_utils import build_timetable_pdf

from flask_cors import CORS

app = Flask(__name__, static_folder="docs", static_url_path="")

ALLOWED_ORIGINS = [
    "https://jprince8.github.io",
    "http://127.0.0.1:8080",
    "http://localhost:8080",
]

CORS(
    app,
    resources={
        r"/rtt/*": {"origins": ALLOWED_ORIGINS},
        r"/timetable/*": {"origins": ALLOWED_ORIGINS},
        r"/api/*": {"origins": ALLOWED_ORIGINS},
    },
)

# Credentials MUST be set in Cloud Run env vars (do NOT hardcode)
RTT_USER = os.environ.get("RTT_USER")
RTT_PASS = os.environ.get("RTT_PASS")

if not RTT_USER or not RTT_PASS:
    raise RuntimeError("RTT_USER and RTT_PASS must be set as environment variables")

RTT_BASE = "https://api.rtt.io/api/v1"

DATA_PATH = os.path.join(os.path.dirname(__file__), "data", "stations.json")


class RttTimeoutError(Exception):
    pass


class RttConnectionError(Exception):
    pass


def norm_station_query(value):
    value = (value or "").lower()
    value = value.replace("&", "and")
    value = re.sub(r"[^a-z0-9 ]+", " ", value)
    value = re.sub(r"\s+", " ", value).strip()
    return value


with open(DATA_PATH, "r", encoding="utf-8") as f:
    STATIONS = json.load(f)

STATIONS_N = [
    {
        "stationName": st["stationName"],
        "crsCode": st["crsCode"],
        "_n": norm_station_query(st["stationName"])
        + " "
        + st["crsCode"].lower(),
    }
    for st in STATIONS
    if st.get("crsCode")
]

STATIONS_BY_CRS = {
    st["crsCode"].upper(): st["stationName"]
    for st in STATIONS
    if st.get("crsCode")
}

def rtt_get(path, params=None):
    url = RTT_BASE + path
    try:
        resp = requests.get(
            url,
            auth=(RTT_USER, RTT_PASS),
            params=params,
            timeout=15,
        )
    except requests.Timeout as exc:
        app.logger.warning("RTT timeout for %s", url)
        raise RttTimeoutError() from exc
    except requests.ConnectionError as exc:
        app.logger.error("RTT connection error for %s: %s", url, exc)
        raise RttConnectionError() from exc
    try:
        resp.raise_for_status()
    except requests.HTTPError as e:
        # Log the body once to see what RTT is actually saying
        app.logger.error("RTT error %s for %s: %s", resp.status_code, url, resp.text[:500])
        raise
    return resp.json()

# Only used in testing
@app.route("/")
def index():
    return app.send_static_file("index.html")

@app.route("/rtt/search")
def api_search():
    crs = request.args.get("crs")
    date = request.args.get("date")  # expected YYYY-MM-DD from the HTML form
    to = request.args.get("to")

    if not crs or not date:
        return jsonify({"error": "crs and date required"}), 400

    # Convert YYYY-MM-DD -> YYYY/MM/DD for RTT, and insert /to/<toStation> before the date
    try:
        year, month, day = date.split("-")
    except ValueError:
        return jsonify({"error": "date must be YYYY-MM-DD"}), 400

    path = f"/json/search/{crs}"
    if to:
        path += f"/to/{to}"
    path += f"/{year}/{month}/{day}"

    try:
        data = rtt_get(path)
    except RttTimeoutError:
        return jsonify({"error": "timeout"}), 504
    except RttConnectionError:
        return jsonify({"error": "connection"}), 503
    return jsonify(data)

@app.route("/rtt/service")
def api_service():
    uid = request.args.get("uid")
    date = request.args.get("date")  # YYYY-MM-DD from the HTML

    if not uid or not date:
        return jsonify({"error": "uid and date required"}), 400

    try:
        year, month, day = date.split("-")
    except ValueError:
        return jsonify({"error": "date must be YYYY-MM-DD"}), 400

    path = f"/json/service/{uid}/{year}/{month}/{day}"
    try:
        data = rtt_get(path)
    except RttTimeoutError:
        return jsonify({"error": "timeout"}), 504
    except RttConnectionError:
        return jsonify({"error": "connection"}), 503
    locations = data.get("locations")
    if isinstance(locations, list):
        filtered_locations = []
        for location in locations:
            if not isinstance(location, dict):
                continue
            has_departure_or_arrival = any(
                isinstance(key, str)
                and ("departure" in key.lower() or "arrival" in key.lower())
                for key in location.keys()
            )
            if not has_departure_or_arrival:
                continue
            cleaned = {
                key: value
                for key, value in location.items()
                if key not in {"origin", "destination"}
            }
            filtered_locations.append(cleaned)
        data["locations"] = filtered_locations
    return jsonify(data)


@app.get("/api/stations")
def api_stations():
    q = request.args.get("q", "").strip()
    if not q:
        return jsonify([])

    qn = norm_station_query(q)
    results = []
    crs_candidate = q.strip().upper()
    if re.fullmatch(r"[A-Z]{3}", crs_candidate):
        station_name = STATIONS_BY_CRS.get(crs_candidate)
        if station_name:
            results.append(
                {"stationName": station_name, "crsCode": crs_candidate}
            )
    for st in STATIONS_N:
        if qn in st["_n"]:
            if any(r["crsCode"] == st["crsCode"] for r in results):
                continue
            results.append(
                {"stationName": st["stationName"], "crsCode": st["crsCode"]}
            )
            if len(results) >= 20:
                break
    return jsonify(results)


@app.route("/timetable/pdf", methods=["POST"])
def timetable_pdf():
    payload = request.get_json(silent=True) or {}
    tables = payload.get("tables", [])
    meta = payload.get("meta", {})

    if not isinstance(tables, list) or not tables:
        return jsonify({"error": "tables payload required"}), 400

    pdf_bytes = build_timetable_pdf(tables, meta=meta)
    return send_file(
        io.BytesIO(pdf_bytes),
        mimetype="application/pdf",
        as_attachment=True,
        download_name="timetable.pdf",
    )

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port)
