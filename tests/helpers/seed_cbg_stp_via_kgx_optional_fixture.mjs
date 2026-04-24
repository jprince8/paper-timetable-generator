import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const QUERY_URL =
  'http://127.0.0.1:8080/?from=CBG&to=STP&date=2026-04-27&start=09%3A00&end=12%3A00&rtt_cache=1&vias=KGX%3F&debug_connections=1';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const seedScriptPath = path.join(repoRoot, 'tests/helpers/seed_cached_query_fixture.mjs');
const cacheDir = path.join(repoRoot, 'tests/fixtures/rtt-query-cache');
const outputPath = path.join(
  repoRoot,
  'tests/fixtures/cbg-stp-via-kgx-optional-2026-04-27.cached-results.json',
);

const fixtureJson = execFileSync(
  process.execPath,
  [seedScriptPath, '--query-url', QUERY_URL, '--cache-dir', cacheDir],
  { encoding: 'utf8' },
);

fs.writeFileSync(outputPath, fixtureJson, 'utf8');
process.stdout.write(`Wrote fixture: ${outputPath}\n`);
