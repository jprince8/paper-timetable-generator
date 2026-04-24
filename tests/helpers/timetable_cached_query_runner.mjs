import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';

function serviceKey(entryOrSvc) {
  const svc = entryOrSvc?.svc || entryOrSvc || {};
  return `${svc.serviceUid || ''}|${svc.runDate || ''}`;
}

function canonicalRequestKey(pathname, params) {
  const quotePlus = (value) => encodeURIComponent(String(value)).replace(/%20/g, '+');
  const entries = Array.from(params.entries()).sort((a, b) => {
    if (a[0] !== b[0]) return a[0].localeCompare(b[0]);
    return a[1].localeCompare(b[1]);
  });
  const query = entries
    .map(([k, v]) => `${quotePlus(k)}=${quotePlus(v)}`)
    .join('&');
  return `${pathname}?${query}`;
}

function cacheFileForRequestKey(cacheDir, requestKey) {
  const digest = crypto.createHash('sha1').update(requestKey, 'utf8').digest('hex');
  return path.join(cacheDir, `${digest}.json`);
}

function buildRawResponseMapFromQueryCache({ fixture, cacheDir }) {
  const map = new Map();
  const requiredKeys = Array.isArray(fixture?.requiredRequestKeys)
    ? fixture.requiredRequestKeys
    : [];
  for (const requestKey of requiredKeys) {
    const cacheFile = cacheFileForRequestKey(cacheDir, requestKey);
    if (!fs.existsSync(cacheFile)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (parsed?.key !== requestKey) continue;
      if (parsed?.response && typeof parsed.response === 'object') {
        map.set(requestKey, parsed.response);
      }
    } catch {
      // Invalid cache payloads are treated as missing and surfaced by fetchStub.
    }
  }

  return map;
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
    this.style = { width: '' };
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

function createHarnessEnvironment({ queryUrl, fixture, repoRoot }) {
  const urlObj = new URL(queryUrl);
  const queryCacheDir = path.join(repoRoot, 'tests', 'fixtures', 'rtt-query-cache');
  const rawResponseMap = buildRawResponseMapFromQueryCache({
    fixture,
    cacheDir: queryCacheDir,
  });
  const missingRequestKeys = new Set();

  const byId = new Map();
  const byTag = new Map();
  function getElementById(id) {
    if (!byId.has(id)) {
      byId.set(id, new FakeElement(id));
    }
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

  const atocCodes = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'data/atoc_codes.json'), 'utf8'),
  );
  const connectionsPath = fs.existsSync(path.join(repoRoot, 'data/connections.json'))
    ? path.join(repoRoot, 'data/connections.json')
    : path.join(repoRoot, 'data/connections2.json');
  const connections = JSON.parse(fs.readFileSync(connectionsPath, 'utf8'));
  const stations = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'data/stations.json'), 'utf8'),
  );

  async function fetchStub(input, options = {}) {
    const reqUrl = typeof input === 'string' ? input : String(input?.url || '');
    const parsed = new URL(reqUrl, 'http://127.0.0.1:8080');
    const pathname = parsed.pathname;

    let payload = null;
    let status = 200;
    let statusText = 'OK';

    if (pathname === '/api/atoc-codes') {
      payload = atocCodes;
    } else if (pathname === '/api/connections') {
      payload = connections;
    } else if (pathname === '/api/stations') {
      payload = stations;
    } else if (pathname === '/rtt/search' || pathname === '/rtt/service') {
      const key = canonicalRequestKey(pathname, parsed.searchParams);
      if (rawResponseMap.has(key)) {
        payload = rawResponseMap.get(key);
      } else {
        missingRequestKeys.add(key);
        payload = { error: 'missing_cached_response', key };
        status = 500;
        statusText = 'Missing Cached Response';
      }
    } else if (pathname === '/timetable/pdf') {
      payload = { error: 'pdf_not_supported_in_harness' };
      status = 500;
      statusText = 'Unsupported';
    } else {
      payload = { error: 'unsupported_endpoint', path: pathname, method: options?.method || 'GET' };
      status = 500;
      statusText = 'Unsupported';
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
    BACKEND_BASE: '',
    location: urlObj,
    history: { replaceState: () => {} },
    isSecureContext: false,
    addEventListener: () => {},
    removeEventListener: () => {},
    navigator: { clipboard: { writeText: async () => {} } },
    URL,
    URLSearchParams,
  };
  windowObj.window = windowObj;

  const context = {
    console,
    window: windowObj,
    document,
    localStorage,
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
  };

  return {
    context: vm.createContext(context),
    getElementById,
    byId,
    missingRequestKeys,
  };
}

