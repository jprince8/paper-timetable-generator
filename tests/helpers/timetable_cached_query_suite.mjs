import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runCachedQueryFixture,
  isConnectionEntry,
  getServiceKey,
  getConnectionSourceKey,
  assertConnectionMisorderHighlightAfterExpansion,
} from './timetable_cached_query_runner.mjs';
import { assertColumnFillContinuity } from './timetable_column_shape_assertions.mjs';

function assertNoDuplicateColumns(directionName, directionData) {
  const cols = directionData.orderedSvcIndicesRaw;
  const unique = new Set(cols);
  assert.equal(
    unique.size,
    cols.length,
    `${directionName}: duplicate service column indices detected (${cols.join(', ')})`,
  );
}

function assertConnectionAdjacency(directionName, directionData) {
  const ordered = directionData.orderedEntries;
  if (ordered.length === 0) return;

  const sourcePosByKey = new Map();
  const sourcePositionsByKey = new Map();
  const connectionPositionsByKey = new Map();
  ordered.forEach((entry, pos) => {
    if (isConnectionEntry(entry)) return;
    const key = getServiceKey(entry);
    if (!key) return;
    if (!sourcePosByKey.has(key)) sourcePosByKey.set(key, pos);
    if (!sourcePositionsByKey.has(key)) sourcePositionsByKey.set(key, []);
    sourcePositionsByKey.get(key).push(pos);
  });

  ordered.forEach((entry, pos) => {
    if (!isConnectionEntry(entry)) return;

    const sourceKey = getConnectionSourceKey(entry);
    assert.ok(
      sourceKey,
      `${directionName}: connection at position ${pos} has no source key`,
    );

    const sourcePos = sourcePosByKey.get(sourceKey);
    assert.notEqual(
      sourcePos,
      undefined,
      `${directionName}: connection at position ${pos} has source ${sourceKey} not present in table`,
    );
    if (!connectionPositionsByKey.has(sourceKey)) {
      connectionPositionsByKey.set(sourceKey, []);
    }
    connectionPositionsByKey.get(sourceKey).push(pos);
  });

  connectionPositionsByKey.forEach((connPositions, sourceKey) => {
    const sourcePositions = sourcePositionsByKey.get(sourceKey) || [];
    assert.ok(
      sourcePositions.length > 0,
      `${directionName}: expected at least one source position for ${sourceKey}`,
    );
    const allPositions = sourcePositions.concat(connPositions).sort((a, b) => a - b);
    const minPos = allPositions[0];
    const maxPos = allPositions[allPositions.length - 1];
    for (let i = minPos; i <= maxPos; i += 1) {
      const entry = ordered[i];
      assert.ok(
        entry,
        `${directionName}: missing entry within source/connection group for ${sourceKey}`,
      );
      if (isConnectionEntry(entry)) {
        assert.equal(
          getConnectionSourceKey(entry),
          sourceKey,
          `${directionName}: connection block for source ${sourceKey} is interrupted by another source at position ${i}`,
        );
        continue;
      }
      const key = getServiceKey(entry);
      assert.equal(
        key,
        sourceKey,
        `${directionName}: non-group service ${key} found inside source/connection block for ${sourceKey} at position ${i}`,
      );
    }
  });
}

function assertConnectionEndpointsInTableRowStations(result) {
  assert.ok(result.connectionStationSet.size > 0, 'expected non-empty table-row station set');

  result.connectionEntries.forEach((entry) => {
    const locs = entry?.detail?.locations || [];
    const fromCrs = locs[0]?.crs || '';
    const toCrs = locs[locs.length - 1]?.crs || '';
    assert.ok(
      result.connectionStationSet.has(fromCrs),
      `connection source ${fromCrs} missing from table-row station set`,
    );
    assert.ok(
      result.connectionStationSet.has(toCrs),
      `connection destination ${toCrs} missing from table-row station set`,
    );
  });
}

function assertHasKgxToStpConnection(result) {
  const isKgxToStpConnection = (entry) => {
    if (!isConnectionEntry(entry)) return false;
    const locs = entry?.detail?.locations || [];
    const fromCrs = locs[0]?.crs || '';
    const toCrs = locs[locs.length - 1]?.crs || '';
    return fromCrs === 'KGX' && toCrs === 'STP';
  };

  const generatedKgxToStpConnections = result.connectionEntries.filter(
    isKgxToStpConnection,
  );
  const displayedKgxToStpConnections = result.ab.orderedEntries
    .concat(result.ba.orderedEntries)
    .filter(isKgxToStpConnection);

  assert.ok(
    generatedKgxToStpConnections.length > 0,
    'expected at least one synthetic KGX -> STP connection',
  );
  assert.ok(
    displayedKgxToStpConnections.length > 0,
    'expected at least one displayed KGX -> STP connection column',
  );
}

function assertHasStpToKgxConnection(result) {
  const isStpToKgxConnection = (entry) => {
    if (!isConnectionEntry(entry)) return false;
    const locs = entry?.detail?.locations || [];
    const fromCrs = locs[0]?.crs || '';
    const toCrs = locs[locs.length - 1]?.crs || '';
    return fromCrs === 'STP' && toCrs === 'KGX';
  };

  const generatedStpToKgxConnections = result.connectionEntries.filter(
    isStpToKgxConnection,
  );
  const displayedStpToKgxConnections = result.ab.orderedEntries
    .concat(result.ba.orderedEntries)
    .filter(isStpToKgxConnection);

  assert.ok(
    generatedStpToKgxConnections.length > 0,
    'expected at least one synthetic STP -> KGX connection',
  );
  assert.ok(
    displayedStpToKgxConnections.length > 0,
    'expected at least one displayed STP -> KGX connection column',
  );
}

