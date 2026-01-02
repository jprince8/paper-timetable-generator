// === Configuration ===
const DEBUG_STATIONS = false; // set true to log station selection / dwell details
// If true: the “must call at >=2 stops” rule is applied *after* hiding stations
// that have no public calls (and iterated to a stable result).
const APPLY_MIN_STOP_FILTER_AFTER_PUBLIC_HIDE = true;

// === Proxy endpoints ===
const PROXY_SEARCH = "/rtt/search";
const PROXY_SERVICE = "/rtt/service";

// === DOM references ===
const form = document.getElementById("form");
const statusEl = document.getElementById("status");
const statusTextEl = document.getElementById("statusText");
const statusBarEl = statusEl ? statusEl.querySelector(".status-bar") : null;
const headingAB = document.getElementById("headingAB");
const headingBA = document.getElementById("headingBA");
const tableCardAB = document.getElementById("table-card-ab");
const tableCardBA = document.getElementById("table-card-ba");
const headerRowAB = document.getElementById("header-row-ab");
const headerIconsRowAB = document.getElementById("header-icons-row-ab");
const bodyRowsAB = document.getElementById("body-rows-ab");
const headerRowBA = document.getElementById("header-row-ba");
const headerIconsRowBA = document.getElementById("header-icons-row-ba");
const bodyRowsBA = document.getElementById("body-rows-ba");
const addViaBtn = document.getElementById("addViaBtn");
const viaScroll = document.getElementById("viaScroll");
const downloadPdfBtn = document.getElementById("downloadPdfBtn");
const shareBtn = document.getElementById("shareBtn");
const cookieBanner = document.getElementById("cookieBanner");
const cookieAcceptBtn = document.getElementById("cookieAcceptBtn");
const nowBtn = document.getElementById("nowBtn");

// === Mutable state ===
const viaInputs = [];

let currentDate = "";
let startMinutes = null;
let endMinutes = null;
let lastPdfPayload = null;

// === Form helpers ===
addViaBtn.addEventListener("click", () => {
  createViaField("");
});

if (cookieAcceptBtn && cookieBanner) {
  const cookieKey = "cookieConsentAccepted";
  const isAccepted = localStorage.getItem(cookieKey) === "true";
  if (!isAccepted) {
    cookieBanner.hidden = false;
  } else {
    cookieBanner.hidden = true;
  }
  cookieAcceptBtn.addEventListener("click", () => {
    localStorage.setItem(cookieKey, "true");
    cookieBanner.hidden = true;
  });
}

if (nowBtn) {
  nowBtn.addEventListener("click", () => {
    const now = new Date();
    const start = new Date(now);
    const end = new Date(now);
    start.setHours(now.getHours() - 1);
    end.setHours(now.getHours() + 2);

    document.getElementById("serviceDate").value = formatDateInput(now);
    document.getElementById("startTime").value = formatTimeInput(start);
    document.getElementById("endTime").value = formatTimeInput(end);
  });
}

function createViaField(initialValue = "") {
  const label = document.createElement("label");

  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = 3;
  input.required = false;
  input.value = initialValue;
  input.style.marginRight = "0.25rem";

  // Small "×" button to remove this via
  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.textContent = "×";
  removeBtn.title = "Remove this via";
  removeBtn.style.marginLeft = "0.25rem";

  removeBtn.addEventListener("click", () => {
    // Remove from DOM
    label.remove();
    // Remove from tracking array
    const idx = viaInputs.indexOf(input);
    if (idx !== -1) {
      viaInputs.splice(idx, 1);
    }
  });

  label.appendChild(input);
  label.appendChild(removeBtn);

  // Insert the new Via label before the Add Via button so vias scroll horizontally.
  if (viaScroll && addViaBtn) {
    viaScroll.insertBefore(label, addViaBtn);
  } else {
    form.insertBefore(label, addViaBtn);
  }

  viaInputs.push(input);
}

function clearViaFields() {
  viaInputs.forEach((input) => {
    input.closest("label")?.remove();
  });
  viaInputs.length = 0;
}

// === Cookie helpers ===
function setCookie(name, value, days) {
  const d = new Date();
  d.setTime(d.getTime() + days * 24 * 60 * 60 * 1000);
  const expires = "expires=" + d.toUTCString();
  document.cookie =
    name +
    "=" +
    encodeURIComponent(value) +
    ";" +
    expires +
    ";path=/;SameSite=Lax";
}

function getCookie(name) {
  const decoded = decodeURIComponent(document.cookie || "");
  const parts = decoded.split(";");
  const prefix = name + "=";
  for (let c of parts) {
    c = c.trim();
    if (c.indexOf(prefix) === 0) {
      return c.substring(prefix.length);
    }
  }
  return "";
}

function loadSavedInputsFromCookies() {
  const from = getCookie("corridor_fromCrs");
  const to = getCookie("corridor_toCrs");
  const date = getCookie("corridor_serviceDate");
  const start = getCookie("corridor_startTime");
  const end = getCookie("corridor_endTime");
  const viasStr = getCookie("corridor_vias");

  if (from) document.getElementById("fromCrs").value = from;
  if (to) document.getElementById("toCrs").value = to;
  if (date) document.getElementById("serviceDate").value = date;
  if (start) document.getElementById("startTime").value = start;
  if (end) document.getElementById("endTime").value = end;

  // Default to NO vias on first run.
  // On subsequent runs, recreate one via field per saved CRS.
  if (viasStr) {
    viasStr
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v)
      .forEach((v) => createViaField(v));
  }
}

// Run once when the script loads
loadSavedInputsFromCookies();

function loadInputsFromQuery() {
  const params = new URLSearchParams(window.location.search);
  if (params.size === 0) return false;

  const from = normaliseCrs(params.get("from"));
  const to = normaliseCrs(params.get("to"));
  const date = params.get("date");
  const start = padTime(params.get("start"));
  const end = padTime(params.get("end"));
  const viasRaw = params.get("vias");

  if (from) document.getElementById("fromCrs").value = from;
  if (to) document.getElementById("toCrs").value = to;
  if (date) document.getElementById("serviceDate").value = date;
  if (start) document.getElementById("startTime").value = start;
  if (end) document.getElementById("endTime").value = end;

  if (viasRaw !== null) {
    clearViaFields();
    viasRaw
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v)
      .forEach((v) => createViaField(normaliseCrs(v)));
  }

  return Boolean(from && to && date && start && end);
}

const shouldAutoSubmit = loadInputsFromQuery();
if (shouldAutoSubmit) {
  setTimeout(() => {
    form.requestSubmit();
  }, 0);
}

