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
