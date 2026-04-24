function findMonotonicViolation(rows, orderedSvcIndices, servicesWithDetails) {
  for (const svcIndex of orderedSvcIndices) {
    let dayOffset = 0;
    let prevAbs = null;
    let prevText = "";
    let prevRowLabel = "";
    const svc = servicesWithDetails[svcIndex]?.svc || {};
    const headcode =
      svc.trainIdentity || svc.runningIdentity || svc.serviceUid || "";

    for (let r = 0; r < rows.length; r++) {
      const val = rows[r].cells[svcIndex];

      const rawText = cellToText(val);
      if (!rawText) continue;
      if (val && typeof val === "object" && val.format?.strike) continue;
      if (val && typeof val === "object" && val.format?.noReport) continue;
      if (rawText.includes("?")) continue;

      const mins = timeStrToMinutes(rawText);
      if (mins === null) continue;

      let base = mins + dayOffset;

      if (prevAbs !== null && base < prevAbs) {
        const diff = prevAbs - base;
        if (diff > 6 * 60) {
          dayOffset += 1440;
          base = mins + dayOffset;
        }
      }

      if (prevAbs !== null && base < prevAbs) {
        const currentRowLabel = rowLabelText(rows[r]) || "current stop";
        const previousRowLabel = prevRowLabel || "previous stop";
        return {
          headcode,
          previousRowLabel,
          prevText,
          currentRowLabel,
          rawText,
        };
      }

      prevAbs = base;
      prevText = rawText;
      prevRowLabel = rowLabelText(rows[r]);
    }
  }

  return null;
}

function buildMonotonicRowOrder(rows, rowSpecs, orderedSvcIndices) {
  const stationRowIndices = [];
  const rowOrderIndex = new Map();
  rowSpecs.forEach((spec, idx) => {
    if (spec.kind === "station") {
      rowOrderIndex.set(idx, stationRowIndices.length);
      stationRowIndices.push(idx);
    }
  });
  if (stationRowIndices.length < 2) return null;

  const edges = new Map();
  const indegree = new Map();
  stationRowIndices.forEach((idx) => {
    edges.set(idx, new Set());
    indegree.set(idx, 0);
  });

  function addEdge(fromIdx, toIdx) {
    if (fromIdx === toIdx) return;
    const outgoing = edges.get(fromIdx);
    if (!outgoing || outgoing.has(toIdx)) return;
    outgoing.add(toIdx);
    indegree.set(toIdx, (indegree.get(toIdx) || 0) + 1);
  }

  orderedSvcIndices.forEach((svcIndex) => {
    let dayOffset = 0;
    let prevAbs = null;
    const entries = [];

    for (const rowIdx of stationRowIndices) {
      const val = rows[rowIdx].cells[svcIndex];
      const rawText = cellToText(val);
      if (!rawText) continue;
      if (val && typeof val === "object" && val.format?.strike) continue;
      if (val && typeof val === "object" && val.format?.noReport) continue;
      if (rawText.includes("?")) continue;

      const mins = timeStrToMinutes(rawText);
      if (mins === null) continue;

      let base = mins + dayOffset;
      if (prevAbs !== null && base < prevAbs) {
        const diff = prevAbs - base;
        if (diff > 6 * 60) {
          dayOffset += 1440;
          base = mins + dayOffset;
        }
      }

      entries.push({
        rowIdx,
        absTime: base,
        order: entries.length,
      });
      prevAbs = base;
    }

    if (entries.length < 2) return;
    entries
      .slice()
      .sort((a, b) => {
        if (a.absTime !== b.absTime) return a.absTime - b.absTime;
        return a.order - b.order;
      })
      .forEach((entry, idx, list) => {
        if (idx === 0) return;
        addEdge(list[idx - 1].rowIdx, entry.rowIdx);
      });
  });

  const queue = [];
  stationRowIndices.forEach((idx) => {
    if ((indegree.get(idx) || 0) === 0) {
      queue.push(idx);
    }
  });
  queue.sort((a, b) => rowOrderIndex.get(a) - rowOrderIndex.get(b));

  const sorted = [];
  while (queue.length > 0) {
    const current = queue.shift();
    sorted.push(current);
    edges.get(current).forEach((nextIdx) => {
      indegree.set(nextIdx, indegree.get(nextIdx) - 1);
      if (indegree.get(nextIdx) === 0) {
        queue.push(nextIdx);
        queue.sort(
          (a, b) => rowOrderIndex.get(a) - rowOrderIndex.get(b),
        );
      }
    });
  }

  if (sorted.length !== stationRowIndices.length) {
    return null;
  }

  const unchanged = stationRowIndices.every(
    (idx, pos) => idx === sorted[pos],
  );
  if (unchanged) return null;
  return sorted;
}

function applyRowOrder(rows, rowSpecs, stationRowOrder) {
  if (!stationRowOrder) return;
  const reorderedRows = [];
  const reorderedSpecs = [];
  let stationIdx = 0;
  rowSpecs.forEach((spec, idx) => {
    if (spec.kind !== "station") {
      reorderedRows.push(rows[idx]);
      reorderedSpecs.push(spec);
      return;
    }
    const targetRowIdx = stationRowOrder[stationIdx];
    reorderedRows.push(rows[targetRowIdx]);
    reorderedSpecs.push(rowSpecs[targetRowIdx]);
    stationIdx += 1;
  });
  rows.splice(0, rows.length, ...reorderedRows);
  rowSpecs.splice(0, rowSpecs.length, ...reorderedSpecs);
}

function enforceAdjacentArrDepRows(rows, rowSpecs) {
  if (!Array.isArray(rows) || !Array.isArray(rowSpecs)) return;
  if (rows.length !== rowSpecs.length) return;

  const stationPositions = new Map();
  rowSpecs.forEach((spec, idx) => {
    if (!spec || spec.kind !== "station") return;
    const stationIndex = spec.stationIndex;
    if (stationIndex === null || stationIndex === undefined) return;
    if (!stationPositions.has(stationIndex)) {
      stationPositions.set(stationIndex, { arr: -1, dep: -1 });
    }
    const entry = stationPositions.get(stationIndex);
    if (spec.mode === "arr") entry.arr = idx;
    if (spec.mode === "dep") entry.dep = idx;
  });

  const stationIndices = Array.from(stationPositions.keys()).sort(
    (a, b) => a - b,
  );
  stationIndices.forEach((stationIndex) => {
    const entry = stationPositions.get(stationIndex);
    if (!entry || entry.arr < 0 || entry.dep < 0) return;
    if (entry.dep === entry.arr + 1) return;

    const depRow = rows.splice(entry.dep, 1)[0];
    const depSpec = rowSpecs.splice(entry.dep, 1)[0];
    const insertAt = entry.dep < entry.arr ? entry.arr : entry.arr + 1;
    rows.splice(insertAt, 0, depRow);
    rowSpecs.splice(insertAt, 0, depSpec);
  });
}

function checkMonotonicTimes(rows, orderedSvcIndices, servicesWithDetails) {
  const violation = findMonotonicViolation(
    rows,
    orderedSvcIndices,
    servicesWithDetails,
  );
  if (!violation) return;

  const detailParts = [
    `${violation.previousRowLabel}: ${violation.prevText} to ${violation.currentRowLabel}: ${violation.rawText}`,
  ];
  if (violation.headcode) {
    detailParts.push(`headcode: ${violation.headcode}`);
  }
  const summary = "Some services cannot show calling points in order (red highlighted)";
  const details = detailParts.join(", ");
  if (typeof assertWithStatus === "function") {
    assertWithStatus(
      false,
      summary,
      details,
      { keepOutputs: true, allowContinue: true },
    );
    return;
  }
  console.warn(`${summary}: ${details}`);
}