function loadFrontendRuntime({ startMinutes, endMinutes, connectionsData, repoRoot }) {
  const context = {
    console,
    window: {
      BACKEND_BASE: '',
      DEBUG_CONNECTIONS: false,
    },
    ALWAYS_SORT_CANCELLED_TIMES: true,
    ENABLE_SORT_LOG_DOWNLOAD: false,
    DEBUG_STATIONS: false,
    startMinutes,
    endMinutes,
    __connectionsData: connectionsData,
    serviceCallsAllStationsInRange(detail, crsSet) {
      if (!detail || !Array.isArray(detail.locations)) return false;
      const parseMins = (value) => {
        const raw = String(value || '').replace(':', '').trim();
        if (!/^\d{3,4}$/.test(raw)) return null;
        const padded = raw.padStart(4, '0');
        const hh = Number(padded.slice(0, 2));
        const mm = Number(padded.slice(2, 4));
        if (!Number.isFinite(hh) || !Number.isFinite(mm) || mm > 59) return null;
        return hh * 60 + mm;
      };
      return detail.locations.every((loc) => {
        const crs = loc?.crs || '';
        if (!crsSet.has(crs)) return true;
        const disp = String(loc?.displayAs || '').toUpperCase();
        if (disp === 'PASS' || disp === 'CANCELLED_PASS') return true;
        const rawTime =
          loc.gbttBookedDeparture ||
          loc.gbttBookedArrival ||
          loc.realtimeDeparture ||
          loc.realtimeArrival ||
          '';
        const mins = parseMins(rawTime);
        return mins !== null && mins >= startMinutes && mins <= endMinutes;
      });
    },
  };

  const vmContext = vm.createContext(context);
  const scripts = [
    path.join(repoRoot, 'docs/js/timetable-utils.js'),
    path.join(repoRoot, 'docs/js/timetable-connections.js'),
    path.join(repoRoot, 'docs/js/timetable-sort.js'),
    path.join(repoRoot, 'docs/js/timetable-model.js'),
  ];

  scripts.forEach((scriptPath) => {
    const code = fs.readFileSync(scriptPath, 'utf8');
    vm.runInContext(code, vmContext, { filename: scriptPath });
  });

  vm.runInContext(
    `
function minutesToRttTime(mins) {
  if (mins === null || mins === undefined) return '';
  const wrapped = ((mins % 1440) + 1440) % 1440;
  const hh = String(Math.floor(wrapped / 60)).padStart(2, '0');
  const mm = String(wrapped % 60).padStart(2, '0');
  return hh + mm;
}
function downloadTextFile() {
  return;
}
connectionsByStation = normaliseConnectionData(__connectionsData);
`,
    vmContext,
  );

  return vmContext;
}

function buildDirection(runtime, stationsDir, stationSetObj, servicesDir, model) {
  const filterResult = runtime.filterServicesForTimetableModel(stationsDir, servicesDir);
  const preFiltered = filterResult.services;

  if (!model || typeof model !== 'object') {
    throw new Error('Missing rendered model from app harness');
  }
  if (model.serviceCount !== preFiltered.length) {
    throw new Error(
      `Unexpected service count mismatch: model=${model.serviceCount} preFiltered=${preFiltered.length}`,
    );
  }

  const orderedSvcIndicesRaw = model.orderedSvcIndices.filter(
    (idx) => Number.isInteger(idx) && idx >= 0 && idx < model.serviceCount,
  );
  const orderedEntries = orderedSvcIndicesRaw.map((idx) => preFiltered[idx]);

  return {
    model,
    pdfTableData: runtime.buildPdfTableData(model),
    preFiltered,
    displayStations: filterResult.displayStations,
    orderedSvcIndicesRaw,
    orderedEntries,
  };
}

