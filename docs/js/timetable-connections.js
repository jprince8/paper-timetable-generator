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

function normaliseConnectionConstraintList(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const values = value;
  const include = [];
  const exclude = [];
  values.forEach((raw) => {
    if (raw === null || raw === undefined) return;
    const text = String(raw).trim();
    if (!text) return;
    const isExcluded = text.startsWith("~");
    const crs = normaliseCrs(isExcluded ? text.slice(1) : text);
    if (!crs) return;
    if (isExcluded) {
      exclude.push(crs);
    } else {
      include.push(crs);
    }
  });
  if (include.length === 0 && exclude.length === 0) return null;
  return { include, exclude };
}

function normaliseConnectionRuleConstraints(value) {
  if (!value || typeof value !== "object") {
    return {
      previousStations: null,
      nextStations: null,
    };
  }
  return {
    previousStations: normaliseConnectionConstraintList(value.previousStations),
    nextStations: normaliseConnectionConstraintList(value.nextStations),
  };
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
          if (!destCrs || !Array.isArray(meta)) return;
          const metaCandidates = meta;
          const cleanedMeta = metaCandidates
            .map((candidate) => {
              if (!candidate || typeof candidate !== "object") return null;
              const durationMinutes = candidate.durationMinutes;
              if (
                typeof durationMinutes !== "number" ||
                Number.isNaN(durationMinutes) ||
                durationMinutes <= 0
              ) {
                return null;
              }
              return {
                durationMinutes,
                mode: candidate.mode || "",
                constraints: normaliseConnectionRuleConstraints(candidate),
              };
            })
            .filter(Boolean);
          if (cleanedMeta.length === 0) return;
          cleanedConnections[destCrs] = cleanedMeta;
        });
        if (Object.keys(cleanedConnections).length === 0) return null;
        return {
          constraints: normaliseConnectionRuleConstraints(entry),
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

function matchConnectionConstraint(constraint, sideCrsList) {
  if (!constraint) return true;
  const crsList = Array.isArray(sideCrsList) ? sideCrsList : [];
  if (
    constraint.exclude.length > 0 &&
    crsList.some((crs) => constraint.exclude.includes(crs))
  ) {
    return false;
  }
  if (constraint.include.length === 0) return true;
  if (crsList.length === 0) return false;
  return crsList.some((crs) => constraint.include.includes(crs));
}

function matchConnectionRuleConstraints(constraints, previousCrsList, nextCrsList) {
  const normalisedConstraints =
    constraints && typeof constraints === "object" ? constraints : {};
  return (
    matchConnectionConstraint(
      normalisedConstraints.previousStations || null,
      previousCrsList,
    ) &&
    matchConnectionConstraint(
      normalisedConstraints.nextStations || null,
      nextCrsList,
    )
  );
}

function locationTimeInfoFromCandidates(loc, candidates) {
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

function locationArrivalTimeInfo(loc) {
  return locationTimeInfoFromCandidates(loc, [
    { field: "gbttBookedArrival", value: loc?.gbttBookedArrival || "" },
    { field: "realtimeArrival", value: loc?.realtimeArrival || "" },
  ]);
}

function locationDepartureTimeInfo(loc) {
  return locationTimeInfoFromCandidates(loc, [
    { field: "gbttBookedDeparture", value: loc?.gbttBookedDeparture || "" },
    { field: "realtimeDeparture", value: loc?.realtimeDeparture || "" },
  ]);
}

function shouldSkipConnection(fromCrs, toCrs, corridorStations) {
  const fromIndex = corridorStations.indexOf(fromCrs);
  const toIndex = corridorStations.indexOf(toCrs);
  if (fromIndex === -1 || toIndex === -1) return false; // not in user specification, allow
  return fromIndex > toIndex; // from appears after to in specification, skip
}

function buildConnectionServiceEntries(
  entries,
  corridorSet,
  bufferMinutes = DEFAULT_CONNECTION_BUFFER_MINUTES,
  connectionDirection = "both",
  corridorStations = [],
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
  let loggedSkips = 0;

  function shouldLogSkip() {
    if (loggedSkips >= 20) return false;
    loggedSkips += 1;
    return true;
  }

  function isRealServiceEntry(entry) {
    return (
      entry &&
      entry.detail &&
      Array.isArray(entry.detail.locations) &&
      entry.isConnection !== true &&
      entry.detail.isConnection !== true &&
      entry.svc?.serviceType !== "connection" &&
      entry.svc?.serviceType !== "walk" &&
      entry.detail?.serviceType !== "connection" &&
      entry.detail?.serviceType !== "walk"
    );
  }

  function makeServiceContext(entry, previous, current, next) {
    const currentCrs = normaliseCrs(current?.crs || "");
    const previousCrsList = normaliseCallingCrsList(previous);
    const nextCrsList = normaliseCallingCrsList(next);

    const hasPreviousEligible = previous.some((loc) => {
      const crs = normaliseCrs(loc?.crs || "");
      return crs && corridorSet.has(crs);
    });

    const hasNextEligible = next.some((loc) => {
      const crs = normaliseCrs(loc?.crs || "");
      return crs && corridorSet.has(crs);
    });

    return {
      entry,
      current,
      currentCrs,
      previous,
      next,
      previousCrsList,
      nextCrsList,
      previousCrs: previousCrsList[previousCrsList.length - 1] || "",
      nextCrs: nextCrsList[0] || "",
      hasPreviousEligible,
      hasNextEligible,
      arrivalTimeInfo: locationArrivalTimeInfo(current),
      departureTimeInfo: locationDepartureTimeInfo(current),
    };
  }

  function buildContextsByStation() {
    const byStation = new Map();

    entries.forEach((entry) => {
      if (!isRealServiceEntry(entry)) return;

      getCallingContexts(entry.detail).forEach(({ previous, current, next }) => {
        const currentCrs = normaliseCrs(current?.crs || "");
        if (!currentCrs || !corridorSet.has(currentCrs)) return;

        const context = makeServiceContext(entry, previous, current, next);

        if (!byStation.has(currentCrs)) {
          byStation.set(currentCrs, []);
        }
        byStation.get(currentCrs).push(context);
      });
    });

    return byStation;
  }

  const contextsByStation = buildContextsByStation();

  function contextsForStation(crs) {
    return contextsByStation.get(crs) || [];
  }

  function contextMatchesConstraints(context, constraints) {
    if (!context) return false;
    return matchConnectionRuleConstraints(
      constraints,
      context.previousCrsList,
      context.nextCrsList,
    );
  }

  function hasMatchingRealServiceAt(stationCrs, constraints) {
    return contextsForStation(stationCrs).some((context) =>
      contextMatchesConstraints(context, constraints),
    );
  }

  function pushGeneratedConnection({
    sourceEntry,
    fromCrs,
    toCrs,
    departMins,
    arriveMins,
    mode,
    durationMinutes,
    sourceTimeInfo,
    previousCrs,
    matchedConstraints,
    placement = "after",
    directionLabel = "Connection",
  }) {
    if (departMins === null || arriveMins === null) return;

    const departTime = minutesToRttTime(departMins);
    const arriveTime = minutesToRttTime(arriveMins);
    const modeLower = (mode || "walk").toLowerCase();
    const atocCode = modeLower === "walk" ? "W" : "U";
    const atocName = modeLower === "walk" ? "Walk" : mode || "Connection";

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

    const substantiveKey = [
      runDate,
      fromCrs,
      toCrs,
      departTime,
      arriveTime,
      modeLower,
      durationMinutes,
      placement,
    ].join("|");

    if (seen.has(substantiveKey)) return;
    seen.add(substantiveKey);

    const svc = {
      serviceUid: `CONN-${baseUid}-${fromCrs}-${toCrs}-${departTime}-${placement}`,
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
        `${sourceTimeDisplay} (${sourceTimeInfo.sourceField || "unknown source"}); ` +
        `${placement === "before" ? "-" : "+"}${bufferMinutes}m buffer; ` +
        `${modeLower === "walk" ? "walk" : mode} ${durationMinutes}m`,
      {
        sourceServiceUid: baseUid,
        runDate,
        previousCrs,
        matchedConstraints: matchedConstraints || null,
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

  function shouldGenerateOutbound() {
    return connectionDirection === "outbound" || connectionDirection === "both";
  }

  function shouldGenerateInbound() {
    return connectionDirection === "inbound" || connectionDirection === "both";
  }

  Object.entries(connectionsByStation).forEach(([originRaw, originEntries]) => {
    const originCrs = normaliseCrs(originRaw);
    if (!originCrs || !corridorSet.has(originCrs)) return;
    if (!Array.isArray(originEntries)) return;

    originEntries.forEach((originRule) => {
      if (!originRule || typeof originRule !== "object") return;

      const originConstraints = originRule.constraints || {};
      const connections = originRule.connections || {};

      Object.entries(connections).forEach(([destRaw, variants]) => {
        const destCrs = normaliseCrs(destRaw);
        if (!destCrs || !corridorSet.has(destCrs)) return;
        if (!Array.isArray(variants)) return;

        if (shouldSkipConnection(originCrs, destCrs, corridorStations)) {
          if (shouldLogSkip()) {
            logConnectionInfo(
              "Connection skip: violates user specification order",
              originCrs,
              destCrs,
            );
          }
          return;
        }

        variants.forEach((variant) => {
          if (!variant || typeof variant !== "object") return;

          const durationMinutes = variant.durationMinutes;
          if (
            typeof durationMinutes !== "number" ||
            Number.isNaN(durationMinutes) ||
            durationMinutes <= 0
          ) {
            if (shouldLogSkip()) {
              logConnectionInfo(
                "Connection skip: invalid duration",
                originCrs,
                destCrs,
                variant,
              );
            }
            return;
          }

          const destConstraints = variant.constraints || {};
          const mode = variant.mode || "walk";

          if (shouldGenerateOutbound()) {
            const originContexts = contextsForStation(originCrs);

            originContexts.forEach((originContext) => {
              if (!originContext.hasPreviousEligible) {
                return;
              }

              const arrivalMins = originContext.arrivalTimeInfo.minutes;
              if (arrivalMins === null) {
                if (shouldLogSkip()) {
                  logConnectionInfo(
                    "Connection skip: outbound origin arrival missing",
                    originCrs,
                    destCrs,
                  );
                }
                return;
              }

              if (!contextMatchesConstraints(originContext, originConstraints)) {
                return;
              }

              if (!hasMatchingRealServiceAt(destCrs, destConstraints)) {
                return;
              }

              const departMins = arrivalMins + bufferMinutes;
              const arriveMins = departMins + durationMinutes;

              pushGeneratedConnection({
                sourceEntry: originContext.entry,
                fromCrs: originCrs,
                toCrs: destCrs,
                departMins,
                arriveMins,
                mode,
                durationMinutes,
                sourceTimeInfo: originContext.arrivalTimeInfo,
                previousCrs: originContext.previousCrs,
                matchedConstraints: originConstraints,
                placement: "after",
                directionLabel: "Outbound connection",
              });
            });
          }

          if (shouldGenerateInbound()) {
            const destContexts = contextsForStation(destCrs);

            destContexts.forEach((destContext) => {
              if (!destContext.hasNextEligible) {
                return;
              }

              const departureMins = destContext.departureTimeInfo.minutes;
              if (departureMins === null) {
                if (shouldLogSkip()) {
                  logConnectionInfo(
                    "Connection skip: inbound destination departure missing",
                    originCrs,
                    destCrs,
                  );
                }
                return;
              }

              if (!contextMatchesConstraints(destContext, destConstraints)) {
                return;
              }

              if (!hasMatchingRealServiceAt(originCrs, originConstraints)) {
                return;
              }

              const arriveMins = departureMins - bufferMinutes;
              const departMins = arriveMins - durationMinutes;

              pushGeneratedConnection({
                sourceEntry: destContext.entry,
                fromCrs: originCrs,
                toCrs: destCrs,
                departMins,
                arriveMins,
                mode,
                durationMinutes,
                sourceTimeInfo: destContext.departureTimeInfo,
                previousCrs: destContext.nextCrs,
                matchedConstraints: destConstraints,
                placement: "before",
                directionLabel: "Inbound connection",
              });
            });
          }
        });
      });
    });
  });

  return generated;
}