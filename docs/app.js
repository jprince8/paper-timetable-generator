// === Configuration ===
// URL query flags:
// - debug_stations=1/true enables station selection/dwell logging
// - sort_log=1/true enables sort log downloads
// - rtt_cache=1/true enables local RTT caching
function hasEnabledQueryFlag(flag) {
  const params = new URLSearchParams(window.location.search);
  if (!params.has(flag)) return false;
  const raw = params.get(flag);
  return raw === "" || raw === "1" || raw === "true";
}

const DEBUG_STATIONS = hasEnabledQueryFlag("debug_stations");
const ENABLE_SORT_LOG_DOWNLOAD = hasEnabledQueryFlag("sort_log");
const RTT_CACHE_ENABLED = hasEnabledQueryFlag("rtt_cache");

const ENABLED_OPTIONS = [
  DEBUG_STATIONS ? "debug_stations" : null,
  ENABLE_SORT_LOG_DOWNLOAD ? "sort_log" : null,
  RTT_CACHE_ENABLED ? "rtt_cache" : null,
].filter(Boolean);

if (ENABLED_OPTIONS.length > 0) {
  console.info(`Enabled options: ${ENABLED_OPTIONS.join(", ")}`);
}
// Apply the “must call at >=2 stops” rule *after* hiding stations
// that have no public calls (and iterate to a stable result).

// === Proxy endpoints ===
const BACKEND_BASE = (window.BACKEND_BASE || "").trim();
const PROXY_SEARCH = `${BACKEND_BASE}/rtt/search`;
const PROXY_SERVICE = `${BACKEND_BASE}/rtt/service`;
const PROXY_PDF = `${BACKEND_BASE}/timetable/pdf`; // if you call this from JS
const PROXY_STATION = `${BACKEND_BASE}/api/stations`; // if you call this from JS
const PROXY_ATOC = `${BACKEND_BASE}/api/atoc-codes`;
const PROXY_CONNECTIONS = `${BACKEND_BASE}/api/connections`;

const STATION_DEBOUNCE_MS = 180;
const STATION_MIN_QUERY = 2;
const ALWAYS_SORT_CANCELLED_TIMES = true;

const RTT_CACHE_PREFIX = "rttCache:";
let rttCacheEnabled = RTT_CACHE_ENABLED;
const rttMemoryCache = new Map();

function getRttCacheKey(url) {
  return `${RTT_CACHE_PREFIX}${url}`;
}

function normaliseRttCachePayload(payload) {
  return {
    text: payload?.text || "",
    status: payload?.status || 200,
    statusText: payload?.statusText || "OK",
    storedAt: payload?.storedAt || Date.now(),
  };
}

function listRttCacheEntries() {
  const entries = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(RTT_CACHE_PREFIX)) continue;
    let storedAt = 0;
    const raw = localStorage.getItem(key);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        storedAt = parsed?.storedAt || 0;
      } catch {
        storedAt = 0;
      }
    }
    entries.push({ key, storedAt });
  }
  return entries;
}

function readRttCache(url) {
  const memoryCached = rttMemoryCache.get(url);
  if (memoryCached) {
    return {
      text: memoryCached.text,
      status: memoryCached.status,
      statusText: memoryCached.statusText,
    };
  }
  if (!rttCacheEnabled || !window.localStorage) return null;
  try {
    const raw = localStorage.getItem(getRttCacheKey(url));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.text !== "string") return null;
    return {
      text: parsed.text,
      status: parsed.status || 200,
      statusText: parsed.statusText || "OK",
    };
  } catch (err) {
    console.warn("Failed to read RTT cache for", url, err);
    return null;
  }
}

function writeRttCache(url, payload) {
  const normalised = normaliseRttCachePayload(payload);
  if (!rttCacheEnabled || !window.localStorage) {
    rttMemoryCache.set(url, normalised);
    return;
  }
  try {
    localStorage.setItem(getRttCacheKey(url), JSON.stringify(normalised));
  } catch (err) {
    const isQuotaError =
      err?.name === "QuotaExceededError" ||
      err?.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
      err?.code === 22;
    if (isQuotaError) {
      try {
        const entries = listRttCacheEntries().sort(
          (a, b) => a.storedAt - b.storedAt,
        );
        for (const entry of entries) {
          localStorage.removeItem(entry.key);
          try {
            localStorage.setItem(
              getRttCacheKey(url),
              JSON.stringify(normalised),
            );
            return;
          } catch (retryErr) {
            if (
              retryErr?.name !== "QuotaExceededError" &&
              retryErr?.name !== "NS_ERROR_DOM_QUOTA_REACHED" &&
              retryErr?.code !== 22
            ) {
              throw retryErr;
            }
          }
        }
      } catch (retryErr) {
        rttCacheEnabled = false;
        rttMemoryCache.set(url, normalised);
        console.warn(
          "RTT cache disabled after quota errors while writing",
          url,
          retryErr,
        );
        return;
      }
      rttCacheEnabled = false;
      rttMemoryCache.set(url, normalised);
      console.warn("RTT cache disabled after repeated quota errors", url);
      return;
    }
    rttMemoryCache.set(url, normalised);
    console.warn("Failed to write RTT cache for", url, err);
  }
}

// === DOM references ===
const form = document.getElementById("form");
const statusEl = document.getElementById("status");
const statusTextEl = document.getElementById("statusText");
const statusBarEl = statusEl ? statusEl.querySelector(".status-bar") : null;
const headingAB = document.getElementById("headingAB");
const headingBA = document.getElementById("headingBA");
const tableCardAB = document.getElementById("table-card-ab");
const tableCardBA = document.getElementById("table-card-ba");
const keyAB = document.getElementById("key-ab");
const keyBA = document.getElementById("key-ba");
const crsKeyAB = document.getElementById("crs-key-ab");
const crsKeyBA = document.getElementById("crs-key-ba");
const headerRowAB = document.getElementById("header-row-ab");
const headerIconsRowAB = document.getElementById("header-icons-row-ab");
const bodyRowsAB = document.getElementById("body-rows-ab");
const headerRowBA = document.getElementById("header-row-ba");
const headerIconsRowBA = document.getElementById("header-icons-row-ba");
const bodyRowsBA = document.getElementById("body-rows-ba");
const addViaBtn = document.getElementById("addViaBtn");
const viaScroll = document.getElementById("viaScroll");
const fromStationInput = document.getElementById("fromStation");
const fromCrsInput = document.getElementById("fromCrs");
const fromSuggestBox = document.getElementById("fromSuggest");
const toStationInput = document.getElementById("toStation");
const toCrsInput = document.getElementById("toCrs");
const toSuggestBox = document.getElementById("toSuggest");
const buildBtn = document.getElementById("buildBtn");
const downloadPdfBtn = document.getElementById("downloadPdfBtn");
const shareBtn = document.getElementById("shareBtn");
const realtimeBtn = document.getElementById("realtimeBtn");
const platformBtn = document.getElementById("platformBtn");
const nowBtn = document.getElementById("nowBtn");
const PLATFORM_TOGGLE_STORAGE_KEY = "corridor_showPlatforms";
const REALTIME_TOGGLE_STORAGE_KEY = "corridor_showRealtime";

// === Mutable state ===
const viaFields = [];
const stationFields = [];

let currentDate = "";
let startMinutes = null;
let endMinutes = null;
let lastPdfPayload = null;
let lastTimetableContext = null;
let lastSortLog = "";
let realtimeEnabled = false;
let realtimeAvailable = false;
let realtimePreferred = false;
let showPlatformsEnabled = false;
let showPlatformsPreferred = false;
let platformAvailable = false;
let buildAbortController = null;
let buildInProgress = false;
let buildCancelled = false;
let suppressNextSubmit = false;
let atocNameByCode = {};
let connectionsByStation = {};
let lookupLoadPromise = null;

function resolveInputStationLabel(crs, inputValue, fallback) {
  const trimmed = (inputValue || "").trim();
  if (trimmed) return trimmed;
  return fallback || crs || "";
}

