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

function getFirstCallingPair(detail) {
  const locs = detail.locations || [];
  let first = null;
  let next = null;
  for (let i = 0; i < locs.length; i += 1) {
    const loc = locs[i];
    if (!isCallingLocation(loc)) continue;
    if (!first) {
      first = loc;
    } else {
      next = loc;
      break;
    }
  }
  return { first, next };
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
  let loggedCorridorSkips = 0;
  let loggedTerminalSkips = 0;
  const inboundCandidatesByDest = new Map();

  Object.entries(connectionsByStation).forEach(([fromCrsRaw, terminalEntries]) => {
    const fromCrs = normaliseCrs(fromCrsRaw);
    if (!fromCrs || !Array.isArray(terminalEntries)) return;
    terminalEntries.forEach((terminalEntry) => {
      if (!terminalEntry || typeof terminalEntry !== "object") return;
      const connections = terminalEntry.connections || {};
      Object.entries(connections).forEach(([destCrsRaw, meta]) => {
        const destCrs = normaliseCrs(destCrsRaw);
        if (!destCrs || !meta || typeof meta !== "object") return;
        if (!inboundCandidatesByDest.has(destCrs)) {
          inboundCandidatesByDest.set(destCrs, []);
        }
        inboundCandidatesByDest.get(destCrs).push({
          fromCrs,
          destCrs,
          meta,
          terminalEntry,
        });
      });
    });
  });

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
    seen.add(uniqueKey);

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
    generated.push({
      svc,
      detail,
      seed: false,
      isConnection: true,
      connectionPlacement: placement,
      connectionSourceServiceUid: sourceIdentity.sourceUid,
      connectionSourceRunDate: sourceIdentity.sourceRunDate,
      connectionSourceServiceKey: sourceIdentity.sourceServiceKey,
    });
  }

  entries.forEach((entry) => {
    if (!entry?.detail || !Array.isArray(entry.detail.locations)) return;
    const { last, previous } = getLastCallingPair(entry.detail);
    const terminalCrs = normaliseCrs(last?.crs || "");
    if (!terminalCrs) {
      logConnectionInfo("Connection skip: missing terminal CRS", entry);
    } else if (corridorSet.has(terminalCrs)) {
      const previousCrs = normaliseCrs(previous?.crs || "");
      const hasConnectionConfig = Object.prototype.hasOwnProperty.call(
        connectionsByStation,
        terminalCrs,
      );
      const terminalEntries = getConnectionEntriesForStation(terminalCrs);
      if (!terminalEntries.length) {
        if (hasConnectionConfig && loggedTerminalSkips < 5) {
          logConnectionInfo(
            "Connection skip: no connections for terminal",
            terminalCrs,
          );
          loggedTerminalSkips += 1;
        }
      } else {
        const arrivalInfo = locationTimeInfo(last);
        const arrivalMins = arrivalInfo.minutes;
        if (arrivalMins === null) {
          logConnectionInfo(
            "Connection skip: terminal arrival time missing",
            terminalCrs,
          );
        } else {
          terminalEntries.forEach((terminalEntry) => {
            if (!matchConnectionEntry(terminalEntry, previousCrs)) {
              if (loggedCorridorSkips < 5) {
                logConnectionInfo(
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
                    logConnectionInfo(
                      "Connection skip: missing destination CRS",
                      terminalCrs,
                    );
                    loggedCorridorSkips += 1;
                  }
                  return;
                }
                if (!corridorSet.has(destCrs)) {
                  if (loggedCorridorSkips < 5) {
                    logConnectionInfo(
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
                    logConnectionInfo(
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
                pushGeneratedConnection({
                  sourceEntry: entry,
                  fromCrs: terminalCrs,
                  toCrs: destCrs,
                  departMins,
                  arriveMins,
                  mode: meta.mode || "walk",
                  sourceTimeInfo: arrivalInfo,
                  previousCrs,
                  matchedPreviousStations: terminalEntry.previousStations,
                  placement: "after",
                  directionLabel: "Outbound connection",
                });
              },
            );
          });
        }
      }
    }

    const { first, next } = getFirstCallingPair(entry.detail);
    const originCrs = normaliseCrs(first?.crs || "");
    if (!originCrs || !corridorSet.has(originCrs)) {
      return;
    }
    const departureInfo = locationTimeInfo(first);
    const departureMins = departureInfo.minutes;
    if (departureMins === null) {
      logConnectionInfo(
        "Connection skip: origin departure time missing",
        originCrs,
      );
      return;
    }
    const nextCrs = normaliseCrs(next?.crs || "");
    const inboundCandidates = inboundCandidatesByDest.get(originCrs) || [];
    inboundCandidates.forEach((candidate) => {
      const fromCrs = candidate.fromCrs;
      const durationMinutes = candidate.meta?.durationMinutes;
      if (!fromCrs || !corridorSet.has(fromCrs)) return;
      if (!durationMinutes) return;

      // Inbound links are anchored to the source service origin. Because we are
      // synthesising "arrival into this service", prior calling pattern at the
      // feeder origin is unknown, so previousStations constraints are not enforced.
      const arriveAtOriginMins = departureMins - bufferMinutes;
      const departFromFeederMins = arriveAtOriginMins - durationMinutes;
      pushGeneratedConnection({
        sourceEntry: entry,
        fromCrs,
        toCrs: originCrs,
        departMins: departFromFeederMins,
        arriveMins: arriveAtOriginMins,
        mode: candidate.meta.mode || "walk",
        sourceTimeInfo: departureInfo,
        previousCrs: nextCrs,
        matchedPreviousStations: candidate.terminalEntry?.previousStations,
        placement: "before",
        directionLabel: "Inbound connection",
      });
    });
  });

  return generated;
}
