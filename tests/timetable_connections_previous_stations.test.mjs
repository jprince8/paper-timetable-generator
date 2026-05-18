import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  assertConnectionGenerationUsesRealtimeWhenEnabled,
  assertConnectionEndpointsForceSplitStationRows,
  assertEqualTimeDepartureSortsAfterArrival,
  loadFrontendRuntime,
} from './helpers/timetable_cached_query_runner.mjs';

test('connection endpoint stations with arrivals and departures use split rows', () => {
  const result = assertConnectionEndpointsForceSplitStationRows();

  assert.deepEqual(
    result.bravoLabels,
    ['arr', 'dep'],
    'expected connection origin station Bravo to split arrival/departure rows',
  );
  assert.deepEqual(
    result.charlieLabels,
    ['arr', 'dep'],
    'expected connection destination station Charlie to split arrival/departure rows',
  );
});

test('equal-time departures sort after arrivals at the same station', () => {
  assert.deepEqual(assertEqualTimeDepartureSortsAfterArrival(), [1, 0]);
});

test('connection generation follows realtime toggle for source train times', () => {
  assert.deepEqual(assertConnectionGenerationUsesRealtimeWhenEnabled(), {
    outboundScheduledDepart: '1000',
    outboundScheduledArrive: '1010',
    outboundRealtimeDepart: '1005',
    outboundRealtimeArrive: '1015',
    inboundScheduledDepart: '1020',
    inboundScheduledArrive: '1030',
    inboundRealtimeDepart: '1030',
    inboundRealtimeArrive: '1040',
  });
});

test('direct connection mandatory vias block generated connections that skip over them', () => {
  const runtime = loadFrontendRuntime({
    startMinutes: 0,
    endMinutes: 24 * 60 - 1,
    connectionsData: {
      AAA: [
        {
          connections: {
            BBB: [{ durationMinutes: 5, mode: 'walk' }],
            CCC: [{ durationMinutes: 10, mode: 'walk' }],
          },
        },
      ],
      BBB: [
        {
          connections: {
            CCC: [{ durationMinutes: 5, mode: 'walk' }],
          },
        },
      ],
    },
    repoRoot: path.resolve(process.cwd()),
  });
  const corridorSet = new Set(['AAA', 'BBB', 'CCC']);
  const entries = [
    buildConnectionContextService('SRC-AAA', ['BBB', 'AAA', 'ZZZ']),
    buildConnectionContextService('SRC-BBB', ['AAA', 'BBB', 'ZZZ']),
    buildConnectionContextService('SRC-CCC', ['BBB', 'CCC', 'ZZZ']),
  ];
  const generatedWithoutBarrier = runtime.buildConnectionServiceEntries(
    entries,
    corridorSet,
    0,
    'both',
    ['AAA', 'BBB', 'CCC'],
  );
  const generatedWithBarrier = runtime.buildConnectionServiceEntries(
    entries,
    corridorSet,
    0,
    'both',
    ['AAA', 'BBB', 'CCC'],
    { mandatoryViaStations: ['BBB'] },
  );

  assert.ok(
    countGeneratedConnection(generatedWithoutBarrier, 'AAA', 'CCC') > 0,
    'expected baseline connection to skip over BBB',
  );
  assert.equal(countGeneratedConnection(generatedWithBarrier, 'AAA', 'CCC'), 0);
  assert.ok(countGeneratedConnection(generatedWithBarrier, 'AAA', 'BBB') > 0);
  assert.ok(countGeneratedConnection(generatedWithBarrier, 'BBB', 'CCC') > 0);
});

test('cancelled current stops do not anchor generated connections', () => {
  const runtime = loadFrontendRuntime({
    startMinutes: 0,
    endMinutes: 24 * 60 - 1,
    connectionsData: {
      AAA: [
        {
          previousStations: ['PRE'],
          connections: {
            BBB: [
              {
                durationMinutes: 5,
                mode: 'walk',
              },
            ],
          },
        },
      ],
      BBB: [
        {
          connections: {
            CCC: [
              {
                durationMinutes: 5,
                mode: 'walk',
                nextStations: ['POST'],
              },
            ],
          },
        },
      ],
    },
    repoRoot: path.resolve(process.cwd()),
  });
  const corridorSet = new Set(['PRE', 'AAA', 'BBB', 'CCC', 'POST']);

  const cancelledAnchor = runtime.buildConnectionServiceEntries(
    [
      buildConnectionContextService('SRC-CANCELLED-ANCHOR', [
        'PRE',
        { crs: 'AAA', displayAs: 'CANCELLED_CALL' },
        'BBB',
      ]),
    ],
    corridorSet,
    0,
    'outbound',
    [],
  );
  const cancelledPrevious = runtime.buildConnectionServiceEntries(
    [
      buildConnectionContextService('SRC-CANCELLED-PREVIOUS', [
        { crs: 'PRE', displayAs: 'CANCELLED_CALL' },
        'AAA',
        'BBB',
      ]),
    ],
    corridorSet,
    0,
    'outbound',
    [],
  );
  const cancelledNext = runtime.buildConnectionServiceEntries(
    [
      buildConnectionContextService('SRC-CANCELLED-NEXT', [
        'AAA',
        'BBB',
        'CCC',
        { crs: 'POST', displayAs: 'CANCELLED_CALL' },
      ]),
    ],
    corridorSet,
    0,
    'inbound',
    [],
  );

  assert.equal(countGeneratedConnection(cancelledAnchor, 'AAA', 'BBB'), 0);
  assert.ok(countGeneratedConnection(cancelledPrevious, 'AAA', 'BBB') > 0);
  assert.ok(countGeneratedConnection(cancelledNext, 'BBB', 'CCC') > 0);
});