function normaliseConnectionList(value) {
  if (!value) return null;
  if (Array.isArray(value)) {
    return value.map((crs) => normaliseCrs(crs)).filter(Boolean);
  }
  const crs = normaliseCrs(value);
  return crs ? [crs] : null;
}

function normaliseConnectionData(raw) {
  if (!raw || typeof raw !== "object") return {};
  const normalised = {};
  Object.entries(raw).forEach(([crs, entries]) => {
    const stationCrs = normaliseCrs(crs);
    if (!stationCrs) return;
    if (!Array.isArray(entries)) return;
    normalised[stationCrs] = entries
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const connections = entry.connections || {};
        const cleanedConnections = {};
        Object.entries(connections).forEach(([dest, meta]) => {
          const destCrs = normaliseCrs(dest);
          if (!destCrs || !meta || typeof meta !== "object") return;
          const durationRaw = meta.durationMinutes ?? meta.duration ?? null;
          let durationMinutes = null;
          if (typeof durationRaw === "number") {
            durationMinutes = durationRaw;
          } else if (typeof durationRaw === "string") {
            const match = durationRaw.match(/\d+/);
            durationMinutes = match ? Number(match[0]) : null;
          }
          if (!durationMinutes || Number.isNaN(durationMinutes)) return;
          cleanedConnections[destCrs] = {
            durationMinutes,
            mode: meta.mode || "",
          };
        });
        if (Object.keys(cleanedConnections).length === 0) return null;
        return {
          previousStations: normaliseConnectionList(entry.previousStations),
          connections: cleanedConnections,
        };
      })
      .filter(Boolean);
  });
  return normalised;
}

function loadLookupData(fetcher = fetch) {
  if (lookupLoadPromise) return lookupLoadPromise;
  lookupLoadPromise = Promise.all([
    fetcher(PROXY_ATOC).then((resp) =>
      resp.ok ? resp.json() : Promise.resolve({}),
    ),
    fetcher(PROXY_CONNECTIONS).then((resp) =>
      resp.ok ? resp.json() : Promise.resolve({}),
    ),
  ])
    .then(([atocData, connectionsData]) => {
      atocNameByCode = atocData || {};
      connectionsByStation = normaliseConnectionData(connectionsData);
    })
    .catch((err) => {
      console.warn("Failed to load lookup data:", err);
      atocNameByCode = {};
      connectionsByStation = {};
    });
  return lookupLoadPromise;
}

function getConnectionEntriesForStation(crs) {
  return connectionsByStation[crs] || [];
}

function hasConnectionBetweenStations(from, to) {
  if (!from || !to) return false;
  const entries = getConnectionEntriesForStation(from);
  return entries.some((entry) => entry.connections?.[to]);
}

function minutesToRttTime(mins) {
  const time = minutesToTimeStr(mins);
  return time.replace(":", "");
}

function setBuildInProgress(active) {
  buildInProgress = active;
  if (!buildBtn) return;
  if (active) {
    buildBtn.textContent = "Cancel Build";
    buildBtn.classList.remove("btn-primary");
    buildBtn.classList.add("btn-secondary");
    buildBtn.type = "button";
    buildBtn.setAttribute("aria-busy", "true");
  } else {
    buildBtn.textContent = "Build Timetable";
    buildBtn.classList.add("btn-primary");
    buildBtn.classList.remove("btn-secondary");
    buildBtn.type = "submit";
    buildBtn.removeAttribute("aria-busy");
  }
}

if (buildBtn) {
  buildBtn.addEventListener("click", (event) => {
    if (!buildInProgress || !buildAbortController) return;
    event.preventDefault();
    event.stopPropagation();
    suppressNextSubmit = true;
    setTimeout(() => {
      suppressNextSubmit = false;
    }, 0);
    buildCancelled = true;
    buildAbortController.abort();
    setBuildInProgress(false);
    hideStatus();
  });
}

// === Form helpers ===
addViaBtn.addEventListener("click", () => {
  createViaField({ crs: "", required: true });
});

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

function setRealtimeToggleState({ enabled, active }, { persist = false } = {}) {
  realtimeAvailable = enabled;
  realtimePreferred = Boolean(active);
  realtimeEnabled = enabled && realtimePreferred;
  if (!realtimeBtn) return;
  realtimeBtn.disabled = !enabled;
  realtimeBtn.classList.toggle("is-active", realtimeEnabled);
  realtimeBtn.setAttribute("aria-pressed", realtimeEnabled ? "true" : "false");
  if (persist && window.localStorage) {
    localStorage.setItem(
      REALTIME_TOGGLE_STORAGE_KEY,
      realtimePreferred ? "true" : "false",
    );
  }
}

if (realtimeBtn) {
  realtimeBtn.addEventListener("click", () => {
    if (realtimeBtn.disabled) return;
    const nextPreferred = !realtimePreferred;
    setRealtimeToggleState(
      {
        enabled: realtimeAvailable,
        active: nextPreferred,
      },
      { persist: true },
    );
    if (lastTimetableContext) {
      renderTimetablesFromContext(lastTimetableContext);
    }
  });
}

function setPlatformToggleState(active, { persist = true } = {}) {
  showPlatformsPreferred = Boolean(active);
  showPlatformsEnabled = platformAvailable && showPlatformsPreferred;
  if (platformBtn) {
    platformBtn.classList.toggle("is-active", showPlatformsEnabled);
    platformBtn.setAttribute(
      "aria-pressed",
      showPlatformsEnabled ? "true" : "false",
    );
  }
  if (persist && window.localStorage) {
    localStorage.setItem(
      PLATFORM_TOGGLE_STORAGE_KEY,
      showPlatformsPreferred ? "true" : "false",
    );
  }
}

function setPlatformToggleAvailability(enabled) {
  platformAvailable = Boolean(enabled);
  if (platformBtn) {
    platformBtn.disabled = !platformAvailable;
    showPlatformsEnabled = platformAvailable && showPlatformsPreferred;
    platformBtn.classList.toggle("is-active", showPlatformsEnabled);
    platformBtn.setAttribute(
      "aria-pressed",
      showPlatformsEnabled ? "true" : "false",
    );
  }
}

if (platformBtn) {
  platformBtn.addEventListener("click", () => {
    if (platformBtn.disabled) return;
    setPlatformToggleState(!showPlatformsEnabled);
    if (lastTimetableContext) {
      renderTimetablesFromContext(lastTimetableContext);
    }
  });
}

async function fetchStationMatches(query) {
  if (!query || query.length < STATION_MIN_QUERY) {
    return [];
  }
  const resp = await fetch(
    `${PROXY_STATION}?q=${encodeURIComponent(query)}`,
  );
  if (!resp.ok) {
    return [];
  }
  return resp.json();
}

function updateStationValidity(field) {
  const textValue = field.textInput.value.trim();
  if (!textValue) {
    field.textInput.setCustomValidity("");
    return;
  }
  if (document.activeElement === field.textInput) {
    field.textInput.setCustomValidity("");
    return;
  }
  if (!field.crsInput.value) {
    field.textInput.setCustomValidity("Select a station from the list.");
    return;
  }
  field.textInput.setCustomValidity("");
}

