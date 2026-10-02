/**
 * Minimal markdown renderer for ComfyUI `MarkdownNote` nodes.
 *
 * ComfyUI draws note text as rendered markdown (headings, paragraphs, bullet
 * lists and GFM tables), not as a plain text field. This reproduces the parts
 * the shipped MiniMax-H3 notes actually use.
 */

const BODY_SIZE = 12;
const HEAD_SIZE = 15;
const LINE = 16;
const CODE_FONT = 'ui-monospace, SFMono-Regular, Menlo, monospace';
const BODY_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

const TEXT = '#DDD';
const DIM = '#AAA';
const LINK = '#5AA9F5';
const RULE = '#555';
const HEADER_BG = '#2A2A2A';
const ALT_BG = '#1E1E1E';

// --------------------------------------------------------------- inline parse
/** Split a line into styled runs: **bold**, *italic*, `code`, [text](url). */
function parseInline(s) {
  const runs = [];
  const re = /(\*\*[^*]+\*\*)|(\*[^*]+\*)|(`[^`]+`)|(\[[^\]]+\]\([^)]*\))/g;
  let last = 0, m;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) runs.push({ text: s.slice(last, m.index) });
    if (m[1]) runs.push({ text: m[1].slice(2, -2), bold: true });
    else if (m[2]) runs.push({ text: m[2].slice(1, -1), italic: true });
    else if (m[3]) runs.push({ text: m[3].slice(1, -1), code: true });
    else if (m[4]) runs.push({ text: m[4].replace(/^\[/, '').replace(/\]\([^)]*\)$/, ''), link: true });
    last = re.lastIndex;
  }
  if (last < s.length) runs.push({ text: s.slice(last) });
  return runs;
}

function fontOf(run, size, bold) {
  const style = (run.italic ? 'italic ' : '') + ((bold || run.bold) ? '600 ' : '');
  const family = run.code ? CODE_FONT : BODY_FONT;
  return `${style}${run.code ? size - 1 : size}px ${family}`;
}

function measure(ctx, run, size, bold) {
  ctx.font = fontOf(run, size, bold);
  return ctx.measureText(run.text).width;
}

/** Greedy word wrap of inline runs into lines of at most `maxW` pixels. */
function wrapRuns(ctx, runs, maxW, size, bold) {
  const lines = [];
  let cur = [], curW = 0;
  const push = () => { if (cur.length) lines.push(cur); cur = []; curW = 0; };

  for (const run of runs) {
    for (const piece of run.text.split(/(\s+)/)) {
      if (piece === '') continue;
      const w = measure(ctx, { ...run, text: piece }, size, bold);
      if (curW + w > maxW && cur.length) { push(); }
      cur.push({ ...run, text: piece });
      curW += w;
    }
  }
  push();
  return lines;
}

// ------------------------------------------------------------------ layout
/** Turn the raw markdown into positioned rows. */
function layout(ctx, text, width) {
  const rows = [];
  const src = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  let i = 0;

  const emitRuns = (runs, { size = BODY_SIZE, bold = false, indent = 0, bullet = false } = {}) => {
    const pad = indent + (bullet ? 12 : 0);
    const lines = wrapRuns(ctx, runs, width - pad - 6, size, bold);
    lines.forEach((ln, k) => rows.push({ kind: 'text', runs: ln, size, bold, indent: pad, bullet: bullet && k === 0 }));
  };

  while (i < src.length) {
    const line = src[i];

    // ---- table: a run of |...| lines with a |---| separator underneath
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(src[i + 1] || '')) {
      const cells = [];
      while (i < src.length && /^\s*\|.*\|\s*$/.test(src[i])) {
        cells.push(src[i].trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()));
        i++;
      }
      const header = cells.shift();          // first row is the header
      cells.shift();                          // drop the |---| separator
      rows.push({ kind: 'table', header, body: cells });
      continue;
    }

    // ---- heading
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const size = level <= 2 ? HEAD_SIZE : HEAD_SIZE - 2;
      rows.push({ kind: 'space', h: level <= 2 ? 8 : 5 });
      emitRuns(parseInline(h[2]), { size, bold: true });
      i++;
      continue;
    }

    // ---- blank line
    if (!line.trim()) { rows.push({ kind: 'space', h: 7 }); i++; continue; }

    // ---- bullet
    const b = /^\s*[-*]\s+(.*)$/.exec(line);
    if (b) { emitRuns(parseInline(b[1]), { indent: 6, bullet: true }); i++; continue; }

    // ---- paragraph
    emitRuns(parseInline(line));
    i++;
  }
  return rows;
}

// ------------------------------------------------------------------ drawing
function drawTable(ctx, row, x, y, width) {
  const cols = row.header.length;
  const cellPad = 6;
  ctx.font = `${BODY_SIZE}px ${BODY_FONT}`;

  // size each column to its widest cell, then scale to fit
  const want = [];
  for (let c = 0; c < cols; c++) {
    let w = ctx.measureText(row.header[c] || '').width;
    for (const r of row.body) w = Math.max(w, ctx.measureText(r[c] || '').width);
    want.push(w + cellPad * 2);
  }
  const total = want.reduce((a, b) => a + b, 0) || 1;
  const scale = width / total;
  const colW = want.map(w => w * scale);
  const rowH = LINE + 4;

  let yy = y;
  const drawRow = (cells, { header = false, bg = null } = {}) => {
    if (bg) { ctx.fillStyle = bg; ctx.fillRect(x, yy, width, rowH); }
    let xx = x;
    for (let c = 0; c < cols; c++) {
      ctx.fillStyle = header ? TEXT : DIM;
      ctx.font = `${header ? '600 ' : ''}${BODY_SIZE}px ${BODY_FONT}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const txt = String(cells[c] ?? '');
      ctx.save();
      ctx.beginPath(); ctx.rect(xx + 1, yy, colW[c] - 2, rowH); ctx.clip();
      ctx.fillText(txt, xx + cellPad, yy + rowH / 2 + 1);
      ctx.restore();
      ctx.strokeStyle = RULE;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(xx, yy); ctx.lineTo(xx, yy + rowH); ctx.stroke();
      xx += colW[c];
    }
    ctx.strokeStyle = RULE;
    ctx.beginPath(); ctx.moveTo(x + width, yy); ctx.lineTo(x + width, yy + rowH); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x, yy); ctx.lineTo(x + width, yy); ctx.stroke();
    yy += rowH;
  };

  drawRow(row.header, { header: true, bg: HEADER_BG });
  row.body.forEach((r, k) => drawRow(r, { bg: k % 2 ? ALT_BG : null }));
  ctx.beginPath(); ctx.moveTo(x, yy); ctx.lineTo(x + width, yy); ctx.stroke();
  return yy - y;
}

