import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--query-url') {
      args.queryUrl = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--cache-dir') {
      args.cacheDir = argv[i + 1];
      i += 1;
      continue;
    }
  }
  if (!args.queryUrl) throw new Error('--query-url is required');
  if (!args.cacheDir) throw new Error('--cache-dir is required');
  return args;
}

function quotePlus(value) {
  return encodeURIComponent(String(value)).replace(/%20/g, '+');
}

function canonicalRequestKey(pathname, params) {
  const entries = Array.from(params.entries()).sort((a, b) => {
    if (a[0] !== b[0]) return a[0].localeCompare(b[0]);
    return a[1].localeCompare(b[1]);
  });
  const query = entries.map(([k, v]) => `${quotePlus(k)}=${quotePlus(v)}`).join('&');
  return `${pathname}?${query}`;
}

function cachePathForKey(cacheDir, key) {
  const digest = crypto.createHash('sha1').update(key, 'utf8').digest('hex');
  return path.join(cacheDir, `${digest}.json`);
}

function parseMinutes(raw) {
  const m = String(raw || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isInteger(hh) || !Number.isInteger(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

function parseViaEntries(viasRaw) {
  if (!viasRaw) return [];
  return String(viasRaw)
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => (token.endsWith('?') ? token.slice(0, -1) : token))
    .map((token) => token.trim().toUpperCase())
    .filter(Boolean);
}

class FakeElement {
  constructor(id = '') {
    this.id = id;
    this.value = '';
    this.textContent = '';
    this.innerHTML = '';
    this.disabled = false;
    this.checked = true;
    this.type = 'text';
    this.children = [];
    this.listeners = {};
    this.dataset = {};
    this.style = { width: '', display: '' };
    this.className = '';
    this.classList = {
      add: () => {},
      remove: () => {},
      contains: () => false,
      toggle: () => false,
    };
  }

  addEventListener(type, handler) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(handler);
  }

  removeEventListener(type, handler) {
    if (!this.listeners[type]) return;
    this.listeners[type] = this.listeners[type].filter((fn) => fn !== handler);
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  insertBefore(child, beforeChild) {
    if (!beforeChild) {
      this.children.push(child);
      return child;
    }
    const index = this.children.indexOf(beforeChild);
    if (index < 0) {
      this.children.push(child);
      return child;
    }
    this.children.splice(index, 0, child);
    return child;
  }

  removeChild(child) {
    this.children = this.children.filter((c) => c !== child);
    return child;
  }

  querySelector() {
    return new FakeElement();
  }

  querySelectorAll() {
    return [];
  }

  setAttribute() {}

  removeAttribute() {}

  reportValidity() {
    return true;
  }

  focus() {}

  select() {}

  setSelectionRange() {}

  setCustomValidity() {}

  click() {
    const handlers = this.listeners.click || [];
    handlers.forEach((fn) => fn({ preventDefault() {}, stopPropagation() {} }));
  }

  remove() {}
}

function paramsObject(searchParams) {
  const out = {};
  for (const [k, v] of searchParams.entries()) out[k] = v;
  return out;
}

async function seedFixture({ repoRoot, queryUrl, cacheDir }) {
  const query = new URL(queryUrl).searchParams;
  const urlObj = new URL(queryUrl);
  const baseUrl = `${urlObj.protocol}//${urlObj.host}`;

  const byId = new Map();
  const byTag = new Map();
  function getElementById(id) {
    if (!byId.has(id)) byId.set(id, new FakeElement(id));
    return byId.get(id);
  }

  const document = {
    getElementById,
    createElement: (tag) => {
      const el = new FakeElement(tag);
      const list = byTag.get(tag) || [];
      list.push(el);
      byTag.set(tag, list);
      return el;
    },
    querySelector: () => new FakeElement(),
    querySelectorAll: () => [],
    body: new FakeElement('body'),
    execCommand: () => true,
  };

  const localStorageMap = new Map();
  const localStorage = {
    getItem: (k) => (localStorageMap.has(k) ? localStorageMap.get(k) : null),
    setItem: (k, v) => {
      localStorageMap.set(k, String(v));
    },
    removeItem: (k) => {
      localStorageMap.delete(k);
    },
    key: (i) => Array.from(localStorageMap.keys())[i] ?? null,
    get length() {
      return localStorageMap.size;
    },
  };

  const atocCodes = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data/atoc_codes.json'), 'utf8'));
  const connectionsPath = fs.existsSync(path.join(repoRoot, 'data/connections.json'))
    ? path.join(repoRoot, 'data/connections.json')
    : path.join(repoRoot, 'data/connections2.json');
  const connections = JSON.parse(fs.readFileSync(connectionsPath, 'utf8'));
  const stations = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data/stations.json'), 'utf8'));

  const requiredRequestKeys = new Set();

  async function fetchRttWithCache(pathname, parsedUrl) {
    const key = canonicalRequestKey(pathname, parsedUrl.searchParams);
    requiredRequestKeys.add(key);
    const cacheFile = cachePathForKey(cacheDir, key);
    if (fs.existsSync(cacheFile)) {
      try {
        const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        if (cached?.key === key && cached?.response && typeof cached.response === 'object') {
          return { status: 200, statusText: 'OK', payload: cached.response };
        }
      } catch {
        // fall through to live fetch
      }
    }

    const upstreamUrl = `${baseUrl}${pathname}${parsedUrl.search}`;
    const upstreamResp = await fetch(upstreamUrl, {
      headers: { Accept: 'application/json' },
    });
    const text = await upstreamResp.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw new Error(`Invalid JSON from ${upstreamUrl}: ${error}`);
    }

    if (!upstreamResp.ok || (payload && typeof payload === 'object' && payload.error)) {
      throw new Error(
        `Upstream request failed for ${key}: status=${upstreamResp.status} body=${JSON.stringify(payload)}`,
      );
    }

    const record = {
      key,
      path: pathname,
      params: paramsObject(parsedUrl.searchParams),
      response: payload,
    };
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(record, null, 2));
    return {
      status: upstreamResp.status,
      statusText: upstreamResp.statusText || 'OK',
      payload,
    };
  }

  async function fetchStub(input, options = {}) {
    const reqUrl = typeof input === 'string' ? input : String(input?.url || '');
    const parsed = new URL(reqUrl, baseUrl);
    const pathname = parsed.pathname;

    let status = 200;
    let statusText = 'OK';
    let payload = null;

    if (pathname === '/api/atoc-codes') {
      payload = atocCodes;
    } else if (pathname === '/api/connections') {
      payload = connections;
    } else if (pathname === '/api/stations') {
      const q = String(parsed.searchParams.get('q') || '').toLowerCase();
      const matches = q
        ? stations
            .filter((s) => {
              const name = String(s.stationName || '').toLowerCase();
              const crs = String(s.crsCode || '').toLowerCase();
              return name.includes(q) || crs.includes(q);
            })
            .slice(0, 25)
        : [];
      payload = matches;
    } else if (pathname === '/rtt/search' || pathname === '/rtt/service') {
      const result = await fetchRttWithCache(pathname, parsed);
      status = result.status;
      statusText = result.statusText;
      payload = result.payload;
    } else if (pathname === '/timetable/pdf') {
      status = 500;
      statusText = 'Unsupported';
      payload = { error: 'pdf_not_supported_in_harness' };
    } else {
      status = 500;
      statusText = 'Unsupported';
      payload = { error: 'unsupported_endpoint', path: pathname, method: options?.method || 'GET' };
    }

    const text = JSON.stringify(payload);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText,
      headers: { get: () => null },
      text: async () => text,
      json: async () => payload,
      blob: async () => ({ __blob: true, text }),
    };
  }

  const windowObj = {
    document,
    localStorage,
    sessionStorage: localStorage,
    BACKEND_BASE: '',
    location: new URL(queryUrl),
    history: { replaceState: () => {} },
    isSecureContext: false,
    addEventListener: () => {},
    removeEventListener: () => {},
    navigator: { clipboard: { writeText: async () => {} } },
    URL,
    URLSearchParams,
  };
  windowObj.window = windowObj;

  const vmConsole = {
    log: () => {},
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
  };

  const context = vm.createContext({
    console: vmConsole,
    window: windowObj,
    document,
    localStorage,
    sessionStorage: localStorage,
    fetch: fetchStub,
    navigator: windowObj.navigator,
    history: windowObj.history,
    URL,
    URLSearchParams,
    Date,
    AbortController,
    DOMException,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  });

  const scripts = [
    path.join(repoRoot, 'docs/js/timetable-utils.js'),
    path.join(repoRoot, 'docs/js/timetable-connections.js'),
    path.join(repoRoot, 'docs/js/timetable-sort.js'),
    path.join(repoRoot, 'docs/js/timetable-model.js'),
    path.join(repoRoot, 'docs/js/timetable-render.js'),
    path.join(repoRoot, 'docs/app.js'),
  ];

  scripts.forEach((scriptPath) => {
    vm.runInContext(fs.readFileSync(scriptPath, 'utf8'), context, { filename: scriptPath });
  });

  const captured = { context: null, modelAB: null, modelBA: null };
  const originalRenderTimetablesFromContext = context.renderTimetablesFromContext;
  context.renderTimetablesFromContext = function wrappedRender(contextObj) {
    captured.context = contextObj;
    return originalRenderTimetablesFromContext(contextObj);
  };

  const originalRenderTimetable = context.renderTimetable;
  context.renderTimetable = function wrappedRenderTimetable(
    model,
    headerRowEl,
    headerIconsRowEl,
    bodyRowsEl,
    keyEl,
    crsKeyEl,
  ) {
    if (headerRowEl?.id === 'header-row-ab') captured.modelAB = model;
    if (headerRowEl?.id === 'header-row-ba') captured.modelBA = model;
    return originalRenderTimetable(model, headerRowEl, headerIconsRowEl, bodyRowsEl, keyEl, crsKeyEl);
  };

  getElementById('fromCrs').value = String(query.get('from') || '').toUpperCase();
  getElementById('fromStation').value = String(query.get('from') || '').toUpperCase();
  getElementById('toCrs').value = String(query.get('to') || '').toUpperCase();
  getElementById('toStation').value = String(query.get('to') || '').toUpperCase();
  getElementById('serviceDate').value = String(query.get('date') || '');
  getElementById('startTime').value = String(query.get('start') || '');
  getElementById('endTime').value = String(query.get('end') || '');

  const form = getElementById('form');
  const submitHandlers = form.listeners.submit || [];
  if (submitHandlers.length === 0) {
    throw new Error('No submit handler registered by app.js');
  }

  const submitEvent = { preventDefault() {}, stopPropagation() {} };
  for (const handler of submitHandlers) {
    // eslint-disable-next-line no-await-in-loop
    await handler(submitEvent);
  }

  if (!captured.context || !captured.modelAB || !captured.modelBA) {
    const statusText = getElementById('statusText')?.textContent || '';
    throw new Error(`App build failed while seeding fixture. Status: ${statusText}`);
  }

  const from = String(query.get('from') || '').toUpperCase();
  const to = String(query.get('to') || '').toUpperCase();
  const viaStations = parseViaEntries(query.get('vias'));

  return {
    fixtureVersion: 3,
    queryUrl,
    startMinutes: parseMinutes(query.get('start')),
    endMinutes: parseMinutes(query.get('end')),
    corridorStations: [from, ...viaStations, to].filter(Boolean),
    requiredRequestKeys: Array.from(requiredRequestKeys.values()).sort(),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  const fixture = await seedFixture({
    repoRoot,
    queryUrl: args.queryUrl,
    cacheDir: path.resolve(args.cacheDir),
  });
  process.stdout.write(`${JSON.stringify(fixture, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
