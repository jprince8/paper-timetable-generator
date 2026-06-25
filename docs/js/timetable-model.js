function computeDisplayStationsForServices(stationsList, svcs) {
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

function filterServicesForTimetableModel(stations, servicesWithDetails) {
  let workingServices = servicesWithDetails.slice();
  let displayStations = [];

  let prevKey = "";
  for (let iter = 0; iter < 5; iter++) {
    displayStations = computeDisplayStationsForServices(
      stations,
      workingServices,
    );
    const displaySet = new Set(
      displayStations.map((s) => s.crs).filter(Boolean),
    );

    const filtered = workingServices.filter(
      ({ detail }) =>
        serviceCallsAtLeastTwoInSet(detail, displaySet) &&
        serviceCallsAllStationsInRange(detail, displaySet),
    );

    const key =
      displayStations.map((s) => s.crs).join(",") + "|" + filtered.length;

    if (key === prevKey) {
      workingServices = filtered;
      break;
    }
    prevKey = key;
    workingServices = filtered;
  }

  return { services: workingServices, displayStations };
}

function timetableModelAssert(condition, userMessage, detail = {}) {
  if (condition) return;
  if (typeof assertWithStatus === "function") {
    assertWithStatus(condition, userMessage, detail);
    return;
  }
  let detailText = "";
  try {
    detailText = JSON.stringify(detail);
  } catch (err) {
    detailText = String(detail);
  }
  throw new Error(detailText ? `${userMessage} (${detailText})` : userMessage);
}

function serviceDebugLabel(entry, meta, svcIndex) {
  const svc = entry?.svc || {};
  const detail = entry?.detail || {};
  const uid = svc.serviceUid || svc.originalServiceUid || "";
  const trainId = svc.trainIdentity || svc.runningIdentity || "";
  const runDate = svc.runDate || detail.runDate || "";
  const operator = meta?.visible || svc.atocCode || detail.atocCode || "";
  return [operator, trainId, uid, runDate]
    .filter(Boolean)
    .join(" ")
    .trim() || `service #${svcIndex + 1}`;
}

function serviceLocationDebugSummary(entry) {
  const locs = entry?.detail?.locations || [];
  return locs.map((loc) => {
    const crs = loc.crs || "";
    const displayAs = loc.displayAs || "";
    const arr = padTime(
      loc.gbttBookedArrival ||
        loc.realtimeArrival ||
        loc.publicArrival ||
        "",
    );
    const dep = padTime(
      loc.gbttBookedDeparture ||
        loc.realtimeDeparture ||
        loc.publicDeparture ||
        "",
    );
    const publicFlag = loc.isPublicCall === true ? "public" : "non-public";
    const timeText = arr && dep && arr !== dep ? `${arr}/${dep}` : arr || dep;
    return [crs, timeText, displayAs, publicFlag].filter(Boolean).join(" ");
  });
}

function assertNoBlankRenderedStationRows(rows, rowSpecs, displayStations) {
  const blankRows = [];
  rows.forEach((row, rowIdx) => {
    const spec = rowSpecs[rowIdx];
    if (spec?.kind !== "station") return;
    const hasVisibleCell = (row.cells || []).some((cell) => {
      const text = cellToText(cell).trim();
      return text && text !== "|";
    });
    if (hasVisibleCell) return;
    const station = displayStations[spec.stationIndex] || {};
    blankRows.push({
      row: rowIdx,
      crs: station.crs || "",
      name: station.name || row.labelStation || "",
      label: row.labelArrDep || "",
    });
  });

  timetableModelAssert(
    blankRows.length === 0,
    "Timetable contains a blank station row.",
    { rows: blankRows },
  );
}

function assertNoBlankRenderedServiceColumns(
  rows,
  rowSpecs,
  servicesWithDetails,
  orderedSvcIndices,
  servicesMeta,
) {
  const stationRowIndices = rowSpecs
    .map((spec, rowIdx) => (spec?.kind === "station" ? rowIdx : null))
    .filter((rowIdx) => rowIdx !== null);
  const blankServices = [];

  (orderedSvcIndices || []).forEach((svcIndex, orderedPosition) => {
    const meta = servicesMeta?.[svcIndex] || null;
    if (meta?.isSpacer === true || svcIndex >= servicesWithDetails.length) {
      return;
    }
    const hasVisibleCell = stationRowIndices.some((rowIdx) => {
      const text = cellToText(rows[rowIdx]?.cells?.[svcIndex]).trim();
      return text && text !== "|";
    });
    if (hasVisibleCell) return;
    const rowSamples = stationRowIndices.map((rowIdx) => {
      const spec = rowSpecs[rowIdx] || {};
      const row = rows[rowIdx] || {};
      return {
        row: rowIdx,
        stationIndex: spec.stationIndex,
        station: row.labelStation || "",
        label: row.labelArrDep || "",
        mode: spec.mode || "",
        text: cellToText(row.cells?.[svcIndex]),
      };
    });
    blankServices.push({
      index: svcIndex,
      orderedPosition,
      service: serviceDebugLabel(
        servicesWithDetails[svcIndex],
        meta,
        svcIndex,
      ),
      meta,
      rows: rowSamples,
      locations: serviceLocationDebugSummary(servicesWithDetails[svcIndex]),
    });
  });

  timetableModelAssert(
    blankServices.length === 0,
    "Timetable contains a blank service column.",
    { services: blankServices },
  );
}

function cellTimeMinutes(cell) {
  if (!cell) return null;
  if (cell && typeof cell === "object" && cell.format?.strike) return null;
  const text = typeof cell === "object" ? cell.text || "" : String(cell || "");
  if (!text || text === "|") return null;
  return timeStrToMinutes(text);
}

function isDepartureRowSpec(spec) {
  return (
    spec?.kind === "station" &&
    (spec.mode === "dep" || spec.mode === "merged" || spec.mode === "single")
  );
}

function isArrivalRowSpec(spec) {
  return (
    spec?.kind === "station" &&
    (spec.mode === "arr" || spec.mode === "merged" || spec.mode === "single")
  );
}

function getStationRowIndices(rowSpecs) {
  const indices = [];
  rowSpecs.forEach((spec, idx) => {
    if (spec?.kind === "station") indices.push(idx);
  });
  return indices;
}

function getServiceTimedStationRows(model, svcIndex) {
  const rows = model.rows || [];
  const rowSpecs = model.rowSpecs || [];
  return getStationRowIndices(rowSpecs).filter((rowIdx) => {
    return cellTimeMinutes(rows[rowIdx]?.cells?.[svcIndex]) !== null;
  });
}

function findFirstDepartureAtStation(model, stationIndex) {
  let first = null;
  const rows = model.rows || [];
  const rowSpecs = model.rowSpecs || [];
  rowSpecs.forEach((spec, rowIdx) => {
    if (spec?.kind !== "station" || spec.stationIndex !== stationIndex) return;
    if (!isDepartureRowSpec(spec)) return;
    (model.orderedSvcIndices || []).forEach((svcIndex) => {
      const mins = cellTimeMinutes(rows[rowIdx]?.cells?.[svcIndex]);
      if (mins === null) return;
      if (first === null || mins < first) first = mins;
    });
  });
  return first;
}

function findFinalArrivalAtStation(model, stationIndex) {
  let last = null;
  const rows = model.rows || [];
  const rowSpecs = model.rowSpecs || [];
  rowSpecs.forEach((spec, rowIdx) => {
    if (spec?.kind !== "station" || spec.stationIndex !== stationIndex) return;
    if (!isArrivalRowSpec(spec)) return;
    (model.orderedSvcIndices || []).forEach((svcIndex) => {
      const mins = cellTimeMinutes(rows[rowIdx]?.cells?.[svcIndex]);
      if (mins === null) return;
      if (last === null || mins > last) last = mins;
    });
  });
  return last;
}

function collectReachableServiceIndices(model) {
  const rows = model.rows || [];
  const rowSpecs = model.rowSpecs || [];
  const displayStations = model.displayStations || [];
  const orderedSvcIndices = (model.orderedSvcIndices || []).filter(
    (idx) =>
      Number.isInteger(idx) &&
      idx >= 0 &&
      idx < (model.servicesWithDetails || []).length,
  );

  if (displayStations.length < 2 || orderedSvcIndices.length === 0) {
    return null;
  }

  const firstStationIndex = 0;
  const lastStationIndex = displayStations.length - 1;
  const firstDeparture = findFirstDepartureAtStation(model, firstStationIndex);
  const finalArrival = findFinalArrivalAtStation(model, lastStationIndex);
  if (firstDeparture === null || finalArrival === null) return null;

  const serviceTimedRows = new Map();
  orderedSvcIndices.forEach((svcIndex) => {
    serviceTimedRows.set(svcIndex, getServiceTimedStationRows(model, svcIndex));
  });

  const earliestAtStation = new Array(displayStations.length).fill(null);
  earliestAtStation[firstStationIndex] = firstDeparture;
  const forwardReachable = new Set();

  for (let iter = 0; iter < orderedSvcIndices.length + displayStations.length; iter++) {
    let changed = false;
    orderedSvcIndices.forEach((svcIndex) => {
      const timedRows = serviceTimedRows.get(svcIndex) || [];
      if (timedRows.length < 2) return;
      const lastTimedRow = timedRows[timedRows.length - 1];
      let boarded = false;

      timedRows.forEach((rowIdx) => {
        const spec = rowSpecs[rowIdx];
        const stationIndex = spec?.stationIndex;
        if (stationIndex === null || stationIndex === undefined) return;
        const mins = cellTimeMinutes(rows[rowIdx]?.cells?.[svcIndex]);
        if (mins === null) return;

        if (
          isDepartureRowSpec(spec) &&
          earliestAtStation[stationIndex] !== null &&
          earliestAtStation[stationIndex] <= mins
        ) {
          boarded = true;
          if (rowIdx !== lastTimedRow) forwardReachable.add(svcIndex);
        }

        if (boarded && isArrivalRowSpec(spec)) {
          const current = earliestAtStation[stationIndex];
          if (current === null || mins < current) {
            earliestAtStation[stationIndex] = mins;
            changed = true;
          }
        }
      });
    });
    if (!changed) break;
  }

  const latestAtStation = new Array(displayStations.length).fill(null);
  latestAtStation[lastStationIndex] = finalArrival;
  const backwardReachable = new Set();

  for (let iter = 0; iter < orderedSvcIndices.length + displayStations.length; iter++) {
    let changed = false;
    orderedSvcIndices.forEach((svcIndex) => {
      const timedRows = serviceTimedRows.get(svcIndex) || [];
      if (timedRows.length < 2) return;
      const firstTimedRow = timedRows[0];
      let reachesDestination = false;

      for (let i = timedRows.length - 1; i >= 0; i--) {
        const rowIdx = timedRows[i];
        const spec = rowSpecs[rowIdx];
        const stationIndex = spec?.stationIndex;
        if (stationIndex === null || stationIndex === undefined) continue;
        const mins = cellTimeMinutes(rows[rowIdx]?.cells?.[svcIndex]);
        if (mins === null) continue;

        if (
          isArrivalRowSpec(spec) &&
          latestAtStation[stationIndex] !== null &&
          mins <= latestAtStation[stationIndex]
        ) {
          reachesDestination = true;
          if (rowIdx !== firstTimedRow) backwardReachable.add(svcIndex);
        }

        if (reachesDestination && isDepartureRowSpec(spec)) {
          const current = latestAtStation[stationIndex];
          if (current === null || mins > current) {
            latestAtStation[stationIndex] = mins;
            changed = true;
          }
        }
      }
    });
    if (!changed) break;
  }

  const reachable = new Set();
  orderedSvcIndices.forEach((svcIndex) => {
    if (forwardReachable.has(svcIndex) && backwardReachable.has(svcIndex)) {
      reachable.add(svcIndex);
    }
  });
  return reachable;
}

function filterReachableServicesFromModel(model) {
  const reachableIndices = collectReachableServiceIndices(model);
  if (!reachableIndices) return null;
  const services = model.servicesWithDetails || [];
  const filtered = services.filter((_, idx) => reachableIndices.has(idx));
  if (filtered.length === services.length) return null;
  return filtered;
}

function collectServiceStationTimes(model) {
  const rows = model.rows || [];
  const rowSpecs = model.rowSpecs || [];
  const displayStations = model.displayStations || [];
  const services = model.servicesWithDetails || [];
  const serviceTimes = new Map();

  services.forEach((_, svcIndex) => {
    serviceTimes.set(
      svcIndex,
      displayStations.map(() => ({ arr: null, dep: null })),
    );
  });

  rowSpecs.forEach((spec, rowIdx) => {
    if (spec?.kind !== "station") return;
    const stationIndex = spec.stationIndex;
    if (
      !Number.isInteger(stationIndex) ||
      stationIndex < 0 ||
      stationIndex >= displayStations.length
    ) {
      return;
    }

    services.forEach((_, svcIndex) => {
      const mins = cellTimeMinutes(rows[rowIdx]?.cells?.[svcIndex]);
      if (mins === null) return;
      const stationTime = serviceTimes.get(svcIndex)?.[stationIndex];
      if (!stationTime) return;
      if (isArrivalRowSpec(spec)) stationTime.arr = mins;
      if (isDepartureRowSpec(spec)) stationTime.dep = mins;
    });
  });

  return serviceTimes;
}

function collectFastestRouteLegs(model) {
  const displayStations = model.displayStations || [];
  const services = model.servicesWithDetails || [];
  const orderedSvcIndices = (model.orderedSvcIndices || []).filter(
    (idx) => Number.isInteger(idx) && idx >= 0 && idx < services.length,
  );

  if (displayStations.length < 2 || orderedSvcIndices.length === 0) {
    return null;
  }

  const lastStationIndex = displayStations.length - 1;
  const serviceTimes = collectServiceStationTimes(model);
  const legs = [];
  const legsFromStation = new Map();
  const legsToStation = new Map();

  orderedSvcIndices.forEach((svcIndex) => {
    const times = serviceTimes.get(svcIndex) || [];
    for (let from = 0; from < lastStationIndex; from++) {
      const dep = times[from]?.dep;
      if (dep === null || dep === undefined) continue;
      for (let to = from + 1; to <= lastStationIndex; to++) {
        const arr = times[to]?.arr;
        if (arr === null || arr === undefined) continue;
        if (arr < dep) continue;
        const leg = { svcIndex, from, to, dep, arr };
        legs.push(leg);
        if (!legsFromStation.has(from)) legsFromStation.set(from, []);
        legsFromStation.get(from).push(leg);
        if (!legsToStation.has(to)) legsToStation.set(to, []);
        legsToStation.get(to).push(leg);
      }
    }
  });

  if (legs.length === 0) return null;

  legs.forEach((leg, index) => {
    leg.index = index;
  });

  return { displayStations, lastStationIndex, legs, legsFromStation, legsToStation };
}

function collectForwardFastestRouteServiceIndices(routeGraph) {
  const { displayStations, lastStationIndex, legs, legsFromStation } = routeGraph;
  const startDepartures = new Set(
    (legsFromStation.get(0) || []).map((leg) => leg.dep),
  );
  if (startDepartures.size === 0) return null;

  const fastestServiceIndices = new Set();
  let foundPath = false;

  startDepartures.forEach((startDep) => {
    const earliestAtStation = new Array(displayStations.length).fill(null);
    const forwardReachableLegs = new Set();
    earliestAtStation[0] = startDep;

    for (let stationIndex = 0; stationIndex <= lastStationIndex; stationIndex++) {
      const earliest = earliestAtStation[stationIndex];
      if (earliest === null) continue;

      (legsFromStation.get(stationIndex) || []).forEach((leg) => {
        if (stationIndex === 0 && leg.dep !== startDep) return;
        if (leg.dep < earliest) return;
        forwardReachableLegs.add(leg.index);
        const current = earliestAtStation[leg.to];
        if (current === null || leg.arr < current) {
          earliestAtStation[leg.to] = leg.arr;
        }
      });
    }

    const fastestArrival = earliestAtStation[lastStationIndex];
    if (fastestArrival === null) return;
    foundPath = true;

    const latestAtStation = new Array(displayStations.length).fill(null);
    latestAtStation[lastStationIndex] = fastestArrival;

    for (let stationIndex = lastStationIndex - 1; stationIndex >= 0; stationIndex--) {
      (legsFromStation.get(stationIndex) || []).forEach((leg) => {
        const latestAtDestination = latestAtStation[leg.to];
        if (latestAtDestination === null) return;
        if (leg.arr > latestAtDestination) return;
        const current = latestAtStation[leg.from];
        if (current === null || leg.dep > current) {
          latestAtStation[leg.from] = leg.dep;
        }
      });
    }

    legs.forEach((leg) => {
      if (!forwardReachableLegs.has(leg.index)) return;
      const latestAtDestination = latestAtStation[leg.to];
      if (latestAtDestination === null) return;
      if (leg.arr > latestAtDestination) return;
      fastestServiceIndices.add(leg.svcIndex);
    });
  });

  if (!foundPath || fastestServiceIndices.size === 0) return null;
  return fastestServiceIndices;
}

function collectBackwardFastestRouteServiceIndices(routeGraph) {
  const { displayStations, lastStationIndex, legs, legsFromStation, legsToStation } =
    routeGraph;
  const finalArrivals = new Set(
    (legsToStation.get(lastStationIndex) || []).map((leg) => leg.arr),
  );
  if (finalArrivals.size === 0) return null;

  const fastestServiceIndices = new Set();
  let foundPath = false;

  finalArrivals.forEach((finalArr) => {
    const latestAtStation = new Array(displayStations.length).fill(null);
    latestAtStation[lastStationIndex] = finalArr;

    for (let stationIndex = lastStationIndex - 1; stationIndex >= 0; stationIndex--) {
      (legsFromStation.get(stationIndex) || []).forEach((leg) => {
        const latestAtDestination = latestAtStation[leg.to];
        if (latestAtDestination === null) return;
        if (leg.to === lastStationIndex && leg.arr !== finalArr) return;
        if (leg.arr > latestAtDestination) return;
        const current = latestAtStation[leg.from];
        if (current === null || leg.dep > current) {
          latestAtStation[leg.from] = leg.dep;
        }
      });
    }

    const fastestDeparture = latestAtStation[0];
    if (fastestDeparture === null) return;
    foundPath = true;

    const earliestAtStation = new Array(displayStations.length).fill(null);
    const forwardReachableLegs = new Set();
    earliestAtStation[0] = fastestDeparture;

    for (let stationIndex = 0; stationIndex <= lastStationIndex; stationIndex++) {
      const earliest = earliestAtStation[stationIndex];
      if (earliest === null) continue;

      (legsFromStation.get(stationIndex) || []).forEach((leg) => {
        if (stationIndex === 0 && leg.dep !== fastestDeparture) return;
        if (leg.to === lastStationIndex && leg.arr !== finalArr) return;
        if (leg.dep < earliest) return;
        forwardReachableLegs.add(leg.index);
        const current = earliestAtStation[leg.to];
        if (current === null || leg.arr < current) {
          earliestAtStation[leg.to] = leg.arr;
        }
      });
    }

    legs.forEach((leg) => {
      if (!forwardReachableLegs.has(leg.index)) return;
      const latestAtDestination = latestAtStation[leg.to];
      if (latestAtDestination === null) return;
      if (leg.to === lastStationIndex && leg.arr !== finalArr) return;
      if (leg.arr > latestAtDestination) return;
      fastestServiceIndices.add(leg.svcIndex);
    });
  });

  if (!foundPath || fastestServiceIndices.size === 0) return null;
  return fastestServiceIndices;
}

function collectFastestRouteServiceIndices(model) {
  const routeGraph = collectFastestRouteLegs(model);
  if (!routeGraph) return null;

  const forwardIndices = collectForwardFastestRouteServiceIndices(routeGraph);
  const backwardIndices = collectBackwardFastestRouteServiceIndices(routeGraph);
  if (!forwardIndices || !backwardIndices) return null;

  const fastestIndices = new Set();
  forwardIndices.forEach((svcIndex) => {
    if (backwardIndices.has(svcIndex)) fastestIndices.add(svcIndex);
  });

  if (fastestIndices.size === 0) return null;
  return fastestIndices;
}

function filterFastestRouteServicesFromModel(model) {
  const fastestIndices = collectFastestRouteServiceIndices(model);
  if (!fastestIndices) return null;
  const services = model.servicesWithDetails || [];
  const filtered = services.filter((_, idx) => fastestIndices.has(idx));
  if (filtered.length === services.length) return null;
  return filtered;
}

function buildBaseTimetableModel(
  stations,
  stationSet,
  servicesWithDetails,
  options = {},
) {
  const {
    realtimeEnabled: realtimeToggleEnabled = false,
    showPlatforms = false,
    atocNameByCode = {},
  } = options;

  const filterResult = filterServicesForTimetableModel(
    stations,
    servicesWithDetails,
  );
  servicesWithDetails = filterResult.services;
  const { displayStations } = filterResult;

  const numServices = servicesWithDetails.length;

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

  const serviceRealtimeFlags = servicesWithDetails.map(
    ({ detail }) => detail && detail.realtimeActivated === true,
  );
  const serviceSyntheticConnectionFlags = servicesWithDetails.map((entry) => {
    const svc = entry?.svc || {};
    const uid = svc.originalServiceUid || svc.serviceUid || "";
    return entry?.isConnection === true || String(uid).startsWith("CONN-");
  });
  const serviceAllCancelled = new Array(numServices).fill(false);
  const serviceAllNoReport = new Array(numServices).fill(false);
  const connectionEndpointCrs = new Set();

  servicesWithDetails.forEach((entry, svcIndex) => {
    const detail = entry?.detail || {};
    if (!serviceSyntheticConnectionFlags[svcIndex]) return;
    const locs = detail.locations || [];
    if (locs.length === 0) return;
    const fromCrs = locs[0]?.crs || "";
    const toCrs = locs[locs.length - 1]?.crs || "";
    if (fromCrs) connectionEndpointCrs.add(fromCrs);
    if (toCrs) connectionEndpointCrs.add(toCrs);
  });

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

      const useRealtimeForService =
        realtimeToggleEnabled && serviceRealtimeFlags[svcIndex] === true;
      const rawArr =
        loc.gbttBookedArrival ||
        (useRealtimeForService ? loc.realtimeArrival : "") ||
        "";
      const rawDep =
        loc.gbttBookedDeparture ||
        (useRealtimeForService ? loc.realtimeDeparture : "") ||
        "";

      const arrStr = rawArr ? padTime(rawArr) : "";
      const depStr = rawDep ? padTime(rawDep) : "";

      const arrMins = arrStr ? timeStrToMinutes(arrStr) : null;
      const depMins = depStr ? timeStrToMinutes(depStr) : null;

      stationTimes[stationIndex][svcIndex] = {
        arrStr,
        arrMins,
        depStr,
        depMins,
        loc,
      };
    });
  });

  const visibleTimeFlags = stationTimes.map((stationRow) =>
    stationRow.map((t) => ({
      arr: t?.arrMins !== null,
      dep: t?.depMins !== null,
    })),
  );

  for (let s = 0; s < numServices; s++) {
    const timedStationIndices = [];
    for (let stationIndex = 0; stationIndex < numStations; stationIndex++) {
      const t = stationTimes[stationIndex][s];
      if (!t?.loc) continue;
      if (t.arrMins === null && t.depMins === null) continue;
      timedStationIndices.push(stationIndex);
    }

    if (timedStationIndices.length === 0) continue;
    if (serviceSyntheticConnectionFlags[s]) continue;

    const firstStationIndex = timedStationIndices[0];
    const lastStationIndex = timedStationIndices[timedStationIndices.length - 1];

    if (stationTimes[firstStationIndex][s]?.arrMins !== null) {
      visibleTimeFlags[firstStationIndex][s].arr = false;
    }
    if (stationTimes[lastStationIndex][s]?.depMins !== null) {
      visibleTimeFlags[lastStationIndex][s].dep = false;
    }
  }

  for (let svcIndex = 0; svcIndex < numServices; svcIndex++) {
    let hasAny = false;
    let hasNonStrike = false;
    let hasAnyTime = false;
    let hasNonNoReport = false;
    for (let stationIndex = 0; stationIndex < numStations; stationIndex++) {
      const t = stationTimes[stationIndex][svcIndex];
      if (!t?.loc) continue;
      if (hasNonStrike) break;
      const useRealtimeForService =
        realtimeToggleEnabled && serviceRealtimeFlags[svcIndex] === true;
      const hasArr =
        t.loc.gbttBookedArrival ||
        (useRealtimeForService ? t.loc.realtimeArrival : "");
      const hasDep =
        t.loc.gbttBookedDeparture ||
        (useRealtimeForService ? t.loc.realtimeDeparture : "");
      if (hasArr) {
        const chosen = chooseDisplayedTimeAndStatus(
          t.loc,
          true,
          serviceRealtimeFlags[svcIndex] === true,
          realtimeToggleEnabled,
        );
        if (chosen.text) {
          hasAnyTime = true;
          if (!chosen.format?.noReport) hasNonNoReport = true;
          hasAny = true;
          if (!chosen.format?.strike) hasNonStrike = true;
        }
      }
      if (hasDep) {
        const chosen = chooseDisplayedTimeAndStatus(
          t.loc,
          false,
          serviceRealtimeFlags[svcIndex] === true,
          realtimeToggleEnabled,
        );
        if (chosen.text) {
          hasAnyTime = true;
          if (!chosen.format?.noReport) hasNonNoReport = true;
          hasAny = true;
          if (!chosen.format?.strike) hasNonStrike = true;
        }
      }
    }
    serviceAllCancelled[svcIndex] = hasAny && !hasNonStrike;
    serviceAllNoReport[svcIndex] = hasAnyTime && !hasNonNoReport;
  }

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
      const flags = visibleTimeFlags[i][s];

      const svc = servicesWithDetails[s].svc;
      const trainId =
        svc.trainIdentity ||
        svc.runningIdentity ||
        svc.serviceUid ||
        "svc#" + s;

      if (flags.arr && t.arrMins !== null) {
        hasArr = true;
        hasAny = true;
      }
      if (flags.dep && t.depMins !== null) {
        hasDep = true;
        hasAny = true;
      }

      if (flags.arr && flags.dep && t.arrMins !== null && t.depMins !== null) {
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
        ((flags.arr && t.arrMins !== null) || (flags.dep && t.depMins !== null))
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
      const station = displayStations[i];
      const forceSplitForConnection =
        station?.crs && connectionEndpointCrs.has(station.crs);
      if (hasLongDwell || forceSplitForConnection) {
        mode = "two";
      } else {
        mode = "merged";
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

  function buildEndpointMeta(location) {
    if (!location) return null;
    const crs = location.crs || "";
    const name = location.description || crs || location.tiploc || "";
    const display = crs || location.tiploc || name;
    return { display, title: name };
  }

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
        originMeta[idx] = buildEndpointMeta(firstLoc);
      }
    }

    if (lastLoc) {
      const crs = lastLoc.crs || "";
      if (!stationSet[crs]) {
        destMeta[idx] = buildEndpointMeta(lastLoc);
      }
    }
  });

  servicesWithDetails.forEach(({ svc }, idx) => {
    if (svc?.splitContinuesToLocation) {
      destMeta[idx] = buildEndpointMeta(svc.splitContinuesToLocation);
    }
    if (svc?.splitComesFromLocation) {
      originMeta[idx] = buildEndpointMeta(svc.splitComesFromLocation);
    }
  });

  const needTopExtra = originMeta.some((m) => !!m);
  const needBottomExtra = destMeta.some((m) => !!m);

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

  function makeRowsForSpecs(specs) {
    const rows = specs.map((spec) => ({
      kind: spec.kind,
      mode: spec.mode,
      labelStation: "",
      labelArrDep: "",
      cells: new Array(numServices).fill(""),
    }));

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
        const loc = t.loc;
        if (!loc) continue;
        const flags = visibleTimeFlags[stationIndex][s];

        const serviceRealtimeActivated = serviceRealtimeFlags[s] === true;

        let timeStr = "";
        let timeFormat = null;
        let platformInfo = null;
        if (mode === "arr") {
          if (!flags.arr) continue;
          const chosen = chooseDisplayedTimeAndStatus(
            loc,
            true,
            serviceRealtimeActivated,
            realtimeToggleEnabled,
          );
          timeStr = chosen.text;
          timeFormat = chosen.format;
        } else if (mode === "dep") {
          if (!flags.dep) continue;
          const chosen = chooseDisplayedTimeAndStatus(
            loc,
            false,
            serviceRealtimeActivated,
            realtimeToggleEnabled,
          );
          timeStr = chosen.text;
          timeFormat = chosen.format;
        } else if (mode === "merged" || mode === "single") {
          const useRealtimeForService =
            realtimeToggleEnabled && serviceRealtimeActivated;
          const hasVisibleDeparture =
            flags.dep &&
            Boolean(
              loc.gbttBookedDeparture ||
                (useRealtimeForService ? loc.realtimeDeparture : ""),
            );
          const hasVisibleArrival =
            flags.arr &&
            Boolean(
              loc.gbttBookedArrival ||
                (useRealtimeForService ? loc.realtimeArrival : ""),
            );
          if (!hasVisibleDeparture && !hasVisibleArrival) continue;
          const chosen = chooseDisplayedTimeAndStatus(
            loc,
            !hasVisibleDeparture,
            serviceRealtimeActivated,
            realtimeToggleEnabled,
          );
          timeStr = chosen.text;
          timeFormat = chosen.format;
        }

        if (timeStr) {
          if (showPlatforms) {
            const platform = String(loc.platform || "").trim();
            if (platform) {
              platformInfo = {
                text: `[${platform}]`,
                confirmed:
                  realtimeToggleEnabled && loc.platformConfirmed === true,
                changed: realtimeToggleEnabled && loc.platformChanged === true,
              };
            }
          }
          rows[r].cells[s] = {
            text: timeStr,
            format: timeFormat,
            platform: platformInfo,
          };
          if (firstRowForService[s] === null || r < firstRowForService[s])
            firstRowForService[s] = r;
          if (lastRowForService[s] === null || r > lastRowForService[s])
            lastRowForService[s] = r;
        }
      }
    }

    return { firstRowForService, lastRowForService };
  }

  let rowSpecs = makeRowSpecs(needTopExtra, needBottomExtra);
  let rows = makeRowsForSpecs(rowSpecs);
  let { firstRowForService, lastRowForService } = fillTimesIntoRows(
    rowSpecs,
    rows,
  );

  const totalRows = rowSpecs.length;

  const topExtraRowIdx = needTopExtra ? 0 : null;
  const bottomExtraRowIdx = needBottomExtra ? totalRows - 1 : null;

  servicesWithDetails.forEach((entry, svcIndex) => {
    const fromInfo = originMeta[svcIndex];
    const toInfo = destMeta[svcIndex];

    if (fromInfo && topExtraRowIdx !== null) {
      if (!rows[topExtraRowIdx].cells[svcIndex]) {
        rows[topExtraRowIdx].cells[svcIndex] = {
          text: fromInfo.display,
          title: fromInfo.title,
          format: { italic: true },
        };
      }
    }

    if (toInfo && bottomExtraRowIdx !== null) {
      if (!rows[bottomExtraRowIdx].cells[svcIndex]) {
        rows[bottomExtraRowIdx].cells[svcIndex] = {
          text: toInfo.display,
          title: toInfo.title,
          format: { italic: true },
        };
      }
    }
  });

  function applyStationLineFill() {
    const stationRowsInOrder = [];
    for (let r = 0; r < rowSpecs.length; r++) {
      if (rowSpecs[r].kind === "station") {
        stationRowsInOrder.push(r);
      }
    }

    // Reset previously generated pass-through markers before recomputing.
    for (const r of stationRowsInOrder) {
      for (let s = 0; s < numServices; s++) {
        const value = rows[r].cells[s];
        if (cellToText(value) === "|") {
          rows[r].cells[s] = "";
        }
      }
    }

    for (let s = 0; s < numServices; s++) {
      const called = stationRowsInOrder.map((r) => Boolean(cellToText(rows[r].cells[s])));

      const firstCalled = called.indexOf(true);
      if (firstCalled === -1) continue;
      let lastCalled = -1;
      for (let i = called.length - 1; i >= 0; i--) {
        if (called[i]) {
          lastCalled = i;
          break;
        }
      }
      if (lastCalled <= firstCalled) continue;

      for (let i = firstCalled + 1; i <= lastCalled - 1; i++) {
        if (called[i]) continue;
        const rowIndex = stationRowsInOrder[i];
        if (rows[rowIndex].cells[s] === "") {
          rows[rowIndex].cells[s] = { text: "|" };
        }
      }
    }
  }

  applyStationLineFill();

  const stationNameByCrs = new Map(
    displayStations.map((station) => [station.crs || "", station.name || ""]),
  );

  const servicesMeta = servicesWithDetails.map(({ svc, detail, isConnection }) => {
    const originText = safePairText(detail.origin);
    const destText = safePairText(detail.destination);
    const dateText = detail.runDate || svc.runDate || "";
    const uid = svc.originalServiceUid || svc.serviceUid || "";
    const date = svc.runDate || detail.runDate || "";
    const isSyntheticConnection =
      isConnection === true || String(uid).startsWith("CONN-");
    const href = isSyntheticConnection
      ? ""
      : `https://www.realtimetrains.co.uk/service/gb-nr:${encodeURIComponent(uid)}/${encodeURIComponent(date)}`;

    const headcode =
      svc.trainIdentity || svc.runningIdentity || svc.serviceUid || "";

    const opCode = svc.atocCode || detail.atocCode || "";
    const opName = svc.atocName || detail.atocName || opCode;

    const visible = atocNameByCode[opCode] || opCode || headcode || "?";

    const line1Parts = [];
    if (opName) line1Parts.push(opName);
    if (headcode) line1Parts.push(headcode);
    if (dateText) line1Parts.push(dateText);
    const line1 = line1Parts.join(" • ");

    let line2 = "";
    if (originText || destText) {
      line2 = `${originText} → ${destText}`;
    }

    let tooltip =
      line2 && line1 ? `${line1}\n${line2}` : line1 || line2 || visible;

    const serviceType = (detail.serviceType || svc.serviceType || "").trim();
    const serviceTypeLower = serviceType.toLowerCase();
    const hasConnectionTooltip =
      isSyntheticConnection || !!detail.connectionMode || serviceTypeLower === "connection";
    if (hasConnectionTooltip) {
      const locs = detail.locations || [];
      const fromLoc = locs[0] || {};
      const toLoc = locs[locs.length - 1] || {};
      const fromCrs = fromLoc.crs || "";
      const toCrs = toLoc.crs || "";
      const fromLabel =
        detail.connectionFromLabel ||
        stationNameByCrs.get(fromCrs) ||
        fromLoc.description ||
        fromCrs ||
        "";
      const toLabel =
        detail.connectionToLabel ||
        stationNameByCrs.get(toCrs) ||
        toLoc.description ||
        toCrs ||
        "";
      const depTime = padTime(fromLoc.gbttBookedDeparture || "");
      const arrTime = padTime(toLoc.gbttBookedArrival || "");
      const baseMode =
        detail.connectionMode ||
        svc.atocName ||
        detail.atocName ||
        (serviceTypeLower === "walk" ? "Walking" : "Connection");
      const modeLabel = /connection/i.test(baseMode)
        ? baseMode
        : `${baseMode} connection`;
      tooltip = `${modeLabel}: ${fromLabel} ${depTime} -> ${toLabel} ${arrTime}`;
    }

    const passenger =
      detail.isPassenger === true || svc.isPassenger !== false;
    const firstClassAvailable =
      passenger && detail.firstClassAvailable === true;
    const isSleeper = passenger && detail.sleeperAvailable === true;

    const isBus = serviceTypeLower === "bus";
    const isWalk = serviceTypeLower === "walk";
    const connectionModeLower = String(detail.connectionMode || "")
      .trim()
      .toLowerCase();
    const isUndergroundConnection = connectionModeLower === "underground";
    const isTramConnection = connectionModeLower === "tram";
    const isDlrConnection = connectionModeLower === "dlr";
    const busFirstClassAvailable = isBus ? false : firstClassAvailable;

    return {
      visible,
      tooltip,
      href,
      headcode,
      firstClassAvailable: busFirstClassAvailable,
      isSleeper,
      isBus,
      isWalk,
      isUndergroundConnection,
      isTramConnection,
      isDlrConnection,
    };
  });

  const sortResult = sortTimetableColumns({
    rows,
    rowSpecs,
    stationTimes,
    visibleTimeFlags,
    stationModes,
    displayStations,
    servicesWithDetails,
    serviceAllCancelled,
    serviceAllNoReport,
    serviceRealtimeFlags,
    realtimeToggleEnabled,
    servicesMeta,
    highlightColors: {
      outOfOrder: "#fce3b0",
      depAfterArrival: "#e6d9ff",
      serviceMisorder: "#f7c9c9",
    },
  });

  // Row-order adjustments during sorting can move station rows; rerun natural
  // line fill so pass-through continuity reflects the final row order.
  applyStationLineFill();

  assertNoBlankRenderedStationRows(rows, rowSpecs, displayStations);
  assertNoBlankRenderedServiceColumns(
    rows,
    rowSpecs,
    servicesWithDetails,
    sortResult.orderedSvcIndices,
    servicesMeta,
  );

  return {
    rows,
    rowSpecs,
    displayStations,
    servicesWithDetails,
    orderedSvcIndices: sortResult.orderedSvcIndices,
    servicesMeta: sortResult.servicesMeta,
    sortLog: sortResult.sortLog,
    partialSort: sortResult.partialSort,
    serviceCount: numServices,
  };
}

function buildTimetableModel(
  stations,
  stationSet,
  servicesWithDetails,
  options = {},
) {
  let model = buildBaseTimetableModel(
    stations,
    stationSet,
    servicesWithDetails,
    options,
  );

  if (options.reachableServicesOnly === true) {
    const filteredServices = filterReachableServicesFromModel(model);
    if (filteredServices) {
      model = buildBaseTimetableModel(
        stations,
        stationSet,
        filteredServices,
        {
          ...options,
          reachableServicesOnly: false,
          fastestRoutesOnly: false,
        },
      );
    }
  }

  if (options.fastestRoutesOnly === true) {
    const filteredServices = filterFastestRouteServicesFromModel(model);
    if (filteredServices) {
      model = buildBaseTimetableModel(
        stations,
        stationSet,
        filteredServices,
        {
          ...options,
          reachableServicesOnly: false,
          fastestRoutesOnly: false,
        },
      );
    }
  }

  return model;
}
