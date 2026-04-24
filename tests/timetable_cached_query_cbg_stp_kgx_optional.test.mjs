import path from 'node:path';
import assert from 'node:assert/strict';
import { registerCachedQuerySuite } from './helpers/timetable_cached_query_suite.mjs';
import { isConnectionEntry } from './helpers/timetable_cached_query_runner.mjs';

const CACHE_PATH = path.resolve(
  process.cwd(),
  process.env.RTT_FIXTURE_PATH_CBG_STP_KGX_OPTIONAL ||
    'tests/fixtures/cbg-stp-via-kgx-optional-2026-04-27.cached-results.json',
);

registerCachedQuerySuite({
  suiteLabel: 'CBG -> STP via KGX? cached query',
  cachePath: CACHE_PATH,
  expectedQueryIncludes: ['from=CBG', 'to=STP', 'vias=KGX%3F'],
  requireKgxToStpConnection: true,
  requireStpToKgxConnection: true,
  extraAssertions: [
    {
      name: 'keeps KGX/STP connection direction aligned with panel direction',
      assert: (result) => {
        const countPair = (entries, fromCrs, toCrs) =>
          entries.filter((entry) => {
            if (!isConnectionEntry(entry)) return false;
            const locs = entry?.detail?.locations || [];
            return locs[0]?.crs === fromCrs && locs[1]?.crs === toCrs;
          }).length;

        const abKgxToStp = countPair(result?.ab?.orderedEntries || [], 'KGX', 'STP');
        const abStpToKgx = countPair(result?.ab?.orderedEntries || [], 'STP', 'KGX');
        const baKgxToStp = countPair(result?.ba?.orderedEntries || [], 'KGX', 'STP');
        const baStpToKgx = countPair(result?.ba?.orderedEntries || [], 'STP', 'KGX');

        assert.ok(abKgxToStp > 0, 'expected AB to include at least one KGX -> STP connection');
        assert.equal(abStpToKgx, 0, 'expected AB to exclude STP -> KGX connections');
        assert.equal(baKgxToStp, 0, 'expected BA to exclude KGX -> STP connections');
        assert.ok(baStpToKgx > 0, 'expected BA to include at least one STP -> KGX connection');
      },
    },
  ],
});
