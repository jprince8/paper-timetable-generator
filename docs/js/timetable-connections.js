const PROXY_CONNECTIONS = `${(window.BACKEND_BASE || "").trim()}/api/connections`;
const DEFAULT_CONNECTION_BUFFER_MINUTES = 0;

let connectionsByStation = {};

function connectionDebugEnabled() {
  return window.DEBUG_CONNECTIONS === true;
}

function logConnectionInfo(...args) {
  if (!connectionDebugEnabled()) return;
  console.info(...args);
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

function getCallingContexts(detail) {
  const locs = detail.locations || [];
  const calling = [];
  locs.forEach((loc) => {
    if (isCallingLocation(loc)) calling.push(loc);
  });
  return calling.map((current, idx) => ({
    previous: calling.slice(0, idx),
    current,
    next: calling.slice(idx + 1),
  }));
}

function normaliseCallingCrsList(locations) {
  if (!Array.isArray(locations)) return [];
  return locations
    .map((loc) => normaliseCrs(loc?.crs || ""))
    .filter(Boolean);
}

function matchConnectionEntryForSide(entry, sideCrsList) {
  const crsList = Array.isArray(sideCrsList) ? sideCrsList : [];
  if (crsList.length === 0) return false;
  const prevStations = entry.previousStations;
  if (!prevStations) return true;
  return crsList.some((crs) => prevStations.includes(crs));
}

function matchConnectionEntry(entry, previousCrs) {
  const prevStations = entry.previousStations;
  if (!prevStations) return true;
  if (!previousCrs) return false;
  return prevStations.includes(previousCrs);
}

function locationTimeInfo(loc) {
  const candidates = [
    { field: "gbttBookedArrival", value: loc?.gbttBookedArrival || "" },
    { field: "realtimeArrival", value: loc?.realtimeArrival || "" },
    { field: "gbttBookedDeparture", value: loc?.gbttBookedDeparture || "" },
    { field: "realtimeDeparture", value: loc?.realtimeDeparture || "" },
  ];
  const chosen = candidates.find((candidate) => candidate.value);
  if (!chosen) {
    return {
      minutes: null,
      sourceField: "",
      sourceRaw: "",
      sourceDisplay: "",
    };
  }
  return {
    minutes: rttTimeToMinutes(chosen.value),
    sourceField: chosen.field,
    sourceRaw: chosen.value,
    sourceDisplay: padTime(chosen.value),
  };
}

function buildConnectionServiceEntries(
  entries,
  corridorSet,
  bufferMinutes = DEFAULT_CONNECTION_BUFFER_MINUTES,
) {
  function sourceIdentityFromEntry(sourceEntry) {
    const sourceSvc = sourceEntry?.svc || {};
    const sourceDetail = sourceEntry?.detail || {};
    const sourceUid = sourceSvc.serviceUid || "";
    const sourceRunDate = sourceSvc.runDate || sourceDetail.runDate || "";
    const sourceServiceKey =
      sourceUid || sourceRunDate ? `${sourceUid}|${sourceRunDate}` : "";
    return { sourceUid, sourceRunDate, sourceServiceKey };
  }

  const generated = [];
  const seen = new Set();
  const generatedByContentKey = new Map();
  let loggedCorridorSkips = 0;
  let loggedTerminalSkips = 0;

  function pushGeneratedConnection({
    sourceEntry,
    fromCrs,
    toCrs,
    departMins,
    arriveMins,
    mode,
    sourceTimeInfo,
    previousCrs,
    matchedPreviousStations,
    placement = "after",
    directionLabel = "Connection",
  }) {
    const departTime = minutesToRttTime(departMins);
    const arriveTime = minutesToRttTime(arriveMins);
    const modeLower = (mode || "walk").toLowerCase();
    const atocCode = modeLower === "walk" ? "W" : "U";
    const atocName =
      modeLower === "walk" ? "Walk" : mode || "Connection";
    const runDate =
      sourceEntry.svc?.runDate ||
      sourceEntry.detail?.runDate ||
      sourceEntry.detail?.date ||
      "";
    const baseUid =
      sourceEntry.svc?.serviceUid ||
      sourceEntry.svc?.originalServiceUid ||
      sourceEntry.svc?.trainIdentity ||
      "CONN";
    const uniqueKey = [
      baseUid,
      runDate,
      fromCrs,
      toCrs,
      departTime,
      placement,
    ].join("|");
    if (seen.has(uniqueKey)) return;
    const contentKey = [
      runDate,
      fromCrs,
      toCrs,
      departTime,
      arriveTime,
    ].join("|");

    const svc = {
      serviceUid: `CONN-${baseUid}-${fromCrs}-${toCrs}-${departTime}`,
      runDate,
      atocCode,
      atocName,
      serviceType: modeLower === "walk" ? "walk" : "connection",
      isPassenger: true,
    };
    const detail = {
      runDate,
      serviceType: modeLower === "walk" ? "walk" : "connection",
      connectionMode: modeLower === "walk" ? "Walking" : mode || "Connection",
      locations: [
        {
          crs: fromCrs,
          gbttBookedDeparture: departTime,
          displayAs: "CALL",
          isPublicCall: true,
        },
        {
          crs: toCrs,
          gbttBookedArrival: arriveTime,
          displayAs: "CALL",
          isPublicCall: true,
        },
      ],
    };

    const sourceTimeDisplay =
      sourceTimeInfo.sourceDisplay || minutesToTimeStr(sourceTimeInfo.minutes);
    const sourceIdentity = sourceIdentityFromEntry(sourceEntry);
    logConnectionInfo(
      `${directionLabel} generated ${fromCrs} -> ${toCrs}: ` +
        `${toCrs} ${sourceTimeDisplay} (${sourceTimeInfo.sourceField || "unknown source"}) ` +
        `${placement === "before" ? "-" : "+"}${bufferMinutes}m buffer; ` +
        `${modeLower === "walk" ? "walk" : mode} ${Math.abs(arriveMins - departMins)}m`,
      {
        sourceServiceUid: baseUid,
        runDate,
        previousCrs,
        matchedPreviousStations: matchedPreviousStations || null,
        sourceRawTime: sourceTimeInfo.sourceRaw || null,
      },
    );
    const generatedEntry = {
      svc,
      detail,
      seed: false,
      isConnection: true,
      connectionPlacement: placement,
      connectionSourceServiceUid: sourceIdentity.sourceUid,
      connectionSourceRunDate: sourceIdentity.sourceRunDate,
      connectionSourceServiceKey: sourceIdentity.sourceServiceKey,
    };

    if (generatedByContentKey.has(contentKey)) {
      const existingIdx = generatedByContentKey.get(contentKey);
      const existing = generated[existingIdx] || {};
      const existingPlacement =
        (existing.connectionPlacement || existing.detail?.connectionPlacement || "after")
          .toLowerCase() === "before"
          ? "before"
          : "after";
      if (existingPlacement === "before" && placement === "after") {
        generated[existingIdx] = generatedEntry;
        seen.add(uniqueKey);
      }
      return;
    }

    seen.add(uniqueKey);
    generatedByContentKey.set(contentKey, generated.length);
    generated.push(generatedEntry);
  }

  entries.forEach((entry) => {
    if (!entry?.detail || !Array.isArray(entry.detail.locations)) return;
    getCallingContexts(entry.detail).forEach(({ previous, current, next }) => {
      const currentCrs = normaliseCrs(current?.crs || "");
      if (!currentCrs || !corridorSet.has(currentCrs)) return;
      const hasConnectionConfig = Object.prototype.hasOwnProperty.call(
        connectionsByStation,
        currentCrs,
      );
      const terminalEntries = getConnectionEntriesForStation(currentCrs);
      if (!terminalEntries.length) {
        if (hasConnectionConfig && loggedTerminalSkips < 5) {
          logConnectionInfo(
            "Connection skip: no connections for station",
            currentCrs,
          );
          loggedTerminalSkips += 1;
        }
        return;
      }

      const previousCrsList = normaliseCallingCrsList(previous);
      const previousCrs = previousCrsList[previousCrsList.length - 1] || "";
      const currentTimeInfo = locationTimeInfo(current);
      const currentMins = currentTimeInfo.minutes;

      if (currentMins === null) {
        logConnectionInfo(
          "Connection skip: station time missing",
          currentCrs,
        );
        return;
      }

      terminalEntries.forEach((terminalEntry) => {
        if (matchConnectionEntryForSide(terminalEntry, previousCrsList)) {
          Object.entries(terminalEntry.connections || {}).forEach(
            ([destCrsRaw, meta]) => {
              const destCrs = normaliseCrs(destCrsRaw);
              if (!destCrs) {
                if (loggedCorridorSkips < 5) {
                  logConnectionInfo(
                    "Connection skip: missing destination CRS",
                    currentCrs,
                  );
                  loggedCorridorSkips += 1;
                }
                return;
              }
              if (!corridorSet.has(destCrs)) {
                if (loggedCorridorSkips < 5) {
                  logConnectionInfo(
                    "Connection skip: destination not in corridor",
                    currentCrs,
                    destCrs,
                  );
                  loggedCorridorSkips += 1;
                }
                return;
              }
              const durationMinutes = meta.durationMinutes;
              if (!durationMinutes) {
                if (loggedCorridorSkips < 5) {
                  logConnectionInfo(
                    "Connection skip: missing duration",
                    currentCrs,
                    destCrs,
                  );
                  loggedCorridorSkips += 1;
                }
                return;
              }
              const departMins = currentMins + bufferMinutes;
              const arriveMins = departMins + durationMinutes;
              pushGeneratedConnection({
                sourceEntry: entry,
                fromCrs: currentCrs,
                toCrs: destCrs,
                departMins,
                arriveMins,
                mode: meta.mode || "walk",
                sourceTimeInfo: currentTimeInfo,
                previousCrs,
                matchedPreviousStations: terminalEntry.previousStations,
                placement: "after",
                directionLabel: "Outbound connection",
              });
            },
          );
        } else {
          if (previousCrs && loggedCorridorSkips < 5) {
            logConnectionInfo(
              "Connection skip: previous station mismatch",
              currentCrs,
              previousCrs,
              terminalEntry.previousStations,
            );
            loggedCorridorSkips += 1;
          }
        }

        const nextCrsList = normaliseCallingCrsList(next);
        const nextCrs = nextCrsList[0] || "";
        if (matchConnectionEntryForSide(terminalEntry, nextCrsList)) {
          Object.entries(terminalEntry.connections || {}).forEach(
            ([destCrsRaw, meta]) => {
              const destCrs = normaliseCrs(destCrsRaw);
              if (!destCrs || !corridorSet.has(destCrs)) return;
              const durationMinutes = meta.durationMinutes;
              if (!durationMinutes) return;
              const arriveAtCurrentMins = currentMins - bufferMinutes;
              const departFromFeederMins = arriveAtCurrentMins - durationMinutes;
              pushGeneratedConnection({
                sourceEntry: entry,
                fromCrs: destCrs,
                toCrs: currentCrs,
                departMins: departFromFeederMins,
                arriveMins: arriveAtCurrentMins,
                mode: meta.mode || "walk",
                sourceTimeInfo: currentTimeInfo,
                previousCrs: nextCrs,
                matchedPreviousStations: terminalEntry.previousStations,
                placement: "before",
                directionLabel: "Inbound connection",
              });
            },
          );
        } else if (nextCrs && loggedCorridorSkips < 5) {
          logConnectionInfo(
            "Connection skip: next station mismatch",
            currentCrs,
            nextCrs,
            terminalEntry.previousStations,
          );
          loggedCorridorSkips += 1;
        }
      });
    });
  });

  return generated;
}