export async function runCachedQueryFixture(cachePath) {
  const absoluteCachePath = path.resolve(cachePath);
  const repoRoot = path.resolve(path.dirname(absoluteCachePath), '..', '..');
  const fixture = JSON.parse(fs.readFileSync(absoluteCachePath, 'utf8'));

  if (fixture?.fixtureVersion !== 3 || !Array.isArray(fixture?.requiredRequestKeys)) {
    throw new Error('Unsupported fixture format. Expected fixtureVersion=3 with requiredRequestKeys.');
  }

  const { context, getElementById, missingRequestKeys } = createHarnessEnvironment({
    queryUrl: fixture.queryUrl,
    fixture,
    repoRoot,
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
    const code = fs.readFileSync(scriptPath, 'utf8');
    vm.runInContext(code, context, { filename: scriptPath });
  });

  const captured = {
    context: null,
    modelAB: null,
    modelBA: null,
  };

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
    if (headerRowEl?.id === 'header-row-ab') {
      captured.modelAB = model;
    }
    if (headerRowEl?.id === 'header-row-ba') {
      captured.modelBA = model;
    }
    return originalRenderTimetable(
      model,
      headerRowEl,
      headerIconsRowEl,
      bodyRowsEl,
      keyEl,
      crsKeyEl,
    );
  };

  const query = new URL(fixture.queryUrl).searchParams;
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
  // eslint-disable-next-line no-await-in-loop
  for (const handler of submitHandlers) {
    // eslint-disable-next-line no-await-in-loop
    await handler(submitEvent);
  }

  if (!captured.context || !captured.modelAB || !captured.modelBA) {
    const statusText = getElementById('statusText')?.textContent || '';
    const missing = Array.from(missingRequestKeys.values()).sort();
    const missingText = missing.length > 0 ? ` Missing cache keys: ${missing.join(', ')}` : '';
    throw new Error(
      `App harness build did not produce rendered models. Status: ${statusText}.${missingText}`,
    );
  }

  const runtime = context;
  const stations = captured.context.stations || [];
  const stationSetObj = captured.context.stationSet || {};
  const servicesAB = captured.context.servicesAB || [];
  const servicesBA = captured.context.servicesBA || [];

  const ab = buildDirection(runtime, stations, stationSetObj, servicesAB, captured.modelAB);
  const ba = buildDirection(
    runtime,
    stations.slice().reverse(),
    stationSetObj,
    servicesBA,
    captured.modelBA,
  );

  const allEntries = servicesAB.concat(servicesBA);
  const allDetails = allEntries.filter((entry) => !isConnectionEntry(entry));
  const connectionEntries = allEntries.filter((entry) => isConnectionEntry(entry));
  const connectionStationSet = new Set(
    ab.displayStations
      .concat(ba.displayStations)
      .map((station) => station?.crs || '')
      .filter(Boolean),
  );

  return {
    queryUrl: fixture.queryUrl,
    stations,
    allDetails,
    connectionStationSet,
    connectionEntries,
    ab,
    ba,
  };
}

export function isConnectionEntry(entry) {
  const uid = String(entry?.svc?.serviceUid || '');
  return entry?.isConnection === true || uid.startsWith('CONN-');
}

export function getServiceKey(entry) {
  return serviceKey(entry);
}

export function getConnectionSourceKey(entry) {
  return (
    entry?.connectionSourceServiceKey ||
    `${entry?.connectionSourceServiceUid || ''}|${entry?.connectionSourceRunDate || ''}`
  );
}

export function assertConnectionMisorderHighlightAfterExpansion() {
  const repoRoot = path.resolve(process.cwd());
  const runtime = loadFrontendRuntime({
    startMinutes: 0,
    endMinutes: 24 * 60 - 1,
    connectionsData: {},
    repoRoot,
  });

  const rows = [
    {
      kind: 'station',
      labelStation: 'A',
      cells: [{ text: '12:00' }, { text: '12:00' }],
    },
    {
      kind: 'station',
      labelStation: 'B',
      cells: [{ text: '12:10' }, { text: '11:50' }],
    },
  ];

  const rowSpecs = [
    { kind: 'station', stationIndex: 0, mode: 'dep' },
    { kind: 'station', stationIndex: 1, mode: 'arr' },
  ];

  const stationTimes = [
    [
      { loc: { gbttBookedDeparture: '1200' } },
      { loc: { gbttBookedDeparture: '1200' } },
    ],
    [
      { loc: { gbttBookedArrival: '1210' } },
      { loc: { gbttBookedArrival: '1150' } },
    ],
  ];

  const servicesWithDetails = [
    {
      svc: { serviceUid: 'SRC1', runDate: '2026-04-27' },
      detail: {},
    },
    {
      svc: { serviceUid: 'CONN-1', runDate: '2026-04-27' },
      detail: {
        connectionSourceServiceUid: 'SRC1',
        connectionSourceRunDate: '2026-04-27',
      },
      isConnection: true,
      connectionSourceServiceUid: 'SRC1',
      connectionSourceRunDate: '2026-04-27',
    },
  ];

  runtime.sortTimetableColumns({
    rows,
    rowSpecs,
    stationTimes,
    stationModes: ['one', 'one'],
    displayStations: [{ name: 'A', crs: 'AAA' }, { name: 'B', crs: 'BBB' }],
    servicesWithDetails,
    serviceAllCancelled: [false, false],
    serviceAllNoReport: [false, false],
    serviceRealtimeFlags: [false, false],
    realtimeToggleEnabled: false,
    servicesMeta: [{ visible: 'SRC1' }, { visible: 'CONN-1' }],
    highlightColors: {
      outOfOrder: '#fce3b0',
      depAfterArrival: '#e6d9ff',
      serviceMisorder: '#f7c9c9',
    },
  });

  const highlightedCell = rows[1]?.cells?.[1];
  return highlightedCell?.format?.bgColor === '#f7c9c9';
}

