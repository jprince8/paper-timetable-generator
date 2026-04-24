import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertConnectionEndpointsForceSplitStationRows,
  assertEqualTimeDepartureSortsAfterArrival,
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
