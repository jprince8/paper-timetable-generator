from flask import Flask, request, jsonify, send_file
import io
import json
import os
import re
from datetime import datetime, timedelta, timezone
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
RTT_TOKEN = os.environ.get("RTT_TOKEN")
RTT_API_MODE = (os.environ.get("RTT_API_MODE") or "auto").strip().lower()

if not ((RTT_USER and RTT_PASS) or RTT_TOKEN):
    raise RuntimeError(
        "Set RTT_USER/RTT_PASS for legacy API and/or RTT_TOKEN for new API"
    )

RTT_LEGACY_BASE = "https://api.rtt.io/api/v1"
RTT_NEW_BASE = "https://data.rtt.io"
NEW_API_NAMESPACE = "gb-nr"

_RTT_ACCESS_TOKEN = None
_RTT_ACCESS_TOKEN_VALID_UNTIL = None
_RTT_AUTO_FORCE_NEW_UNTIL_RESTART = False

if RTT_API_MODE not in {"new", "legacy", "auto"}:
    RTT_API_MODE = "auto"

print(f"RTT API mode: {RTT_API_MODE}")

DATA_PATH = os.path.join(os.path.dirname(__file__), "data", "stations.json")


class RttTimeoutError(Exception):
    pass


class RttConnectionError(Exception):
    pass


class RttHttpError(Exception):
    def __init__(self, status_code, body):
        super().__init__(f"RTT HTTP {status_code}")
        self.status_code = status_code
        self.body = body


class RttRateLimitError(Exception):
    def __init__(self, retry_after=None, body=None):
        super().__init__("RTT HTTP 429")
        self.retry_after = retry_after
        self.body = body


def _legacy_api_looks_deprecated(exc):
    status = exc.status_code
    if status in {404, 410, 426}:
        return True

    body = str(exc.body or "").lower()
    if not body:
        return False

    markers = (
        "deprecated",
        "deprecation",
        "sunset",
        "retired",
        "no longer available",
        "legacy api",
        "use data.rtt.io",
        "migrat",
    )
    return any(marker in body for marker in markers)


def _pin_auto_mode_to_new(reason):
    global _RTT_AUTO_FORCE_NEW_UNTIL_RESTART
    if _RTT_AUTO_FORCE_NEW_UNTIL_RESTART:
        return
    _RTT_AUTO_FORCE_NEW_UNTIL_RESTART = True
    app.logger.warning(
        "RTT auto mode pinned to new API until restart (%s)",
        reason,
    )


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
        "_name_n": norm_station_query(st["stationName"]),
        "_crs_n": st["crsCode"].lower(),
        "_n": norm_station_query(st["stationName"]) + " " + st["crsCode"].lower(),
    }
    for st in STATIONS
    if st.get("crsCode")
]

STATIONS_BY_CRS = {
    st["crsCode"].upper(): st["stationName"]
    for st in STATIONS
    if st.get("crsCode")
}


def _parse_retry_after(value):
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        parsed = int(text)
    except ValueError:
        return None
    return parsed if parsed >= 0 else None

def rtt_get(path, params=None):
    url = RTT_LEGACY_BASE + path
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
    if resp.status_code == 429:
        retry_after = _parse_retry_after(resp.headers.get("Retry-After"))
        app.logger.warning(
            "RTT rate limit for %s (retry_after=%s): %s",
            url,
            retry_after,
            resp.text[:500],
        )
        raise RttRateLimitError(retry_after=retry_after, body=resp.text)
    try:
        resp.raise_for_status()
    except requests.HTTPError as e:
        # Log the body once to see what RTT is actually saying
        app.logger.error("RTT error %s for %s: %s", resp.status_code, url, resp.text[:500])
        raise RttHttpError(resp.status_code, resp.text) from e
    return resp.json()


def _short_code_from_location(location_obj):
    if not isinstance(location_obj, dict):
        return ""
    short_codes = location_obj.get("shortCodes")
    if isinstance(short_codes, list):
        for code in short_codes:
            if isinstance(code, str) and len(code) == 3:
                return code.upper()
        for code in short_codes:
            if isinstance(code, str) and code:
                return code.upper()
    return ""


def _long_code_from_location(location_obj):
    if not isinstance(location_obj, dict):
        return ""
    long_codes = location_obj.get("longCodes")
    if isinstance(long_codes, list):
        for code in long_codes:
            if isinstance(code, str) and code:
                return code.upper()
    return ""


def _extract_hhmm(value):
    if not value:
        return ""
    text = str(value).strip()
    if not text:
        return ""
    m = re.search(r"T(\d{2}):(\d{2})", text)
    if m:
        return f"{m.group(1)}{m.group(2)}"
    m = re.fullmatch(r"(\d{2}):(\d{2})", text)
    if m:
        return f"{m.group(1)}{m.group(2)}"
    m = re.fullmatch(r"(\d{4})", text)
    if m:
        return m.group(1)
    return ""