/**
 * Render `text` into the rect (x, y, w, h), clipped, with a scrollbar when the
 * content overflows — the same shape ComfyUI's note widget draws.
 */
export function drawMarkdown(ctx, text, x, y, w, h, scroll = 0) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.textBaseline = 'alphabetic';

  const rows = layout(ctx, text, w);
  let cy = y + 4 - scroll;

  for (const row of rows) {
    if (row.kind === 'space') { cy += row.h; continue; }
    if (row.kind === 'table') { cy += drawTable(ctx, row, x, cy, w) + 4; continue; }

    const { runs, size, indent, bullet } = row;
    if (cy > y + h) break;
    if (cy + LINE < y) { cy += LINE; continue; }

    let cx = x + 4 + indent;
    if (bullet) { ctx.fillStyle = DIM; ctx.font = `${size}px ${BODY_FONT}`; ctx.fillText('•', x + 2, cy + size - 2); }
    for (const run of runs) {
      ctx.font = fontOf(run, size, row.bold);
      ctx.fillStyle = run.link ? LINK : (run.bold || row.bold ? TEXT : DIM);
      ctx.textAlign = 'left';
      ctx.fillText(run.text, cx, cy + size - 2);
      cx += ctx.measureText(run.text).width;
    }
    cy += LINE;
  }

  const total = cy + scroll - y;
  if (total > h) {
    const trackH = h - 4;
    const barH = Math.max(24, trackH * (h / total));
    const barY = y + 2 + (trackH - barH) * Math.min(1, scroll / Math.max(1, total - h));
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fillRect(x + w - 7, y + 2, 5, trackH);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(x + w - 7, barY, 5, barH);
  }
  ctx.restore();
}
