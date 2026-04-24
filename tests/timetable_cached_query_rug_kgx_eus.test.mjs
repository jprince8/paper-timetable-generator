import path from 'node:path';
import assert from 'node:assert/strict';
import { registerCachedQuerySuite } from './helpers/timetable_cached_query_suite.mjs';
import { isConnectionEntry } from './helpers/timetable_cached_query_runner.mjs';

const CACHE_PATH = path.resolve(
  process.cwd(),
  process.env.RTT_FIXTURE_PATH_RUG_KGX_EUS ||
    'tests/fixtures/rug-kgx-via-eus-2026-04-27.cached-results.json',
);

registerCachedQuerySuite({
  suiteLabel: 'RUG -> KGX via EUS cached query',
  cachePath: CACHE_PATH,
  expectedQueryIncludes: ['from=RUG', 'to=KGX', 'vias=EUS'],
  expectedConnectionEntriesAtLeast: 0,
  extraAssertions: [],
});