def _map_display_as(temporal):
    if not isinstance(temporal, dict):
        temporal = {}

    scheduled_call_type = _first_present_text(temporal.get("scheduledCallType")).upper()
    realtime_call_type = _first_present_text(temporal.get("realtimeCallType")).upper()
    call_type = realtime_call_type or scheduled_call_type

    raw_display = _first_present_text(temporal.get("displayAs"))
    if raw_display:
        display = raw_display.upper()
        if display == "STARTS":
            return "STARTS"
        if display == "TERMINATES":
            return "ENDS"
        if display == "CANCELLED":
            if call_type in {"ADVERTISED_OPEN", "ADVERTISED_SET_DOWN", "ADVERTISED_PICK_UP"}:
                return "CANCELLED_CALL"
            return "CANCELLED_PASS"
        if display == "DIVERTED":
            return "PASS"
        return display

    if call_type in {"ADVERTISED_OPEN", "ADVERTISED_SET_DOWN", "ADVERTISED_PICK_UP"}:
        return "CALL"
    if call_type == "OPERATIONAL_ONLY":
        return "PASS"

    departure = temporal.get("departure") if isinstance(temporal.get("departure"), dict) else {}
    arrival = temporal.get("arrival") if isinstance(temporal.get("arrival"), dict) else {}
    passtime = temporal.get("pass") if isinstance(temporal.get("pass"), dict) else {}

    has_departure = bool(
        _extract_hhmm(
            departure.get("scheduleAdvertised")
            or departure.get("scheduleInternal")
            or departure.get("realtimeActual")
            or departure.get("realtimeForecast")
            or departure.get("realtimeEstimate")
        )
    )
    has_arrival = bool(
        _extract_hhmm(
            arrival.get("scheduleAdvertised")
            or arrival.get("scheduleInternal")
            or arrival.get("realtimeActual")
            or arrival.get("realtimeForecast")
            or arrival.get("realtimeEstimate")
        )
    )
    has_pass = bool(
        _extract_hhmm(
            passtime.get("scheduleAdvertised")
            or passtime.get("scheduleInternal")
            or passtime.get("realtimeActual")
            or passtime.get("realtimeForecast")
            or passtime.get("realtimeEstimate")
        )
    )

    if has_arrival and has_departure:
        return "CALL"
    if has_departure and not has_arrival:
        return "STARTS"
    if has_arrival and not has_departure:
        return "ENDS"
    if has_pass and not (has_arrival or has_departure):
        return "PASS"

    # Per API spec, null displayAs should be treated as PASS.
    return "PASS"


def _infer_is_public_call(display_as, *candidate_values):
    for value in candidate_values:
        if isinstance(value, bool):
            return value
    display = (display_as or "").upper()
    return display not in {"PASS", "CANCELLED_PASS"}


def _extract_facility_lists(service):
    lists = []
    allocations = service.get("allocationData")
    if not isinstance(allocations, list):
        return lists
    for allocation in allocations:
        if not isinstance(allocation, dict):
            continue
        kyt = allocation.get("knowYourTrainData")
        if not isinstance(kyt, dict):
            continue

        common = kyt.get("commonFacilities")
        if isinstance(common, list):
            lists.append(common)

        groups = kyt.get("data")
        if not isinstance(groups, list):
            continue
        for group in groups:
            if not isinstance(group, dict):
                continue
            group_facilities = group.get("groupFacilities")
            if isinstance(group_facilities, list):
                lists.append(group_facilities)
            vehicles = group.get("vehicles")
            if not isinstance(vehicles, list):
                continue
            for vehicle in vehicles:
                if not isinstance(vehicle, dict):
                    continue
                individual = vehicle.get("individualFacilities")
                if isinstance(individual, list):
                    lists.append(individual)
    return lists


def _service_has_facility(service, facility_name):
    target = str(facility_name or "").strip().lower()
    if not target:
        return None
    facility_lists = _extract_facility_lists(service)
    if not facility_lists:
        return None
    for values in facility_lists:
        for value in values:
            if isinstance(value, str) and value.strip().lower() == target:
                return True
    return False


def _first_present_text(*values):
    for value in values:
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return ""


def _bool_or_none(*values):
    for value in values:
        if isinstance(value, bool):
            return value
    return None


def _normalize_pair_entry(pair):
    if not isinstance(pair, dict):
        return None
    location = pair.get("location") or {}
    temporal = pair.get("temporalData") or {}
    public_time = _extract_hhmm(
        pair.get("publicTime")
        or temporal.get("scheduleAdvertised")
        or temporal.get("scheduleInternal")
    )
    description = _first_present_text(pair.get("description"), location.get("description"))
    if not description and location:
        description = _short_code_from_location(location) or _long_code_from_location(location)
    if not description and pair.get("tiploc"):
        description = str(pair.get("tiploc"))
    if not description and pair.get("crs"):
        description = str(pair.get("crs"))
    if not description and not public_time:
        return None
    return {"description": description, "publicTime": public_time}