function assertStationOrderByLabel(directionName, directionData, orderedLabels) {
  const rows = directionData?.model?.rows || [];
  const stationLabels = rows
    .filter((row) => row?.kind === 'station')
    .map((row) => String(row?.labelStation || '').trim())
    .filter(Boolean);

  let previousPos = -1;
  orderedLabels.forEach((label, idx) => {
    const pos = stationLabels.indexOf(label);
    assert.ok(pos >= 0, `${directionName}: expected station row "${label}" to be present`);
    assert.ok(
      pos > previousPos,
      `${directionName}: expected station row "${label}" after "${orderedLabels[idx - 1]}"`,
    );
    previousPos = pos;
  });
}

function assertWalkOnlyAppearsAsPdfOperator(directionName, directionData) {
  const tableData = directionData?.pdfTableData || {};
  const headers = tableData.headers || [];
  const facilitiesRow = tableData.rows?.[0] || [];
  const walkOperatorColumns = headers
    .map((header, idx) => (String(header).toUpperCase() === 'WALK' ? idx : -1))
    .filter((idx) => idx > 0);

  if (walkOperatorColumns.length === 0) return;

  walkOperatorColumns.forEach((idx) => {
    assert.notEqual(
      String(facilitiesRow[idx] || '').toUpperCase(),
      'WALK',
      `${directionName}: WALK should not appear in PDF facilities row`,
    );
  });
}

export function registerCachedQuerySuite({
  suiteLabel,
  cachePath,
  expectedQueryIncludes = [],
  expectedConnectionEntriesAtLeast = null,
  requireKgxToStpConnection = false,
  requireStpToKgxConnection = false,
  expectedAbStationOrderLabels = null,
  extraAssertions = [],
}) {
  let cachedResultPromise = null;
  const getResult = async () => {
    if (!cachedResultPromise) {
      cachedResultPromise = runCachedQueryFixture(cachePath);
    }
    return cachedResultPromise;
  };

  test(`${suiteLabel} metadata matches expected corridor`, async () => {
    const result = await getResult();
    expectedQueryIncludes.forEach((needle) => {
      assert.ok(result.queryUrl.includes(needle), `expected query to include ${needle}`);
    });
    if (expectedConnectionEntriesAtLeast !== null) {
      assert.ok(
        result.connectionEntries.length >= expectedConnectionEntriesAtLeast,
        `expected at least ${expectedConnectionEntriesAtLeast} generated connections`,
      );
    }
  });

  test(`${suiteLabel} produces stable, non-duplicated timetable columns`, async () => {
    const result = await getResult();
    assertNoDuplicateColumns('AB', result.ab);
    assertNoDuplicateColumns('BA', result.ba);
  });

  test(`${suiteLabel} keeps each source/connection group contiguous`, async () => {
    const result = await getResult();
    assertConnectionAdjacency('AB', result.ab);
    assertConnectionAdjacency('BA', result.ba);
  });

  test(`${suiteLabel} connections only use endpoints that already exist as table-row stations`, async () => {
    const result = await getResult();
    assertConnectionEndpointsInTableRowStations(result);
  });

  if (requireKgxToStpConnection) {
    test(`${suiteLabel} displays KGX -> STP connection when STP is a table-row station`, async () => {
      const result = await getResult();
      assertHasKgxToStpConnection(result);
    });
  }
  if (requireStpToKgxConnection) {
    test(`${suiteLabel} displays STP -> KGX connection when KGX is a table-row station`, async () => {
      const result = await getResult();
      assertHasStpToKgxConnection(result);
    });
  }

  if (Array.isArray(expectedAbStationOrderLabels) && expectedAbStationOrderLabels.length > 1) {
    test(`${suiteLabel} keeps expected AB station row order`, async () => {
      const result = await getResult();
      assertStationOrderByLabel('AB', result.ab, expectedAbStationOrderLabels);
    });
  }

  test(`${suiteLabel} columns have continuous time-or-line blocks with gaps only outside active range`, async () => {
    const result = await getResult();
    assertColumnFillContinuity('AB', result.ab);
    assertColumnFillContinuity('BA', result.ba);
  });

  test(`${suiteLabel} keeps walking labels out of PDF facilities row`, async () => {
    const result = await getResult();
    assertWalkOnlyAppearsAsPdfOperator('AB', result.ab);
    assertWalkOnlyAppearsAsPdfOperator('BA', result.ba);
  });

  test(`${suiteLabel} enforces post-expansion service-misorder coloring for connections`, () => {
    assert.ok(
      assertConnectionMisorderHighlightAfterExpansion(),
      'expected service misorder highlight on grouped connection column after expansion',
    );
  });

  if (Array.isArray(extraAssertions)) {
    extraAssertions.forEach((entry, idx) => {
      if (!entry || typeof entry !== 'object') return;
      const name = String(entry.name || `extra assertion ${idx + 1}`);
      const fn = entry.assert;
      if (typeof fn !== 'function') return;
      test(`${suiteLabel} ${name}`, async () => {
        const result = await getResult();
        fn(result);
      });
    });
  }
}