function setupStationPicker(field) {
  const { textInput, crsInput, suggestBox } = field;
  let debounceTimer = null;
  let results = [];
  let activeIndex = -1;
  let isOpen = false;
  let scrollListenerAttached = false;

  if (suggestBox.parentElement !== document.body) {
    document.body.appendChild(suggestBox);
  }

  function clearSuggestions() {
    suggestBox.innerHTML = "";
    suggestBox.style.display = "none";
    activeIndex = -1;
    results = [];
    isOpen = false;
    if (scrollListenerAttached) {
      window.removeEventListener("scroll", positionSuggestBox, true);
      window.removeEventListener("resize", positionSuggestBox);
      scrollListenerAttached = false;
    }
  }

  function positionSuggestBox() {
    const rect = textInput.getBoundingClientRect();
    const left = Math.round(rect.left + window.scrollX);
    const top = Math.round(rect.bottom + window.scrollY + 6);
    suggestBox.style.left = `${left}px`;
    suggestBox.style.top = `${top}px`;
    suggestBox.style.minWidth = `${Math.round(rect.width)}px`;
  }

  function ensurePositioning() {
    if (!scrollListenerAttached) {
      window.addEventListener("scroll", positionSuggestBox, true);
      window.addEventListener("resize", positionSuggestBox);
      scrollListenerAttached = true;
    }
    positionSuggestBox();
  }

  function setActiveIndex(index) {
    activeIndex = index;
    const items = Array.from(
      suggestBox.querySelectorAll(".station-suggest-item"),
    );
    items.forEach((item, idx) => {
      item.classList.toggle("is-active", idx === activeIndex);
      item.setAttribute("aria-selected", idx === activeIndex ? "true" : "false");
    });
  }

  function selectResult(result) {
    textInput.value = result.stationName;
    crsInput.value = result.crsCode;
    textInput.setCustomValidity("");
    clearSuggestions();
  }

  async function resolveExactMatch(query) {
    if (!query || query.length < STATION_MIN_QUERY) {
      return null;
    }
    const matches = results.length ? results : await fetchStationMatches(query);
    return findExactMatch(query, matches);
  }

  function findExactMatch(query, list) {
    const normalized = query.trim().toLowerCase();
    return (
      list.find(
        (item) =>
          item.stationName.toLowerCase() === normalized ||
          item.crsCode.toLowerCase() === normalized,
      ) || null
    );
  }

  function renderSuggestions(list) {
    suggestBox.innerHTML = "";
    list.forEach((result, index) => {
      const option = document.createElement("div");
      option.className = "station-suggest-item";
      option.textContent = result.stationName;
      option.setAttribute("role", "option");
      option.addEventListener("mousedown", (event) => {
        event.preventDefault();
        selectResult(result);
      });
      if (index === activeIndex) {
        option.classList.add("is-active");
        option.setAttribute("aria-selected", "true");
      }
      suggestBox.appendChild(option);
    });
    ensurePositioning();
    isOpen = true;
    suggestBox.style.display = list.length ? "block" : "none";
  }

  textInput.addEventListener("input", () => {
    crsInput.value = "";
    updateStationValidity(field);
    const q = textInput.value.trim();
    clearTimeout(debounceTimer);
    if (q.length < STATION_MIN_QUERY) {
      clearSuggestions();
      return;
    }
    debounceTimer = setTimeout(async () => {
      const matches = await fetchStationMatches(q);
      if (textInput.value.trim() !== q) {
        return;
      }
      results = matches;
      activeIndex = -1;
      renderSuggestions(results);
    }, STATION_DEBOUNCE_MS);
  });

  textInput.addEventListener("keydown", (event) => {
    if (!results.length || suggestBox.style.display !== "block") {
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const nextIndex = Math.min(activeIndex + 1, results.length - 1);
      setActiveIndex(nextIndex);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      const nextIndex = Math.max(activeIndex - 1, 0);
      setActiveIndex(nextIndex);
    } else if (event.key === "Enter" && activeIndex >= 0) {
      event.preventDefault();
      selectResult(results[activeIndex]);
    } else if (event.key === "Enter") {
      const exactMatch = findExactMatch(textInput.value, results);
      if (exactMatch) {
        event.preventDefault();
        selectResult(exactMatch);
      }
    } else if (event.key === "Escape") {
      clearSuggestions();
    }
  });

  textInput.addEventListener("blur", async () => {
    if (!crsInput.value) {
      const exactMatch = await resolveExactMatch(textInput.value);
      if (exactMatch) {
        selectResult(exactMatch);
      }
    }
    updateStationValidity(field);
    setTimeout(clearSuggestions, 120);
  });

  field.resolveExactMatch = resolveExactMatch;
}

function registerStationField(field) {
  stationFields.push(field);
  setupStationPicker(field);
  return field;
}

async function hydrateStationField(field) {
  const crs = normaliseCrs(field.crsInput.value);
  if (!crs) {
    return;
  }
  field.crsInput.value = crs;
  try {
    const matches = await fetchStationMatches(crs);
    const exactMatch = matches.find(
      (match) => normaliseCrs(match.crsCode) === crs,
    );
    const picked = exactMatch || matches[0];
    if (picked) {
      field.textInput.value = picked.stationName;
      field.crsInput.value = picked.crsCode;
      updateStationValidity(field);
      return;
    }
  } catch (err) {
    console.warn("Failed to hydrate station field", err);
  }
  field.textInput.value = crs;
  updateStationValidity(field);
}

function updateViaRequirementUi(field) {
  const isRequired = field.requiredToggle.checked;
  field.row.classList.toggle("is-optional", !isRequired);
}

function createViaField(initialConfig = {}) {
  const config =
    typeof initialConfig === "string"
      ? { crs: initialConfig, required: true }
      : {
          crs: initialConfig.crs || "",
          required: initialConfig.required !== false,
        };
  const label = document.createElement("label");
  label.className = "station-field";

  const requiredToggle = document.createElement("label");
  requiredToggle.className = "via-required-toggle";
  requiredToggle.title = "Toggle mandatory/optional via";

  const requiredInput = document.createElement("input");
  requiredInput.type = "checkbox";
  requiredInput.checked = config.required;
  requiredInput.setAttribute("aria-label", "Mandatory via");

  requiredToggle.appendChild(requiredInput);

  const input = document.createElement("input");
  input.type = "text";
  input.required = false;
  input.className = "station-input";
  input.autocomplete = "off";
  input.setAttribute("aria-label", "Via station");

  const crsInput = document.createElement("input");
  crsInput.type = "hidden";

  // Small "×" button to remove this via
  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.textContent = "×";
  removeBtn.title = "Remove this via";
  removeBtn.className = "via-remove";

  const row = document.createElement("div");
  row.className = "station-field-row via-row";
  row.appendChild(requiredToggle);
  row.appendChild(input);
  row.appendChild(removeBtn);

  const suggestBox = document.createElement("div");
  suggestBox.className = "station-suggest";
  suggestBox.setAttribute("role", "listbox");

  removeBtn.addEventListener("click", () => {
    label.remove();
    const idx = viaFields.findIndex((field) => field.textInput === input);
    if (idx !== -1) {
      viaFields.splice(idx, 1);
    }
  });

  requiredInput.addEventListener("change", () => {
    updateViaRequirementUi(field);
  });

  label.appendChild(row);
  label.appendChild(crsInput);
  label.appendChild(suggestBox);

  if (viaScroll && addViaBtn) {
    viaScroll.insertBefore(label, addViaBtn);
  } else {
    form.insertBefore(label, addViaBtn);
  }

  const field = registerStationField({
    textInput: input,
    crsInput,
    suggestBox,
    required: false,
    requiredToggle: requiredInput,
    row,
  });
  updateViaRequirementUi(field);
  viaFields.push(field);

  if (config.crs) {
    field.crsInput.value = normaliseCrs(config.crs);
    hydrateStationField(field);
  }
}

function clearViaFields() {
  viaFields.forEach((field) => {
    field.textInput.closest("label")?.remove();
  });
  viaFields.length = 0;
}

const fromField = registerStationField({
  textInput: fromStationInput,
  crsInput: fromCrsInput,
  suggestBox: fromSuggestBox,
  required: true,
});
const toField = registerStationField({
  textInput: toStationInput,
  crsInput: toCrsInput,
  suggestBox: toSuggestBox,
  required: true,
});