def _normalize_pairs(pairs):
    if not isinstance(pairs, list):
        return []
    out = []
    for pair in pairs:
        normalized = _normalize_pair_entry(pair)
        if normalized:
            out.append(normalized)
    return out


def _normalize_location(location):
    if not isinstance(location, dict):
        return None

    temporal = location.get("temporalData") or {}
    departure = temporal.get("departure") or {}
    arrival = temporal.get("arrival") or {}
    passtime = temporal.get("pass") or {}
    location_obj = location.get("location") or {}
    location_metadata = location.get("locationMetadata") or {}
    platform_meta = location_metadata.get("platform") or {}

    crs = _first_present_text(location.get("crs"), _short_code_from_location(location_obj))
    if not crs:
        return None

    description = _first_present_text(location.get("description"), location_obj.get("description"))
    tiploc = _first_present_text(location.get("tiploc"), _long_code_from_location(location_obj))

    gbtt_departure = _extract_hhmm(
        location.get("gbttBookedDeparture")
        or departure.get("scheduleAdvertised")
        or departure.get("scheduleInternal")
    )
    gbtt_arrival = _extract_hhmm(
        location.get("gbttBookedArrival")
        or arrival.get("scheduleAdvertised")
        or arrival.get("scheduleInternal")
    )
    gbtt_pass = _extract_hhmm(
        location.get("gbttBookedPass")
        or passtime.get("scheduleAdvertised")
        or passtime.get("scheduleInternal")
    )
    realtime_departure = _extract_hhmm(
        location.get("realtimeDeparture")
        or departure.get("realtimeActual")
        or departure.get("realtimeForecast")
        or departure.get("realtimeEstimate")
    )
    realtime_arrival = _extract_hhmm(
        location.get("realtimeArrival")
        or arrival.get("realtimeActual")
        or arrival.get("realtimeForecast")
        or arrival.get("realtimeEstimate")
    )
    realtime_pass = _extract_hhmm(
        location.get("realtimePass")
        or passtime.get("realtimeActual")
        or passtime.get("realtimeForecast")
        or passtime.get("realtimeEstimate")
    )

    display_as = _first_present_text(location.get("displayAs")).upper()
    if not display_as:
        display_as = _map_display_as(temporal)

        # Legacy payloads may omit temporalData/displayAs while still providing
        # top-level booked times. Infer call shape from those values so
        # historical legacy services are not treated as non-calls.
        if display_as == "PASS" and not temporal:
            has_departure = bool(gbtt_departure or realtime_departure)
            has_arrival = bool(gbtt_arrival or realtime_arrival)
            has_pass = bool(gbtt_pass or realtime_pass)
            if has_arrival and has_departure:
                display_as = "CALL"
            elif has_departure and not has_arrival:
                display_as = "STARTS"
            elif has_arrival and not has_departure:
                display_as = "ENDS"
            elif has_pass and not (has_arrival or has_departure):
                display_as = "PASS"

    is_public_call = _bool_or_none(location.get("isPublicCall"), temporal.get("isPublicCall"))
    if is_public_call is None:
        is_public_call = _infer_is_public_call(display_as)

    planned_platform = _first_present_text(platform_meta.get("planned"))
    forecast_platform = _first_present_text(platform_meta.get("forecast"))
    actual_platform = _first_present_text(platform_meta.get("actual"))
    display_platform = _first_present_text(
        location.get("platform"),
        forecast_platform,
        actual_platform,
        planned_platform,
    )

    platform_confirmed = _bool_or_none(location.get("platformConfirmed"))
    if platform_confirmed is None:
        platform_confirmed = bool(
            planned_platform
            and (forecast_platform or actual_platform)
            and planned_platform == (forecast_platform or actual_platform)
        )

    platform_changed = _bool_or_none(location.get("platformChanged"))
    if platform_changed is None:
        platform_changed = bool(
            planned_platform
            and (forecast_platform or actual_platform)
            and planned_platform != (forecast_platform or actual_platform)
        )

    realtime_departure_actual = _bool_or_none(
        location.get("realtimeDepartureActual"),
        bool(departure.get("realtimeActual")) if departure.get("realtimeActual") else None,
    )
    realtime_arrival_actual = _bool_or_none(
        location.get("realtimeArrivalActual"),
        bool(arrival.get("realtimeActual")) if arrival.get("realtimeActual") else None,
    )
    realtime_pass_actual = _bool_or_none(
        location.get("realtimePassActual"),
        bool(passtime.get("realtimeActual")) if passtime.get("realtimeActual") else None,
    )

    realtime_departure_no_report = _bool_or_none(
        location.get("realtimeDepartureNoReport"),
        departure.get("realtimeNoReport"),
    )
    realtime_arrival_no_report = _bool_or_none(
        location.get("realtimeArrivalNoReport"),
        arrival.get("realtimeNoReport"),
    )
    realtime_pass_no_report = _bool_or_none(
        location.get("realtimePassNoReport"),
        passtime.get("realtimeNoReport"),
    )

    return {
        "crs": crs,
        "description": description,
        "tiploc": tiploc,
        "displayAs": display_as,
        "isPublicCall": bool(is_public_call),
        "gbttBookedDeparture": gbtt_departure,
        "gbttBookedArrival": gbtt_arrival,
        "gbttBookedPass": gbtt_pass,
        "realtimeDeparture": realtime_departure,
        "realtimeArrival": realtime_arrival,
        "realtimePass": realtime_pass,
        "realtimeDepartureActual": bool(realtime_departure_actual),
        "realtimeArrivalActual": bool(realtime_arrival_actual),
        "realtimePassActual": bool(realtime_pass_actual),
        "realtimeDepartureNoReport": bool(realtime_departure_no_report),
        "realtimeArrivalNoReport": bool(realtime_arrival_no_report),
        "realtimePassNoReport": bool(realtime_pass_no_report),
        "platform": display_platform,
        "platformConfirmed": bool(platform_confirmed),
        "platformChanged": bool(platform_changed),
    }