export function assertEqualTimeDepartureSortsAfterArrival() {
  const repoRoot = path.resolve(process.cwd());
  const runtime = loadFrontendRuntime({
    startMinutes: 0,
    endMinutes: 24 * 60 - 1,
    connectionsData: {},
    repoRoot,
  });

  const rows = [
    {
      kind: 'station',
      labelStation: 'X',
      labelArrDep: 'arr',
      cells: [{ text: '' }, { text: '10:00' }],
    },
    {
      kind: 'station',
      labelStation: '',
      labelArrDep: 'dep',
      cells: [{ text: '10:00' }, { text: '' }],
    },
  ];
  const rowSpecs = [
    { kind: 'station', stationIndex: 0, mode: 'arr' },
    { kind: 'station', stationIndex: 0, mode: 'dep' },
  ];
  const stationTimes = [
    [
      {
        depStr: '10:00',
        depMins: 600,
        arrStr: '',
        arrMins: null,
        loc: { gbttBookedDeparture: '1000' },
      },
      {
        arrStr: '10:00',
        arrMins: 600,
        depStr: '',
        depMins: null,
        loc: { gbttBookedArrival: '1000' },
      },
    ],
  ];

  const sortResult = runtime.sortTimetableColumns({
    rows,
    rowSpecs,
    stationTimes,
    stationModes: ['two'],
    displayStations: [{ name: 'X', crs: 'XXX' }],
    servicesWithDetails: [
      { svc: { serviceUid: 'DEP', runDate: '2026-04-27' }, detail: {} },
      { svc: { serviceUid: 'ARR', runDate: '2026-04-27' }, detail: {} },
    ],
    serviceAllCancelled: [false, false],
    serviceAllNoReport: [false, false],
    serviceRealtimeFlags: [false, false],
    realtimeToggleEnabled: false,
    servicesMeta: [{ visible: 'DEP' }, { visible: 'ARR' }],
    highlightColors: {
      outOfOrder: '#fce3b0',
      depAfterArrival: '#e6d9ff',
      serviceMisorder: '#f7c9c9',
    },
  });

  return Array.from(sortResult.orderedSvcIndices);
}

