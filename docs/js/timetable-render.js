function bedSvgMarkup() {
  return `
<span class="bed-icon" title="Sleeper" aria-label="Sleeper">
  <svg viewBox="0 0 24 24" role="img" focusable="false" aria-hidden="true">
    <!-- headboard + left leg (single stroke) -->
    <path d="M4 6v14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>

    <!-- mattress -->
    <path d="M4 12h16a2 2 0 0 1 2 2v4H4z"
    fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>

    <!-- pillow (simple) -->
    <path d="M7 10h4a2 2 0 0 1 2 2H7a2 2 0 0 1-2-2a2 2 0 0 1 2-2z"
    fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>

    <!-- right leg at end of mattress -->
    <path d="M20 20v-2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  </svg>
</span>

  `;
}

function busSvgMarkup() {
  return `
<span class="bus-icon" title="Bus service" aria-label="Bus service">
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Bus icon">
    <rect x="92" y="72" width="328" height="336" rx="72" ry="72" fill="currentColor"/>
    <rect x="184" y="104" width="144" height="34" rx="8" ry="8" fill="#fff"/>
    <path d="M152 178 Q152 158 172 158 H340 Q360 158 360 178 V292 Q256 336 152 292 Z" fill="#fff"/>
    <rect x="154" y="332" width="74" height="34" rx="8" ry="8" fill="#fff"/>
    <rect x="284" y="332" width="74" height="34" rx="8" ry="8" fill="#fff"/>
    <rect x="110" y="380" width="72" height="70" rx="14" ry="14" fill="currentColor"/>
    <rect x="330" y="380" width="72" height="70" rx="14" ry="14" fill="currentColor"/>
  </svg>
</span>
  `;
}

function renderTableKey(model, keyEl) {
  if (!keyEl) return;
  const { rows, orderedSvcIndices, servicesMeta } = model;
  const items = [];

  const HIGHLIGHT_OUT_OF_ORDER_COLOR = "#fce3b0";
  const HIGHLIGHT_DEP_AFTER_ARRIVAL_COLOR = "#e6d9ff";
  const HIGHLIGHT_SERVICE_MISORDER_COLOR = "#f7c9c9";

  const facilityFlags = {
    firstClass: servicesMeta.some((meta) => meta.firstClassAvailable),
    sleeper: servicesMeta.some((meta) => meta.isSleeper),
    bus: servicesMeta.some((meta) => meta.isBus),
  };

  if (facilityFlags.firstClass) {
    items.push({
      sampleHtml:
        '<span class="fc-icon" title="First class available" aria-label="First class available">1</span>',
      label: "First class",
    });
  }
  if (facilityFlags.sleeper) {
    items.push({ sampleHtml: bedSvgMarkup(), label: "Sleeper" });
  }
  if (facilityFlags.bus) {
    items.push({ sampleHtml: busSvgMarkup(), label: "Bus service" });
  }

  const formatFlags = {
    bold: false,
    italic: false,
    strike: false,
    color: false,
    noReport: false,
    outOfOrder: false,
    depBeforeArrival: false,
    serviceMisorder: false,
    platformAny: false,
    platformConfirmed: false,
    platformChanged: false,
  };

  rows.forEach((row) => {
    if (row.kind !== "station") {
      return;
    }
    orderedSvcIndices.forEach((svcIndex) => {
      const val = row.cells[svcIndex];
      if (!val || typeof val !== "object") return;
      const format = val.format || {};
      if (format.bold) formatFlags.bold = true;
      if (format.italic) formatFlags.italic = true;
      if (format.strike) formatFlags.strike = true;
      if (format.color && format.color !== "muted") formatFlags.color = true;
      if (format.noReport) formatFlags.noReport = true;
      if (val.platform?.text) formatFlags.platformAny = true;
      if (val.platform?.confirmed) formatFlags.platformConfirmed = true;
      if (val.platform?.changed) formatFlags.platformChanged = true;
      if (format.bgColor) {
        const bg = String(format.bgColor).toLowerCase();
        if (bg === HIGHLIGHT_OUT_OF_ORDER_COLOR) {
          formatFlags.outOfOrder = true;
        } else if (bg === HIGHLIGHT_DEP_AFTER_ARRIVAL_COLOR) {
          formatFlags.depBeforeArrival = true;
        } else if (bg === HIGHLIGHT_SERVICE_MISORDER_COLOR) {
          formatFlags.serviceMisorder = true;
        }
      }
    });
  });

  if (formatFlags.bold) {
    items.push({
      sampleHtml:
        '<span class="table-key-sample time-bold" title="Actual time example" aria-label="Actual time example">12:34</span>',
      label: "Actual time",
    });
  }
  if (formatFlags.italic) {
    const sampleText = "12:34";
    items.push({
      sampleHtml: `<span class="table-key-sample time-italic" title="Predicted time example" aria-label="Predicted time example">${sampleText}</span>`,
      label: "Predicted time",
    });
  }
  if (formatFlags.noReport) {
    items.push({
      sampleHtml:
        '<span class="table-key-sample time-italic" title="No report example" aria-label="No report example">12:34?</span>',
      label: "No realtime report",
    });
  }
  if (formatFlags.strike) {
    items.push({
      sampleHtml:
        '<span class="table-key-sample time-cancelled" title="Cancelled example" aria-label="Cancelled example">12:34</span>',
      label: "Cancelled",
    });
  }
  if (formatFlags.color) {
    items.push({
      sampleHtml:
        '<span class="table-key-sample table-key-sample--early" title="Early running example" aria-label="Early running example">12:34</span>',
      label: "Early running",
    });
    items.push({
      sampleHtml:
        '<span class="table-key-sample table-key-sample--late" title="Late running example" aria-label="Late running example">12:34</span>',
      label: "Late running",
    });
  }
  if (formatFlags.outOfOrder) {
    items.push({
      sampleHtml:
        '<span class="table-key-sample table-key-sample--out-of-order" title="Out of order example" aria-label="Out of order example">12:34</span>',
      label: "Non-chronological",
    });
  }
  if (formatFlags.depBeforeArrival) {
    items.push({
      sampleHtml:
        '<span class="table-key-sample table-key-sample--dep-before" title="Departs before previous arrival example" aria-label="Departs before previous arrival example">12:34</span>',
      label: "Departs before previous arrival",
    });
  }
  if (formatFlags.serviceMisorder) {
    items.push({
      sampleHtml:
        '<span class="table-key-sample table-key-sample--service-misorder" title="Service internally misordered example" aria-label="Service internally misordered example">12:34</span>',
      label: "Service internally misordered",
    });
  }
  if (formatFlags.platformAny) {
    items.push({
      sampleHtml:
        '<span class="table-key-sample"><span class="platform-tag" title="Platform example" aria-label="Platform example">[1]</span></span>',
      label: "Platform",
    });
  }
  if (formatFlags.platformConfirmed) {
    items.push({
      sampleHtml:
        '<span class="table-key-sample"><span class="platform-tag platform-confirmed" title="Confirmed platform example" aria-label="Confirmed platform example">[1]</span></span>',
      label: "Confirmed platform",
    });
  }
  if (formatFlags.platformChanged) {
    items.push({
      sampleHtml:
        '<span class="table-key-sample"><span class="platform-tag platform-changed platform-confirmed" title="Changed platform example" aria-label="Changed platform example">[1]</span></span>',
      label: "Changed platform",
    });
  }

  keyEl.innerHTML = "";
  if (items.length === 0) {
    keyEl.classList.add("is-empty");
    return;
  }
  keyEl.classList.remove("is-empty");
  const label = document.createElement("span");
  label.classList.add("table-key-label");
  label.textContent = "Key:";
  keyEl.appendChild(label);

  items.forEach((item) => {
    const wrapper = document.createElement("span");
    wrapper.classList.add("table-key-item");
    wrapper.innerHTML = `${item.sampleHtml}<span>${item.label}</span>`;
    keyEl.appendChild(wrapper);
  });
}