def _normalize_search_service_entry(service, search_crs="", search_description=""):
    if not isinstance(service, dict):
        return None

    schedule = service.get("scheduleMetadata") or {}
    location_detail_raw = service.get("locationDetail")
    if not isinstance(location_detail_raw, dict):
        location_detail_raw = service
    location_detail = _normalize_location(location_detail_raw)
    if not location_detail and isinstance(location_detail_raw, dict) and search_crs:
        fallback = dict(location_detail_raw)
        fallback["crs"] = search_crs
        if search_description:
            fallback["description"] = search_description
        location_detail = _normalize_location(fallback)
    if not location_detail:
        return None

    display_as = _first_present_text(location_detail.get("displayAs")).upper()
    planned_cancel = _bool_or_none(service.get("plannedCancel"))
    if planned_cancel is None:
        planned_cancel = display_as.startswith("CANCELLED")

    return {
        "serviceUid": _first_present_text(service.get("serviceUid"), schedule.get("identity")),
        "runDate": _first_present_text(service.get("runDate"), schedule.get("departureDate")),
        "trainIdentity": _first_present_text(
            service.get("trainIdentity"),
            service.get("runningIdentity"),
            schedule.get("trainReportingIdentity"),
            schedule.get("identity"),
        ),
        "atocCode": _first_present_text(
            service.get("atocCode"),
            (schedule.get("operator") or {}).get("code"),
        ),
        "atocName": _first_present_text(
            service.get("atocName"),
            (schedule.get("operator") or {}).get("name"),
        ),
        "serviceType": _first_present_text(
            service.get("serviceType"),
            schedule.get("modeType"),
        ).lower(),
        "isPassenger": (
            service.get("isPassenger")
            if isinstance(service.get("isPassenger"), bool)
            else (schedule.get("inPassengerService") if isinstance(schedule.get("inPassengerService"), bool) else True)
        ),
        "plannedCancel": bool(planned_cancel),
        "locationDetail": location_detail,
    }


def _normalize_search_response(data, to_code=None):
    query = (data or {}).get("query") or {}
    query_location = query.get("location") or {}
    location = (data or {}).get("location") or {}
    filter_obj = (data or {}).get("filter") or {}
    destination = filter_obj.get("destination") or filter_obj.get("location") or {}

    from_name = _first_present_text(
        location.get("name"),
        location.get("description"),
        query_location.get("description"),
        query_location.get("name"),
    )
    to_name = _first_present_text(
        destination.get("name"),
        destination.get("description"),
        STATIONS_BY_CRS.get((to_code or "").upper(), "") if to_code else "",
    )
    query_crs = _first_present_text(_short_code_from_location(query_location), location.get("crs"))

    services = (data or {}).get("services") or []
    normalized_services = []
    for service in services:
        normalized = _normalize_search_service_entry(
            service,
            search_crs=query_crs,
            search_description=from_name,
        )
        if normalized:
            normalized_services.append(normalized)

    return {
        "location": {"name": from_name, "description": from_name},
        "filter": {
            "destination": {"name": to_name, "description": to_name},
            "location": {"name": to_name, "description": to_name},
        },
        "services": normalized_services,
    }