// === Local storage helpers ===
function loadSavedInputsFromStorage() {
  const from = localStorage.getItem("corridor_fromCrs") || "";
  const to = localStorage.getItem("corridor_toCrs") || "";
  const date = localStorage.getItem("corridor_serviceDate") || "";
  const start = localStorage.getItem("corridor_startTime") || "";
  const end = localStorage.getItem("corridor_endTime") || "";
  const viasStr = localStorage.getItem("corridor_vias") || "";
  const showPlatformsRaw =
    localStorage.getItem(PLATFORM_TOGGLE_STORAGE_KEY) || "";
  const realtimeRaw =
    localStorage.getItem(REALTIME_TOGGLE_STORAGE_KEY) || "";

  if (from) {
    fromField.crsInput.value = normaliseCrs(from);
  }
  if (to) {
    toField.crsInput.value = normaliseCrs(to);
  }
  if (date) document.getElementById("serviceDate").value = date;
  if (start) document.getElementById("startTime").value = start;
  if (end) document.getElementById("endTime").value = end;
  if (showPlatformsRaw) {
    setPlatformToggleState(showPlatformsRaw === "true", { persist: false });
  }
  if (realtimeRaw) {
    realtimePreferred = realtimeRaw === "true";
  }

  // Default to NO vias on first run.
  // On subsequent runs, recreate one via field per saved CRS.
  if (viasStr) {
    viasStr
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v)
      .forEach((v) => {
        const parsed = parseViaToken(v);
        createViaField(parsed);
      });
  } else {
    clearViaFields();
  }
}

function hydratePrefilledStations() {
  const hydrations = [];
  stationFields.forEach((field) => {
    if (field.crsInput.value) {
      hydrations.push(hydrateStationField(field));
    }
  });
  return Promise.all(hydrations);
}

function loadInputsFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const autoBuildRequested = window.location.hash === "#autobuild";

  if (params.size === 0) {
    return { shouldAutoSubmit: false, autoBuildRequested };
  }

  const from = normaliseCrs(params.get("from"));
  const to = normaliseCrs(params.get("to"));
  const date = params.get("date");
  const start = padTime(params.get("start"));
  const end = padTime(params.get("end"));
  const viasRaw = params.get("vias");
  if (from) {
    fromField.crsInput.value = from;
  }
  if (to) {
    toField.crsInput.value = to;
  }
  if (date) document.getElementById("serviceDate").value = date;
  if (start) document.getElementById("startTime").value = start;
  if (end) document.getElementById("endTime").value = end;

  if (viasRaw === null) {
    clearViaFields();
  } else if (viasRaw !== null) {
    clearViaFields();
    viasRaw
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v)
      .forEach((v) => {
        const parsed = parseViaToken(v);
        createViaField(parsed);
      });
  }

  return {
    shouldAutoSubmit: Boolean(
      autoBuildRequested && from && to && date && start && end,
    ),
    autoBuildRequested,
  };
}

const { shouldAutoSubmit, autoBuildRequested } = loadInputsFromQuery();
if (new URLSearchParams(window.location.search).size === 0) {
  loadSavedInputsFromStorage();
}
if (new URLSearchParams(window.location.search).size > 0) {
  const showPlatformsRaw =
    localStorage.getItem(PLATFORM_TOGGLE_STORAGE_KEY) || "";
  if (showPlatformsRaw) {
    setPlatformToggleState(showPlatformsRaw === "true", { persist: false });
  }
  const realtimeRaw =
    localStorage.getItem(REALTIME_TOGGLE_STORAGE_KEY) || "";
  if (realtimeRaw) {
    realtimePreferred = realtimeRaw === "true";
  }
}
hydratePrefilledStations().then(() => {
  if (shouldAutoSubmit) {
    setTimeout(() => {
      form.requestSubmit();
    }, 0);
  }
});

// === Service range helpers ===
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

function serviceCallsAllStationsInRange(detail, crsSet) {
  if (!detail || !Array.isArray(detail.locations)) return false;

  return detail.locations.every((loc) => {
    const crs = loc.crs || "";
    if (!crsSet.has(crs)) return true;

    const disp = (loc.displayAs || "").toUpperCase();
    if (disp === "PASS" || disp === "CANCELLED_PASS") return true;

    return serviceInTimeRange(loc);
  });
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
  if (buildCancelled) {
    hideStatus();
    return;
  }
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
  if (buildCancelled) {
    hideStatus();
    return;
  }
  const percent = total > 0 ? Math.round((completed / total) * 100) : 100;
  setStatus(`${label}`, { progress: percent });
}

function resetOutputs() {
  hideStatus();
  headingAB.textContent = "";
  headingBA.textContent = "";
  tableCardAB?.classList.remove("has-data");
  tableCardBA?.classList.remove("has-data");
  if (keyAB) {
    keyAB.classList.add("is-empty");
    keyAB.innerHTML = "";
  }
  if (keyBA) {
    keyBA.classList.add("is-empty");
    keyBA.innerHTML = "";
  }
  if (crsKeyAB) {
    crsKeyAB.classList.add("is-empty");
    crsKeyAB.innerHTML = "";
  }
  if (crsKeyBA) {
    crsKeyBA.classList.add("is-empty");
    crsKeyBA.innerHTML = "";
  }
  headerRowAB.innerHTML = "";
  headerIconsRowAB.innerHTML = "";
  bodyRowsAB.innerHTML = "";
  headerRowBA.innerHTML = "";
  headerIconsRowBA.innerHTML = "";
  bodyRowsBA.innerHTML = "";
  downloadPdfBtn.disabled = true;
  shareBtn.disabled = true;
  lastPdfPayload = null;
  lastTimetableContext = null;
  lastSortLog = "";
  setRealtimeToggleState({ enabled: false, active: realtimePreferred });
  setPlatformToggleAvailability(false);
}

function clearTimetableOutputs() {
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
  lastTimetableContext = null;
  lastSortLog = "";
  setRealtimeToggleState({ enabled: false, active: realtimePreferred });
  setPlatformToggleAvailability(false);
}

function buildCorridorPaths(from, to, viaEntries) {
  const paths = [];
  const totalVia = viaEntries.length;

  function collectPaths(index, current) {
    if (index >= totalVia) {
      paths.push([from, ...current, to]);
      return;
    }
    const via = viaEntries[index];
    if (via.required) {
      collectPaths(index + 1, [...current, via.crs]);
      return;
    }
    collectPaths(index + 1, current);
    collectPaths(index + 1, [...current, via.crs]);
  }

  collectPaths(0, []);
  return paths.length ? paths : [[from, to]];
}

function buildCorridorLegs(paths) {
  const legMap = new Map();
  paths.forEach((path) => {
    for (let i = 0; i < path.length - 1; i += 1) {
      const fromCrs = path[i];
      const toCrs = path[i + 1];
      const key = `${fromCrs}|${toCrs}`;
      if (!legMap.has(key)) {
        legMap.set(key, {
          from: fromCrs,
          to: toCrs,
        });
      }
    }
  });

  return Array.from(legMap.values());
}

function formatAssertDetail(detail) {
  if (!detail) return "";
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) return detail.join(", ");
  if (typeof detail !== "object") return String(detail);

  const parts = [];
  Object.entries(detail).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    let rendered = value;
    if (Array.isArray(value)) {
      rendered = value.join(" → ");
    } else if (typeof value === "object") {
      rendered = JSON.stringify(value);
    }
    parts.push(`${key}: ${rendered}`);
  });
  return parts.join(", ");
}

function assertWithStatus(condition, userMessage, detail = {}, options = {}) {
  if (condition) return;
  const detailText = formatAssertDetail(detail);
  const fullMessage = detailText
    ? `${userMessage} (${detailText})`
    : userMessage;
  console.assert(false, fullMessage, detail);
  if (!options.keepOutputs) {
    clearTimetableOutputs();
  }
  setStatus(fullMessage, { isError: true });
  if (!options.allowContinue) {
    throw new Error(fullMessage);
  }
}

