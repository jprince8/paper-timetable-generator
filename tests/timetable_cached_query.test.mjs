import path from 'node:path';
import { registerCachedQuerySuite } from './helpers/timetable_cached_query_suite.mjs';

const CACHE_PATH = path.resolve(
  process.cwd(),
  process.env.RTT_FIXTURE_PATH_BFR ||
    process.env.RTT_FIXTURE_PATH ||
    'tests/fixtures/cbg-bfr-via-kgx-optional-2026-05-11.cached-results.json',
);

registerCachedQuerySuite({
  suiteLabel: 'BFR cached query',
  cachePath: CACHE_PATH,
  expectedQueryIncludes: ['from=CBG', 'to=BFR'],
  requireKgxToStpConnection: false,
  requireStpToKgxConnection: false,
  localStorageSeed: {
    corridor_specifiedConnectionsOnly: false,
  },
  expectedAbStationOrderLabels: [
    'Cambridge',
    'London Blackfriars',
  ],
});