export function assertConnectionEndpointsForceSplitStationRows() {
  const repoRoot = path.resolve(process.cwd());
  const runtime = loadFrontendRuntime({
    startMinutes: 0,
    endMinutes: 24 * 60 - 1,
    connectionsData: {},
    repoRoot,
  });

  const stations = [
    { crs: 'AAA', name: 'Alpha' },
    { crs: 'BBB', name: 'Bravo' },
    { crs: 'CCC', name: 'Charlie' },
    { crs: 'DDD', name: 'Delta' },
  ];
  const stationSet = Object.fromEntries(stations.map((station) => [station.crs, station]));
  const servicesWithDetails = [
    {
      svc: { serviceUid: 'BASE', runDate: '2026-04-27' },
      detail: {
        runDate: '2026-04-27',
        locations: [
          { crs: 'AAA', gbttBookedDeparture: '0950', displayAs: 'CALL', isPublicCall: true },
          {
            crs: 'BBB',
            gbttBookedArrival: '1000',
            gbttBookedDeparture: '1001',
            displayAs: 'CALL',
            isPublicCall: true,
          },
          {
            crs: 'CCC',
            gbttBookedArrival: '1010',
            gbttBookedDeparture: '1011',
            displayAs: 'CALL',
            isPublicCall: true,
          },
          { crs: 'DDD', gbttBookedArrival: '1020', displayAs: 'CALL', isPublicCall: true },
        ],
      },
    },
    {
      svc: { serviceUid: 'CONN-BASE-BBB-CCC-1001', runDate: '2026-04-27' },
      detail: {
        runDate: '2026-04-27',
        serviceType: 'connection',
        locations: [
          { crs: 'BBB', gbttBookedDeparture: '1001', displayAs: 'CALL', isPublicCall: true },
          { crs: 'CCC', gbttBookedArrival: '1009', displayAs: 'CALL', isPublicCall: true },
        ],
      },
      isConnection: true,
    },
  ];

  const model = runtime.buildTimetableModel(stations, stationSet, servicesWithDetails);
  const stationRows = model.rows
    .filter((row) => row.kind === 'station')
    .map((row) => ({
      station: row.labelStation || '',
      arrDep: row.labelArrDep || '',
      mode: row.mode || '',
    }));
  function labelsForStation(stationName) {
    const labels = [];
    let active = '';
    stationRows.forEach((row) => {
      if (row.station) active = row.station;
      if (active === stationName) labels.push(row.arrDep);
    });
    return labels;
  }

  return {
    bravoLabels: labelsForStation('Bravo'),
    charlieLabels: labelsForStation('Charlie'),
    stationRows,
  };
}

export function assertInboundConnectionsHonourPreviousStations() {
  const repoRoot = path.resolve(process.cwd());
  const runtime = loadFrontendRuntime({
    startMinutes: 0,
    endMinutes: 24 * 60 - 1,
    connectionsData: {
      PAD: [
        {
          previousStations: ['AML'],
          connections: {
            EUS: [
              {
                durationMinutes: 25,
                mode: 'Underground',
                nextStations: ['BDS'],
              },
              {
                durationMinutes: 25,
                mode: 'Underground',
                nextStations: ['~AML'],
              },
            ],
          },
        },
      ],
      EUS: [
        {
          connections: {
            PAD: [
              {
                durationMinutes: 25,
                mode: 'Underground',
              },
            ],
          },
        },
      ],
    },
    repoRoot,
  });

  const corridorSet = new Set(['PAD', 'EUS']);
  const buildPadEntry = (previousCrs, nextCrs) => ({
    svc: { serviceUid: `SRC-${previousCrs}-${nextCrs}`, runDate: '2026-04-27' },
    detail: {
      runDate: '2026-04-27',
      locations: [
        {
          crs: previousCrs,
          gbttBookedDeparture: '0950',
          displayAs: 'CALL',
        },
        {
          crs: 'PAD',
          gbttBookedArrival: '1000',
          gbttBookedDeparture: '1000',
          displayAs: 'CALL',
        },
        {
          crs: nextCrs,
          gbttBookedArrival: '1010',
          displayAs: 'CALL',
        },
      ],
    },
  });
  const countByPath = (generated, fromCrs, toCrs) =>
    generated.filter(
      (entry) =>
        entry?.detail?.locations?.[0]?.crs === fromCrs &&
        entry?.detail?.locations?.[1]?.crs === toCrs,
    );

  const mismatched = runtime.buildConnectionServiceEntries([buildPadEntry('ABW', 'AML')], corridorSet, 0, "both", []);
  const inboundMatched = runtime.buildConnectionServiceEntries([buildPadEntry('ABW', 'BDS')], corridorSet, 0, "both", []);
  const outboundMatched = runtime.buildConnectionServiceEntries([buildPadEntry('AML', 'BDS')], corridorSet, 0, "both", []);
  const excludedByTilde = runtime.buildConnectionServiceEntries([buildPadEntry('AML', 'AML')], corridorSet, 0, "both", []);

  return {
    mismatchedCount: mismatched.length,
    inboundMatchedCount: countByPath(inboundMatched, 'EUS', 'PAD').length,
    inboundMatchedLocations: countByPath(inboundMatched, 'EUS', 'PAD')[0]?.detail?.locations || [],
    outboundMatchedCount: countByPath(outboundMatched, 'PAD', 'EUS').length,
    outboundMatchedLocations: countByPath(outboundMatched, 'PAD', 'EUS')[0]?.detail?.locations || [],
    excludedByTildeCount: excludedByTilde.length,
  };
}
