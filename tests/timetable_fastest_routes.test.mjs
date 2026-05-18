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

function loadRuntime() {
  return loadFrontendRuntime({
    startMinutes: 0,
    endMinutes: 24 * 60 - 1,
    connectionsData: {},
    repoRoot: path.resolve(process.cwd()),
  });
}

test('fastest routes filter removes a slower reachable path for the same departure', () => {
  const runtime = loadRuntime();
  const services = [
    service('SLOW-DIRECT', [
      { crs: 'AAA', gbttBookedDeparture: '0900' },
      { crs: 'DDD', gbttBookedArrival: '1000' },
    ]),
    service('FAST-START', [
      { crs: 'AAA', gbttBookedDeparture: '0900' },
      { crs: 'BBB', gbttBookedArrival: '0910' },
    ]),
    service('FAST-FINISH', [
      { crs: 'BBB', gbttBookedDeparture: '0915' },
      { crs: 'DDD', gbttBookedArrival: '0945' },
    ]),
  ];

  const filtered = runtime.buildTimetableModel(stations, stationSet, services, {
    fastestRoutesOnly: true,
  });

  assert.deepEqual(serviceUids(filtered), ['FAST-START', 'FAST-FINISH']);
});

test('fastest routes filter keeps equal earliest-arrival alternatives', () => {
  const runtime = loadRuntime();
  const services = [
    service('VIA-B-START', [
      { crs: 'AAA', gbttBookedDeparture: '0900' },
      { crs: 'BBB', gbttBookedArrival: '0910' },
    ]),
    service('VIA-B-FINISH', [
      { crs: 'BBB', gbttBookedDeparture: '0915' },
      { crs: 'DDD', gbttBookedArrival: '0945' },
    ]),
    service('VIA-C-START', [
      { crs: 'AAA', gbttBookedDeparture: '0900' },
      { crs: 'CCC', gbttBookedArrival: '0920' },
    ]),
    service('VIA-C-FINISH', [
      { crs: 'CCC', gbttBookedDeparture: '0925' },
      { crs: 'DDD', gbttBookedArrival: '0945' },
    ]),
    service('SLOW-DIRECT', [
      { crs: 'AAA', gbttBookedDeparture: '0900' },
      { crs: 'DDD', gbttBookedArrival: '1000' },
    ]),
  ];

  const filtered = runtime.buildTimetableModel(stations, stationSet, services, {
    fastestRoutesOnly: true,
  });

  assert.deepEqual(serviceUids(filtered), [
    'VIA-B-START',
    'VIA-B-FINISH',
    'VIA-C-START',
    'VIA-C-FINISH',
  ]);
});

test('fastest routes filter unions paths across multiple first-station departures', () => {
  const runtime = loadRuntime();
  const services = [
    service('EARLY-START', [
      { crs: 'AAA', gbttBookedDeparture: '0900' },
      { crs: 'BBB', gbttBookedArrival: '0910' },
    ]),
    service('EARLY-FINISH', [
      { crs: 'BBB', gbttBookedDeparture: '0915' },
      { crs: 'DDD', gbttBookedArrival: '0945' },
    ]),
    service('LATE-DIRECT', [
      { crs: 'AAA', gbttBookedDeparture: '1000' },
      { crs: 'DDD', gbttBookedArrival: '1035' },
    ]),
    service('LATE-SLOW-START', [
      { crs: 'AAA', gbttBookedDeparture: '1000' },
      { crs: 'CCC', gbttBookedArrival: '1015' },
    ]),
    service('LATE-SLOW-FINISH', [
      { crs: 'CCC', gbttBookedDeparture: '1020' },
      { crs: 'DDD', gbttBookedArrival: '1050' },
    ]),
  ];

  const filtered = runtime.buildTimetableModel(stations, stationSet, services, {
    fastestRoutesOnly: true,
  });

  assert.deepEqual(serviceUids(filtered), [
    'EARLY-START',
    'EARLY-FINISH',
    'LATE-DIRECT',
  ]);
});

test('fastest routes filter includes synthetic connection legs in fastest paths', () => {
  const runtime = loadRuntime();
  const services = [
    service('TRAIN-START', [
      { crs: 'AAA', gbttBookedDeparture: '0900' },
      { crs: 'BBB', gbttBookedArrival: '0910' },
    ]),
    service(
      'WALK-B-C',
      [
        { crs: 'BBB', gbttBookedDeparture: '0910' },
        { crs: 'CCC', gbttBookedArrival: '0920' },
      ],
      { isConnection: true, serviceType: 'walk', atocCode: 'W' },
    ),
    service('TRAIN-FINISH', [
      { crs: 'CCC', gbttBookedDeparture: '0925' },
      { crs: 'DDD', gbttBookedArrival: '0945' },
    ]),
    service('SLOW-DIRECT', [
      { crs: 'AAA', gbttBookedDeparture: '0900' },
      { crs: 'DDD', gbttBookedArrival: '1000' },
    ]),
  ];

  const filtered = runtime.buildTimetableModel(stations, stationSet, services, {
    fastestRoutesOnly: true,
  });

  assert.deepEqual(serviceUids(filtered), [
    'TRAIN-START',
    'WALK-B-C',
    'TRAIN-FINISH',
  ]);
});

test('fastest routes filter requires coverage from both departure and arrival passes', () => {
  const runtime = loadRuntime();
  const services = [
    service('EARLY-SAME-ARRIVAL', [
      { crs: 'AAA', gbttBookedDeparture: '0900' },
      { crs: 'DDD', gbttBookedArrival: '1000' },
    ]),
    service('LATER-SAME-ARRIVAL', [
      { crs: 'AAA', gbttBookedDeparture: '0930' },
      { crs: 'DDD', gbttBookedArrival: '1000' },
    ]),
    service('SLOW-LATE', [
      { crs: 'AAA', gbttBookedDeparture: '0930' },
      { crs: 'DDD', gbttBookedArrival: '1010' },
    ]),
  ];

  const filtered = runtime.buildTimetableModel(stations, stationSet, services, {
    fastestRoutesOnly: true,
  });

  assert.deepEqual(serviceUids(filtered), ['LATER-SAME-ARRIVAL']);
});
