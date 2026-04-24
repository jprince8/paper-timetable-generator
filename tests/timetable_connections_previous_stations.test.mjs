import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertConnectionEndpointsForceSplitStationRows,
  assertEqualTimeDepartureSortsAfterArrival,
  assertInboundConnectionsHonourPreviousStations,
} from './helpers/timetable_cached_query_runner.mjs';

test('inbound connections honour previousStations using the source service next station', () => {
  const result = assertInboundConnectionsHonourPreviousStations();

  assert.equal(
    result.mismatchedCount,
    0,
    'expected no connection when neither adjacent station matches previousStations',
  );
  assert.equal(
    result.inboundMatchedCount,
    1,
    'expected inbound connection when next station is in previousStations',
  );
  assert.equal(
    result.inboundMatchedLocations.map((loc) => loc.crs).join(','),
    'EUS,PAD',
  );
  assert.equal(
    result.outboundMatchedCount,
    1,
    'expected outbound connection when previous station is in previousStations',
  );
  assert.equal(
    result.outboundMatchedLocations.map((loc) => loc.crs).join(','),
    'PAD,EUS',
  );
  assert.equal(
    result.duplicateTransferCount,
    1,
    'expected duplicate synthetic transfer legs to be deduplicated',
  );
  assert.equal(
    result.duplicateTransferPlacement,
    'after',
    'expected duplicate transfer to keep the after-arrival source',
  );
  assert.equal(result.duplicateTransferSourceKey, 'PAD-SRC|2026-04-27');
  assert.equal(
    result.nonAdjacentOutboundMatchedCount,
    1,
    'expected outbound connection when any previous station is in previousStations',
  );
  assert.equal(
    result.nonAdjacentInboundMatchedCount,
    1,
    'expected inbound connection when any next station is in previousStations',
  );
  assert.equal(
    result.unconstrainedAtFirstStopCount,
    1,
    'expected only outbound connection for unconstrained config at a first stop',
  );
  assert.equal(
    result.unconstrainedAtLastStopCount,
    1,
    'expected only inbound connection for unconstrained config at a last stop',
  );
  assert.equal(
    result.unconstrainedWithBothSidesCount,
    2,
    'expected inbound and outbound connections when unconstrained config has both sides',
  );
  assert.equal(
    result.intermediateCount,
    1,
    'expected inbound connection at an intermediate connection station',
  );
  assert.equal(
    result.intermediateLocations.map((loc) => loc.crs).join(','),
    'EUS,PAD',
  );
  assert.equal(result.intermediateSourceKey, 'G23409|2026-04-27');
});

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
