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

function minutesToTimeStr(mins) {
  if (mins === null || mins === undefined) return "";
  const m = Math.max(0, mins);
  const h = Math.floor(m / 60) % 24;
  const mm = m % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
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

function cellToText(cell) {
  if (!cell) return "";
  if (typeof cell === "object") {
    const base = cell.text || "";
    const platform = cell.platform?.text || "";
    if (base && platform) return `${base} ${platform}`;
    return base || platform;
  }
  return String(cell);
}

function formatDelayText(delayMins) {
  if (!delayMins || Number.isNaN(delayMins)) return "";
  const sign = delayMins > 0 ? "+" : "";
  return `${sign}${delayMins}`;
}

function hexToRgb(hex) {
  const normalized = hex.replace("#", "");
  if (normalized.length !== 6) return null;
  const intVal = parseInt(normalized, 16);
  if (Number.isNaN(intVal)) return null;
  return {
    r: (intVal >> 16) & 255,
    g: (intVal >> 8) & 255,
    b: intVal & 255,
  };
}

function rgbToHex({ r, g, b }) {
  const clamp = (val) => Math.max(0, Math.min(255, Math.round(val)));
  return `#${[r, g, b]
    .map((val) => clamp(val).toString(16).padStart(2, "0"))
    .join("")}`;
}

function interpolateHexColor(startHex, endHex, t) {
  const start = hexToRgb(startHex);
  const end = hexToRgb(endHex);
  if (!start || !end) return endHex;
  const mix = (a, b) => a + (b - a) * t;
  return rgbToHex({
    r: mix(start.r, end.r),
    g: mix(start.g, end.g),
    b: mix(start.b, end.b),
  });
}

function delayToColor(delayMins) {
  if (delayMins === null || delayMins === undefined) return null;
  const absDelay = Math.abs(delayMins);
  if (absDelay <= 1) return null;

  const earlyDark = "#1f3a6f";
  const earlyBright = "#2c6fbe";
  const lateDark = "#7a1f1f";
  const lateBright = "#e53935";

  if (delayMins < 0) {
    if (absDelay <= 5) return earlyDark;
    return earlyBright;
  }

  if (absDelay <= 5) return lateDark;
  if (absDelay >= 20) return lateBright;

  const t = (absDelay - 5) / (20 - 5);
  return interpolateHexColor(lateDark, lateBright, t);
}

function chooseDisplayedTimeAndStatus(
  loc,
  isArrival,
  serviceRealtimeActivated,
  realtimeToggleEnabled,
) {
  const sched = isArrival
    ? loc.gbttBookedArrival
    : loc.gbttBookedDeparture;
  const rt = isArrival ? loc.realtimeArrival : loc.realtimeDeparture;
  const rtAct = isArrival
    ? loc.realtimeArrivalActual
    : loc.realtimeDepartureActual;

  const schedDisplay = sched ? padTime(sched) : "";
  const rtDisplay = rt ? padTime(rt) : "";

  const displayAs = (loc.displayAs || "").toUpperCase();
  if (displayAs === "CANCELLED_CALL") {
    return {
      text: schedDisplay,
      format: { strike: true },
    };
  }
  if (isArrival && displayAs === "STARTS") {
    return {
      text: schedDisplay,
      format: { strike: true },
    };
  }
  if (!isArrival && displayAs === "ENDS") {
    return {
      text: schedDisplay,
      format: { strike: true },
    };
  }

  if (serviceRealtimeActivated !== true || !realtimeToggleEnabled) {
    return { text: schedDisplay, format: null };
  }

  const noReport = isArrival
    ? loc.realtimePassNoReport === true ||
      loc.realtimeArrivalNoReport === true
    : loc.realtimePassNoReport === true ||
      loc.realtimeDepartureNoReport === true;
  if (noReport) {
    const baseDisplay = rtDisplay || schedDisplay;
    const unknownPass = baseDisplay ? `${baseDisplay}?` : "?";
    return {
      text: unknownPass,
      format: { italic: true, noReport: true },
    };
  }

  if (rtDisplay) {
    const schedMins = rttTimeToMinutes(sched);
    const rtMins = rttTimeToMinutes(rt);
    const delayMins =
      schedMins !== null && rtMins !== null ? rtMins - schedMins : null;
    const color = delayToColor(delayMins);
    return {
      text: rtDisplay,
      format: {
        bold: rtAct === true,
        italic: rtAct !== true,
        color,
        delayMins: rtAct === true ? delayMins : null,
      },
    };
  }

  return { text: schedDisplay, format: null };
}

function safePairText(pairs) {
  if (!Array.isArray(pairs) || !pairs[0]) return "";
  const p = pairs[0];
  const name = p.description || "";
  const time = p.publicTime ? padTime(p.publicTime) : "";
  return name + (time ? " " + time : "");
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

function downloadTextFile(filename, contents) {
  const blob = new Blob([contents], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function stripHtmlToText(value) {
  if (!value) return "";
  if (typeof value === "object") return cellToText(value);
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
  const text = cellToText(value);
  if (!text) return "";
  const match = String(text).match(/\b\d{2}:\d{2}\b/);
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
      if (meta.isWalk) icons.push("WALK");
      return icons.join(" ");
    }),
  ];
  const tableRows = rows.map((row) => {
    const label = rowLabelText(row);
    const cells = orderedSvcIndices.map((svcIndex) => {
      const val = row.cells[svcIndex];
      if (val && typeof val === "object") {
        const text = val.text || "";
        const format = val.format || {};
        const cellData = { text };
        if (val.title) cellData.title = val.title;
        if (format.bgColor) cellData.bgColor = format.bgColor;
        if (format.strike) cellData.strike = true;
        if (format.italic) cellData.italic = true;
        if (format.bold) cellData.bold = true;
        if (format.color) cellData.color = format.color;
        if (format.noReport) cellData.noReport = true;
        if (val.platform?.text) cellData.platformText = val.platform.text;
        if (val.platform?.confirmed) cellData.platformConfirmed = true;
        if (val.platform?.changed) cellData.platformChanged = true;
        return cellData;
      }
      return cellToText(val);
    });
    return [label, ...cells];
  });
  const serviceTimes = orderedSvcIndices.map((svcIndex) => {
    for (const row of rows) {
      const value = cellToText(row.cells[svcIndex]);
      const time = extractFirstTime(value);
      if (time) return time;
    }
    return "";
  });
  return { headers, rows: [facilitiesRow, ...tableRows], serviceTimes };
}