def _normalize_service_response(data):
    payload = data or {}
    service_obj = payload.get("service") if isinstance(payload.get("service"), dict) else payload
    schedule = service_obj.get("scheduleMetadata") or {}

    raw_locations = service_obj.get("locations") or payload.get("locations") or []
    locations = []
    for location in raw_locations:
        normalized = _normalize_location(location)
        if normalized:
            locations.append(normalized)

    raw_origin = service_obj.get("origin") or payload.get("origin") or []
    raw_destination = service_obj.get("destination") or payload.get("destination") or []
    origin = _normalize_pairs(raw_origin)
    destination = _normalize_pairs(raw_destination)

    is_passenger = payload.get("isPassenger")
    if not isinstance(is_passenger, bool):
        is_passenger = service_obj.get("inPassengerService")
    if not isinstance(is_passenger, bool):
        is_passenger = schedule.get("inPassengerService")
    if not isinstance(is_passenger, bool):
        is_passenger = True

    first_class_available = _bool_or_none(
        payload.get("firstClassAvailable"),
        service_obj.get("firstClassAvailable"),
    )
    sleeper_available = _bool_or_none(
        payload.get("sleeperAvailable"),
        service_obj.get("sleeperAvailable"),
    )

    if first_class_available is None:
        legacy_train_class = _first_present_text(
            payload.get("trainClass"),
            service_obj.get("trainClass"),
        )
        if legacy_train_class:
            first_class_available = legacy_train_class.upper() != "S"
        elif "trainClass" in payload or "trainClass" in service_obj:
            first_class_available = True
        else:
            facility_first = _service_has_facility(service_obj, "first")
            first_class_available = bool(facility_first) if isinstance(facility_first, bool) else False

    if sleeper_available is None:
        legacy_sleepers = _first_present_text(
            payload.get("sleepers"),
            payload.get("sleeper"),
            service_obj.get("sleepers"),
            service_obj.get("sleeper"),
        )
        if legacy_sleepers:
            sleeper_available = True
        else:
            facility_sleeper = _service_has_facility(service_obj, "sleeper")
            sleeper_available = bool(facility_sleeper) if isinstance(facility_sleeper, bool) else False

    realtime_activated = _bool_or_none(
        payload.get("realtimeActivated"),
        service_obj.get("realtimeActivated"),
    )
    if realtime_activated is None:
        realtime_activated = any(
            l.get("realtimeArrival") or l.get("realtimeDeparture") or l.get("realtimePass")
            for l in locations
        )

    return {
        "serviceUid": _first_present_text(
            payload.get("serviceUid"),
            service_obj.get("serviceUid"),
            schedule.get("identity"),
        ),
        "runDate": _first_present_text(
            payload.get("runDate"),
            service_obj.get("runDate"),
            schedule.get("departureDate"),
        ),
        "trainIdentity": _first_present_text(
            payload.get("trainIdentity"),
            payload.get("runningIdentity"),
            service_obj.get("trainIdentity"),
            service_obj.get("runningIdentity"),
            schedule.get("trainReportingIdentity"),
            schedule.get("identity"),
        ),
        "atocCode": _first_present_text(
            payload.get("atocCode"),
            service_obj.get("atocCode"),
            (schedule.get("operator") or {}).get("code"),
        ),
        "atocName": _first_present_text(
            payload.get("atocName"),
            service_obj.get("atocName"),
            (schedule.get("operator") or {}).get("name"),
        ),
        "serviceType": _first_present_text(
            payload.get("serviceType"),
            service_obj.get("serviceType"),
            schedule.get("modeType"),
        ).lower(),
        "isPassenger": bool(is_passenger),
        "realtimeActivated": bool(realtime_activated),
        "firstClassAvailable": bool(first_class_available) and bool(is_passenger),
        "sleeperAvailable": bool(sleeper_available) and bool(is_passenger),
        "origin": origin,
        "destination": destination,
        "locations": locations,
    }