function renderCrsKey(model, crsKeyEl) {
  if (!crsKeyEl) return;
  const { rows, orderedSvcIndices } = model;
  const crsMap = new Map();
  rows.forEach((row) => {
    if (
      row.labelStation !== "Comes from" &&
      row.labelStation !== "Continues to"
    ) {
      return;
    }
    orderedSvcIndices.forEach((svcIndex) => {
      const val = row.cells[svcIndex];
      if (!val) return;
      const text = typeof val === "object" ? val.text : cellToText(val);
      const code = (text || "").trim();
      if (!code) return;
      if (!crsMap.has(code)) {
        crsMap.set(code, typeof val === "object" ? val.title || "" : "");
      }
    });
  });

  const entries = Array.from(crsMap.entries()).sort((a, b) =>
    a[0].localeCompare(b[0]),
  );
  crsKeyEl.innerHTML = "";
  if (entries.length === 0) {
    crsKeyEl.classList.add("is-empty");
    return;
  }
  crsKeyEl.classList.remove("is-empty");
  const label = document.createElement("span");
  label.classList.add("table-key-label");
  label.textContent = "Station codes:";
  crsKeyEl.appendChild(label);
  const lineBreak = document.createElement("span");
  lineBreak.classList.add("table-key-break");
  lineBreak.setAttribute("aria-hidden", "true");
  crsKeyEl.appendChild(lineBreak);

  entries.forEach(([code, title]) => {
    const item = document.createElement("span");
    item.classList.add("table-key-item");
    const labelText = title ? `${code}: ${title}` : code;
    item.textContent = labelText;
    if (title) {
      item.title = labelText;
      item.setAttribute("aria-label", labelText);
    } else {
      item.setAttribute("aria-label", labelText);
    }
    crsKeyEl.appendChild(item);
  });
}

