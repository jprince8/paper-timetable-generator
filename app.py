from flask import Flask, send_from_directory, request, jsonify
import os
import requests

app = Flask(__name__, static_folder="static")

# Credentials MUST be set in Cloud Run env vars (do NOT hardcode)
RTT_USER = os.environ.get("RTT_USER")
RTT_PASS = os.environ.get("RTT_PASS")

RTT_BASE = "https://api.rtt.io/api/v1"

def rtt_get(path, params=None):
    resp = requests.get(
        RTT_BASE + path,
        auth=(RTT_USER, RTT_PASS),
        params=params,
        timeout=15
    )
    resp.raise_for_status()
    return resp.json()

@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")

@app.route("/rtt/search")
def api_search():
    crs = request.args.get("crs")
    date = request.args.get("date")
    to = request.args.get("to")
    if not crs or not date:
        return jsonify({"error": "crs and date required"}), 400
    path = f"/json/search/{crs}/{date}"
    params = {"to": to} if to else None
    return jsonify(rtt_get(path, params))

@app.route("/rtt/service")
def api_service():
    uid = request.args.get("uid")
    date = request.args.get("date")
    if not uid or not date:
        return jsonify({"error": "uid and date required"}), 400
    path = f"/json/service/{uid}/{date}"
    return jsonify(rtt_get(path))

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port)