def _convert_new_location_entry(entry):
    schedule = entry.get("scheduleMetadata") or {}
    temporal = entry.get("temporalData") or {}
    location_metadata = entry.get("locationMetadata") or {}
    departure = temporal.get("departure") or {}
    arrival = temporal.get("arrival") or {}
    platform_meta = location_metadata.get("platform") or {}
    planned_platform = (platform_meta.get("planned") or "").strip()
    forecast_platform = (platform_meta.get("forecast") or "").strip()
    display_platform = forecast_platform or planned_platform

    display_as = _map_display_as(temporal)
    cancelled = display_as.startswith("CANCELLED")
    is_public_call = _infer_is_public_call(
        display_as,
        temporal.get("isPublicCall"),
        entry.get("isPublicCall"),
        location_metadata.get("isPublicCall"),
    )

    return {
        "serviceUid": schedule.get("identity", ""),
        "runDate": schedule.get("departureDate", ""),
        "trainIdentity": schedule.get("identity", ""),
        "atocCode": (schedule.get("operator") or {}).get("code", ""),
        "atocName": (schedule.get("operator") or {}).get("name", ""),
        "serviceType": (schedule.get("modeType") or "").lower(),
        "isPassenger": schedule.get("inPassengerService", True),
        "plannedCancel": cancelled,
        "locationDetail": {
            "crs": _short_code_from_location(entry.get("location")),
            "description": (entry.get("location") or {}).get("description", ""),
            "tiploc": _long_code_from_location(entry.get("location")),
            "displayAs": display_as,
            "isPublicCall": is_public_call,
            "gbttBookedDeparture": _extract_hhmm(
                departure.get("scheduleAdvertised") or departure.get("scheduleInternal")
            ),
            "gbttBookedArrival": _extract_hhmm(
                arrival.get("scheduleAdvertised") or arrival.get("scheduleInternal")
            ),
            "realtimeDeparture": _extract_hhmm(
                departure.get("realtimeActual")
                or departure.get("realtimeForecast")
                or departure.get("realtimeEstimate")
            ),
            "realtimeArrival": _extract_hhmm(
                arrival.get("realtimeActual")
                or arrival.get("realtimeForecast")
                or arrival.get("realtimeEstimate")
            ),
            "realtimeDepartureActual": bool(departure.get("realtimeActual")),
            "realtimeArrivalActual": bool(arrival.get("realtimeActual")),
            "realtimeDepartureNoReport": departure.get("realtimeNoReport") is True,
            "realtimeArrivalNoReport": arrival.get("realtimeNoReport") is True,
            "platform": display_platform,
            "platformConfirmed": bool(
                planned_platform and forecast_platform and planned_platform == forecast_platform
            ),
            "platformChanged": bool(
                planned_platform and forecast_platform and planned_platform != forecast_platform
            ),
        },
    }


def _convert_new_service_location(loc):
    temporal = loc.get("temporalData") or {}
    departure = temporal.get("departure") or {}
    arrival = temporal.get("arrival") or {}
    passtime = temporal.get("pass") or {}
    location_metadata = loc.get("locationMetadata") or {}
    platform_meta = location_metadata.get("platform") or {}
    planned_platform = (platform_meta.get("planned") or "").strip()
    forecast_platform = (platform_meta.get("forecast") or "").strip()
    display_platform = forecast_platform or planned_platform
    display_as = _map_display_as(temporal)
    is_public_call = _infer_is_public_call(
        display_as,
        temporal.get("isPublicCall"),
        loc.get("isPublicCall"),
        location_metadata.get("isPublicCall"),
    )

    return {
        "crs": _short_code_from_location(loc.get("location")),
        "description": (loc.get("location") or {}).get("description", ""),
        "tiploc": _long_code_from_location(loc.get("location")),
        "displayAs": display_as,
        "isPublicCall": is_public_call,
        "gbttBookedDeparture": _extract_hhmm(
            departure.get("scheduleAdvertised") or departure.get("scheduleInternal")
        ),
        "gbttBookedArrival": _extract_hhmm(
            arrival.get("scheduleAdvertised") or arrival.get("scheduleInternal")
        ),
        "gbttBookedPass": _extract_hhmm(
            passtime.get("scheduleAdvertised") or passtime.get("scheduleInternal")
        ),
        "realtimeDeparture": _extract_hhmm(
            departure.get("realtimeActual")
            or departure.get("realtimeForecast")
            or departure.get("realtimeEstimate")
        ),
        "realtimeArrival": _extract_hhmm(
            arrival.get("realtimeActual")
            or arrival.get("realtimeForecast")
            or arrival.get("realtimeEstimate")
        ),
        "realtimePass": _extract_hhmm(
            passtime.get("realtimeActual")
            or passtime.get("realtimeForecast")
            or passtime.get("realtimeEstimate")
        ),
        "realtimeDepartureActual": bool(departure.get("realtimeActual")),
        "realtimeArrivalActual": bool(arrival.get("realtimeActual")),
        "realtimePassActual": bool(passtime.get("realtimeActual")),
        "realtimeDepartureNoReport": departure.get("realtimeNoReport") is True,
        "realtimeArrivalNoReport": arrival.get("realtimeNoReport") is True,
        "realtimePassNoReport": passtime.get("realtimeNoReport") is True,
        "platform": display_platform,
        "platformConfirmed": bool(
            planned_platform and forecast_platform and planned_platform == forecast_platform
        ),
        "platformChanged": bool(
            planned_platform and forecast_platform and planned_platform != forecast_platform
        ),
    }


def _convert_new_search_to_legacy_shape(data, to_code=None):
    query = data.get("query") or {}
    query_location = query.get("location") or {}
    from_name = query_location.get("description") or ""
    to_name = STATIONS_BY_CRS.get((to_code or "").upper(), "") if to_code else ""
    services = data.get("services") or []
    return {
        "location": {"name": from_name, "description": from_name},
        "filter": {
            "destination": {"name": to_name, "description": to_name},
            "location": {"name": to_name, "description": to_name},
        },
        "services": [_convert_new_location_entry(svc) for svc in services],
    }


