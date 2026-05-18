import path from 'node:path';
import assert from 'node:assert/strict';
import { registerCachedQuerySuite } from './helpers/timetable_cached_query_suite.mjs';
import { isConnectionEntry } from './helpers/timetable_cached_query_runner.mjs';

const CACHE_PATH = path.resolve(
  process.cwd(),
  process.env.RTT_FIXTURE_PATH_RUG_KGX_EUS ||
    'tests/fixtures/rug-kgx-via-eus-2026-05-11.cached-results.json',
);

registerCachedQuerySuite({
  suiteLabel: 'RUG -> KGX via EUS cached query',
  cachePath: CACHE_PATH,
  expectedQueryIncludes: ['from=RUG', 'to=KGX', 'vias=EUS'],
  expectedConnectionEntriesAtLeast: 1,
  extraAssertions: [
    {
      name: 'uses generated EUS <-> KGX connections to satisfy the KGX endpoint',
      assert(result) {
        const connectionRoutes = result.connectionEntries
          .filter((entry) => isConnectionEntry(entry))
          .map((entry) =>
            (entry.detail?.locations || []).map((loc) => loc.crs).join('>'),
          );

        assert.ok(
          connectionRoutes.includes('EUS>KGX'),
          'expected generated EUS -> KGX connection',
        );
        assert.ok(
          connectionRoutes.includes('KGX>EUS'),
          'expected generated KGX -> EUS connection',
        );
      },
    },
  ],
});
