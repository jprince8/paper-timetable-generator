const PROXY_CONNECTIONS = `${(window.BACKEND_BASE || "").trim()}/api/connections`;

let connectionsByStation = {};

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

function getConnectionEntriesForStation(crs) {
  return connectionsByStation[crs] || [];
}

function hasConnectionBetweenStations(from, to) {
  if (!from || !to) return false;
  const entries = getConnectionEntriesForStation(from);
  return entries.some((entry) => entry.connections?.[to]);
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