downloadPdfBtn.addEventListener("click", async () => {
  if (!lastPdfPayload) return;
  downloadPdfBtn.disabled = true;
  setStatus("Building PDF...");

  try {
    const resp = await fetch(PROXY_PDF, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(lastPdfPayload),
    });

    if (!resp.ok) {
      const text = await resp.text();
      const friendly = stripHtmlToText(text).trim();
      throw new Error(friendly || "PDF build failed");
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

function buildUrlFromInputs({ includeAutoBuild = false } = {}) {
  const url = new URL(window.location.href);
  const from = normaliseCrs(fromCrsInput.value);
  const to = normaliseCrs(toCrsInput.value);
  const date = document.getElementById("serviceDate").value;
  const start = document.getElementById("startTime").value;
  const end = document.getElementById("endTime").value;
  const viaValues = viaFields
    .map((field) => serializeViaField(field))
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
  url.hash = includeAutoBuild ? "#autobuild" : "";

  return url;
}

function buildShareUrl() {
  return buildUrlFromInputs({ includeAutoBuild: true }).toString();
}

function parseViaToken(token) {
  const cleaned = (token || "").trim();
  if (!cleaned) return { crs: "", required: true };
  const isOptional = cleaned.endsWith("?");
  const crs = normaliseCrs(isOptional ? cleaned.slice(0, -1) : cleaned);
  return { crs, required: !isOptional };
}

function serializeViaField(field) {
  const crs = normaliseCrs(field.crsInput.value);
  if (!crs) return null;
  const required = field.requiredToggle ? field.requiredToggle.checked : true;
  return required ? crs : `${crs}?`;
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

function renderTimetablesFromContext(context) {
  const {
    stations,
    stationSet,
    servicesAB,
    servicesBA,
    fromName,
    toName,
    forwardStopsLabel,
    reverseStopsLabel,
    corridorLabel,
    dateLabel,
    generatedTimestamp,
  } = context;
  const hasServices = servicesAB.length > 0 || servicesBA.length > 0;
  setPlatformToggleAvailability(hasServices);
  const pdfTables = [];
  const sortLogs = [];
  context.partialSort = null;

  if (servicesAB.length > 0) {
    const modelAB = buildTimetableModel(stations, stationSet, servicesAB, {
      realtimeEnabled,
      showPlatforms: showPlatformsEnabled,
      atocNameByCode,
    });
    const pdfModelAB = buildTimetableModel(stations, stationSet, servicesAB, {
      realtimeEnabled: false,
      showPlatforms: showPlatformsEnabled,
      atocNameByCode,
    });
    headingAB.textContent =
      forwardStopsLabel + " (" + modelAB.serviceCount + " services)";
    if (modelAB.sortLog) sortLogs.push(modelAB.sortLog);
    renderTimetable(
      modelAB,
      headerRowAB,
      headerIconsRowAB,
      bodyRowsAB,
      keyAB,
      crsKeyAB,
    );
    if (modelAB.partialSort) {
      context.partialSort = context.partialSort || { unsorted: [] };
      context.partialSort.unsorted.push(...modelAB.partialSort.unsortedLabels);
    }
    const tableDataAB = buildPdfTableData(pdfModelAB);
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
    tableCardAB?.classList.remove("has-data");
    if (keyAB) {
      keyAB.classList.add("is-empty");
      keyAB.innerHTML = "";
    }
    if (crsKeyAB) {
      crsKeyAB.classList.add("is-empty");
      crsKeyAB.innerHTML = "";
    }
  }

  if (servicesBA.length > 0) {
    const stationsRev = stations.slice().reverse();
    const modelBA = buildTimetableModel(stationsRev, stationSet, servicesBA, {
      realtimeEnabled,
      showPlatforms: showPlatformsEnabled,
      atocNameByCode,
    });
    const pdfModelBA = buildTimetableModel(stationsRev, stationSet, servicesBA, {
      realtimeEnabled: false,
      showPlatforms: showPlatformsEnabled,
      atocNameByCode,
    });
    headingBA.textContent =
      reverseStopsLabel + " (" + modelBA.serviceCount + " services)";
    if (modelBA.sortLog) sortLogs.push(modelBA.sortLog);
    renderTimetable(
      modelBA,
      headerRowBA,
      headerIconsRowBA,
      bodyRowsBA,
      keyBA,
      crsKeyBA,
    );
    if (modelBA.partialSort) {
      context.partialSort = context.partialSort || { unsorted: [] };
      context.partialSort.unsorted.push(...modelBA.partialSort.unsortedLabels);
    }
    const tableDataBA = buildPdfTableData(pdfModelBA);
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
    tableCardBA?.classList.remove("has-data");
    if (keyBA) {
      keyBA.classList.add("is-empty");
      keyBA.innerHTML = "";
    }
    if (crsKeyBA) {
      crsKeyBA.classList.add("is-empty");
      crsKeyBA.innerHTML = "";
    }
  }

  if (sortLogs.length > 0) {
    lastSortLog = sortLogs.join("\n\n");
    if (ENABLE_SORT_LOG_DOWNLOAD) {
      downloadTextFile("timetable-sort-log.txt", lastSortLog);
    }
  } else {
    lastSortLog = "";
  }

  if (pdfTables.length > 0) {
    const title = corridorLabel || `${fromName} ↔ ${toName}`;
    const subtitle = `Generated on ${generatedTimestamp}`;
    lastPdfPayload = {
      meta: {
        title,
        subtitle,
      },
      tables: pdfTables,
    };
    downloadPdfBtn.disabled = false;
    shareBtn.disabled = false;
  } else {
    downloadPdfBtn.disabled = true;
    shareBtn.disabled = true;
  }

  if (context.partialSort?.unsorted?.length) {
    try {
      assertWithStatus(
        false,
        "Unable to sort some services",
        { services: context.partialSort.unsorted.join(", ") },
        { keepOutputs: true },
      );
    } catch (err) {
      // keep rendered timetable despite the assertion
    }
  }

}

// === Main form submit ===
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (suppressNextSubmit) {
    return;
  }
  if (buildInProgress) {
    return;
  }

  buildCancelled = false;
  // Run HTML5 validation for "required" fields, min/max, etc.
  stationFields.forEach((field) => updateStationValidity(field));
  if (!form.reportValidity()) {
    return;
  }

  buildAbortController = new AbortController();
  const { signal } = buildAbortController;
  const isAbortError = (err) =>
    err?.name === "AbortError" || signal.aborted || buildCancelled;
  const fetchWithSignal = (url, options = {}) =>
    fetch(url, { ...options, signal });
  const fetchRttText = async (url, options = {}) => {
    const cached = readRttCache(url);
    if (cached && cached.status >= 200 && cached.status < 300) {
      return cached;
    }
    const resp = await fetchWithSignal(url, options);
    const text = await resp.text();
    if (resp.status >= 200 && resp.status < 300) {
      writeRttCache(url, {
        text,
        status: resp.status,
        statusText: resp.statusText,
      });
    }
    return { text, status: resp.status, statusText: resp.statusText };
  };
  const shouldAbort = () => signal.aborted || buildCancelled;

  setBuildInProgress(true);
  try {
    resetOutputs();
    setStatus("Initialising timetable...", { progress: 0 });
    if (shouldAbort()) {
      return;
    }
    await loadLookupData(fetchWithSignal);
    if (shouldAbort()) {
      return;
    }

  const from = normaliseCrs(fromCrsInput.value);
  const to = normaliseCrs(toCrsInput.value);
  const dateInput = document.getElementById("serviceDate").value;
  const startInput = document.getElementById("startTime").value;
  const endInput = document.getElementById("endTime").value;

  // Collect via CRS values (non-empty only)
  const viaEntries = viaFields
    .map((field) => ({
      crs: normaliseCrs(field.crsInput.value),
      required: field.requiredToggle ? field.requiredToggle.checked : true,
    }))
    .filter((entry) => entry.crs);
  const viaValues = viaEntries.map((entry) => entry.crs);

  // Persist current form values + vias for next visit
  localStorage.setItem("corridor_fromCrs", from);
  localStorage.setItem("corridor_toCrs", to);
  localStorage.setItem("corridor_serviceDate", dateInput);
  localStorage.setItem("corridor_startTime", startInput);
  localStorage.setItem("corridor_endTime", endInput);
  const viaTokens = viaFields
    .map((field) => serializeViaField(field))
    .filter((v) => v);
  localStorage.setItem("corridor_vias", viaTokens.join(","));
  const updatedUrl = buildUrlFromInputs();
  if (autoBuildRequested) {
    updatedUrl.hash = "";
  }
  window.history.replaceState({}, "", updatedUrl.toString());

  currentDate = dateInput;
  startMinutes = timeStrToMinutes(startInput);
  endMinutes = timeStrToMinutes(endInput);

  if (!from || !to) {
    setStatus("Please select both From and To stations.", { isError: true });
    return;
  }
  if (startMinutes === null || endMinutes === null) {
    setStatus("Please enter a valid time range.", { isError: true });
    return;
  }

  // Full corridor chain including vias
  const corridorStations = [from, ...viaValues, to];

  const corridorPaths = buildCorridorPaths(from, to, viaEntries);
  const corridorLegs = buildCorridorLegs(corridorPaths);

  // Step 1: fetch all corridor services across all legs, deduplicated by serviceUid|runDate
  const corridorServicesMap = new Map();
  const stationNameByCrs = {};
  const legServiceCounts = new Map();
  let invalidInputsDetected = false;
  let rttTimeoutDetected = false;
  const rttTimeoutMessage = "Error fetching data from RTT. Please try again.";
  const rttConnectionMessage =
    "Unable to reach RTT. Please check your connection and try again.";
  let rttConnectionDetected = false;

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
      const { text } = await fetchRttText(url, {
        headers: { Accept: "application/json" },
      });
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
      if (data && data.error === "timeout") {
        rttTimeoutDetected = true;
        return;
      }
      if (data && data.error === "connection") {
        rttConnectionDetected = true;
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
        return true;
      });
      legServiceCounts.set(
        `${leg.from}|${leg.to}`,
        eligibleServices.length,
      );
      eligibleServices.forEach((svc) => {
        const key = (svc.serviceUid || "") + "|" + (svc.runDate || "");
        if (!corridorServicesMap.has(key)) {
          corridorServicesMap.set(key, svc);
        }
      });
    });

    await Promise.all(searchPromises);
  } catch (err) {
    if (isAbortError(err)) {
      setStatus("Build cancelled.");
      return;
    }
    setStatus("Error fetching initial service search results: " + err, {
      isError: true,
    });
    return;
  }

  if (shouldAbort()) {
    return;
  }
  if (rttTimeoutDetected) {
    setStatus(rttTimeoutMessage, { isError: true });
    return;
  }
  if (rttConnectionDetected) {
    setStatus(rttConnectionMessage, { isError: true });
    return;
  }

  if (invalidInputsDetected) {
    setStatus("Invalid inputs.", { isError: true });
    return;
  }

  const invalidPaths = corridorPaths
    .map((path) => {
      const missing = [];
      for (let i = 0; i < path.length - 1; i += 1) {
        const fromCrs = path[i];
        const toCrs = path[i + 1];
        const count =
          legServiceCounts.get(`${fromCrs}|${toCrs}`) || 0;
        if (count === 0 && !hasConnectionBetweenStations(fromCrs, toCrs)) {
          missing.push({ from: fromCrs, to: toCrs });
        }
      }
      return { path, missing };
    })
    .filter((entry) => entry.missing.length > 0);
  const connectionsAllowAllLegs = corridorLegs.every((leg) => {
    const count = legServiceCounts.get(`${leg.from}|${leg.to}`) || 0;
    return count > 0 || hasConnectionBetweenStations(leg.from, leg.to);
  });
  if (invalidPaths.length === corridorPaths.length) {
    invalidPaths.sort((a, b) => a.missing.length - b.missing.length);
    const gap = invalidPaths[0].missing[0];
    const fromName = stationNameByCrs[gap.from] || gap.from;
    const toName = stationNameByCrs[gap.to] || gap.to;
    setStatus(
      "No passenger services between " + fromName + " and " + toName + ".",
      { isError: true },
    );
    return;
  }

  const corridorServices = Array.from(corridorServicesMap.values());

  if (corridorServices.length === 0 && !connectionsAllowAllLegs) {
    const fromLabel = stationNameByCrs[from] || from;
    const toLabel = stationNameByCrs[to] || to;
    setStatus(
      "No passenger services between " +
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
    const { text, status, statusText } = await fetchRttText(url, {
      headers: { Accept: "application/json" },
    });
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
    if (data && data.error === "timeout") {
      rttTimeoutDetected = true;
    }
    if (data && data.error === "connection") {
      rttConnectionDetected = true;
    }
    return {
      svc,
      detail: data,
      status,
      statusText,
      seed: true,
    };
  });

  let corridorDetails;
  try {
    corridorDetails = await Promise.all(corridorDetailPromises);
  } catch (err) {
    if (isAbortError(err)) {
      setStatus("Build cancelled.");
      return;
    }
    setStatus("Error fetching service details: " + err, { isError: true });
    return;
  }

  if (shouldAbort()) {
    return;
  }
  if (rttTimeoutDetected) {
    setStatus(rttTimeoutMessage, { isError: true });
    return;
  }
  if (rttConnectionDetected) {
    setStatus(rttConnectionMessage, { isError: true });
    return;
  }

  const splitCorridorDetails = splitServiceEntries(
    corridorDetails,
    corridorStations,
  );
  const okCorridorDetails = splitCorridorDetails.filter(
    (d) => d.detail && Array.isArray(d.detail.locations),
  );
  if (okCorridorDetails.length === 0 && !connectionsAllowAllLegs) {
    setStatus("No usable service detail responses.");
    return;
  }

  // Build station union from all corridor services, over the multi-via chain,
  // ignoring PASS / CANCELLED_PASS.
  if (shouldAbort()) {
    return;
  }

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
      const { text } = await fetchRttText(url, {
        headers: { Accept: "application/json" },
      });
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
      if (data && data.error === "timeout") {
        rttTimeoutDetected = true;
        return;
      }
      if (data && data.error === "connection") {
        rttConnectionDetected = true;
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
    if (isAbortError(err)) {
      return;
    }
    console.warn("Error during station searches:", err);
  }

  if (shouldAbort()) {
    return;
  }
  if (rttTimeoutDetected) {
    setStatus(rttTimeoutMessage, { isError: true });
    return;
  }
  if (rttConnectionDetected) {
    setStatus(rttConnectionMessage, { isError: true });
    return;
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
    const p = fetchRttText(url, {
      headers: { Accept: "application/json" },
    })
      .then(({ text }) => {
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
        if (data && data.error === "timeout") {
          rttTimeoutDetected = true;
          return;
        }
        if (data && data.error === "connection") {
          rttConnectionDetected = true;
          return;
        }
        entry.detail = data;
      })
      .catch((err) => {
        if (isAbortError(err)) {
          throw err;
        }
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
    if (isAbortError(err)) {
      return;
    }
    console.warn("Error during candidate detail fetch:", err);
  }

  if (shouldAbort()) {
    return;
  }
  if (rttTimeoutDetected) {
    setStatus(rttTimeoutMessage, { isError: true });
    return;
  }
  if (rttConnectionDetected) {
    setStatus(rttConnectionMessage, { isError: true });
    return;
  }

  setStatus("Building timetable...");

  const splitCandidateEntries = [];
  for (const entry of candidateMap.values()) {
    splitCandidateEntries.push(
      ...splitServiceEntries([entry], corridorStations),
    );
  }
  const dedupedCandidateEntries =
    dedupeServiceEntries(splitCandidateEntries);

  // Filter to services that:
  //  - have valid detail.locations
  //  - and call at >= 2 *distinct* non-PASS corridor stations.
  // This removes loops like CTR→CTR that only ever touch one station in the table.
  const allDetails = [];
  for (const entry of dedupedCandidateEntries) {
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

  if (shouldAbort()) {
    return;
  }
  if (allDetails.length === 0) {
    setStatus(
      "No services found that call at two or more selected stations in this time range.",
    );
    return;
  }

  // Split into A->B vs B->A, based on order of corridor stations in the calling pattern.
  const corridorSet = new Set(corridorStations.filter(Boolean));
  const connectionEntries = buildConnectionServiceEntries(
    allDetails,
    corridorSet,
  );
  console.info(
    "Connection summary: generated",
    connectionEntries.length,
    "from",
    allDetails.length,
    "base services",
    "corridor",
    Array.from(corridorSet).join(","),
  );
  const allDetailsWithConnections = allDetails.concat(connectionEntries);
  const split = splitByDirection(allDetailsWithConnections, stations);
  const servicesAB = split.ab;
  const servicesBA = split.ba;
  const inTableConnections = connectionEntries.filter((entry) => {
    const { detail } = entry;
    if (!detail || !Array.isArray(detail.locations)) return false;
    const seen = new Set();
    detail.locations.forEach((loc) => {
      const crs = normaliseCrs(loc?.crs || "");
      if (crs && corridorSet.has(crs)) seen.add(crs);
    });
    return seen.size >= 2;
  });
  console.info(
    "Connection summary: in-table connections",
    inTableConnections.length,
    "AB",
    servicesAB.filter((entry) => entry.isConnection).length,
    "BA",
    servicesBA.filter((entry) => entry.isConnection).length,
  );

  const fromName = resolveInputStationLabel(
    from,
    fromStationInput.value,
    findStationNameByCrs(stations, from),
  );
  const toName = resolveInputStationLabel(
    to,
    toStationInput.value,
    findStationNameByCrs(stations, to),
  );
  const viaNames = viaValues.map((crs) => {
    const viaField = viaFields.find(
      (field) => normaliseCrs(field.crsInput.value) === crs,
    );
    return resolveInputStationLabel(
      crs,
      viaField?.textInput?.value,
      findStationNameByCrs(stations, crs),
    );
  });
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

  const hasRealtimeServices =
    servicesAB.some((entry) => entry.detail?.realtimeActivated === true) ||
    servicesBA.some((entry) => entry.detail?.realtimeActivated === true);
  setRealtimeToggleState({
    enabled: hasRealtimeServices,
    active: realtimePreferred,
  });

  lastTimetableContext = {
    stations,
    stationSet,
    servicesAB,
    servicesBA,
    fromName,
    toName,
    viaNamesForward,
    forwardStopsLabel,
    reverseStopsLabel,
    corridorLabel,
    dateLabel,
    generatedTimestamp: formatGeneratedTimestamp(),
  };
    renderTimetablesFromContext(lastTimetableContext);
    if (!statusEl?.classList.contains("is-error")) {
      hideStatus();
    }
  } finally {
    buildAbortController = null;
    setBuildInProgress(false);
  }
});

function splitServiceEntries(entries, corridorStations = []) {
  const corridorSet = new Set(corridorStations.filter(Boolean));
  const splitEntries = [];
  entries.forEach((entry) => {
    if (!entry?.detail || !Array.isArray(entry.detail.locations)) {
      splitEntries.push(entry);
      return;
    }
    if (entry?.svc?.originalServiceUid) {
      splitEntries.push(entry);
      return;
    }
    const splitIndex = findRepeatedStationSplitIndex(
      entry.detail.locations,
      corridorSet,
    );
    if (splitIndex === null) {
      splitEntries.push(entry);
      return;
    }
    const locations = entry.detail.locations;
    const firstLocations = locations.slice(0, splitIndex + 1);
    const secondLocations = locations.slice(splitIndex);
    const firstSvc = withServiceSuffix(entry.svc, "(1)");
    firstSvc.splitContinuesToLocation =
      secondLocations[secondLocations.length - 1] || null;
    const secondSvc = withServiceSuffix(entry.svc, "(2)");
    secondSvc.splitComesFromLocation = firstLocations[0] || null;
    splitEntries.push({
      ...entry,
      svc: firstSvc,
      detail: { ...entry.detail, locations: firstLocations },
    });
    splitEntries.push({
      ...entry,
      svc: secondSvc,
      detail: { ...entry.detail, locations: secondLocations },
    });
  });
  return splitEntries;
}

function findRepeatedStationSplitIndex(locations, corridorSet) {
  const seen = new Map();
  for (let i = 0; i < locations.length; i++) {
    const crs = locations[i]?.crs || "";
    if (!crs) continue;
    if (seen.has(crs)) {
      const firstIndex = seen.get(crs);
      let splitIndex = i - 1;
      for (let j = i - 1; j > firstIndex; j--) {
        const corridorCrs = locations[j]?.crs || "";
        if (corridorCrs && corridorSet.has(corridorCrs)) {
          splitIndex = j;
          break;
        }
      }
      if (splitIndex >= 0) {
        return splitIndex;
      }
      return null;
    }
    seen.set(crs, i);
  }
  return null;
}

function withServiceSuffix(svc, suffix) {
  const updated = { ...(svc || {}) };
  if (updated.serviceUid && !updated.originalServiceUid) {
    updated.originalServiceUid = updated.serviceUid;
  }
  if (updated.serviceUid) {
    updated.serviceUid = `${updated.serviceUid}${suffix}`;
  }
  if (updated.trainIdentity) {
    updated.trainIdentity = `${updated.trainIdentity}${suffix}`;
  }
  if (updated.runningIdentity) {
    updated.runningIdentity = `${updated.runningIdentity}${suffix}`;
  }
  return updated;
}

function dedupeServiceEntries(entries) {
  const seen = new Set();
  const deduped = [];
  entries.forEach((entry) => {
    if (!entry?.detail || !Array.isArray(entry.detail.locations)) {
      deduped.push(entry);
      return;
    }
    const svc = entry.svc || {};
    const uid =
      svc.serviceUid ||
      svc.originalServiceUid ||
      svc.trainIdentity ||
      svc.runningIdentity ||
      "";
    const date = svc.runDate || entry.detail.runDate || "";
    const locationKey = entry.detail.locations
      .map((loc) => {
        const crs = loc.crs || "";
        const arr =
          loc.gbttBookedArrival || loc.realtimeArrival || "";
        const dep =
          loc.gbttBookedDeparture || loc.realtimeDeparture || "";
        const displayAs = loc.displayAs || "";
        return `${crs}|${arr}|${dep}|${displayAs}`;
      })
      .join(">");
    const key = `${uid}|${date}|${locationKey}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    deduped.push(entry);
  });
  return deduped;
}

function isCallingLocation(loc) {
  if (!loc) return false;
  const disp = (loc.displayAs || "").toUpperCase();
  return disp !== "PASS" && disp !== "CANCELLED_PASS";
}

function getLastCallingPair(detail) {
  const locs = detail.locations || [];
  let last = null;
  let previous = null;
  for (let i = locs.length - 1; i >= 0; i -= 1) {
    const loc = locs[i];
    if (!isCallingLocation(loc)) continue;
    if (!last) {
      last = loc;
    } else {
      previous = loc;
      break;
    }
  }
  return { last, previous };
}

function matchConnectionEntry(entry, previousCrs) {
  const prevStations = entry.previousStations;
  if (!prevStations) return true;
  if (!previousCrs) return false;
  return prevStations.includes(previousCrs);
}

function locationTimeMinutes(loc) {
  const raw =
    loc.gbttBookedArrival ||
    loc.realtimeArrival ||
    loc.gbttBookedDeparture ||
    loc.realtimeDeparture ||
    "";
  return rttTimeToMinutes(raw);
}

function buildConnectionServiceEntries(
  entries,
  corridorSet,
  bufferMinutes = 5,
) {
  const generated = [];
  const seen = new Set();
  let loggedCorridorSkips = 0;
  let loggedTerminalSkips = 0;

  entries.forEach((entry) => {
    if (!entry?.detail || !Array.isArray(entry.detail.locations)) return;
    const { last, previous } = getLastCallingPair(entry.detail);
    const terminalCrs = normaliseCrs(last?.crs || "");
    if (!terminalCrs) {
      console.info("Connection skip: missing terminal CRS", entry);
      return;
    }
    if (!corridorSet.has(terminalCrs)) {
      return;
    }

    const previousCrs = normaliseCrs(previous?.crs || "");
    const hasConnectionConfig = Object.prototype.hasOwnProperty.call(
      connectionsByStation,
      terminalCrs,
    );
    const terminalEntries = getConnectionEntriesForStation(terminalCrs);
    if (!terminalEntries.length) {
      if (hasConnectionConfig && loggedTerminalSkips < 5) {
        console.info(
          "Connection skip: no connections for terminal",
          terminalCrs,
        );
        loggedTerminalSkips += 1;
      }
      return;
    }

    const arrivalMins = locationTimeMinutes(last);
    if (arrivalMins === null) {
      console.info(
        "Connection skip: terminal arrival time missing",
        terminalCrs,
      );
      return;
    }

    terminalEntries.forEach((terminalEntry) => {
      if (!matchConnectionEntry(terminalEntry, previousCrs)) {
        if (loggedCorridorSkips < 5) {
          console.info(
            "Connection skip: previous station mismatch",
            terminalCrs,
            previousCrs,
            terminalEntry.previousStations,
          );
          loggedCorridorSkips += 1;
        }
        return;
      }
      Object.entries(terminalEntry.connections || {}).forEach(
        ([destCrsRaw, meta]) => {
          const destCrs = normaliseCrs(destCrsRaw);
          if (!destCrs) {
            if (loggedCorridorSkips < 5) {
              console.info(
                "Connection skip: missing destination CRS",
                terminalCrs,
              );
              loggedCorridorSkips += 1;
            }
            return;
          }
          if (!corridorSet.has(destCrs)) {
            if (loggedCorridorSkips < 5) {
              console.info(
                "Connection skip: destination not in corridor",
                terminalCrs,
                destCrs,
              );
              loggedCorridorSkips += 1;
            }
            return;
          }
          const durationMinutes = meta.durationMinutes;
          if (!durationMinutes) {
            if (loggedCorridorSkips < 5) {
              console.info(
                "Connection skip: missing duration",
                terminalCrs,
                destCrs,
              );
              loggedCorridorSkips += 1;
            }
            return;
          }
          const departMins = arrivalMins + bufferMinutes;
          const arriveMins = departMins + durationMinutes;
          const departTime = minutesToRttTime(departMins);
          const arriveTime = minutesToRttTime(arriveMins);
          const mode = meta.mode || "walk";
          const modeLower = mode.toLowerCase();
          const atocCode = modeLower === "walk" ? "W" : "U";
          const atocName =
            modeLower === "walk" ? "Walk" : mode || "Connection";
          const runDate =
            entry.svc?.runDate ||
            entry.detail?.runDate ||
            entry.detail?.date ||
            "";
          const baseUid =
            entry.svc?.serviceUid ||
            entry.svc?.originalServiceUid ||
            entry.svc?.trainIdentity ||
            "CONN";
          const uniqueKey = [
            baseUid,
            runDate,
            terminalCrs,
            destCrs,
            departTime,
          ].join("|");
          if (seen.has(uniqueKey)) return;
          seen.add(uniqueKey);
          const svc = {
            serviceUid: `CONN-${baseUid}-${terminalCrs}-${destCrs}-${departTime}`,
            runDate,
            atocCode,
            atocName,
            serviceType: modeLower === "walk" ? "walk" : "connection",
            isPassenger: true,
          };
          const detail = {
            runDate,
            serviceType: modeLower === "walk" ? "walk" : "connection",
            locations: [
              {
                crs: terminalCrs,
                gbttBookedDeparture: departTime,
                displayAs: "CALL",
                isPublicCall: true,
              },
              {
                crs: destCrs,
                gbttBookedArrival: arriveTime,
                displayAs: "CALL",
                isPublicCall: true,
              },
            ],
          };
          console.info(
            "Connection generated",
            terminalCrs,
            "->",
            destCrs,
            `${minutesToTimeStr(departMins)} +${durationMinutes}m`,
          );
          generated.push({ svc, detail, seed: false, isConnection: true });
        },
      );
    });
  });

  return generated;
}

// Build station union over a possibly multi-via corridor.
// corridorStations is e.g. ["SHR", "VIA1", "VIA2", "WRX"].
function buildStationsUnion(corridorStations, servicesWithDetails) {
  const stationMap = {};
  const corridorIndex = {};
  const orderedCrs = [];

  if (!servicesWithDetails || servicesWithDetails.length === 0) {
    return corridorStations
      .filter((crs) => crs)
      .map((crs) => ({
        crs,
        tiploc: "",
        name: crs,
      }));
  }

  // Map each corridor CRS to its index in the chain (A=0, VIA1=1, ..., Z=n)
  corridorStations.forEach((crs, idx) => {
    if (crs) corridorIndex[crs] = idx;
  });

  function addStation(crs, tiploc, name) {
    if (!crs) return;
    const key = crs;
    if (!stationMap[key]) {
      stationMap[key] = {
        crs,
        tiploc: tiploc || "",
        name: name || crs,
      };
    }
  }

  function mergeIntoOrder(sequence) {
    sequence.forEach((crs, idx) => {
      if (!crs) return;
      if (orderedCrs.includes(crs)) return;

      let prevKnown = null;
      for (let i = idx - 1; i >= 0; i--) {
        if (orderedCrs.includes(sequence[i])) {
          prevKnown = sequence[i];
          break;
        }
      }

      let nextKnown = null;
      for (let i = idx + 1; i < sequence.length; i++) {
        if (orderedCrs.includes(sequence[i])) {
          nextKnown = sequence[i];
          break;
        }
      }

      if (prevKnown && nextKnown) {
        const prevIndex = orderedCrs.indexOf(prevKnown);
        const nextIndex = orderedCrs.indexOf(nextKnown);
        assertWithStatus(
          prevIndex < nextIndex,
          "Could not build a consistent station order for this route",
          `inserting ${crs} between ${prevKnown} and ${nextKnown}`,
        );
        orderedCrs.splice(nextIndex, 0, crs);
      } else if (prevKnown) {
        const prevIndex = orderedCrs.indexOf(prevKnown);
        orderedCrs.splice(prevIndex + 1, 0, crs);
      } else if (nextKnown) {
        const nextIndex = orderedCrs.indexOf(nextKnown);
        orderedCrs.splice(nextIndex, 0, crs);
      } else {
        orderedCrs.push(crs);
      }
    });

    const orderedSet = new Set(orderedCrs);
    const filteredSequence = sequence.filter((crs) => orderedSet.has(crs));
    const indices = filteredSequence.map((crs) => orderedCrs.indexOf(crs));
    for (let i = 1; i < indices.length; i++) {
      assertWithStatus(
        indices[i - 1] < indices[i],
        "Service calling pattern conflicts with the station order",
        `sequence: ${filteredSequence.join(" → ")}`,
      );
    }
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
      const segmentSequence = [];

      for (let i = i1; step > 0 ? i <= i2 : i >= i2; i += step) {
        const l = locs[i];
        if (!l) continue;
        const disp = (l.displayAs || "").toUpperCase();
        if (disp === "PASS" || disp === "CANCELLED_PASS") continue; // only calling points

        const crs = l.crs || "";
        if (!crs) continue;
        const tiploc = l.tiploc || "";
        const name = l.description || crs || tiploc;

        addStation(crs, tiploc, name);
        segmentSequence.push(crs);
      }

      if (segmentSequence.length > 0) {
        if (c1 > c2) {
          segmentSequence.reverse();
        }
        mergeIntoOrder(segmentSequence);
      }
    }
  });

  return orderedCrs.map((crs) => stationMap[crs]).filter(Boolean);
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
