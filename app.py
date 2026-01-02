from flask import Flask, send_from_directory, request, jsonify, send_file
import io
import os
import requests

from pdf_utils import build_timetable_pdf

app = Flask(__name__, static_folder="static")

# Credentials MUST be set in Cloud Run env vars (do NOT hardcode)
RTT_USER = os.environ.get("RTT_USER")
RTT_PASS = os.environ.get("RTT_PASS")

if not RTT_USER or not RTT_PASS:
    raise RuntimeError("RTT_USER and RTT_PASS must be set as environment variables")

RTT_BASE = "https://api.rtt.io/api/v1"

def rtt_get(path, params=None):
    url = RTT_BASE + path
    resp = requests.get(url, auth=(RTT_USER, RTT_PASS), params=params, timeout=15)
    try:
        resp.raise_for_status()
    except requests.HTTPError as e:
        # Log the body once to see what RTT is actually saying
        app.logger.error("RTT error %s for %s: %s", resp.status_code, url, resp.text[:500])
        raise
    return resp.json()

@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")

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

    data = rtt_get(path)
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
    data = rtt_get(path)
    return jsonify(data)

@app.route("/timetable/pdf", methods=["POST"])
def timetable_pdf():
    payload = request.get_json(silent=True) or {}
    tables = payload.get("tables", [])

    if not isinstance(tables, list) or not tables:
        return jsonify({"error": "tables payload required"}), 400

    pdf_bytes = build_timetable_pdf(tables)
    return send_file(
        io.BytesIO(pdf_bytes),
        mimetype="application/pdf",
        as_attachment=True,
        download_name="timetable.pdf",
    )

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port)
