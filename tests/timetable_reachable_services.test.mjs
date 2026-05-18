import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadFrontendRuntime } from './helpers/timetable_cached_query_runner.mjs';

const stations = [
  { crs: 'AAA', name: 'Alpha' },
  { crs: 'BBB', name: 'Bravo' },
  { crs: 'CCC', name: 'Charlie' },
  { crs: 'DDD', name: 'Delta' },
];

const stationSet = Object.fromEntries(stations.map((station) => [station.crs, true]));

function service(uid, locations, extra = {}) {
  return {
    svc: {
      serviceUid: uid,
      runDate: '2026-04-27',
      atocCode: extra.atocCode || 'ZZ',
      serviceType: extra.serviceType || '',
      isPassenger: true,
    },
    detail: {
      runDate: '2026-04-27',
      atocCode: extra.atocCode || 'ZZ',
      serviceType: extra.serviceType || '',
      locations: locations.map((location) => ({
        displayAs: 'CALL',
        isPublicCall: true,
        ...location,
      })),
    },
    isConnection: extra.isConnection === true,
  };
}

function serviceUids(model) {
  return model.servicesWithDetails.map((entry) => entry.svc.serviceUid);
}

test('reachable services filter keeps only services on a valid first-to-final chain', () => {
  const runtime = loadFrontendRuntime({
    startMinutes: 0,
    endMinutes: 24 * 60 - 1,
    connectionsData: {},
    repoRoot: path.resolve(process.cwd()),
  });

  const services = [
    service('START', [
      { crs: 'AAA', gbttBookedDeparture: '0900' },
      { crs: 'BBB', gbttBookedArrival: '0910' },
    ]),
    service(
      'WALK-B-C',
      [
        { crs: 'BBB', gbttBookedDeparture: '0920' },
        { crs: 'CCC', gbttBookedArrival: '0930' },
      ],
      { isConnection: true, serviceType: 'walk', atocCode: 'W' },
    ),
    service('FINISH', [
      { crs: 'CCC', gbttBookedDeparture: '0940' },
      { crs: 'DDD', gbttBookedArrival: '0950' },
    ]),
    service('TOO-EARLY', [
      { crs: 'BBB', gbttBookedDeparture: '0800' },
      { crs: 'CCC', gbttBookedArrival: '0810' },
    ]),
    service('TOO-LATE', [
      { crs: 'AAA', gbttBookedDeparture: '1000' },
      { crs: 'BBB', gbttBookedArrival: '1010' },
    ]),
  ];

  const unfiltered = runtime.buildTimetableModel(stations, stationSet, services);
  const filtered = runtime.buildTimetableModel(stations, stationSet, services, {
    reachableServicesOnly: true,
  });

  assert.deepEqual(serviceUids(unfiltered), [
    'START',
    'WALK-B-C',
    'FINISH',
    'TOO-EARLY',
    'TOO-LATE',
  ]);
  assert.deepEqual(serviceUids(filtered), ['START', 'WALK-B-C', 'FINISH']);
});
