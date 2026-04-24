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
  expectedConnectionEntriesAtLeast: 1,
  extraAssertions: [
    {
      name: 'shows EUS -> KGX walking connections',
      assert: (result) => {
        const isEusToKgx = (entry) => {
          if (!isConnectionEntry(entry)) return false;
          const locs = entry?.detail?.locations || [];
          const fromCrs = locs[0]?.crs || '';
          const toCrs = locs[locs.length - 1]?.crs || '';
          return fromCrs === 'EUS' && toCrs === 'KGX';
        };

        const generated = result.connectionEntries.filter(isEusToKgx);
        const displayed = result.ab.orderedEntries
          .concat(result.ba.orderedEntries)
          .filter(isEusToKgx);

        assert.ok(
          generated.length > 0,
          'expected at least one generated EUS -> KGX synthetic connection',
        );
        assert.ok(
          displayed.length > 0,
          'expected at least one displayed EUS -> KGX connection column',
        );
      },
    },
  ],
});
