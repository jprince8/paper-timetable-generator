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

function buildTimetableModel(
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
  const serviceAllCancelled = new Array(numServices).fill(false);
  const serviceAllNoReport = new Array(numServices).fill(false);
  const connectionEndpointCrs = new Set();

  servicesWithDetails.forEach((entry) => {
    const svc = entry?.svc || {};
    const detail = entry?.detail || {};
    const uid = svc.originalServiceUid || svc.serviceUid || "";
    const isSyntheticConnection =
      entry?.isConnection === true || String(uid).startsWith("CONN-");
    if (!isSyntheticConnection) return;
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
        loc,
      };
    });
  });

  for (let svcIndex = 0; svcIndex < numServices; svcIndex++) {
    let hasAny = false;
    let hasNonStrike = false;
    let hasAnyTime = false;
    let hasNonNoReport = false;
    for (let stationIndex = 0; stationIndex < numStations; stationIndex++) {
      const t = stationTimes[stationIndex][svcIndex];
      if (!t?.loc) continue;
      if (hasNonStrike) break;
      const hasArr = t.loc.gbttBookedArrival || t.loc.realtimeArrival;
      const hasDep = t.loc.gbttBookedDeparture || t.loc.realtimeDeparture;
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

        const serviceRealtimeActivated = serviceRealtimeFlags[s] === true;

        let timeStr = "";
        let timeFormat = null;
        let platformInfo = null;
        if (mode === "arr") {
          const chosen = chooseDisplayedTimeAndStatus(
            loc,
            true,
            serviceRealtimeActivated,
            realtimeToggleEnabled,
          );
          timeStr = chosen.text;
          timeFormat = chosen.format;
        } else if (mode === "dep") {
          const chosen = chooseDisplayedTimeAndStatus(
            loc,
            false,
            serviceRealtimeActivated,
            realtimeToggleEnabled,
          );
          timeStr = chosen.text;
          timeFormat = chosen.format;
        } else if (mode === "merged" || mode === "single") {
          const hasDeparture =
            loc.gbttBookedDeparture || loc.realtimeDeparture;
          const chosen = chooseDisplayedTimeAndStatus(
            loc,
            !hasDeparture,
            serviceRealtimeActivated,
            realtimeToggleEnabled,
          );
          timeStr = chosen.text;
          timeFormat = chosen.format;
        }

        if (timeStr) {
          if (showPlatforms) {
            const platform = String(loc.platform || "").trim();
            platformInfo = {
              text: platform ? `[${platform}]` : "[?]",
              confirmed:
                realtimeToggleEnabled && loc.platformConfirmed === true,
              changed: realtimeToggleEnabled && loc.platformChanged === true,
            };
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
    const busFirstClassAvailable = isBus ? false : firstClassAvailable;

    return {
      visible,
      tooltip,
      href,
      firstClassAvailable: busFirstClassAvailable,
      isSleeper,
      isBus,
      isWalk,
    };
  });

  const sortResult = sortTimetableColumns({
    rows,
    rowSpecs,
    stationTimes,
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

  return {
    rows,
    orderedSvcIndices: sortResult.orderedSvcIndices,
    servicesMeta: sortResult.servicesMeta,
    sortLog: sortResult.sortLog,
    partialSort: sortResult.partialSort,
    serviceCount: numServices,
  };
}