// === Formatting utilities ===
function formatDateInput(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatTimeInput(date) {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function htmlEscape(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normaliseCrs(v) {
  return (v || "").trim().toUpperCase();
}

function padTime(str) {
  if (!str) return "";
  const s = String(str);
  if (s.length === 4) {
    return s.slice(0, 2) + ":" + s.slice(2);
  } else if (s.length === 6) {
    return s.slice(0, 2) + ":" + s.slice(2, 4);
  }
  return s;
}

function timeStrToMinutes(hhmm) {
  if (!hhmm) return null;
  const parts = hhmm.split(":");
  if (parts.length !== 2) return null;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function rttTimeToMinutes(hhmm) {
  if (!hhmm) return null;
  const s = String(hhmm);
  if (s.length !== 4) return null;
  const h = parseInt(s.slice(0, 2), 10);
  const m = parseInt(s.slice(2), 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function serviceInTimeRange(locationDetail) {
  if (!locationDetail) return false;
  const tStr =
    locationDetail.gbttBookedDeparture ||
    locationDetail.gbttBookedArrival ||
    locationDetail.realtimeDeparture ||
    locationDetail.realtimeArrival ||
    "";
  const mins = rttTimeToMinutes(tStr);
  if (mins === null) return false;
  return mins >= startMinutes && mins <= endMinutes;
}

function serviceAtStationInRange(service) {
  const ld = service.locationDetail || {};
  return serviceInTimeRange(ld);
}

function safePairText(pairs) {
  if (!Array.isArray(pairs) || !pairs[0]) return "";
  const p = pairs[0];
  const name = p.description || "";
  const time = p.publicTime ? padTime(p.publicTime) : "";
  return name + (time ? " " + time : "");
}

// === Status helpers ===
function showStatus() {
  if (!statusEl) return;
  statusEl.hidden = false;
}

function hideStatus() {
  if (!statusEl) return;
  statusEl.hidden = true;
  statusEl.classList.remove("is-error");
  if (statusTextEl) statusTextEl.textContent = "";
  if (statusBarEl) statusBarEl.style.width = "0%";
}

function setStatus(msg, options = {}) {
  if (!statusEl || !statusTextEl) return;
  const { isError = false, progress = null } = options;
  if (!msg) {
    hideStatus();
    return;
  }
  showStatus();
  statusTextEl.textContent = msg;
  statusEl.classList.toggle("is-error", isError);
  if (statusBarEl) {
    statusBarEl.style.width =
      typeof progress === "number" ? `${progress}%` : "0%";
  }
}

function setProgressStatus(label, completed, total) {
  const percent = total > 0 ? Math.round((completed / total) * 100) : 100;
  setStatus(`${label}`, { progress: percent });
}

function resetOutputs() {
  hideStatus();
  headingAB.textContent = "";
  headingBA.textContent = "";
  tableCardAB?.classList.remove("has-data");
  tableCardBA?.classList.remove("has-data");
  headerRowAB.innerHTML = "";
  headerIconsRowAB.innerHTML = "";
  bodyRowsAB.innerHTML = "";
  headerRowBA.innerHTML = "";
  headerIconsRowBA.innerHTML = "";
  bodyRowsBA.innerHTML = "";
  downloadPdfBtn.disabled = true;
  shareBtn.disabled = true;
  lastPdfPayload = null;
}

function stripHtmlToText(value) {
  if (!value) return "";
  if (!String(value).includes("<")) return String(value);
  const wrapper = document.createElement("div");
  wrapper.innerHTML = value;
  return wrapper.textContent || "";
}

function rowLabelText(row) {
  if (row.labelStation && row.labelArrDep) {
    return `${row.labelStation} (${row.labelArrDep})`;
  }
  if (row.labelStation) return row.labelStation;
  if (!row.labelStation && row.labelArrDep) return `(${row.labelArrDep})`;
  return "";
}

function extractFirstTime(value) {
  if (!value) return "";
  const match = String(value).match(/\b\d{2}:\d{2}\b/);
  return match ? match[0] : "";
}

function buildPdfTableData(model) {
  const { rows, orderedSvcIndices, servicesMeta } = model;
  const headers = [
    "Operator",
    ...orderedSvcIndices.map((svcIndex) => servicesMeta[svcIndex].visible),
  ];
  const facilitiesRow = [
    "Facilities",
    ...orderedSvcIndices.map((svcIndex) => {
      const meta = servicesMeta[svcIndex];
      const icons = [];
      if (meta.firstClassAvailable) icons.push("FC");
      if (meta.isSleeper) icons.push("SL");
      if (meta.isBus) icons.push("BUS");
      return icons.join(" ");
    }),
  ];
  const tableRows = rows.map((row) => {
    const label = rowLabelText(row);
    const cells = orderedSvcIndices.map((svcIndex) =>
      stripHtmlToText(row.cells[svcIndex]),
    );
    return [label, ...cells];
  });
  const serviceTimes = orderedSvcIndices.map((svcIndex) => {
    for (const row of rows) {
      const value = stripHtmlToText(row.cells[svcIndex]);
      const time = extractFirstTime(value);
      if (time) return time;
    }
    return "";
  });
  return { headers, rows: [facilitiesRow, ...tableRows], serviceTimes };
}

function findStationNameByCrs(stations, crs) {
  const match = stations.find((st) => st.crs === crs);
  return match ? match.name : crs;
}

function formatDateDisplay(dateStr) {
  if (!dateStr || !dateStr.includes("-")) return dateStr;
  const [year, month, day] = dateStr.split("-");
  if (!year || !month || !day) return dateStr;
  return `${day}/${month}/${year}`;
}

function formatGeneratedTimestamp(dateObj = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(dateObj);
  const lookup = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${lookup.day}/${lookup.month}/${lookup.year} ${lookup.hour}:${lookup.minute}`;
}

downloadPdfBtn.addEventListener("click", async () => {
  if (!lastPdfPayload) return;
  downloadPdfBtn.disabled = true;
  setStatus("Building PDF...");

  try {
    const resp = await fetch("/timetable/pdf", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(lastPdfPayload),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(text || "PDF build failed");
    }

    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "timetable.pdf";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setStatus("");
  } catch (err) {
    setStatus("Error building PDF: " + err.message, { isError: true });
  } finally {
    downloadPdfBtn.disabled = false;
  }
});

function buildShareUrl() {
  const url = new URL(window.location.href);
  const from = normaliseCrs(document.getElementById("fromCrs").value);
  const to = normaliseCrs(document.getElementById("toCrs").value);
  const date = document.getElementById("serviceDate").value;
  const start = document.getElementById("startTime").value;
  const end = document.getElementById("endTime").value;
  const viaValues = viaInputs
    .map((input) => normaliseCrs(input.value))
    .filter((v) => v);

  url.searchParams.set("from", from);
  url.searchParams.set("to", to);
  url.searchParams.set("date", date);
  url.searchParams.set("start", start);
  url.searchParams.set("end", end);
  if (viaValues.length > 0) {
    url.searchParams.set("vias", viaValues.join(","));
  } else {
    url.searchParams.delete("vias");
  }

  return url.toString();
}

async function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const tempInput = document.createElement("input");
  tempInput.value = text;
  document.body.appendChild(tempInput);
  tempInput.select();
  tempInput.setSelectionRange(0, text.length);
  document.execCommand("copy");
  tempInput.remove();
}

shareBtn.addEventListener("click", async () => {
  if (shareBtn.disabled) return;
  const url = buildShareUrl();
  try {
    await copyToClipboard(url);
    setStatus("Share link copied to clipboard.");
  } catch (err) {
    setStatus("Unable to copy share link.", { isError: true });
  }
});

// === Main form submit ===
form.addEventListener("submit", async (e) => {
  e.preventDefault();

  // Run HTML5 validation for "required" fields, min/max, etc.
  if (!form.reportValidity()) {
    return;
  }

  resetOutputs();

  const from = normaliseCrs(document.getElementById("fromCrs").value);
  const to = normaliseCrs(document.getElementById("toCrs").value);
  const dateInput = document.getElementById("serviceDate").value;
  const startInput = document.getElementById("startTime").value;
  const endInput = document.getElementById("endTime").value;

  // Collect via CRS values (non-empty only)
  const viaValues = viaInputs
    .map((input) => normaliseCrs(input.value))
    .filter((v) => v);

  // Persist current form values + vias for next visit
  setCookie("corridor_fromCrs", from, 365);
  setCookie("corridor_toCrs", to, 365);
  setCookie("corridor_serviceDate", dateInput, 365);
  setCookie("corridor_startTime", startInput, 365);
  setCookie("corridor_endTime", endInput, 365);
  setCookie("corridor_vias", viaValues.join(","), 365);

  currentDate = dateInput;
  startMinutes = timeStrToMinutes(startInput);
  endMinutes = timeStrToMinutes(endInput);

  if (!from || !to) {
    setStatus("Please enter both From and To CRS codes.", { isError: true });
    return;
  }
  if (startMinutes === null || endMinutes === null) {
    setStatus("Please enter a valid time range.", { isError: true });
    return;
  }

  // Full corridor chain including vias
  const corridorStations = [from, ...viaValues, to];

  // Legs: A->B, B->C, ..., for each adjacent pair in the corridor chain
  const corridorLegs = [];
  for (let i = 0; i < corridorStations.length - 1; i++) {
    corridorLegs.push({
      from: corridorStations[i],
      to: corridorStations[i + 1],
    });
  }

  // Step 1: fetch all corridor services across all legs, deduplicated by serviceUid|runDate
  const corridorServicesMap = new Map();
  const stationNameByCrs = {};
  let noServicesLeg = null;
  let invalidInputsDetected = false;

  try {
    const searchPromises = corridorLegs.map(async (leg) => {
      const url =
        PROXY_SEARCH +
        "?crs=" +
        encodeURIComponent(leg.from) +
        "&to=" +
        encodeURIComponent(leg.to) +
        "&date=" +
        encodeURIComponent(currentDate);
      const resp = await fetch(url, {
        headers: { Accept: "application/json" },
      });
      const text = await resp.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        console.warn(
          "Failed to parse corridor search JSON for leg",
          leg,
          e,
          text,
        );
        return;
      }
      if (data && data.error === "unknown error occurred") {
        invalidInputsDetected = true;
        return;
      }
      const fromNameCandidate =
        data.location?.name || data.location?.description || null;
      if (fromNameCandidate) {
        stationNameByCrs[leg.from] = fromNameCandidate;
      }
      const toNameCandidate =
        data.filter?.destination?.name ||
        data.filter?.destination?.description ||
        data.filter?.location?.name ||
        data.filter?.location?.description ||
        null;
      if (toNameCandidate) {
        stationNameByCrs[leg.to] = toNameCandidate;
      }
      const services = Array.isArray(data.services) ? data.services : [];
      const eligibleServices = services.filter((svc) => {
        if (svc.isPassenger === false) return;
        if (svc.plannedCancel) return;
        if (!serviceAtStationInRange(svc)) return;
        return true;
      });
      if (eligibleServices.length === 0 && !noServicesLeg) {
        const fromName = stationNameByCrs[leg.from] || leg.from;
        const toName = stationNameByCrs[leg.to] || leg.to;
        noServicesLeg = {
          from: leg.from,
          to: leg.to,
          fromName,
          toName,
        };
      }
      eligibleServices.forEach((svc) => {
        const key = (svc.serviceUid || "") + "|" + (svc.runDate || "");
        if (!corridorServicesMap.has(key)) {
          corridorServicesMap.set(key, svc);
        }
      });
    });

    await Promise.all(searchPromises);
  } catch (err) {
    setStatus("Error fetching initial service search results: " + err, {
      isError: true,
    });
    return;
  }

  if (invalidInputsDetected) {
    setStatus("Invalid inputs.", { isError: true });
    return;
  }

  if (noServicesLeg) {
    setStatus(
      "No passenger services in this time range between " +
        noServicesLeg.fromName +
        " and " +
        noServicesLeg.toName +
        ".",
      { isError: true },
    );
    return;
  }

  const corridorServices = Array.from(corridorServicesMap.values());

  if (corridorServices.length === 0) {
    const fromLabel = stationNameByCrs[from] || from;
    const toLabel = stationNameByCrs[to] || to;
    setStatus(
      "No passenger services in this time range between " +
        fromLabel +
        " and " +
        toLabel +
        ".",
      { isError: true },
    );
    return;
  }

  // Step 2: Get full details for corridor services to derive station union.
  const corridorDetailPromises = corridorServices.map(async (svc) => {
    const uid = svc.serviceUid;
    const date = svc.runDate;
    const url =
      PROXY_SERVICE +
      "?uid=" +
      encodeURIComponent(uid) +
      "&date=" +
      encodeURIComponent(date);
    const resp = await fetch(url, {
      headers: { Accept: "application/json" },
    });
    const text = await resp.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      console.warn(
        "Failed to parse corridor service JSON for",
        uid,
        e,
        text,
      );
      data = null;
    }
    return {
      svc,
      detail: data,
      status: resp.status,
      statusText: resp.statusText,
      seed: true,
    };
  });

  let corridorDetails;
  try {
    corridorDetails = await Promise.all(corridorDetailPromises);
  } catch (err) {
    setStatus("Error fetching service details: " + err, { isError: true });
    return;
  }

  const okCorridorDetails = corridorDetails.filter(
    (d) => d.detail && Array.isArray(d.detail.locations),
  );
  if (okCorridorDetails.length === 0) {
    setStatus("No usable service detail responses.");
    return;
  }

  // Build station union from all corridor services, over the multi-via chain,
  // ignoring PASS / CANCELLED_PASS.
  const stations = buildStationsUnion(
    corridorStations,
    okCorridorDetails,
  );
  if (stations.length === 0) {
    setStatus(
      "No stations found between " +
        from +
        " and " +
        to +
        (viaValues.length ? " (via " + viaValues.join(", ") + ")" : "") +
        ".",
    );
    return;
  }
  const stationSet = {};
  stations.forEach((s) => {
    if (s.crs) stationSet[s.crs] = true;
  });

  setProgressStatus("Finding services...", 0, stations.length);

  // Build a candidate map of all services seen at any corridor station.
  const candidateMap = new Map(); // key -> { svc, detail, seed }

  function serviceKey(svc) {
    return (svc.serviceUid || "") + "|" + (svc.runDate || "");
  }

  // Seed with corridor services + their details.
  okCorridorDetails.forEach((entry) => {
    const key = serviceKey(entry.svc);
    candidateMap.set(key, {
      svc: entry.svc,
      detail: entry.detail,
      seed: true,
    });
  });

  // For each corridor station, search all services at that station (for the same date),
  // and filter by time range at that station.
  let stationsCompleted = 0;
  const stationSearchPromises = stations.map(async (st) => {
    try {
      const url =
        PROXY_SEARCH +
        "?crs=" +
        encodeURIComponent(st.crs) +
        "&date=" +
        encodeURIComponent(currentDate);
      const resp = await fetch(url, {
        headers: { Accept: "application/json" },
      });
      const text = await resp.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        console.warn(
          "Failed to parse search for station",
          st.crs,
          e,
          text,
        );
        return;
      }
      const services = Array.isArray(data.services) ? data.services : [];
      services.forEach((svc) => {
        if (svc.isPassenger === false) return;
        if (svc.plannedCancel) return;
        if (!serviceAtStationInRange(svc)) return;
        const key = serviceKey(svc);
        if (!key) return;
        if (!candidateMap.has(key)) {
          candidateMap.set(key, { svc: svc, detail: null, seed: false });
        }
      });
    } finally {
      stationsCompleted += 1;
      setProgressStatus(
        "Finding services...",
        stationsCompleted,
        stations.length,
      );
    }
  });

  try {
    await Promise.all(stationSearchPromises);
  } catch (err) {
    console.warn("Error during station searches:", err);
  }

  // Fetch details for candidates that don't already have them.
  const totalCandidateServices = candidateMap.size;
  let completedDetailServices = 0;
  const detailFetchPromises = [];
  for (const [key, entry] of candidateMap.entries()) {
    if (entry.detail) {
      completedDetailServices += 1;
      continue; // already have
    }
    const uid = entry.svc.serviceUid;
    const date = entry.svc.runDate;
    if (!uid || !date) continue;
    const url =
      PROXY_SERVICE +
      "?uid=" +
      encodeURIComponent(uid) +
      "&date=" +
      encodeURIComponent(date);
    const p = fetch(url, { headers: { Accept: "application/json" } })
      .then((resp) =>
        resp.text().then((text) => {
          let data = null;
          try {
            data = JSON.parse(text);
          } catch (e) {
            console.warn(
              "Failed to parse candidate service JSON for",
              uid,
              e,
              text,
            );
          }
          entry.detail = data;
        }),
      )
      .catch((err) => {
        console.warn(
          "Error fetching candidate service detail for",
          uid,
          err,
        );
      })
      .finally(() => {
        completedDetailServices += 1;
        setProgressStatus(
          "Gathering service details...",
          completedDetailServices,
          totalCandidateServices,
        );
      });
    detailFetchPromises.push(p);
  }

  if (totalCandidateServices > 0) {
    setProgressStatus(
      "Gathering service details...",
      completedDetailServices,
      totalCandidateServices,
    );
  }

  try {
    await Promise.all(detailFetchPromises);
  } catch (err) {
    console.warn("Error during candidate detail fetch:", err);
  }

  setStatus("Building timetable...");

  // Filter to services that:
  //  - have valid detail.locations
  //  - and call at >= 2 *distinct* non-PASS corridor stations.
  // This removes loops like CTR→CTR that only ever touch one station in the table.
  const allDetails = [];
  for (const [key, entry] of candidateMap.entries()) {
    const detail = entry.detail;
    if (!detail || !Array.isArray(detail.locations)) continue;

    const locs = detail.locations;
    const seenStations = new Set();

    for (const l of locs) {
      const crs = l.crs || "";
      if (!stationSet[crs]) continue;

      const disp = (l.displayAs || "").toUpperCase();
      if (disp === "PASS" || disp === "CANCELLED_PASS") continue; // only calling points

      seenStations.add(crs);
      if (seenStations.size >= 2) break;
    }

    if (seenStations.size >= 2) {
      allDetails.push(entry);
    }
  }

  if (allDetails.length === 0) {
    setStatus(
      "No services found that call at two or more selected stations in this time range.",
    );
    return;
  }

  // Split into A->B vs B->A, based on order of corridor stations in the calling pattern.
  const split = splitByDirection(allDetails, stations);
  const servicesAB = split.ab;
  const servicesBA = split.ba;

  // Build A -> B table (stations in forward order)
  const pdfTables = [];
  const fromName = findStationNameByCrs(stations, from);
  const toName = findStationNameByCrs(stations, to);
  const viaNames = viaValues.map((crs) => findStationNameByCrs(stations, crs));
  const viaNamesForward = viaNames.filter(Boolean);
  const forwardStopsLabel = [fromName, ...viaNamesForward, toName]
    .filter(Boolean)
    .join(" → ");
  const reverseStopsLabel = [
    toName,
    ...viaNamesForward.slice().reverse(),
    fromName,
  ]
    .filter(Boolean)
    .join(" → ");
  const corridorLabel = [fromName, ...viaNamesForward, toName].join(" ↔ ");
  const dateLabel = formatDateDisplay(currentDate);
  if (servicesAB.length > 0) {
    const modelAB = buildTimetableModel(stations, stationSet, servicesAB);
    headingAB.textContent =
      forwardStopsLabel +
      " (" +
      modelAB.orderedSvcIndices.length +
      " services)";
    renderTimetable(modelAB, headerRowAB, headerIconsRowAB, bodyRowsAB);
    const tableDataAB = buildPdfTableData(modelAB);
    pdfTables.push({
      title: `${fromName} → ${toName}`,
      dateLabel,
      serviceTimes: tableDataAB.serviceTimes,
      ...tableDataAB,
    });
    tableCardAB?.classList.add("has-data");
  } else {
    headingAB.textContent =
      forwardStopsLabel + ": no through services in this time range";
  }

  // Build B -> A table (stations in reverse order)
  if (servicesBA.length > 0) {
    const stationsRev = stations.slice().reverse();
    const modelBA = buildTimetableModel(
      stationsRev,
      stationSet,
      servicesBA,
    );
    headingBA.textContent =
      reverseStopsLabel +
      " (" +
      modelBA.orderedSvcIndices.length +
      " services)";
    renderTimetable(modelBA, headerRowBA, headerIconsRowBA, bodyRowsBA);
    const tableDataBA = buildPdfTableData(modelBA);
    pdfTables.push({
      title: `${toName} → ${fromName}`,
      dateLabel,
      serviceTimes: tableDataBA.serviceTimes,
      ...tableDataBA,
    });
    tableCardBA?.classList.add("has-data");
  } else {
    headingBA.textContent =
      reverseStopsLabel + ": no through services in this time range";
  }

  if (pdfTables.length > 0) {
    const title = corridorLabel || `${fromName} ↔ ${toName}`;
    const subtitle = `Generated on ${formatGeneratedTimestamp()}`;
    lastPdfPayload = {
      meta: {
        title,
        subtitle,
      },
      tables: pdfTables,
    };
    downloadPdfBtn.disabled = false;
    shareBtn.disabled = false;
  }
  hideStatus();
});

// Build station union over a possibly multi-via corridor.
// corridorStations is e.g. ["SHR", "VIA1", "VIA2", "WRX"].
function buildStationsUnion(corridorStations, servicesWithDetails) {
  const stationMap = {};
  const corridorIndex = {};

  // Map each corridor CRS to its index in the chain (A=0, VIA1=1, ..., Z=n)
  corridorStations.forEach((crs, idx) => {
    if (crs) corridorIndex[crs] = idx;
  });

  function addStation(crs, tiploc, name, pos) {
    if (!crs) return;
    const key = crs;
    if (!stationMap[key]) {
      stationMap[key] = {
        crs,
        tiploc: tiploc || "",
        name: name || crs,
        positions: [],
      };
    }
    stationMap[key].positions.push(pos);
  }

  servicesWithDetails.forEach(({ detail }) => {
    const locs = detail.locations || [];
    if (!locs.length) return;

    // All corridor hits for this service: list of { i, corridorIdx }
    const hits = [];
    for (let i = 0; i < locs.length; i++) {
      const crs = locs[i].crs || "";
      if (
        crs &&
        Object.prototype.hasOwnProperty.call(corridorIndex, crs)
      ) {
        hits.push({ i, corridorIdx: corridorIndex[crs] });
      }
    }
    if (hits.length === 0) return;

    // For each adjacent pair of corridor hits, walk the segment between them
    for (let h = 0; h < hits.length - 1; h++) {
      const { i: i1, corridorIdx: c1 } = hits[h];
      const { i: i2, corridorIdx: c2 } = hits[h + 1];
      if (i1 === i2) continue;

      const step = i1 < i2 ? 1 : -1;
      const span = Math.abs(i2 - i1);

      for (let i = i1; step > 0 ? i <= i2 : i >= i2; i += step) {
        const l = locs[i];
        if (!l) continue;
        const disp = (l.displayAs || "").toUpperCase();
        if (disp === "PASS" || disp === "CANCELLED_PASS") continue; // only calling points

        const crs = l.crs || "";
        if (!crs) continue;
        const tiploc = l.tiploc || "";
        const name = l.description || crs || tiploc;

        let pos;
        if (Object.prototype.hasOwnProperty.call(corridorIndex, crs)) {
          // Corridor station itself -> exact integer corridor index
          pos = corridorIndex[crs];
        } else {
          // Off-corridor station: interpolate between the two corridor stations
          const offset = Math.abs(i - i1);
          const frac = span === 0 ? 0 : offset / span;
          pos = c1 + (c2 - c1) * frac; // fractional position between corridor indices
        }

        addStation(crs, tiploc, name, pos);
      }
    }
  });

  const stations = Object.values(stationMap);
  stations.forEach((s) => {
    const sum = s.positions.reduce((a, b) => a + b, 0);
    s.avgPos = sum / s.positions.length;
  });
  stations.sort((a, b) => a.avgPos - b.avgPos);
  return stations;
}

function splitByDirection(servicesWithDetails, stations) {
  const ab = [];
  const ba = [];

  // Map CRS to corridor order index (0..N-1) based on stations array
  const crsToOrderIdx = {};
  stations.forEach((s, i) => {
    if (s.crs) crsToOrderIdx[s.crs] = i;
  });

  servicesWithDetails.forEach((entry) => {
    const locs = entry.detail.locations || [];
    const corridorOrderIndices = [];

    // Collect the corridor order indices for every corridor station this service calls at
    for (const l of locs) {
      const crs = l.crs || "";
      if (crs in crsToOrderIdx) {
        corridorOrderIndices.push(crsToOrderIdx[crs]);
      }
    }

    if (corridorOrderIndices.length < 2) {
      // Shouldn't normally happen because we already required >=2 corridor calls,
      // but if it does, just treat it as A→B by default so it appears somewhere.
      ab.push(entry);
      return;
    }

    const first = corridorOrderIndices[0];
    const last = corridorOrderIndices[corridorOrderIndices.length - 1];

    if (first <= last) {
      ab.push(entry);
    } else {
      ba.push(entry);
    }
  });

  return { ab, ba };
}

function checkMonotonicTimes(rows, orderedSvcIndices) {
  orderedSvcIndices.forEach((svcIndex) => {
    let dayOffset = 0; // minutes added for midnight rollovers
    let prevAbs = null; // previous absolute time in minutes

    for (let r = 0; r < rows.length; r++) {
      const val = rows[r].cells[svcIndex];

      if (!val) continue;
      if (typeof val === "string" && val.startsWith("<i")) continue; // skip from/to italics

      const mins = timeStrToMinutes(val); // "HH:MM" -> 0..1439
      if (mins === null) continue;

      let base = mins + dayOffset;

      // If this appears to go backwards, treat it as a midnight rollover
      if (prevAbs !== null && base < prevAbs) {
        // allow multiple midnights in pathological cases (up to a few days)
        let safety = 0;
        while (base <= prevAbs && safety < 5) {
          dayOffset += 1440;
          base = mins + dayOffset;
          safety++;
        }
      }

      // If it's STILL going backwards, assert-fail in console
      if (prevAbs !== null && base < prevAbs) {
        console.assert(
          false,
          "Time order assertion failed for service column",
          {
            svcIndex,
            rowIndex: r,
            previousAbsoluteMinutes: prevAbs,
            currentAbsoluteMinutes: base,
            currentCellValue: val,
          },
        );
        break; // stop checking this service; we've already flagged it
      }

      prevAbs = base;
    }
  });
}

  function buildTimetableModel(stations, stationSet, servicesWithDetails) {
    // --- Helper: decide which stations get rows (only those with at least one PUBLIC call) ---
    function computeDisplayStations(stationsList, svcs) {
      return stationsList.filter((station) => {
        return svcs.some(({ detail }) => {
          const locs = detail.locations || [];
          return locs.some((locEntry) => {
            if ((locEntry.crs || "") !== station.crs) return false;
            const disp = (locEntry.displayAs || "").toUpperCase();
            const isPublic = locEntry.isPublicCall === true;
            if (disp === "PASS" || disp === "CANCELLED_PASS") return false;
            return isPublic;
          });
        });
      });
    }

    // --- Helper: does a service call at >=2 *distinct* stations from a given set? ---
    function serviceCallsAtLeastTwoInSet(detail, crsSet) {
      const locs = detail.locations || [];
      const seen = new Set();

      for (const l of locs) {
        const crs = l.crs || "";
        if (!crsSet.has(crs)) continue;

        const disp = (l.displayAs || "").toUpperCase();
        if (disp === "PASS" || disp === "CANCELLED_PASS") continue;

        seen.add(crs);
        if (seen.size >= 2) return true;
      }
      return false;
    }

    // Optionally apply the >=2-stops filter AFTER public-station hiding (iterated to stability)
    let workingServices = servicesWithDetails.slice();
    let displayStations = [];

    if (APPLY_MIN_STOP_FILTER_AFTER_PUBLIC_HIDE) {
      let prevKey = "";
      for (let iter = 0; iter < 5; iter++) {
        displayStations = computeDisplayStations(stations, workingServices);
        const displaySet = new Set(displayStations.map((s) => s.crs).filter(Boolean));

        // Filter services based on what would actually be visible (post-hide)
        const filtered = workingServices.filter(({ detail }) =>
          serviceCallsAtLeastTwoInSet(detail, displaySet),
        );

        const key =
          displayStations.map((s) => s.crs).join(",") + "|" + filtered.length;

        if (key === prevKey) {
          workingServices = filtered;
          break; // stable
        }
        prevKey = key;
        workingServices = filtered;
      }
    } else {
      // Original behaviour: hide stations using all incoming services (no extra filtering here)
      displayStations = computeDisplayStations(stations, workingServices);
    }

    // From here on, use workingServices everywhere
    servicesWithDetails = workingServices;

    const numServices = servicesWithDetails.length;

    // (keep your existing DEBUG_STATIONS logging, but use displayStations computed above)
    if (DEBUG_STATIONS) {
      const hidden = stations
        .filter((st) => !displayStations.includes(st))
        .map((st) => ({ crs: st.crs, name: st.name }));
      console.log(
        "Display stations:",
        displayStations.map((s) => s.crs + " " + s.name),
      );
      console.log(
        "Hidden stations (no public calls in any included service):",
        hidden,
      );
    }

    const numStations = displayStations.length;

  // --- Precompute per-station, per-service arrival/departure times ---
  // stationTimes[stationIndex][svcIndex] = { arrStr, arrMins, depStr, depMins }
  const stationTimes = [];
  for (let i = 0; i < numStations; i++) {
    const row = [];
    for (let s = 0; s < numServices; s++) {
      row.push({ arrStr: "", arrMins: null, depStr: "", depMins: null });
    }
    stationTimes.push(row);
  }

  servicesWithDetails.forEach(({ detail }, svcIndex) => {
    const locs = detail.locations || [];

    displayStations.forEach((station, stationIndex) => {
      const loc = locs.find(
        (locEntry) => (locEntry.crs || "") === station.crs,
      );
      if (!loc) return;

      const rawArr = loc.gbttBookedArrival || loc.realtimeArrival || "";
      const rawDep =
        loc.gbttBookedDeparture || loc.realtimeDeparture || "";

      const arrStr = rawArr ? padTime(rawArr) : "";
      const depStr = rawDep ? padTime(rawDep) : "";

      const arrMins = arrStr ? timeStrToMinutes(arrStr) : null;
      const depMins = depStr ? timeStrToMinutes(depStr) : null;

      stationTimes[stationIndex][svcIndex] = {
        arrStr,
        arrMins,
        depStr,
        depMins,
      };
    });
  });

  // --- Decide row mode per station (merged vs two rows vs single) ---
  const stationModes = [];

  for (let i = 0; i < numStations; i++) {
    const times = stationTimes[i];

    let hasArr = false;
    let hasDep = false;
    let hasAny = false;

    let hasLongDwell = false;
    const dwellDebugEntries = [];

    for (let s = 0; s < numServices; s++) {
      const t = times[s];
      if (!t) continue;

      const svc = servicesWithDetails[s].svc;
      const trainId =
        svc.trainIdentity ||
        svc.runningIdentity ||
        svc.serviceUid ||
        "svc#" + s;

      if (t.arrMins !== null) {
        hasArr = true;
        hasAny = true;
      }
      if (t.depMins !== null) {
        hasDep = true;
        hasAny = true;
      }

      if (t.arrMins !== null && t.depMins !== null) {
        const dwellMinutes = Math.abs(t.depMins - t.arrMins);

        if (dwellMinutes > 2) {
          hasLongDwell = true;
        }

        if (DEBUG_STATIONS) {
          dwellDebugEntries.push({
            svcIndex: s,
            trainId,
            arrTimeStr: t.arrStr,
            depTimeStr: t.depStr,
            arrMins: t.arrMins,
            depMins: t.depMins,
            dwellMinutes,
          });
        }
      } else if (
        DEBUG_STATIONS &&
        (t.arrMins !== null || t.depMins !== null)
      ) {
        dwellDebugEntries.push({
          svcIndex: s,
          trainId,
          arrTimeStr: t.arrStr,
          depTimeStr: t.depStr,
          arrMins: t.arrMins,
          depMins: t.depMins,
          dwellMinutes: null,
        });
      }
    }

    let mode;
    if (hasArr && hasDep) {
      if (hasLongDwell) {
        mode = "two";

        if (DEBUG_STATIONS) {
          const station = displayStations[i];
          const offenders = dwellDebugEntries.filter(
            (e) => e.dwellMinutes !== null && e.dwellMinutes > 2,
          );

          console.groupCollapsed(
            "[DWELL] Station not merged:",
            station.crs,
            station.name,
            "— at least one service has dwell > 2 mins",
          );
          console.log(
            "All services' arr/dep at this station:",
            dwellDebugEntries,
          );
          console.log("Offending services (dwell > 2 mins):", offenders);
          console.groupEnd();
        }
      } else {
        mode = "merged";

        if (DEBUG_STATIONS) {
          const station = displayStations[i];
          console.groupCollapsed(
            "[DWELL] Station merged:",
            station.crs,
            station.name,
            "— all dwells <= 2 mins",
          );
          console.log(
            "All services' arr/dep at this station:",
            dwellDebugEntries,
          );
          console.groupEnd();
        }
      }
    } else if (hasAny) {
      mode = "single";

      if (DEBUG_STATIONS) {
        const station = displayStations[i];
        console.groupCollapsed(
          "[DWELL] Station single-row (only arr OR only dep overall):",
          station.crs,
          station.name,
        );
        console.log(
          "All services' arr/dep at this station:",
          dwellDebugEntries,
        );
        console.groupEnd();
      }
    } else {
      mode = "single";
    }

    stationModes[i] = mode;
  }

  // --- Compute origin/destination meta for services that start/end outside the corridor ---
  // We store:
  //  - display: CRS only
  //  - title: full name only (no "from/to")
  const originMeta = new Array(numServices).fill(null);
  const destMeta = new Array(numServices).fill(null);

  servicesWithDetails.forEach(({ detail }, idx) => {
    const locs = detail.locations || [];
    if (locs.length === 0) return;

    const firstLoc = locs[0];
    const lastLoc = locs[locs.length - 1];

    if (firstLoc) {
      const crs = firstLoc.crs || "";
      if (!stationSet[crs]) {
        const name = firstLoc.description || crs || firstLoc.tiploc || "";
        const crsCode = crs || firstLoc.tiploc || name;
        originMeta[idx] = { display: crsCode, title: name };
      }
    }

    if (lastLoc) {
      const crs = lastLoc.crs || "";
      if (!stationSet[crs]) {
        const name = lastLoc.description || crs || lastLoc.tiploc || "";
        const crsCode = crs || lastLoc.tiploc || name;
        destMeta[idx] = { display: crsCode, title: name };
      }
    }
  });

  // Dedicated extra rows:
  // - Top row: "Comes from" (only if any originMeta exists in this direction)
  // - Bottom row: "Continues to" (only if any destMeta exists in this direction)
  const needTopExtra = originMeta.some((m) => !!m);
  const needBottomExtra = destMeta.some((m) => !!m);

  // --- Helper: build rowSpecs, optionally with top/bottom extra rows ---
  function makeRowSpecs(includeTopExtra, includeBottomExtra) {
    const specs = [];
    if (includeTopExtra) {
      specs.push({
        kind: "extra",
        mode: "comes-from",
        label: "Comes from",
        stationIndex: null,
        arrDepLabel: "",
      });
    }

    for (let i = 0; i < numStations; i++) {
      const mode = stationModes[i];
      if (mode === "two") {
        specs.push({
          kind: "station",
          stationIndex: i,
          mode: "arr",
          arrDepLabel: "arr",
        });
        specs.push({
          kind: "station",
          stationIndex: i,
          mode: "dep",
          arrDepLabel: "dep",
        });
      } else {
        specs.push({
          kind: "station",
          stationIndex: i,
          mode: mode,
          arrDepLabel: "",
        });
      }
    }

    if (includeBottomExtra) {
      specs.push({
        kind: "extra",
        mode: "continues-to",
        label: "Continues to",
        stationIndex: null,
        arrDepLabel: "",
      });
    }

    return specs;
  }

  // --- Helper: init rows + labels for a given rowSpecs ---
  function makeRowsForSpecs(specs) {
    const rows = specs.map((spec) => ({
      kind: spec.kind, // "station" / "extra"
      mode: spec.mode, // "arr"/"dep"/"merged"/"single"/"comes-from"/"continues-to"
      labelStation: "",
      labelArrDep: "",
      cells: new Array(numServices).fill(""),
    }));

    // Label station name only on first row for that station
    let lastStationIndexForLabel = null;
    for (let r = 0; r < specs.length; r++) {
      const spec = specs[r];

      if (spec.kind === "extra") {
        rows[r].labelStation = spec.label || "";
        continue;
      }

      if (spec.kind === "station") {
        const stationIndex = spec.stationIndex;
        const station = displayStations[stationIndex];

        if (stationIndex !== lastStationIndexForLabel) {
          rows[r].labelStation = station.name;
          lastStationIndexForLabel = stationIndex;
        }

        rows[r].labelArrDep = spec.arrDepLabel;
      }
    }

    return rows;
  }

  // --- Helper: fill times + return first/last timing row per service ---
  function fillTimesIntoRows(specs, rows) {
    const firstRowForService = new Array(numServices).fill(null);
    const lastRowForService = new Array(numServices).fill(null);

    for (let r = 0; r < specs.length; r++) {
      const spec = specs[r];
      if (spec.kind !== "station") continue;

      const stationIndex = spec.stationIndex;
      const mode = spec.mode;

      for (let s = 0; s < numServices; s++) {
        const t = stationTimes[stationIndex][s];
        if (!t) continue;

        let timeStr = "";
        if (mode === "arr") {
          timeStr = t.arrStr;
        } else if (mode === "dep") {
          timeStr = t.depStr;
        } else if (mode === "merged" || mode === "single") {
          timeStr = t.depStr || t.arrStr;
        }

        if (timeStr) {
          rows[r].cells[s] = timeStr;
          if (firstRowForService[s] === null || r < firstRowForService[s])
            firstRowForService[s] = r;
          if (lastRowForService[s] === null || r > lastRowForService[s])
            lastRowForService[s] = r;
        }
      }
    }

    return { firstRowForService, lastRowForService };
  }

  // --- Build rows with only the extra rows we need (per direction) ---
  let rowSpecs = makeRowSpecs(needTopExtra, needBottomExtra);
  let rows = makeRowsForSpecs(rowSpecs);
  let { firstRowForService, lastRowForService } = fillTimesIntoRows(
    rowSpecs,
    rows,
  );

  const totalRows = rowSpecs.length;

  // --- Put origin/destination CRS into the dedicated extra rows (top/bottom) ---
  const topExtraRowIdx = needTopExtra ? 0 : null;
  const bottomExtraRowIdx = needBottomExtra ? totalRows - 1 : null;

  servicesWithDetails.forEach((entry, svcIndex) => {
    const fromInfo = originMeta[svcIndex];
    const toInfo = destMeta[svcIndex];

    if (fromInfo && topExtraRowIdx !== null) {
      if (!rows[topExtraRowIdx].cells[svcIndex]) {
        rows[topExtraRowIdx].cells[svcIndex] =
          `<i title="${htmlEscape(fromInfo.title)}">${htmlEscape(fromInfo.display)}</i>`;
      }
    }

    if (toInfo && bottomExtraRowIdx !== null) {
      if (!rows[bottomExtraRowIdx].cells[svcIndex]) {
        rows[bottomExtraRowIdx].cells[svcIndex] =
          `<i title="${htmlEscape(toInfo.title)}">${htmlEscape(toInfo.display)}</i>`;
      }
    }
  });

  // === Add "|" markers for skipped stations (only BETWEEN first & last called station) ===
  // We do this per *station group* (so we don't wrongly mark empty arr/dep partner rows as "skipped").
  const stationRowGroups = Array.from({ length: numStations }, () => []);
  for (let r = 0; r < rowSpecs.length; r++) {
    const spec = rowSpecs[r];
    if (spec.kind === "station") {
      stationRowGroups[spec.stationIndex].push(r);
    }
  }

  for (let s = 0; s < numServices; s++) {
    const called = new Array(numStations).fill(false);

    // A station is "called" if ANY row in its group has a real time string for this service.
    for (let stIdx = 0; stIdx < numStations; stIdx++) {
      const groupRows = stationRowGroups[stIdx];
      for (const r of groupRows) {
        const v = rows[r].cells[s];
        if (!v) continue;
        if (typeof v === "string" && v.startsWith("<i")) continue; // ignore Comes/Continues rows if ever present
        called[stIdx] = true;
        break;
      }
    }

    const firstCalled = called.indexOf(true);
    if (firstCalled === -1) continue;
    let lastCalled = -1;
    for (let stIdx = numStations - 1; stIdx >= 0; stIdx--) {
      if (called[stIdx]) {
        lastCalled = stIdx;
        break;
      }
    }
    if (lastCalled <= firstCalled) continue; // need at least two calls to have an "in between"

    // For stations strictly between first/last called, mark empty cells with "|"
    for (let stIdx = firstCalled + 1; stIdx <= lastCalled - 1; stIdx++) {
      if (called[stIdx]) continue; // not skipped
      for (const r of stationRowGroups[stIdx]) {
        if (rows[r].cells[s] === "") {
          rows[r].cells[s] = "|";
        }
      }
    }
  }

  // === Column ordering ===
  // We insert services row-by-row based on firstRowForService.
  // When inserting a service that starts on a given row, we compare it against
  // existing columns using the *time on that same row*, with this preference:
  //   - use departure time if available
  //   - otherwise use arrival time
  //
  // (If a service has no time on that row at all, it sorts last for that row.)
  function preferredTimeMinsAtRow(serviceIdx, rowIdx) {
    const spec = rowSpecs[rowIdx];
    if (!spec || spec.kind !== "station") return null;

    const stationIndex = spec.stationIndex;
    const t = stationTimes[stationIndex][serviceIdx];
    if (!t) return null;

    // Prefer dep; otherwise arr (even on "arr" rows).
    const timeStr = t.depStr && t.depStr.trim() ? t.depStr : t.arrStr;
    if (!timeStr) return null;

    const mins = timeStrToMinutes(timeStr);
    return mins === null ? null : mins;
  }

  const orderedSvcIndices = [];

  for (let r = 0; r < totalRows; r++) {
    // Services whose first corridor timing row is exactly this row.
    const startingHere = [];
    for (let s = 0; s < numServices; s++) {
      if (firstRowForService[s] === r) {
        startingHere.push({
          index: s,
          timeMins: preferredTimeMinsAtRow(s, r),
        });
      }
    }

    // Sort those by preferred row-time (nulls last, then by original index)
    startingHere.sort((a, b) => {
      if (a.timeMins === null && b.timeMins === null)
        return a.index - b.index;
      if (a.timeMins === null) return 1;
      if (b.timeMins === null) return -1;
      if (a.timeMins !== b.timeMins) return a.timeMins - b.timeMins;
      return a.index - b.index;
    });

    // Insert into orderedSvcIndices relative to existing services, comparing
    // against the existing services' preferred time on *this same row*.
    for (const { index: sIdx, timeMins } of startingHere) {
      if (orderedSvcIndices.length === 0 || timeMins === null) {
        orderedSvcIndices.push(sIdx);
        continue;
      }

      let inserted = false;
      for (let pos = 0; pos < orderedSvcIndices.length; pos++) {
        const existingIdx = orderedSvcIndices[pos];
        const existingTime = preferredTimeMinsAtRow(existingIdx, r);
        if (existingTime === null) continue; // can't compare at this row

        if (timeMins <= existingTime) {
          orderedSvcIndices.splice(pos, 0, sIdx);
          inserted = true;
          break;
        }
      }

      if (!inserted) orderedSvcIndices.push(sIdx);
    }
  }

  // --- ATOC code -> display name override (updated LUT) ---
  const ATOC_NAME_BY_CODE = {
    LM: "WMT",
    LF: "LWC",
    CC: "C2C",
    LE: "GA",
    SW: "SWR",
    XR: "EL",
    CS: "CS",
    TP: "TPE",
    SR: "SR",
    LD: "LEC",
    SE: "SE",
    GM: "TfGM",
    AW: "TfW",
    NT: "N",
    GR: "LNER",
    IL: "IL",
    LO: "LO",
    SN: "S",
    GX: "GEx",
    GN: "GN",
    TL: "TL",
    ES: "E",
    EM: "EMR",
    VT: "AWC",
    XC: "XC",
    GC: "GC",
    GW: "GWR",
    NY: "NYMR",
    ME: "M",
    HT: "HT",
    HX: "HEx",
    WR: "WCR",
    CH: "CR",
    ZZ: "Other",
  }

  // --- Service header metadata (for renderer) ---
  const servicesMeta = servicesWithDetails.map(({ svc, detail }) => {
    const originText = safePairText(detail.origin);
    const destText = safePairText(detail.destination);
    const dateText = detail.runDate || svc.runDate || "";
    const uid = svc.serviceUid || "";
    const date = svc.runDate || detail.runDate || "";
    const href = `https://www.realtimetrains.co.uk/service/gb-nr:${encodeURIComponent(uid)}/${encodeURIComponent(date)}`;

    const headcode =
      svc.trainIdentity || svc.runningIdentity || svc.serviceUid || "";

    const opCode = svc.atocCode || detail.atocCode || "";
    const opName = svc.atocName || detail.atocName || opCode;

    const visible = ATOC_NAME_BY_CODE[opCode] || opCode || headcode || "?";

    const line1Parts = [];
    if (opName) line1Parts.push(opName);
    if (headcode) line1Parts.push(headcode);
    if (dateText) line1Parts.push(dateText);
    const line1 = line1Parts.join(" • ");

    let line2 = "";
    if (originText || destText) {
      line2 = `${originText} → ${destText}`;
    }

    const tooltip =
      line2 && line1 ? `${line1}\n${line2}` : line1 || line2 || visible;

    // === class/sleeper extraction ===
    const tc = (detail.trainClass || "").trim();
    const passenger =
      detail.isPassenger === true || svc.isPassenger !== false;
    const firstClassAvailable =
      passenger && (tc === "" ? true : tc !== "S");

    const sl = (detail.sleepers || "").trim();
    const isSleeper = sl !== "";

    const serviceType = (detail.serviceType || svc.serviceType || "").trim();
    const isBus = serviceType.toLowerCase() === "bus";

    return {
      visible,
      tooltip,
      href,
      firstClassAvailable,
      isSleeper,
      isBus,
    };
  });

  // Assert (in console) that times in each service column never decrease
  // as you go down the table, allowing for midnight rollovers.
  checkMonotonicTimes(rows, orderedSvcIndices);

  return {
    rows,
    orderedSvcIndices,
    servicesMeta,
  };
}

// === Rendering: turn model into DOM ===
function renderTimetable(
  model,
  headerRowEl,
  headerIconsRowEl,
  bodyRowsEl,
) {
  const { rows, orderedSvcIndices, servicesMeta } = model;

  headerRowEl.innerHTML = "";
  headerIconsRowEl.innerHTML = "";
  bodyRowsEl.innerHTML = "";

  // --- Build headers row (existing) ---
  const thStation = document.createElement("th");
  thStation.classList.add("sticky-top", "sticky-left", "corner");
  thStation.textContent = "Operator";
  headerRowEl.appendChild(thStation);

  orderedSvcIndices.forEach((svcIndex) => {
    const meta = servicesMeta[svcIndex];
    const th = document.createElement("th");
    th.classList.add("sticky-top");

    const tooltipEsc = htmlEscape(meta.tooltip);
    const visibleEsc = htmlEscape(meta.visible);
    const href = meta.href || "";

    if (href) {
      th.innerHTML = `
  <a class="service-header"
     href="${href}"
     target="_blank"
     rel="noopener noreferrer"
     title="${tooltipEsc}">${visibleEsc}</a>
`;
    } else {
      th.innerHTML = `<span class="service-header" title="${tooltipEsc}">${visibleEsc}</span>`;
    }

    headerRowEl.appendChild(th);
  });

  // --- Build icons row ---
  const thStationIcons = document.createElement("th");
  thStationIcons.classList.add("sticky-left", "icon-row");
  thStationIcons.textContent = "Facilities"; // blank under "Station"
  headerIconsRowEl.appendChild(thStationIcons);

  function bedSvg() {
    // simple inline SVG bed icon (currentColor stroke/fill)
    return `
<span class="bed-icon" title="Sleeper" aria-label="Sleeper">
  <svg viewBox="0 0 24 24" role="img" focusable="false" aria-hidden="true">
    <!-- headboard + left leg (single stroke) -->
    <path d="M4 6v14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>

    <!-- mattress -->
    <path d="M4 12h16a2 2 0 0 1 2 2v4H4z"
    fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>

    <!-- pillow (simple) -->
    <path d="M7 10h4a2 2 0 0 1 2 2H7a2 2 0 0 1-2-2a2 2 0 0 1 2-2z"
    fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>

    <!-- right leg at end of mattress -->
    <path d="M20 20v-2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  </svg>
</span>

    `;
  }

  function busSvg() {
    return `
<span class="bus-icon" title="Bus service" aria-label="Bus service">
  <svg viewBox="0 0 24 24" role="img" focusable="false" aria-hidden="true">
    <rect x="3.5" y="4" width="17" height="16" rx="2" ry="2" fill="none" stroke="currentColor" stroke-width="2"/>
    <path d="M7 6h10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    <rect x="7" y="7.5" width="10" height="6.5" rx="1" ry="1" fill="none" stroke="currentColor" stroke-width="1.8"/>
    <circle cx="8.5" cy="16.5" r="1" fill="currentColor"/>
    <circle cx="15.5" cy="16.5" r="1" fill="currentColor"/>
  </svg>
</span>
    `;
  }

  orderedSvcIndices.forEach((svcIndex) => {
    const meta = servicesMeta[svcIndex];

    const th = document.createElement("th");
    th.classList.add("icon-row");

    const icons = [];
    if (meta.firstClassAvailable) {
      icons.push(
        `<span class="fc-icon" title="First class available" aria-label="First class available">1</span>`,
      );
    }
    if (meta.isSleeper) {
      icons.push(bedSvg());
    }
    if (meta.isBus) {
      icons.push(busSvg());
    }

    th.innerHTML = icons.length
      ? `<span class="icon-wrap">${icons.join("")}</span>`
      : "";
    headerIconsRowEl.appendChild(th);
  });

  // --- Render body rows (unchanged) ---
  rows.forEach((row, rowIdx) => {
    const tr = document.createElement("tr");

    if (rowIdx === 0) tr.classList.add("row-sep-top");
    if (row.kind === "station" && row.labelArrDep === "dep")
      tr.classList.add("row-sep-top");

    const prevRow = rowIdx > 0 ? rows[rowIdx - 1] : null;
    if (prevRow) {
      const boundaryExtraToStation =
        prevRow.kind === "extra" && row.kind === "station";
      const boundaryStationToExtra =
        prevRow.kind === "station" && row.kind === "extra";
      if (boundaryExtraToStation || boundaryStationToExtra) {
        tr.classList.add("row-sep-top");
      }
    }

    let labelText = "";
    if (row.labelStation && row.labelArrDep)
      labelText = row.labelStation + " (" + row.labelArrDep + ")";
    else if (row.labelStation) labelText = row.labelStation;
    else if (!row.labelStation && row.labelArrDep)
      labelText = "(" + row.labelArrDep + ")";

    const labelTd = document.createElement("td");
    labelTd.classList.add("sticky-left", "station-row-label");
    labelTd.textContent = labelText;
    tr.appendChild(labelTd);

    orderedSvcIndices.forEach((svcIndex) => {
      const val = row.cells[svcIndex];
      const td = document.createElement("td");
      if (val && val.startsWith("<i")) {
        td.innerHTML = val;
      } else {
        td.textContent = val;
        if (!val) td.classList.add("time-empty");
      }
      tr.appendChild(td);
    });

    bodyRowsEl.appendChild(tr);
  });
}
