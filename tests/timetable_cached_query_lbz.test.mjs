import path from 'node:path';
import { registerCachedQuerySuite } from './helpers/timetable_cached_query_suite.mjs';

const CACHE_PATH = path.resolve(
  process.cwd(),
  process.env.RTT_FIXTURE_PATH_LBZ ||
    'tests/fixtures/cbg-lbz-via-kgx-eus-2026-04-27.cached-results.json',
);

registerCachedQuerySuite({
  suiteLabel: 'LBZ cached query',
  cachePath: CACHE_PATH,
  expectedQueryIncludes: ['from=CBG', 'to=LBZ', 'vias=KGX%2CEUS'],
  expectedConnectionEntriesAtLeast: 1,
});