def _convert_new_service_to_legacy_shape(data):
    service = data.get("service") or {}
    schedule = service.get("scheduleMetadata") or {}
    locations = service.get("locations") or []
    converted_locations = [_convert_new_service_location(loc) for loc in locations]
    first_class_available = _service_has_facility(service, "first")
    sleeper_available = _service_has_facility(service, "sleeper")
    realtime_activated = any(
        (
            loc.get("realtimeArrival")
            or loc.get("realtimeDeparture")
            or loc.get("realtimePass")
        )
        for loc in converted_locations
    )
    converted = {
        "serviceUid": schedule.get("identity", ""),
        "runDate": schedule.get("departureDate", ""),
        "atocCode": (schedule.get("operator") or {}).get("code", ""),
        "atocName": (schedule.get("operator") or {}).get("name", ""),
        "serviceType": (schedule.get("modeType") or "").lower(),
        "isPassenger": schedule.get("inPassengerService", True),
        "realtimeActivated": realtime_activated,
        "locations": converted_locations,
    }
    if isinstance(first_class_available, bool):
        converted["firstClassAvailable"] = first_class_available
    if isinstance(sleeper_available, bool):
        converted["sleeperAvailable"] = sleeper_available
    return converted


def _parse_iso8601(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def _get_refreshable_access_token():
    global _RTT_ACCESS_TOKEN, _RTT_ACCESS_TOKEN_VALID_UNTIL

    if not RTT_TOKEN:
        raise RuntimeError("RTT_TOKEN not set")

    now = datetime.now(timezone.utc)
    if (
        _RTT_ACCESS_TOKEN
        and _RTT_ACCESS_TOKEN_VALID_UNTIL
        and now < (_RTT_ACCESS_TOKEN_VALID_UNTIL - timedelta(seconds=60))
    ):
        return _RTT_ACCESS_TOKEN

    # Try treating RTT_TOKEN as a refresh token first.
    url = f"{RTT_NEW_BASE}/api/get_access_token"
    try:
        resp = requests.get(
            url,
            headers={"Authorization": f"Bearer {RTT_TOKEN}"},
            timeout=15,
        )
    except requests.Timeout as exc:
        app.logger.warning("RTT timeout for %s", url)
        raise RttTimeoutError() from exc
    except requests.ConnectionError as exc:
        app.logger.error("RTT connection error for %s: %s", url, exc)
        raise RttConnectionError() from exc
    if resp.status_code == 429:
        retry_after = _parse_retry_after(resp.headers.get("Retry-After"))
        app.logger.warning(
            "RTT rate limit for %s (retry_after=%s): %s",
            url,
            retry_after,
            resp.text[:500],
        )
        raise RttRateLimitError(retry_after=retry_after, body=resp.text)

    if resp.status_code == 200:
        payload = resp.json()
        token = payload.get("token")
        valid_until = _parse_iso8601(payload.get("validUntil"))
        if token:
            _RTT_ACCESS_TOKEN = token
            _RTT_ACCESS_TOKEN_VALID_UNTIL = valid_until
            return _RTT_ACCESS_TOKEN

    # If refresh exchange fails, fall back to treating RTT_TOKEN as a direct access token.
    return RTT_TOKEN


def rtt_get_new(path, params=None):
    token = _get_refreshable_access_token()
    url = RTT_NEW_BASE + path
    try:
        resp = requests.get(
            url,
            headers={"Authorization": f"Bearer {token}"},
            params=params,
            timeout=15,
        )
    except requests.Timeout as exc:
        app.logger.warning("RTT timeout for %s", url)
        raise RttTimeoutError() from exc
    except requests.ConnectionError as exc:
        app.logger.error("RTT connection error for %s: %s", url, exc)
        raise RttConnectionError() from exc
    if resp.status_code == 429:
        retry_after = _parse_retry_after(resp.headers.get("Retry-After"))
        app.logger.warning(
            "RTT rate limit for %s (retry_after=%s): %s",
            url,
            retry_after,
            resp.text[:500],
        )
        raise RttRateLimitError(retry_after=retry_after, body=resp.text)
    try:
        resp.raise_for_status()
    except requests.HTTPError as e:
        app.logger.error(
            "RTT new API error %s for %s: %s",
            resp.status_code,
            url,
            resp.text[:500],
        )
        raise RttHttpError(resp.status_code, resp.text) from e
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

    api_mode = RTT_API_MODE

    def fetch_legacy():
        path = f"/json/search/{crs}"
        if to:
            path += f"/to/{to}"
        path += f"/{year}/{month}/{day}"
        return rtt_get(path)

    def fetch_new():
        params = {
            "code": crs.upper(),
            "timeFrom": f"{date}T00:00:00",
            "timeTo": f"{date}T23:59:00",
            "detailed": "true",
        }
        if to:
            params["filterTo"] = to.upper()
        return rtt_get_new("/gb-nr/location", params=params)

    try:
        if api_mode == "new":
            data = fetch_new()
        elif api_mode == "legacy":
            data = fetch_legacy()
        else:
            if _RTT_AUTO_FORCE_NEW_UNTIL_RESTART:
                data = fetch_new()
            elif RTT_USER and RTT_PASS:
                try:
                    data = fetch_legacy()
                except RttHttpError as exc:
                    if not RTT_TOKEN or not _legacy_api_looks_deprecated(exc):
                        raise
                    _pin_auto_mode_to_new("legacy search deprecated")
                    app.logger.info(
                        "Legacy /rtt/search appears deprecated; falling back to new API"
                    )
                    data = fetch_new()
                except (RttTimeoutError, RttConnectionError):
                    if not RTT_TOKEN:
                        raise
                    _pin_auto_mode_to_new("legacy search unavailable")
                    app.logger.info(
                        "Legacy /rtt/search unavailable; falling back to new API"
                    )
                    data = fetch_new()
            else:
                data = fetch_new()
    except RttTimeoutError:
        return jsonify({"error": "timeout"}), 504
    except RttConnectionError:
        return jsonify({"error": "connection"}), 503
    except RttRateLimitError as exc:
        payload = {"error": "rate_limited"}
        headers = {}
        if exc.retry_after is not None:
            payload["retry_after"] = exc.retry_after
            headers["Retry-After"] = str(exc.retry_after)
        return jsonify(payload), 429, headers
    except RttHttpError as exc:
        return jsonify({"error": "upstream", "status": exc.status_code}), 502
    return jsonify(_normalize_search_response(data, to_code=to))

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

    api_mode = RTT_API_MODE

    def fetch_legacy():
        path = f"/json/service/{uid}/{year}/{month}/{day}"
        return rtt_get(path)

    def fetch_new():
        params = {
            "identity": uid,
            "departureDate": date,
            "detailed": "true",
        }
        return rtt_get_new("/gb-nr/service", params=params)

    try:
        if api_mode == "new":
            data = fetch_new()
        elif api_mode == "legacy":
            data = fetch_legacy()
        else:
            if _RTT_AUTO_FORCE_NEW_UNTIL_RESTART:
                data = fetch_new()
            elif RTT_USER and RTT_PASS:
                try:
                    data = fetch_legacy()
                except RttHttpError as exc:
                    if not RTT_TOKEN or not _legacy_api_looks_deprecated(exc):
                        raise
                    _pin_auto_mode_to_new("legacy service deprecated")
                    app.logger.info(
                        "Legacy /rtt/service appears deprecated; falling back to new API"
                    )
                    data = fetch_new()
                except (RttTimeoutError, RttConnectionError):
                    if not RTT_TOKEN:
                        raise
                    _pin_auto_mode_to_new("legacy service unavailable")
                    app.logger.info(
                        "Legacy /rtt/service unavailable; falling back to new API"
                    )
                    data = fetch_new()
            else:
                data = fetch_new()
    except RttTimeoutError:
        return jsonify({"error": "timeout"}), 504
    except RttConnectionError:
        return jsonify({"error": "connection"}), 503
    except RttRateLimitError as exc:
        payload = {"error": "rate_limited"}
        headers = {}
        if exc.retry_after is not None:
            payload["retry_after"] = exc.retry_after
            headers["Retry-After"] = str(exc.retry_after)
        return jsonify(payload), 429, headers
    except RttHttpError as exc:
        return jsonify({"error": "upstream", "status": exc.status_code}), 502
    return jsonify(_normalize_service_response(data))


@app.get("/api/stations")
def api_stations():
    q = request.args.get("q", "").strip()
    if not q:
        return jsonify([])

    qn = norm_station_query(q)
    if not qn:
        return jsonify([])

    def station_match_score(st):
        name_n = st["_name_n"]
        crs_n = st["_crs_n"]
        text_n = st["_n"]

        if crs_n == qn:
            return 0
        if name_n == qn:
            return 1
        if name_n.startswith(qn):
            return 2
        if any(word.startswith(qn) for word in name_n.split()):
            return 3
        if f" {qn}" in name_n:
            return 4
        if qn in name_n:
            return 5
        if crs_n.startswith(qn):
            return 6
        if qn in crs_n:
            return 7
        if qn in text_n:
            return 8
        return None

    matches = []
    for st in STATIONS_N:
        score = station_match_score(st)
        if score is None:
            continue
        matches.append((score, len(st["stationName"]), st["stationName"], st))

    matches.sort(key=lambda item: (item[0], item[1], item[2]))
    return jsonify(
        [
            {"stationName": st["stationName"], "crsCode": st["crsCode"]}
            for _, _, _, st in matches[:20]
        ]
    )


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
