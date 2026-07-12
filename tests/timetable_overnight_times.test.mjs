import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadAppRuntime, loadFrontendRuntime } from './helpers/timetable_cached_query_runner.mjs';

test('overnight detailed service times are absolutized while display wraps after midnight', () => {
  const runtime = loadAppRuntime({ repoRoot: path.resolve(process.cwd()) });
  const detail = runtime.absolutizeServiceDetail({
    locations: [
      { crs: 'AAA', gbttBookedDeparture: '2358' },
      { crs: 'BBB', gbttBookedArrival: '0013' },
      { crs: 'CCC', gbttBookedArrival: '0027' },
    ],
  });

  assert.equal(detail.locations[0].gbttBookedDeparture, '2358');
  assert.equal(detail.locations[1].gbttBookedArrival, '2413');
  assert.equal(detail.locations[2].gbttBookedArrival, '2427');
  assert.equal(runtime.formatRttTimeForDisplay(detail.locations[1].gbttBookedArrival), '00:13');
});

test('search range filtering excludes previous-day services that arrive after midnight', () => {
  const runtime = loadAppRuntime({ repoRoot: path.resolve(process.cwd()) });
  runtime.__setBuildTimeRangeForTests('2026-07-03', 0, 23 * 60 + 59);

  assert.equal(
    runtime.serviceAtStationInRange({
      runDate: '2026-07-02',
      locationDetail: { gbttBookedArrival: '0013' },
    }),
    false,
  );
  assert.equal(
    runtime.serviceAtStationInRange({
      runDate: '2026-07-03',
      locationDetail: { gbttBookedArrival: '0013' },
    }),
    true,
  );
});

test('overnight selected time ranges wrap the end time into the next day', () => {
  const runtime = loadAppRuntime({ repoRoot: path.resolve(process.cwd()) });
  const wrapped = runtime.normaliseSelectedTimeRange(20 * 60 + 46, 11 * 60 + 46);

  assert.equal(wrapped.startMins, 20 * 60 + 46);
  assert.equal(wrapped.endMins, 24 * 60 + 11 * 60 + 46);

  runtime.__setBuildTimeRangeForTests('2026-07-13', wrapped.startMins, wrapped.endMins);
  const detail = runtime.absolutizeServiceDetail({
    locations: [
      { crs: 'CMB', gbttBookedDeparture: '2258', isPublicCall: true },
      { crs: 'KGX', gbttBookedArrival: '0044', isPublicCall: true },
    ],
  });

  assert.equal(runtime.serviceAnyStationInRange(detail, new Set(['CMB', 'KGX'])), true);
});

test('displayed timetable cells wrap overnight absolute times without losing absolute sort minutes', () => {
  const runtime = loadFrontendRuntime({ repoRoot: path.resolve(process.cwd()) });
  const chosen = runtime.chooseDisplayedTimeAndStatus(
    { gbttBookedArrival: '2413' },
    true,
    false,
    false,
  );

  assert.equal(chosen.text, '00:13');
  assert.equal(chosen.mins, 24 * 60 + 13);
});
