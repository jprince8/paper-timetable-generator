import assert from 'node:assert/strict';

function cellText(cell) {
  if (typeof cell === 'string') return cell;
  if (cell && typeof cell === 'object') return String(cell.text || '');
  return '';
}

function isTimeText(text) {
  return /^\d{1,2}:\d{2}$/.test(text);
}

export function assertColumnFillContinuity(directionName, directionData) {
  const model = directionData?.model || {};
  const rows = Array.isArray(model.rows) ? model.rows : [];
  const serviceCount = Number.isInteger(model.serviceCount) ? model.serviceCount : 0;
  if (rows.length === 0 || serviceCount === 0) return;

  for (let col = 0; col < serviceCount; col += 1) {
    const values = rows.map((row) => cellText((row?.cells || [])[col]));
    const timePositions = values
      .map((value, idx) => (isTimeText(value) ? idx : -1))
      .filter((idx) => idx >= 0);

    if (timePositions.length === 0) continue;

    const firstTimePos = timePositions[0];
    const lastTimePos = timePositions[timePositions.length - 1];

    for (let rowIdx = 0; rowIdx < values.length; rowIdx += 1) {
      const value = values[rowIdx];
      const inActiveRange = rowIdx >= firstTimePos && rowIdx <= lastTimePos;
      if (inActiveRange) {
        assert.ok(
          isTimeText(value) || value === '|',
          `${directionName}: column ${col} has gap/non-line value "${value}" between first and last time (row ${rowIdx})`,
        );
      }
    }
  }
}