function sortTimetableColumns({
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
  highlightColors,
}) {
  const numStations = displayStations.length;
  const numServices = servicesWithDetails.length;
  const sortLogLines = [];
  const stationLabels = displayStations.map(
    (station) => station.name || station.crs || "?",
  );
  let groupMembersByLeader = new Map();
  sortLogLines.push("Column sort log");
  sortLogLines.push(`Stations: ${stationLabels.join(" → ")}`);
  sortLogLines.push(`Services: ${numServices}`);

  function logHighlight(
    reason,
    rowIdx,
    svcIndex,
    currentTime,
    compareTime,
    compareSvcIndex,
  ) {
    const rowLabel = rowLabelText(rows[rowIdx]) || `row#${rowIdx}`;
    const currentSvc = serviceShortLabel(svcIndex);
    const compareSvc =
      compareSvcIndex !== null && compareSvcIndex !== undefined
        ? serviceShortLabel(compareSvcIndex)
        : "unknown";
    const message = `Highlight ${rowLabel}: ${currentTime} (${currentSvc}) < ${compareTime} (${compareSvc}) because ${reason}`;
    sortLogLines.push(message);
  }

  function serviceLabel(serviceIdx) {
    const svc = servicesWithDetails[serviceIdx]?.svc || {};
    const detail = servicesWithDetails[serviceIdx]?.detail || {};
    const headcode =
      svc.trainIdentity || svc.runningIdentity || svc.serviceUid || "";
    const originText = safePairText(detail.origin);
    const destText = safePairText(detail.destination);
    const route =
      originText || destText ? `${originText} → ${destText}` : "";
    const labelBase = headcode || svc.serviceUid || `svc#${serviceIdx + 1}`;
    return route ? `${labelBase} (${route})` : labelBase;
  }

  function serviceShortLabel(serviceIdx) {
    const svc = servicesWithDetails[serviceIdx]?.svc || {};
    return (
      svc.trainIdentity ||
      svc.runningIdentity ||
      svc.serviceUid ||
      `svc#${serviceIdx + 1}`
    );
  }

  function serviceIdentity(serviceIdx) {
    const entry = servicesWithDetails[serviceIdx] || {};
    const svc = entry.svc || {};
    const detail = entry.detail || {};
    const serviceKey =
      entry.serviceKey ||
      detail.serviceKey ||
      (svc.serviceUid || svc.runDate ? `${svc.serviceUid || ""}|${svc.runDate || ""}` : "");
    if (serviceKey) return serviceKey;
    const uid = svc.serviceUid || "";
    const runDate = svc.runDate || detail.runDate || "";
    if (!uid && !runDate) return "";
    return `${uid}|${runDate}`;
  }

  function connectionSourceIdentity(serviceIdx) {
    const entry = servicesWithDetails[serviceIdx] || {};
    const svc = entry.svc || {};
    const detail = entry.detail || {};
    const uid = svc.serviceUid || svc.originalServiceUid || "";
    const isSyntheticConnection =
      entry.isConnection === true || String(uid).startsWith("CONN-");
    if (!isSyntheticConnection) return "";
    const sourceServiceKey =
      entry.connectionSourceServiceKey ||
      detail.connectionSourceServiceKey ||
      "";
    if (sourceServiceKey) return sourceServiceKey;
    const sourceUid =
      entry.connectionSourceServiceUid ||
      detail.connectionSourceServiceUid ||
      "";
    const sourceRunDate =
      entry.connectionSourceRunDate ||
      detail.connectionSourceRunDate ||
      "";
    if (!sourceUid && !sourceRunDate) return "";
    return `${sourceUid}|${sourceRunDate}`;
  }

  function buildConnectionSortGroups(serviceIndices) {
    const connectionsBeforeBySource = new Map();
    const connectionsAfterBySource = new Map();
    const keyedConnectionIndices = new Set();

    serviceIndices.forEach((svcIdx) => {
      const sourceIdentity = connectionSourceIdentity(svcIdx);
      if (!sourceIdentity) return;
      keyedConnectionIndices.add(svcIdx);
      const entry = servicesWithDetails[svcIdx] || {};
      const placement =
        (entry.connectionPlacement || entry.detail?.connectionPlacement || "after")
          .toLowerCase() === "before"
          ? "before"
          : "after";
      const targetMap =
        placement === "before" ? connectionsBeforeBySource : connectionsAfterBySource;
      if (!targetMap.has(sourceIdentity)) {
        targetMap.set(sourceIdentity, []);
      }
      targetMap.get(sourceIdentity).push(svcIdx);
    });

    const groupLeaders = [];
    const groupMembersByLeader = new Map();
    const assignedConnections = new Set();

    serviceIndices.forEach((svcIdx) => {
      if (keyedConnectionIndices.has(svcIdx)) return;
      const members = [];
      const sourceIdentity = serviceIdentity(svcIdx);
      const linkedConnectionsBefore = sourceIdentity
        ? connectionsBeforeBySource.get(sourceIdentity)
        : null;
      const linkedConnectionsAfter = sourceIdentity
        ? connectionsAfterBySource.get(sourceIdentity)
        : null;
      if (linkedConnectionsBefore && linkedConnectionsBefore.length > 0) {
        linkedConnectionsBefore.forEach((connIdx) => {
          if (assignedConnections.has(connIdx)) return;
          members.push(connIdx);
          assignedConnections.add(connIdx);
        });
      }
      members.push(svcIdx);
      if (linkedConnectionsAfter && linkedConnectionsAfter.length > 0) {
        linkedConnectionsAfter.forEach((connIdx) => {
          if (assignedConnections.has(connIdx)) return;
          members.push(connIdx);
          assignedConnections.add(connIdx);
        });
      }
      groupLeaders.push(svcIdx);
      groupMembersByLeader.set(svcIdx, members);
    });

    serviceIndices.forEach((svcIdx) => {
      if (!keyedConnectionIndices.has(svcIdx)) return;
      if (assignedConnections.has(svcIdx)) return;
      groupLeaders.push(svcIdx);
      groupMembersByLeader.set(svcIdx, [svcIdx]);
      assignedConnections.add(svcIdx);
    });

    return { groupLeaders, groupMembersByLeader };
  }

  function expandGroupedOrder(groupLeaderOrder, groupMembersByLeader) {
    const expanded = [];
    groupLeaderOrder.forEach((leaderIdx) => {
      const members = groupMembersByLeader.get(leaderIdx);
      if (!Array.isArray(members) || members.length === 0) {
        expanded.push(leaderIdx);
        return;
      }
      expanded.push(...members);
    });
    return expanded;
  }

  function groupedMembersForSort(serviceIdx) {
    const members = groupMembersByLeader.get(serviceIdx);
    if (Array.isArray(members) && members.length > 0) return members;
    return [serviceIdx];
  }

  function preferredTimeMinsAtStation(serviceIdx, stationIdx) {
    const t = stationTimes[stationIdx][serviceIdx];
    if (!t) return null;
    if (t.depMins !== null) return t.depMins;
    if (t.arrMins !== null) return t.arrMins;
    return null;
  }

  function preferredTimeLabelAtStation(serviceIdx, stationIdx) {
    const t = stationTimes[stationIdx][serviceIdx];
    if (!t) return "";
    if (t.depStr) return t.depStr;
    if (t.arrStr) return t.arrStr;
    return "";
  }

  function getDisplayedTimeInfo(serviceIdx, stationIdx, isArrival) {
    const t = stationTimes[stationIdx][serviceIdx];
    if (!t || !t.loc) return { text: "", mins: null, format: null };
    const serviceRealtimeActivated = serviceRealtimeFlags[serviceIdx] === true;
    const chosen = chooseDisplayedTimeAndStatus(
      t.loc,
      isArrival,
      serviceRealtimeActivated,
      realtimeToggleEnabled,
    );
    const allowCancelled =
      ALWAYS_SORT_CANCELLED_TIMES || serviceAllCancelled[serviceIdx] === true;
    if (!chosen.text || (!allowCancelled && chosen.format?.strike)) {
      return { text: "", mins: null, format: chosen.format };
    }
    const allowNoReportMins =
      chosen.format?.noReport && serviceAllNoReport[serviceIdx] === true;
    const minsText = allowNoReportMins
      ? chosen.text.replace(/\?$/, "")
      : chosen.text;
    return {
      text: chosen.text,
      mins: chosen.format?.noReport
        ? allowNoReportMins
          ? timeStrToMinutes(minsText)
          : null
        : timeStrToMinutes(minsText),
      format: chosen.format,
    };
  }

  function stationTimeMinsForSingleService(
    serviceIdx,
    stationIdx,
    arrOnlyStationIdx = null,
    modeOverride = null,
    ignoreFromStationIdx = null,
    depOnlyStationIdx = null,
    ignoreStationIdx = null,
  ) {
    const t = stationTimes[stationIdx][serviceIdx];
    if (!t) return null;
    if (ignoreStationIdx === stationIdx) {
      return null;
    }
    if (ignoreFromStationIdx !== null && stationIdx >= ignoreFromStationIdx) {
      return null;
    }
    if (arrOnlyStationIdx === stationIdx || modeOverride === "arrOnly") {
      return getDisplayedTimeInfo(serviceIdx, stationIdx, true).mins;
    }
    if (depOnlyStationIdx === stationIdx || modeOverride === "depOnly") {
      return getDisplayedTimeInfo(serviceIdx, stationIdx, false).mins;
    }
    if (modeOverride === "ignore") {
      return null;
    }
    const hasDeparture = t.loc?.gbttBookedDeparture || t.loc?.realtimeDeparture;
    const isArrival = !hasDeparture;
    return getDisplayedTimeInfo(serviceIdx, stationIdx, isArrival).mins;
  }

  function stationTimeMins(
    serviceIdx,
    stationIdx,
    arrOnlyStationIdx = null,
    modeOverride = null,
    ignoreFromStationIdx = null,
    depOnlyStationIdx = null,
    ignoreStationIdx = null,
  ) {
    let chosen = null;
    groupedMembersForSort(serviceIdx).forEach((memberIdx) => {
      const mins = stationTimeMinsForSingleService(
        memberIdx,
        stationIdx,
        arrOnlyStationIdx,
        modeOverride,
        ignoreFromStationIdx,
        depOnlyStationIdx,
        ignoreStationIdx,
      );
      if (mins === null) return;
      if (chosen === null || mins < chosen) {
        chosen = mins;
      }
    });
    return chosen;
  }

  function stationTimeRoleForSingleService(
    serviceIdx,
    stationIdx,
    arrOnlyStationIdx = null,
    modeOverride = null,
    ignoreFromStationIdx = null,
    depOnlyStationIdx = null,
    ignoreStationIdx = null,
  ) {
    const t = stationTimes[stationIdx][serviceIdx];
    if (!t) return "";
    if (ignoreStationIdx === stationIdx) return "";
    if (ignoreFromStationIdx !== null && stationIdx >= ignoreFromStationIdx) {
      return "";
    }
    if (arrOnlyStationIdx === stationIdx || modeOverride === "arrOnly") {
      return getDisplayedTimeInfo(serviceIdx, stationIdx, true).mins === null
        ? ""
        : "arr";
    }
    if (depOnlyStationIdx === stationIdx || modeOverride === "depOnly") {
      return getDisplayedTimeInfo(serviceIdx, stationIdx, false).mins === null
        ? ""
        : "dep";
    }
    if (modeOverride === "ignore") return "";
    const hasDeparture = t.loc?.gbttBookedDeparture || t.loc?.realtimeDeparture;
    const isArrival = !hasDeparture;
    return getDisplayedTimeInfo(serviceIdx, stationIdx, isArrival).mins === null
      ? ""
      : isArrival
        ? "arr"
        : "dep";
  }

  function stationTimeRole(
    serviceIdx,
    stationIdx,
    arrOnlyStationIdx = null,
    modeOverride = null,
    ignoreFromStationIdx = null,
    depOnlyStationIdx = null,
    ignoreStationIdx = null,
  ) {
    let chosen = null;
    groupedMembersForSort(serviceIdx).forEach((memberIdx) => {
      const mins = stationTimeMinsForSingleService(
        memberIdx,
        stationIdx,
        arrOnlyStationIdx,
        modeOverride,
        ignoreFromStationIdx,
        depOnlyStationIdx,
        ignoreStationIdx,
      );
      if (mins === null) return;
      const role = stationTimeRoleForSingleService(
        memberIdx,
        stationIdx,
        arrOnlyStationIdx,
        modeOverride,
        ignoreFromStationIdx,
        depOnlyStationIdx,
        ignoreStationIdx,
      );
      const roleRank = role === "dep" ? 1 : 0;
      if (
        chosen === null ||
        mins < chosen.mins ||
        (mins === chosen.mins && roleRank < chosen.roleRank)
      ) {
        chosen = { mins, role, roleRank };
      }
    });
    return chosen ? chosen.role : "";
  }

  function stationTimeRoleComesBefore(leftRole, rightRole) {
    return leftRole === "arr" && rightRole === "dep";
  }

  function firstTimeInfo(serviceIdx) {
    let firstMins = null;
    let firstRow = null;
    for (let rowIdx = 0; rowIdx < rowSpecs.length; rowIdx++) {
      const spec = rowSpecs[rowIdx];
      if (!spec || spec.kind !== "station") continue;
      const stationIdx = spec.stationIndex;
      const mins = stationTimeMins(serviceIdx, stationIdx);
      if (mins === null) continue;
      if (firstMins === null || mins < firstMins) {
        firstMins = mins;
        firstRow = rowIdx;
      }
    }
    return { firstMins, firstRow };
  }

  function stationTimeLabelForSingleService(
    serviceIdx,
    stationIdx,
    arrOnlyStationIdx = null,
    modeOverride = null,
    ignoreFromStationIdx = null,
    depOnlyStationIdx = null,
    ignoreStationIdx = null,
  ) {
    const t = stationTimes[stationIdx][serviceIdx];
    if (!t) return "";
    if (ignoreStationIdx === stationIdx) {
      return "";
    }
    if (ignoreFromStationIdx !== null && stationIdx >= ignoreFromStationIdx) {
      return "";
    }
    if (arrOnlyStationIdx === stationIdx || modeOverride === "arrOnly") {
      return getDisplayedTimeInfo(serviceIdx, stationIdx, true).text;
    }
    if (depOnlyStationIdx === stationIdx || modeOverride === "depOnly") {
      return getDisplayedTimeInfo(serviceIdx, stationIdx, false).text;
    }
    if (modeOverride === "ignore") {
      return "";
    }
    const hasDeparture = t.loc?.gbttBookedDeparture || t.loc?.realtimeDeparture;
    const isArrival = !hasDeparture;
    return getDisplayedTimeInfo(serviceIdx, stationIdx, isArrival).text;
  }

  function stationTimeLabel(
    serviceIdx,
    stationIdx,
    arrOnlyStationIdx = null,
    modeOverride = null,
    ignoreFromStationIdx = null,
    depOnlyStationIdx = null,
    ignoreStationIdx = null,
  ) {
    let chosen = null;
    groupedMembersForSort(serviceIdx).forEach((memberIdx) => {
      const mins = stationTimeMinsForSingleService(
        memberIdx,
        stationIdx,
        arrOnlyStationIdx,
        modeOverride,
        ignoreFromStationIdx,
        depOnlyStationIdx,
        ignoreStationIdx,
      );
      if (mins === null) return;
      const text = stationTimeLabelForSingleService(
        memberIdx,
        stationIdx,
        arrOnlyStationIdx,
        modeOverride,
        ignoreFromStationIdx,
        depOnlyStationIdx,
        ignoreStationIdx,
      );
      if (chosen === null || mins < chosen.mins) {
        chosen = { mins, text };
      }
    });
    return chosen ? chosen.text : "";
  }

  function findInsertBounds(serviceIdx, orderedSvcIndices, options = {}) {
    const {
      arrOnlyStationIdx = null,
      logEnabled = true,
      modeOverride = null,
      ignoreFromStationIdx = null,
      depOnlyStationIdx = null,
      ignoreStationIdx = null,
    } = options;
    const label = serviceLabel(serviceIdx);
    if (logEnabled) {
      sortLogLines.push("");
      sortLogLines.push(`Service: ${label}`);
      sortLogLines.push(`Sorted count: ${orderedSvcIndices.length}`);
    }

    let lowerBound = 0;
    let upperBound = orderedSvcIndices.length;
    let hasConstraint = false;

    for (let stationIdx = 0; stationIdx < numStations; stationIdx++) {
      const time = stationTimeMins(
        serviceIdx,
        stationIdx,
        arrOnlyStationIdx,
        modeOverride,
        ignoreFromStationIdx,
        depOnlyStationIdx,
        ignoreStationIdx,
      );
      if (time === null) continue;
      const timeLabel = stationTimeLabel(
        serviceIdx,
        stationIdx,
        arrOnlyStationIdx,
        modeOverride,
        ignoreFromStationIdx,
        depOnlyStationIdx,
        ignoreStationIdx,
      );
      const timeRole = stationTimeRole(
        serviceIdx,
        stationIdx,
        arrOnlyStationIdx,
        modeOverride,
        ignoreFromStationIdx,
        depOnlyStationIdx,
        ignoreStationIdx,
      );

      let lastLE = -1;
      let firstGE = orderedSvcIndices.length;
      const greaterPositions = [];

      for (let pos = 0; pos < orderedSvcIndices.length; pos++) {
        const otherSvc = orderedSvcIndices[pos];
        const otherTime = stationTimeMins(
          otherSvc,
          stationIdx,
          arrOnlyStationIdx,
          modeOverride,
          ignoreFromStationIdx,
          depOnlyStationIdx,
          ignoreStationIdx,
        );
        if (otherTime === null) continue;
        const otherRole = stationTimeRole(
          otherSvc,
          stationIdx,
          arrOnlyStationIdx,
          modeOverride,
          ignoreFromStationIdx,
          depOnlyStationIdx,
          ignoreStationIdx,
        );

        if (
          otherTime < time ||
          (otherTime === time &&
            stationTimeRoleComesBefore(otherRole, timeRole))
        ) {
          lastLE = pos;
        }
        if (
          otherTime > time ||
          (otherTime === time &&
            stationTimeRoleComesBefore(timeRole, otherRole))
        ) {
          greaterPositions.push(pos);
          if (firstGE === orderedSvcIndices.length) {
            firstGE = pos;
          }
        }
      }

      let stationLower = lastLE + 1;
      let stationUpper =
        firstGE === orderedSvcIndices.length ? orderedSvcIndices.length : firstGE;

      if (stationLower > stationUpper) {
        const nextGreater = greaterPositions.find((pos) => pos > lastLE);
        if (nextGreater !== undefined) {
          firstGE = nextGreater;
          stationUpper = nextGreater;
        } else {
          firstGE = orderedSvcIndices.length;
          stationUpper = orderedSvcIndices.length;
        }
      }

      if (lastLE !== -1 || firstGE !== orderedSvcIndices.length) {
        hasConstraint = true;
        lowerBound = Math.max(lowerBound, lastLE + 1);
        upperBound = Math.min(upperBound, firstGE);
      }

      const stationLabel = stationLabels[stationIdx] || `station#${stationIdx}`;
      const lastLabel =
        lastLE >= 0 ? serviceLabel(orderedSvcIndices[lastLE]) : "none";
      const firstLabel =
        firstGE < orderedSvcIndices.length
          ? serviceLabel(orderedSvcIndices[firstGE])
          : "none";
      const lastTimeLabel =
        lastLE >= 0
          ? stationTimeLabel(
              orderedSvcIndices[lastLE],
              stationIdx,
              arrOnlyStationIdx,
              modeOverride,
              ignoreFromStationIdx,
              depOnlyStationIdx,
              ignoreStationIdx,
            )
          : "";
      const firstTimeLabel =
        firstGE < orderedSvcIndices.length
          ? stationTimeLabel(
              orderedSvcIndices[firstGE],
              stationIdx,
              arrOnlyStationIdx,
              modeOverride,
              ignoreFromStationIdx,
              depOnlyStationIdx,
              ignoreStationIdx,
            )
          : "";
      if (logEnabled) {
        const leftTime = lastLE >= 0 ? lastTimeLabel || "?" : "start";
        const rightTime =
          firstGE < orderedSvcIndices.length ? firstTimeLabel || "?" : "end";
        const leftSvc =
          lastLE >= 0 ? serviceShortLabel(orderedSvcIndices[lastLE]) : "start";
        const rightSvc =
          firstGE < orderedSvcIndices.length
            ? serviceShortLabel(orderedSvcIndices[firstGE])
            : "end";
        const currentSvc = serviceShortLabel(serviceIdx);
        sortLogLines.push(
          `  ${stationLabel}: ${leftTime} < ${timeLabel || "?"} < ${rightTime} (${leftSvc} < ${currentSvc} < ${rightSvc}), bounds ${stationLower}-${stationUpper}`,
        );
      }
    }

    if (logEnabled) {
      const maxPos = orderedSvcIndices.length;
      const candidateStart = hasConstraint ? lowerBound : 0;
      const candidateEnd = hasConstraint ? upperBound : maxPos;
      const candidates =
        candidateStart <= candidateEnd
          ? Array.from(
              { length: candidateEnd - candidateStart + 1 },
              (_, idx) => candidateStart + idx,
            ).join(", ")
          : "(none)";
      const reason = hasConstraint
        ? lowerBound <= upperBound
          ? `${lowerBound}-${upperBound}`
          : `conflicting bounds ${lowerBound}-${upperBound}`
        : "no station constraints";
      const conclusion =
        hasConstraint && lowerBound === upperBound
          ? `strict position ${lowerBound}`
          : hasConstraint
            ? "no strict bounds"
            : "no constraints";
      sortLogLines.push(
        `Combined bounds: ${reason}; available positions: ${candidates}. Conclusion: ${conclusion}.`,
      );
    }

    return { hasConstraint, lowerBound, upperBound };
  }

  function computeStationBounds(serviceIdx, orderedSvcIndices, stationIdx) {
    const time = stationTimeMins(serviceIdx, stationIdx, stationIdx);
    if (time === null) return { lastPos: -1, firstPos: -1 };

    let lastPos = -1;
    let firstPos = -1;

    for (let pos = 0; pos < orderedSvcIndices.length; pos++) {
      const otherSvc = orderedSvcIndices[pos];
      const otherTime = stationTimeMins(otherSvc, stationIdx, stationIdx);
      if (otherTime === null) continue;
      if (otherTime < time) lastPos = pos;
      if (firstPos === -1 && otherTime > time) {
        firstPos = pos;
      }
    }

    return { lastPos, firstPos };
  }

  function attemptInsertService(serviceIdx, orderedSvcIndices, options = {}) {
    const bounds = findInsertBounds(serviceIdx, orderedSvcIndices, options);
    if (
      bounds.hasConstraint &&
      bounds.lowerBound <= bounds.upperBound &&
      bounds.lowerBound === bounds.upperBound
    ) {
      orderedSvcIndices.splice(bounds.lowerBound, 0, serviceIdx);
      sortLogLines.push(
        `Chosen position: ${bounds.lowerBound} (bounds ${bounds.lowerBound}-${bounds.upperBound})`,
      );
      return true;
    }
    return false;
  }

  function insertFirstCandidate(
    serviceIdx,
    orderedSvcIndices,
    options = {},
    logPrefix = "Resolution pass 0",
  ) {
    const { hasConstraint, lowerBound, upperBound } = findInsertBounds(
      serviceIdx,
      orderedSvcIndices,
      { ...options, logEnabled: false },
    );
    const maxPos = orderedSvcIndices.length;
    const candidateStart = hasConstraint ? lowerBound : 0;
    const candidateEnd = hasConstraint ? upperBound : maxPos;
    if (candidateEnd > candidateStart) {
      orderedSvcIndices.splice(candidateStart, 0, serviceIdx);
      sortLogLines.push(
        `${logPrefix}: selected first position ${candidateStart} (bounds ${candidateStart}-${candidateEnd}) for ${serviceLabel(serviceIdx)}`,
      );
      return true;
    }
    return false;
  }

  function recordSortSequence(serviceIdx) {
    sortSequence.push(serviceIdx);
  }

  // Add this helper near findInsertBounds / attemptInsertService helpers:
  function countBaselineInsertPositions(serviceIdx, orderedSvcIndices) {
    const { hasConstraint, lowerBound, upperBound } = findInsertBounds(
      serviceIdx,
      orderedSvcIndices,
      { logEnabled: false }, // baseline = no modifications
    );

    const maxPos = orderedSvcIndices.length;

    const start = hasConstraint ? lowerBound : 0;
    const end = hasConstraint ? upperBound : maxPos;

    if (start > end) return 0;
    return end - start + 1;
  }

  function resolveUnboundedServices(remainingServices, orderedSvcIndices) {
    sortLogLines.push("Resolution pass 1: start");
    for (let idx = 0; idx < remainingServices.length; idx++) {
      const svcIdx = remainingServices[idx];

      // NEW: skip if baseline (unmodified) insert positions > 1
      const baselineCount = countBaselineInsertPositions(svcIdx, orderedSvcIndices);
      if (baselineCount > 1) {
        sortLogLines.push(
          `Resolution pass 1: skipping ${serviceLabel(svcIdx)} (baseline has ${baselineCount} possible positions; won't apply modifications)`,
        );
        continue;
      }

      sortLogLines.push(
        `Resolution pass 1: evaluating ${serviceLabel(svcIdx)} for arr-only fixes`,
      );
      let attemptedStation = false;

      for (let stationIdx = numStations - 1; stationIdx >= 0; stationIdx--) {
        if (stationModes[stationIdx] !== "two") continue;
        const t = stationTimes[stationIdx][svcIdx];
        if (!t || t.arrMins === null) continue;
        attemptedStation = true;

        sortLogLines.push(
          `Resolution attempt for ${serviceLabel(svcIdx)} at ${stationLabels[stationIdx] || `station#${stationIdx}`} (arr-only station, scan backwards)`,
        );

        const attemptA = orderedSvcIndices.slice();
        sortLogLines.push("  Option A: insert service with arr-only at station.");
        const attemptAInserted = attemptInsertService(svcIdx, attemptA, {
          arrOnlyStationIdx: stationIdx,
        });
        if (
          attemptAInserted ||
          insertFirstCandidate(
            svcIdx,
            attemptA,
            { arrOnlyStationIdx: stationIdx },
            "Resolution pass 1",
          )
        ) {
          orderedSvcIndices.splice(0, orderedSvcIndices.length, ...attemptA);
          remainingServices.splice(idx, 1);
          recordSortSequence(svcIdx);
          return true;
        }

        const { lastPos, firstPos } = computeStationBounds(
          svcIdx,
          orderedSvcIndices,
          stationIdx,
        );

        if (lastPos >= 0) {
          sortLogLines.push(
            `  Option B: remove lower-bound ${serviceLabel(orderedSvcIndices[lastPos])}, insert service normally, then reinsert lower-bound with arr-only.`,
          );
          const attemptB = orderedSvcIndices.slice();
          const [removedSvc] = attemptB.splice(lastPos, 1);
          const attemptBInserted = attemptInsertService(svcIdx, attemptB);
          if (
            attemptBInserted ||
            insertFirstCandidate(svcIdx, attemptB, {}, "Resolution pass 1")
          ) {
            if (
              attemptInsertService(removedSvc, attemptB, {
                arrOnlyStationIdx: stationIdx,
              })
            ) {
              orderedSvcIndices.splice(
                0,
                orderedSvcIndices.length,
                ...attemptB,
              );
              remainingServices.splice(idx, 1);
              recordSortSequence(svcIdx);
              return true;
            }
          }
        }

        if (firstPos >= 0) {
          sortLogLines.push(
            `  Option C: remove upper-bound ${serviceLabel(orderedSvcIndices[firstPos])}, insert service normally, then reinsert upper-bound with arr-only.`,
          );
          const attemptC = orderedSvcIndices.slice();
          const [removedSvc] = attemptC.splice(firstPos, 1);
          const attemptCInserted = attemptInsertService(svcIdx, attemptC);
          if (
            attemptCInserted ||
            insertFirstCandidate(svcIdx, attemptC, {}, "Resolution pass 1")
          ) {
            if (
              attemptInsertService(removedSvc, attemptC, {
                arrOnlyStationIdx: stationIdx,
              })
            ) {
              orderedSvcIndices.splice(
                0,
                orderedSvcIndices.length,
                ...attemptC,
              );
              remainingServices.splice(idx, 1);
              recordSortSequence(svcIdx);
              return true;
            }
          }
        }
      }

      if (!attemptedStation) {
        sortLogLines.push(
          `Resolution pass 1: no eligible arr-only stations for ${serviceLabel(svcIdx)}`,
        );
      }
    }

    sortLogLines.push("Resolution pass 1: no resolution found");
    return false;
  }

  function resolveUnboundedServicesByIgnoringValue(
    remainingServices,
    orderedSvcIndices,
  ) {
    sortLogLines.push("Resolution pass 2: start");
    for (let idx = 0; idx < remainingServices.length; idx++) {
      const svcIdx = remainingServices[idx];

      // NEW: skip if baseline (unmodified) insert positions > 1
      const baselineCount = countBaselineInsertPositions(svcIdx, orderedSvcIndices);
      if (baselineCount > 1) {
        sortLogLines.push(
          `Resolution pass 2: skipping ${serviceLabel(svcIdx)} (baseline has ${baselineCount} possible positions; won't apply modifications)`,
        );
        continue;
      }

      sortLogLines.push(
        `Resolution pass 2: evaluating ${serviceLabel(svcIdx)} for ignore-value fixes`,
      );
      let attemptedStation = false;

      for (let stationIdx = numStations - 1; stationIdx >= 0; stationIdx--) {
        const t = stationTimes[stationIdx][svcIdx];
        if (!t) continue;
        attemptedStation = true;

        const stationName =
          stationLabels[stationIdx] || `station#${stationIdx}`;
        if (t.depMins !== null) {
          sortLogLines.push(
            `Resolution pass 2 for ${serviceLabel(svcIdx)} at ${stationName}: ignore dep time and all rows below.`,
          );
          const attemptDep = orderedSvcIndices.slice();
          const attemptDepInserted = attemptInsertService(svcIdx, attemptDep, {
            arrOnlyStationIdx: stationIdx,
            ignoreFromStationIdx: stationIdx + 1,
          });
          if (
            attemptDepInserted ||
            insertFirstCandidate(
              svcIdx,
              attemptDep,
              {
                arrOnlyStationIdx: stationIdx,
                ignoreFromStationIdx: stationIdx + 1,
              },
              "Resolution pass 2",
            )
          ) {
            orderedSvcIndices.splice(
              0,
              orderedSvcIndices.length,
              ...attemptDep,
            );
            remainingServices.splice(idx, 1);
            recordSortSequence(svcIdx);
            return true;
          }
        }

        if (t.arrMins !== null) {
          sortLogLines.push(
            `Resolution pass 2 for ${serviceLabel(svcIdx)} at ${stationName}: ignore arr+dep time and all rows below.`,
          );
          const attemptArrDep = orderedSvcIndices.slice();
          const attemptArrDepInserted = attemptInsertService(
            svcIdx,
            attemptArrDep,
            {
              ignoreFromStationIdx: stationIdx + 1,
              ignoreStationIdx: stationIdx,
            },
          );
          if (
            attemptArrDepInserted ||
            insertFirstCandidate(
              svcIdx,
              attemptArrDep,
              {
                ignoreFromStationIdx: stationIdx + 1,
                ignoreStationIdx: stationIdx,
              },
              "Resolution pass 2",
            )
          ) {
            orderedSvcIndices.splice(
              0,
              orderedSvcIndices.length,
              ...attemptArrDep,
            );
            remainingServices.splice(idx, 1);
            recordSortSequence(svcIdx);
            return true;
          }
        }
      }

      if (!attemptedStation) {
        sortLogLines.push(
          `Resolution pass 2: no eligible stations for ${serviceLabel(svcIdx)}`,
        );
      }
    }

    sortLogLines.push("Resolution pass 2: no resolution found");
    return false;
  }

  function resolveUnboundedServicesByPickingFirst(
    remainingServices,
    orderedSvcIndices,
  ) {
    sortLogLines.push("Resolution pass 3: start");
    for (let idx = 0; idx < remainingServices.length; idx++) {
      const svcIdx = remainingServices[idx];
      if (insertFirstCandidate(svcIdx, orderedSvcIndices)) {
        remainingServices.splice(idx, 1);
        recordSortSequence(svcIdx);
        return true;
      }
    }
  }

  const orderedSvcIndices = [];
  const sortSequence = [];
  let unsortedServices = null;
  let unsortedLabels = null;
  const allServiceIndices = Array.from(
    { length: numServices },
    (_, idx) => idx,
  );
  const { groupLeaders, groupMembersByLeader: computedGroupMembersByLeader } = buildConnectionSortGroups(
    allServiceIndices,
  );
  groupMembersByLeader = computedGroupMembersByLeader;
  const remainingServices = groupLeaders.slice();
  const groupedConnectionCount = numServices - groupLeaders.length;
  if (groupedConnectionCount > 0) {
    sortLogLines.push(
      `Connection grouping: formed ${groupLeaders.length} virtual columns from ${numServices} services (${groupedConnectionCount} attached connection columns).`,
    );
  }
  remainingServices.sort((a, b) => {
    const infoA = firstTimeInfo(a);
    const infoB = firstTimeInfo(b);
    if (infoA.firstRow === null && infoB.firstRow === null) return a - b;
    if (infoA.firstRow === null) return 1;
    if (infoB.firstRow === null) return -1;
    if (infoA.firstRow !== infoB.firstRow) {
      return infoA.firstRow - infoB.firstRow;
    }
    if (infoA.firstMins === null && infoB.firstMins === null) return a - b;
    if (infoA.firstMins === null) return 1;
    if (infoB.firstMins === null) return -1;
    if (infoA.firstMins !== infoB.firstMins) {
      return infoA.firstMins - infoB.firstMins;
    }
    return a - b;
  });

  if (remainingServices.length > 0) {
    sortLogLines.push("");
    sortLogLines.push("Initial queue order (after pre-sort):");
    remainingServices.forEach((svcIndex, position) => {
      const info = firstTimeInfo(svcIndex);
      const svc = servicesWithDetails[svcIndex]?.svc || {};
      const headcode =
        svc.trainIdentity ||
        svc.runningIdentity ||
        svc.serviceUid ||
        `svc#${svcIndex + 1}`;
      const minsLabel = info.firstMins === null ? "none" : info.firstMins;
      const rowLabel = info.firstRow === null ? "none" : info.firstRow;
      sortLogLines.push(
        `${position + 1}. ${headcode}: first mins ${minsLabel}, first row ${rowLabel}`,
      );
    });
  }

  if (remainingServices.length > 0) {
    const seedService = remainingServices.shift();
    orderedSvcIndices.push(seedService);
    recordSortSequence(seedService);
    sortLogLines.push("");
    sortLogLines.push(`Seed service: ${serviceLabel(seedService)}`);
  }

  let rotationsWithoutInsert = 0;
  while (remainingServices.length > 0) {
    if (rotationsWithoutInsert >= remainingServices.length) {
      sortLogLines.push(
        `Queue cycled with no inserts; contents: ${remainingServices
          .map(serviceLabel)
          .join(", ")}`,
      );
      const resolved = resolveUnboundedServices(
        remainingServices,
        orderedSvcIndices,
      );
      if (resolved) {
        rotationsWithoutInsert = 0;
        continue;
      }
      const resolvedSecondPass = resolveUnboundedServicesByIgnoringValue(
        remainingServices,
        orderedSvcIndices,
      );
      if (resolvedSecondPass) {
        rotationsWithoutInsert = 0;
        continue;
      }
      const resolvedThirdPass = resolveUnboundedServicesByPickingFirst(
        remainingServices,
        orderedSvcIndices,
      );
      if (resolvedThirdPass) {
        rotationsWithoutInsert = 0;
        continue;
      }

      unsortedLabels = remainingServices.map(serviceLabel);
      unsortedServices = remainingServices.slice();
      sortLogLines.push(
        `Assertion: unable to determine strict bounds for remaining services: ${unsortedLabels.join(
          ", ",
        )}`,
      );
      if (ENABLE_SORT_LOG_DOWNLOAD) {
        downloadTextFile("timetable-sort-log.txt", sortLogLines.join("\n"));
      }
      break;
    }

    const svcIdx = remainingServices.shift();
    if (attemptInsertService(svcIdx, orderedSvcIndices)) {
      recordSortSequence(svcIdx);
      rotationsWithoutInsert = 0;
    } else {
      remainingServices.push(svcIdx);
      rotationsWithoutInsert += 1;
      sortLogLines.push(
        `Moved to end of queue: ${serviceLabel(svcIdx)}`,
      );
    }
  }

  sortLogLines.push("");
  sortLogLines.push(
    `Final order: ${
      orderedSvcIndices.length > 0
        ? orderedSvcIndices.map(serviceLabel).join(", ")
        : "(none)"
    }`,
  );
  sortLogLines.push(
    `Sort sequence: ${
      sortSequence.length > 0
        ? sortSequence.map(serviceLabel).join(", ")
        : "(none)"
    }`,
  );

  let displayOrderedSvcIndices = orderedSvcIndices.slice();
  const HIGHLIGHT_OUT_OF_ORDER_COLOR = highlightColors?.outOfOrder || "#fce3b0";
  const HIGHLIGHT_DEP_AFTER_ARRIVAL_COLOR =
    highlightColors?.depAfterArrival || "#e6d9ff";
  const HIGHLIGHT_SERVICE_MISORDER_COLOR =
    highlightColors?.serviceMisorder || "#f7c9c9";

  function applyServiceMisorderHighlight(columnOrder) {
    columnOrder.forEach((svcIndex) => {
      let dayOffset = 0;

      let prevAbs = null;  // for detecting day rollover
      let maxAbs = null;   // max absolute time seen so far (monotonic requirement)

      for (let r = 0; r < rows.length; r++) {
        const val = rows[r].cells[svcIndex];
        const rawText = cellToText(val);

        if (!rawText) continue;
        if (val && typeof val === "object" && val.format?.strike) continue;
        if (val && typeof val === "object" && val.format?.noReport) continue;
        if (rawText.includes("?")) continue;

        const mins = timeStrToMinutes(rawText);
        if (mins === null) continue;

        // Compute absolute minutes, allowing a single (or multiple) midnight rollovers.
        let base = mins + dayOffset;

        if (prevAbs !== null && base < prevAbs) {
          const diff = prevAbs - base;
          if (diff > 6 * 60) {
            dayOffset += 1440;
            base = mins + dayOffset;
          }
        }

        // Highlight if this time is earlier than ANY earlier time (max so far).
        if (maxAbs !== null && base < maxAbs) {
          if (val && typeof val === "object") {
            val.format = val.format || {};
            val.format.bgColor = HIGHLIGHT_SERVICE_MISORDER_COLOR;
          } else {
            rows[r].cells[svcIndex] = {
              text: rawText,
              format: { bgColor: HIGHLIGHT_SERVICE_MISORDER_COLOR },
            };
          }
        }

        prevAbs = base;
        if (maxAbs === null || base > maxAbs) maxAbs = base;
      }
    });
  }

  function tryResortForHighlighting() {
    let movedAny = false;
    let attemptRound = 0;
    const highlightTriggers = [];
    attemptRound += 1;
    sortLogLines.push(`Highlight resort pass ${attemptRound}: start`);

    for (let r = 0; r < rows.length; r++) {
      let minTime = null;
      let minTimeSvcIndex = null;
      for (let colPos = orderedSvcIndices.length - 1; colPos >= 0; colPos--) {
        const svcIndex = orderedSvcIndices[colPos];
        const value = rows[r].cells[svcIndex];
        const timeText = cellToText(value);
        if (!timeText) continue;
        if (value && typeof value === "object" && value.format?.strike) {
          continue;
        }
        const mins = timeStrToMinutes(timeText);
        if (mins === null) continue;
        if (minTime === null || mins <= minTime) {
          minTime = mins;
          minTimeSvcIndex = svcIndex;
          continue;
        }
        sortLogLines.push(
          `Highlight resort trigger: row ${r + 1} ${rowLabelText(rows[r]) || ""} service ${serviceLabel(svcIndex)} time ${timeText} (min ${minutesToTimeStr(minTime)})`,
        );
        highlightTriggers.push({ svcIndex });
      }
    }

    const stationRowIndices = new Map();
    for (let r = 0; r < rowSpecs.length; r++) {
      const spec = rowSpecs[r];
      if (spec.kind !== "station") continue;
      if (!stationRowIndices.has(spec.stationIndex)) {
        stationRowIndices.set(spec.stationIndex, {});
      }
      const entry = stationRowIndices.get(spec.stationIndex);
      if (spec.mode === "arr") entry.arr = r;
      if (spec.mode === "dep") entry.dep = r;
    }

    stationRowIndices.forEach((entry) => {
      if (entry.arr === undefined || entry.dep === undefined) return;
      let maxArr = null;
      for (let colPos = 0; colPos < orderedSvcIndices.length; colPos++) {
        const svcIndex = orderedSvcIndices[colPos];
        const arrVal = rows[entry.arr].cells[svcIndex];
        const arrText = cellToText(arrVal);
        if (arrVal && typeof arrVal === "object" && arrVal.format?.strike) {
          continue;
        }
        if (arrText) {
          const arrMins = timeStrToMinutes(arrText);
          if (arrMins !== null) {
            if (maxArr === null || arrMins > maxArr) {
              maxArr = arrMins;
            }
          }
        }

        const depVal = rows[entry.dep].cells[svcIndex];
        const depText = cellToText(depVal);
        if (depVal && typeof depVal === "object" && depVal.format?.strike) {
          continue;
        }
        if (!depText || maxArr === null) continue;
        const depMins = timeStrToMinutes(depText);
        if (depMins === null) continue;
        if (depMins < maxArr) {
          sortLogLines.push(
            `Highlight resort trigger: station ${rowLabelText(rows[entry.dep]) || ""} service ${serviceLabel(svcIndex)} dep ${depText} before max arr ${minutesToTimeStr(maxArr)}`,
          );
          highlightTriggers.push({ svcIndex });
        }
      }
    });

    highlightTriggers.forEach(({ svcIndex }) => {
      const attempt = orderedSvcIndices.filter((idx) => idx !== svcIndex);
      if (attempt.length !== orderedSvcIndices.length) {
        if (attemptInsertService(svcIndex, attempt, { logEnabled: true })) {
          orderedSvcIndices.splice(0, orderedSvcIndices.length, ...attempt);
          movedAny = true;
          return;
        }
        if (
          insertFirstCandidate(
            svcIndex,
            attempt,
            {},
            "Highlight resort",
          )
        ) {
          orderedSvcIndices.splice(0, orderedSvcIndices.length, ...attempt);
          movedAny = true;
        }
      }
    });
    if (!movedAny) {
      sortLogLines.push(`Highlight resort pass ${attemptRound}: no moves`);
    }
    return movedAny;
  }

  tryResortForHighlighting();
  displayOrderedSvcIndices = expandGroupedOrder(
    orderedSvcIndices,
    groupMembersByLeader,
  );
  if (displayOrderedSvcIndices.length !== orderedSvcIndices.length) {
    sortLogLines.push(
      "Expanded virtual service+connection column groups into display columns after sorting.",
    );
  }

  const rowOrderColumns = displayOrderedSvcIndices.slice();
  const originalRows = rows.slice();
  const originalSpecs = rowSpecs.slice();
  const rowOrder = buildMonotonicRowOrder(
    rows,
    rowSpecs,
    rowOrderColumns,
  );
  if (rowOrder) {
    applyRowOrder(rows, rowSpecs, rowOrder);
    enforceAdjacentArrDepRows(rows, rowSpecs);
    const violation = findMonotonicViolation(
      rows,
      rowOrderColumns,
      servicesWithDetails,
    );
    if (violation) {
      rows.splice(0, rows.length, ...originalRows);
      rowSpecs.splice(0, rowSpecs.length, ...originalSpecs);
    }
  }
  enforceAdjacentArrDepRows(rows, rowSpecs);
  checkMonotonicTimes(rows, rowOrderColumns, servicesWithDetails);

  let partialSort = null;
  let spacerIndex = null;
  if (unsortedServices && unsortedServices.length > 0) {
    spacerIndex = servicesMeta.length;
    servicesMeta.push({
      visible: "UNSORTED >",
      tooltip: "Unsorted services",
      href: "",
      firstClassAvailable: false,
      isSleeper: false,
      isBus: false,
    });
    rows.forEach((row) => {
      row.cells[spacerIndex] = "";
    });
    displayOrderedSvcIndices = [
      ...expandGroupedOrder(orderedSvcIndices, groupMembersByLeader),
      spacerIndex,
      ...expandGroupedOrder(unsortedServices, groupMembersByLeader),
    ];
    partialSort = {
      unsortedLabels: unsortedLabels || [],
    };
  }

  function connectionColumnKey(serviceIdx) {
    const entry = servicesWithDetails[serviceIdx];
    if (!entry) return "";
    const svc = entry.svc || {};
    const detail = entry.detail || {};
    const uid = svc.serviceUid || svc.originalServiceUid || "";
    const isConnection =
      entry.isConnection === true || String(uid).startsWith("CONN-");
    if (!isConnection) return "";

    const locations = Array.isArray(detail.locations) ? detail.locations : [];
    const fromCrs = String(locations[0]?.crs || "").trim().toUpperCase();
    const toCrs = String(locations[locations.length - 1]?.crs || "")
      .trim()
      .toUpperCase();
    if (!fromCrs || !toCrs) return "";

    const mode = String(
      detail.connectionMode || detail.serviceType || svc.serviceType || "",
    )
      .trim()
      .toLowerCase();
    return `${mode}|${fromCrs}|${toCrs}`;
  }

  function dedupeAdjacentConnectionColumns(columnOrder) {
    const deduped = [];
    const seenConnectionKeys = new Set();

    columnOrder.forEach((svcIndex) => {
      const key = connectionColumnKey(svcIndex);
      if (!key) {
        // Reset when we hit a real service or non-connection column.
        seenConnectionKeys.clear();
        deduped.push(svcIndex);
        return;
      }

      if (seenConnectionKeys.has(key)) {
        sortLogLines.push(
          `Removed duplicate connection column in range: ${serviceLabel(svcIndex)} (${key})`,
        );
        return;
      }

      seenConnectionKeys.add(key);
      deduped.push(svcIndex);
    });
    return deduped;
  }

  displayOrderedSvcIndices = dedupeAdjacentConnectionColumns(
    displayOrderedSvcIndices,
  );

  const highlightCutoff =
    spacerIndex !== null
      ? displayOrderedSvcIndices.indexOf(spacerIndex)
      : displayOrderedSvcIndices.length;
  const highlightColumns = displayOrderedSvcIndices.slice(0, highlightCutoff);

  applyServiceMisorderHighlight(highlightColumns);

  for (let r = 0; r < rows.length; r++) {
    let minTime = null;
    let minTimeSvcIndex = null;
    for (let colPos = highlightCutoff - 1; colPos >= 0; colPos--) {
      const svcIndex = displayOrderedSvcIndices[colPos];
      const value = rows[r].cells[svcIndex];
      const timeText = cellToText(value);
      if (!timeText) continue;
      if (value && typeof value === "object" && value.format?.strike) {
        continue;
      }
      const mins = timeStrToMinutes(timeText);
      if (mins === null) continue;
      if (minTime === null || mins <= minTime) {
        minTime = mins;
        minTimeSvcIndex = svcIndex;
        continue;
      }
      logHighlight(
        "time later than min to the right",
        r,
        svcIndex,
        timeText,
        minutesToTimeStr(minTime),
        minTimeSvcIndex,
      );
      if (value && typeof value === "object") {
        value.format = value.format || {};
        if (value.format.bgColor !== HIGHLIGHT_SERVICE_MISORDER_COLOR) {
          value.format.bgColor = HIGHLIGHT_OUT_OF_ORDER_COLOR;
        }
      } else {
        rows[r].cells[svcIndex] = {
          text: timeText,
          format: { bgColor: HIGHLIGHT_OUT_OF_ORDER_COLOR },
        };
      }
    }
  }

  const stationRowIndices = new Map();
  for (let r = 0; r < rowSpecs.length; r++) {
    const spec = rowSpecs[r];
    if (spec.kind !== "station") continue;
    if (!stationRowIndices.has(spec.stationIndex)) {
      stationRowIndices.set(spec.stationIndex, {});
    }
    const entry = stationRowIndices.get(spec.stationIndex);
    if (spec.mode === "arr") entry.arr = r;
    if (spec.mode === "dep") entry.dep = r;
  }

  stationRowIndices.forEach((entry) => {
    if (entry.arr === undefined || entry.dep === undefined) return;
    let maxArr = null;
    let maxArrSvcIndex = null;
    for (let colPos = 0; colPos < highlightCutoff; colPos++) {
      const svcIndex = displayOrderedSvcIndices[colPos];
      const arrVal = rows[entry.arr].cells[svcIndex];
      const arrText = cellToText(arrVal);
      if (arrVal && typeof arrVal === "object" && arrVal.format?.strike) {
        continue;
      }
      if (arrText) {
        const arrMins = timeStrToMinutes(arrText);
        if (arrMins !== null) {
          if (maxArr === null || arrMins > maxArr) {
            maxArr = arrMins;
            maxArrSvcIndex = svcIndex;
          }
        }
      }

      const depVal = rows[entry.dep].cells[svcIndex];
      const depText = cellToText(depVal);
      if (depVal && typeof depVal === "object" && depVal.format?.strike) {
        continue;
      }
      if (!depText || maxArr === null) continue;
      const depMins = timeStrToMinutes(depText);
      if (depMins === null) continue;
      if (depMins < maxArr) {
        logHighlight(
          "departure earlier than max arrival at station",
          entry.dep,
          svcIndex,
          depText,
          minutesToTimeStr(maxArr),
          maxArrSvcIndex,
        );
        if (depVal && typeof depVal === "object") {
          depVal.format = depVal.format || {};
          if (depVal.format.bgColor !== HIGHLIGHT_SERVICE_MISORDER_COLOR) {
            depVal.format.bgColor = HIGHLIGHT_DEP_AFTER_ARRIVAL_COLOR;
          }
        } else {
          rows[entry.dep].cells[svcIndex] = {
            text: depText,
            format: { bgColor: HIGHLIGHT_DEP_AFTER_ARRIVAL_COLOR },
          };
        }
      }
    }
  });

  return {
    orderedSvcIndices: displayOrderedSvcIndices,
    servicesMeta,
    sortLog: sortLogLines.join("\n"),
    partialSort,
  };
}