test('endpoint arrival and departure times are hidden before deciding split rows', () => {
  const runtime = loadFrontendRuntime({
    startMinutes: 0,
    endMinutes: 24 * 60 - 1,
    connectionsData: {},
    repoRoot: path.resolve(process.cwd()),
  });
  const stations = [
    { crs: 'AAA', name: 'Alpha' },
    { crs: 'BBB', name: 'Bravo' },
    { crs: 'CCC', name: 'Charlie' },
  ];
  const stationSet = Object.fromEntries(stations.map((station) => [station.crs, station]));
  const model = runtime.buildTimetableModel(stations, stationSet, [
    {
      svc: { serviceUid: 'SPLIT-ENDPOINTS', runDate: '2026-04-27' },
      detail: {
        runDate: '2026-04-27',
        locations: [
          {
            crs: 'AAA',
            gbttBookedArrival: '0900',
            gbttBookedDeparture: '0910',
            displayAs: 'CALL',
            isPublicCall: true,
          },
          {
            crs: 'BBB',
            gbttBookedArrival: '0920',
            gbttBookedDeparture: '0921',
            displayAs: 'CALL',
            isPublicCall: true,
          },
          {
            crs: 'CCC',
            gbttBookedArrival: '0930',
            gbttBookedDeparture: '0940',
            displayAs: 'CALL',
            isPublicCall: true,
          },
        ],
      },
    },
  ]);

  const stationRows = model.rows.filter((row) => row.kind === 'station');
  const renderedRows = stationRows.map((row) => ({
    station: row.labelStation,
    arrDep: row.labelArrDep,
    cell: row.cells[0]?.text || row.cells[0] || '',
  }));

  assert.deepEqual(
    JSON.parse(JSON.stringify(renderedRows)),
    [
      { station: 'Alpha', arrDep: '', cell: '09:10' },
      { station: 'Bravo', arrDep: '', cell: '09:21' },
      { station: 'Charlie', arrDep: '', cell: '09:30' },
    ],
  );
});

test('merged-row sorting uses the same endpoint-visible time as rendering', () => {
  const runtime = loadFrontendRuntime({
    startMinutes: 0,
    endMinutes: 24 * 60 - 1,
    connectionsData: {},
    repoRoot: path.resolve(process.cwd()),
  });
  const rows = [
    {
      kind: 'station',
      labelStation: 'London Bridge',
      labelArrDep: '',
      cells: [{ text: '10:28' }, { text: '10:28' }],
    },
  ];
  const rowSpecs = [{ kind: 'station', stationIndex: 0, mode: 'merged' }];
  const stationTimes = [
    [
      {
        arrStr: '10:26',
        arrMins: 626,
        depStr: '10:28',
        depMins: 628,
        loc: {
          gbttBookedArrival: '1026',
          gbttBookedDeparture: '1028',
          realtimeArrival: '1026',
          realtimeDeparture: '1028',
        },
      },
      {
        arrStr: '10:29',
        arrMins: 629,
        depStr: '10:31',
        depMins: 631,
        loc: {
          gbttBookedArrival: '1029',
          gbttBookedDeparture: '1031',
          realtimeArrival: '1028',
          realtimeDeparture: '1031',
        },
      },
    ],
  ];

  const sortResult = runtime.sortTimetableColumns({
    rows,
    rowSpecs,
    stationTimes,
    visibleTimeFlags: [
      [
        { arr: false, dep: true },
        { arr: true, dep: false },
      ],
    ],
    stationModes: ['merged'],
    displayStations: [{ name: 'London Bridge', crs: 'LBG' }],
    servicesWithDetails: [
      {
        svc: { serviceUid: 'P5-FIRST', runDate: '2026-05-17' },
        detail: { realtimeActivated: true },
      },
      {
        svc: { serviceUid: 'P6-LAST', runDate: '2026-05-17' },
        detail: { realtimeActivated: true },
      },
    ],
    serviceAllCancelled: [false, false],
    serviceAllNoReport: [false, false],
    serviceRealtimeFlags: [true, true],
    realtimeToggleEnabled: true,
    servicesMeta: [{ visible: 'P5-FIRST' }, { visible: 'P6-LAST' }],
    highlightColors: {
      outOfOrder: '#fce3b0',
      depAfterArrival: '#e6d9ff',
      serviceMisorder: '#f7c9c9',
    },
  });

  assert.deepEqual(Array.from(sortResult.orderedSvcIndices), [1, 0]);
});

function buildConnectionContextService(uid, crsList) {
  return {
    svc: { serviceUid: uid, runDate: '2026-04-27' },
    detail: {
      runDate: '2026-04-27',
      locations: crsList.map((station, idx) => {
        const stationSpec =
          station && typeof station === 'object' ? station : { crs: station };
        return {
          crs: stationSpec.crs,
          gbttBookedArrival: idx === 0 ? '' : `09${String(idx).padStart(2, '0')}`,
          gbttBookedDeparture:
            idx === crsList.length - 1 ? '' : `09${String(idx).padStart(2, '0')}`,
          displayAs: stationSpec.displayAs || 'CALL',
          isPublicCall: true,
        };
      }),
    },
  };
}

function countGeneratedConnection(entries, fromCrs, toCrs) {
  return entries.filter(
    (entry) =>
      entry?.detail?.locations?.[0]?.crs === fromCrs &&
      entry?.detail?.locations?.[1]?.crs === toCrs,
  ).length;
}