function renderTimetable(
  model,
  headerRowEl,
  headerIconsRowEl,
  bodyRowsEl,
  keyEl,
  crsKeyEl,
) {
  const { rows, orderedSvcIndices, servicesMeta } = model;

  headerRowEl.innerHTML = "";
  headerIconsRowEl.innerHTML = "";
  bodyRowsEl.innerHTML = "";

  const thStation = document.createElement("th");
  thStation.classList.add("sticky-top", "sticky-left", "corner");
  thStation.textContent = "Operator";
  headerRowEl.appendChild(thStation);

  orderedSvcIndices.forEach((svcIndex) => {
    const meta = servicesMeta[svcIndex];
    const th = document.createElement("th");
    th.classList.add("sticky-top");

    const tooltipEsc = htmlEscape(meta.tooltip);
    const visibleEsc = htmlEscape(meta.visible);
    const href = meta.href || "";

    if (href) {
      th.innerHTML = `
  <a class="service-header"
     href="${href}"
     target="_blank"
     rel="noopener noreferrer"
     title="${tooltipEsc}">${visibleEsc}</a>
`;
    } else {
      th.innerHTML = `<span class="service-header" title="${tooltipEsc}">${visibleEsc}</span>`;
    }

    headerRowEl.appendChild(th);
  });

  const thStationIcons = document.createElement("th");
  thStationIcons.classList.add("sticky-left", "icon-row");
  thStationIcons.textContent = "Facilities";
  headerIconsRowEl.appendChild(thStationIcons);

  orderedSvcIndices.forEach((svcIndex) => {
    const meta = servicesMeta[svcIndex];

    const th = document.createElement("th");
    th.classList.add("icon-row");

    const icons = [];
    if (meta.firstClassAvailable) {
      icons.push(
        `<span class="fc-icon" title="First class available" aria-label="First class available">1</span>`,
      );
    }
    if (meta.isSleeper) {
      icons.push(bedSvgMarkup());
    }
    if (meta.isBus) {
      icons.push(busSvgMarkup());
    }

    th.innerHTML = icons.length
      ? `<span class="icon-wrap">${icons.join("")}</span>`
      : "";
    headerIconsRowEl.appendChild(th);
  });

  rows.forEach((row, rowIdx) => {
    const tr = document.createElement("tr");

    if (rowIdx === 0) tr.classList.add("row-sep-top");
    if (row.kind === "station" && row.labelArrDep === "dep")
      tr.classList.add("row-sep-top");

    const prevRow = rowIdx > 0 ? rows[rowIdx - 1] : null;
    if (prevRow) {
      const boundaryExtraToStation =
        prevRow.kind === "extra" && row.kind === "station";
      const boundaryStationToExtra =
        prevRow.kind === "station" && row.kind === "extra";
      if (boundaryExtraToStation || boundaryStationToExtra) {
        tr.classList.add("row-sep-top");
      }
    }

    let labelText = "";
    if (row.labelStation && row.labelArrDep)
      labelText = row.labelStation + " (" + row.labelArrDep + ")";
    else if (row.labelStation) labelText = row.labelStation;
    else if (!row.labelStation && row.labelArrDep)
      labelText = "(" + row.labelArrDep + ")";

    const labelTd = document.createElement("td");
    labelTd.classList.add("sticky-left", "station-row-label");
    labelTd.textContent = labelText;
    tr.appendChild(labelTd);

    orderedSvcIndices.forEach((svcIndex) => {
      const val = row.cells[svcIndex];
      const td = document.createElement("td");
      if (val && typeof val === "object") {
        const text = val.text || "";
        if (!text) {
          td.classList.add("time-empty");
        } else {
          const span = document.createElement("span");
          span.textContent = text;
          const format = val.format || {};
          if (format.bold) span.classList.add("time-bold");
          if (format.italic) span.classList.add("time-italic");
          if (format.strike) span.classList.add("time-cancelled");
          if (format.color === "muted") {
            span.classList.add("time-muted");
          } else if (format.color && format.color.startsWith("#")) {
            span.style.color = format.color;
          }
          if (format.bgColor) {
            td.style.backgroundColor = format.bgColor;
          }
          const titleParts = [];
          if (val.title) titleParts.push(val.title);
          if (format.bold && format.delayMins) {
            titleParts.push(formatDelayText(format.delayMins));
          }
          if (titleParts.length) span.title = titleParts.join(" ");
          td.appendChild(span);
          if (val.platform?.text) {
            const platformSpan = document.createElement("span");
            platformSpan.classList.add("platform-tag");
            if (val.platform.confirmed) {
              platformSpan.classList.add("platform-confirmed");
            }
            if (val.platform.changed) {
              platformSpan.classList.add("platform-changed");
            }
            if (val.format?.strike) {
              platformSpan.classList.add("time-cancelled");
            }
            platformSpan.textContent = val.platform.text;
            td.appendChild(platformSpan);
          }
        }
      } else {
        td.textContent = val || "";
        if (!val) td.classList.add("time-empty");
      }
      tr.appendChild(td);
    });

    bodyRowsEl.appendChild(tr);
  });

  renderTableKey(model, keyEl);
  renderCrsKey(model, crsKeyEl);
}
