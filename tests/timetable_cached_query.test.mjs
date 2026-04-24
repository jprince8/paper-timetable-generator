import path from 'node:path';
import assert from 'node:assert/strict';
import { registerCachedQuerySuite } from './helpers/timetable_cached_query_suite.mjs';
import {
  isConnectionEntry,
  getConnectionSourceKey,
} from './helpers/timetable_cached_query_runner.mjs';

const CACHE_PATH = path.resolve(
  process.cwd(),
  process.env.RTT_FIXTURE_PATH_BFR ||
    process.env.RTT_FIXTURE_PATH ||
    'tests/fixtures/cbg-bfr-via-kgx-optional-2026-04-27.cached-results.json',
);

registerCachedQuerySuite({
  suiteLabel: 'BFR cached query',
  cachePath: CACHE_PATH,
  expectedQueryIncludes: ['from=CBG', 'to=BFR'],
  requireKgxToStpConnection: true,
  requireStpToKgxConnection: true,
  expectedAbStationOrderLabels: [
    'Cambridge',
    'London Kings Cross',
    'St Pancras International',
    'London Blackfriars',
  ],
  extraAssertions: [
    {
      name: 'keeps pre-11:39 STP departures ahead of W58535 connection group',
      assert: (result) => {
        const ordered = result?.ab?.orderedEntries || [];
        const idxW58535 = ordered.findIndex(
          (entry) => String(entry?.svc?.serviceUid || '') === 'W58535',
        );
        assert.ok(idxW58535 >= 0, 'expected W58535 to be present in AB columns');
        const idxConn = ordered.findIndex(
          (entry) =>
            isConnectionEntry(entry) &&
            getConnectionSourceKey(entry) === 'W58535|2026-04-27' &&
            (entry?.detail?.locations?.[0]?.crs || '') === 'KGX' &&
            (entry?.detail?.locations?.[1]?.crs || '') === 'STP',
        );
        assert.equal(idxConn, idxW58535 + 1, 'expected W58535 connection immediately after W58535');

        const idxW57674 = ordered.findIndex(
          (entry) => String(entry?.svc?.serviceUid || '') === 'W57674',
        );
        const idxW59431 = ordered.findIndex(
          (entry) => String(entry?.svc?.serviceUid || '') === 'W59431',
        );
        const idxG84901 = ordered.findIndex(
          (entry) => String(entry?.svc?.serviceUid || '') === 'G84901',
        );

        assert.ok(idxW57674 >= 0, 'expected W57674 to be present in AB columns');
        assert.ok(idxW59431 >= 0, 'expected W59431 to be present in AB columns');
        assert.ok(idxG84901 >= 0, 'expected G84901 to be present in AB columns');
        assert.ok(idxW57674 < idxW58535, 'expected W57674 before W58535/connection group');
        assert.ok(idxW59431 < idxW58535, 'expected W59431 before W58535/connection group');
        assert.ok(idxG84901 > idxConn, 'expected G84901 after W58535 connection');
      },
    },
  ],
});
