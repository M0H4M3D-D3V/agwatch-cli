import React, { useState, useCallback, useEffect } from 'react';
import { render, Box, Text, useInput, useApp, useWindowSize } from 'ink';
import type { TimeRange, DashboardData, SummaryMetrics, AggregateRow, DailyRow } from '../domain/types.js';
import { formatMoney, formatPercent } from '../utils/format.js';
import { loadDataForRange } from '../services/load-dashboard-data.js';
import { getEnabledAgents, loadConfig } from '../config/agents.js';
import { SUPPORTED_PROVIDERS } from '../config/providers.js';
import { getPricingTimestamp, formatPricingDate, refreshPricing } from '../services/pricing-fetcher.js';
import { forceRefreshProviders, refreshProvidersBackgroundOnly } from '../services/provider-service.js';
import type { ProviderUsageData } from '../providers/types.js';
import { closeBrowser, releaseBrowserHandles } from '../providers/browser.js';
import { ProviderPopup } from './provider-popup.js';

let fastQuitRequested = false;

// ─── Periods ──────────────────────────────────────────────────────────────────

const PERIODS: TimeRange[] = ['today', '7d', '30d', 'month'];
const PERIOD_LABELS: Record<TimeRange, string> = {
  today: 'Today',
  '7d':  '7 Days',
  '30d': '30 Days',
  month: 'This Month',
};

// ─── Color palette ────────────────────────────────────────────────────────────

const C = {
  brand:    '#FF8C42',
  gold:     '#FFD700',
  cyan:     '#5BE0F5',
  green:    '#5BF5A0',
  purple:   '#C77DFF',
  amber:    '#F5C85B',
  blue:     '#5B9EF5',
  pink:     '#F55BE0',
  salmon:   '#F5A05B',
  dim:      '#3a3a3a',
  muted:    '#666666',
  subtle:   '#999999',
  white:    '#E8E8E8',
  // panel borders
  pDaily:   '#5B9EF5',
  pProject: '#5BF5A0',
  pModel:   '#C77DFF',
  pActiv:   '#F5C85B',
  pTools:   '#5BE0F5',
  pShell:   '#F5A05B',
  pMcp:     '#F55BE0',
  pOver:    '#FF8C42',
  pProv:    '#FFD700',
};

function formatScrapedTime(ms: number): string {
  const d = new Date(ms);
  const h24 = d.getHours();
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ampm = h24 >= 12 ? 'PM' : 'AM';
  const h12 = (h24 % 12) || 12;
  return `${h12}:${mi} ${ampm}`;
}

// ─── Gradient color (blue → yellow → red) ────────────────────────────────────

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * Math.max(0, Math.min(1, t)));
}

function lerpHex(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number, t: number): string {
  const r = lerp(r1, r2, t).toString(16).padStart(2, '0');
  const g = lerp(g1, g2, t).toString(16).padStart(2, '0');
  const b = lerp(b1, b2, t).toString(16).padStart(2, '0');
  return `#${r}${g}${b}`;
}

/**
 * 4-stop gradient color for a position t ∈ [0, 1] across the bar:
 *   0%–33%  blue  → yellow
 *  33%–66%  yellow → orange
 *  66%–100% orange → red
 */
function multiStopColor(t: number): string {
  const T = Math.max(0, Math.min(1, t));
  if (T < 1 / 3) return lerpHex(91, 158, 245, 245, 200, 91, T * 3);
  if (T < 2 / 3) return lerpHex(245, 200, 91, 255, 140, 66, (T - 1 / 3) * 3);
  return lerpHex(255, 140, 66, 255, 55, 55, (T - 2 / 3) * 3);
}

/**
 * Build colored segments for a multi-stop gradient progress bar.
 * Filled chars (█) are colored by their position in the full bar width.
 * Inactive chars (░) use a dim tone.
 */
function barSegments(
  value: number,
  max:   number,
  width: number,
): { str: string; color: string }[] {
  if (width <= 0) return [];
  if (max === 0 || value <= 0) return [{ str: '░'.repeat(width), color: C.dim }];

  const ratio  = Math.min(1, value / max);
  const filled = Math.max(1, Math.round(ratio * width));
  const segs: { str: string; color: string }[] = [];

  for (let i = 0; i < filled; i++) {
    const t     = width > 1 ? i / (width - 1) : 0;
    const color = multiStopColor(t);
    segs.push({ str: '█', color });
  }

  if (filled < width) {
    segs.push({ str: '░'.repeat(width - filled), color: '#2a2a2a' });
  }

  return segs;
}

// ─── String helpers ───────────────────────────────────────────────────────────

/** Left-pad to n, truncate with … if over */
function fitL(s: string, n: number): string {
  if (n <= 0) return '';
  if (s.length > n) return s.slice(0, Math.max(1, n - 1)) + '…';
  return s.padEnd(n);
}

/** Right-align in n chars */
function fitR(s: string, n: number): string {
  if (n <= 0) return '';
  if (s.length > n) return s.slice(0, n);
  return s.padStart(n);
}

function tok(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000)     return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)         return `${Math.round(n / 1_000)}K`;
  return n.toString();
}

function cint(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000)    return `${Math.round(n / 1_000)}K`;
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// ─── Progress bar ─────────────────────────────────────────────────────────────

/** Renders a multi-color gradient progress bar inline. */
function BarCell({ value, max, width }: { value: number; max: number; width: number }) {
  const segs = barSegments(value, max, width);
  return (
    <>
      {segs.map((s, i) => <Text key={i} color={s.color}>{s.str}</Text>)}
    </>
  );
}

// ─── Column system ────────────────────────────────────────────────────────────

type ColKey = 'bar' | 'day' | 'name' | 'in' | 'out' | 'cost' | 'calls' | 'sessions';

interface ColSpec {
  key:   ColKey;
  label: string;
  width: number;
  right: boolean;  // right-align?
}

const COL_BASE: Record<ColKey, { label: string; min: number; right: boolean; grow: boolean }> = {
  bar:      { label: '',         min: 6,  right: false, grow: false },
  day:      { label: 'Day',      min: 5,  right: false, grow: false },
  name:     { label: '',         min: 8,  right: false, grow: true  },
  in:       { label: 'In',       min: 6,  right: true,  grow: true  },
  out:      { label: 'Out',      min: 6,  right: true,  grow: true  },
  cost:     { label: 'Cost',     min: 7,  right: true,  grow: true  },
  calls:    { label: 'Calls',    min: 7,  right: true,  grow: true  },
  sessions: { label: 'Sessions', min: 8,  right: true,  grow: true  },
};

/**
 * Compute column specs that fill exactly `iw` characters (including single-space separators).
 * - If 'name' is present: name gets all remaining space.
 * - If no 'name': remaining space is distributed evenly across growable cols.
 */
function computeCols(
  iw: number,
  bw: number,
  keys: ColKey[],
  minOverrides?: Partial<Record<ColKey, number>>,
): ColSpec[] {
  const bases = { ...COL_BASE };
  bases.bar = { ...bases.bar, min: bw };
  if (minOverrides) {
    for (const [k, v] of Object.entries(minOverrides) as [ColKey, number][]) {
      if (bases[k] && Number.isFinite(v) && v > 0) {
        bases[k] = { ...bases[k], min: v };
      }
    }
  }

  const spacers  = keys.length - 1;
  const minTotal = keys.reduce((s, k) => s + bases[k].min, 0);
  const extra    = Math.max(0, iw - spacers - minTotal);
  const widths   = Object.fromEntries(keys.map(k => [k, bases[k].min])) as Record<ColKey, number>;

  if (keys.includes('name')) {
    widths['name'] += extra;
  } else {
    const growable = keys.filter(k => bases[k].grow);
    if (growable.length > 0) {
      const perCol  = Math.floor(extra / growable.length);
      let   leftover = extra - perCol * growable.length;
      for (const k of growable) {
        widths[k] += perCol;
      }
      // give remainder to the widest growing col (cost or calls)
      const priority = growable.find(k => k === 'cost') ?? growable[0];
      widths[priority] += leftover;
    }
  }

  return keys.map(k => ({
    key:   k,
    label: bases[k].label,
    width: widths[k],
    right: bases[k].right,
  }));
}

// ─── Column value & color ─────────────────────────────────────────────────────

function colValue(col: ColSpec, row: AggregateRow | DailyRow): string {
  const w = col.width;
  switch (col.key) {
    case 'day': {
      const d = (row as DailyRow).day ?? '';
      const parts = d.split('-');
      return fitL(parts.length === 3 ? `${parts[2]}.${parts[1]}` : d.slice(5), w);
    }
    case 'name':     return fitL(row.name, w);
    case 'in':       return fitR(tok(row.inputTokens), w);
    case 'out':      return fitR(tok(row.outputTokens), w);
    case 'cost':     return fitR(formatMoney(row.costUsd), w);
    case 'calls':    return fitR(cint(row.calls), w);
    case 'sessions': return fitR(cint(row.sessions), w);
    default:         return ' '.repeat(w);
  }
}

function colColor(key: ColKey, barColor: string): string {
  switch (key) {
    case 'bar':      return barColor;
    case 'day':      return C.blue;
    case 'name':     return C.white;
    case 'in':       return C.cyan;
    case 'out':      return C.green;
    case 'cost':     return C.gold;
    case 'calls':    return C.subtle;
    case 'sessions': return C.subtle;
    default:         return C.white;
  }
}

// ─── Panel wrapper ────────────────────────────────────────────────────────────

function Panel({ title, color, width, children }: {
  title:    string;
  color:    string;
  width:    number;
  children: React.ReactNode;
}) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} width={width} overflow="hidden">
      <Box paddingX={1}>
        <Text bold color={color}>{'▸ '}{title}</Text>
      </Box>
      {children}
    </Box>
  );
}

// ─── Table panel ──────────────────────────────────────────────────────────────

/**
 * A single data row rendered as fixed-width Box cells — no wrapping possible.
 */
function DataRow({ cols, row, maxVal, metricKey }: {
  cols:      ColSpec[];
  row:       AggregateRow | DailyRow;
  maxVal:    number;
  metricKey: 'costUsd' | 'calls';
}) {
  // Use the panel's actual metric for the bar — NOT a hardcoded field
  const metricVal = (row as unknown as Record<string, number>)[metricKey] ?? 0;

  return (
    <Box flexDirection="row" overflow="hidden">
      {cols.map((col, ci) => {
        const spacer = ci < cols.length - 1;
        if (col.key === 'bar') {
          return (
            <React.Fragment key={ci}>
              <BarCell value={metricVal} max={maxVal} width={col.width} />
              {spacer ? <Text color={C.dim}>{' '}</Text> : null}
            </React.Fragment>
          );
        }
        const val   = colValue(col, row);
        const color = colColor(col.key, '');
        return (
          <React.Fragment key={ci}>
            <Text color={color}>{val}</Text>
            {spacer ? <Text color={C.dim}>{' '}</Text> : null}
          </React.Fragment>
        );
      })}
    </Box>
  );
}

/**
 * Header row — bar column is blank, others show label. No color.
 */
function HeaderRow({ cols }: { cols: ColSpec[] }) {
  return (
    <Box flexDirection="row" overflow="hidden">
      {cols.map((col, ci) => {
        const label = col.key === 'bar'
          ? ' '.repeat(col.width)
          : col.right
            ? fitR(col.label, col.width)
            : fitL(col.label, col.width);
        return (
          <React.Fragment key={ci}>
            <Text color={C.muted}>{label}</Text>
            {ci < cols.length - 1 ? <Text color={C.dim}>{' '}</Text> : null}
          </React.Fragment>
        );
      })}
    </Box>
  );
}

function TablePanel({ title, color, cols, rows, pw, metricKey, limit = 12, emptyMsg = 'No data' }: {
  title:     string;
  color:     string;
  cols:      ColSpec[];
  rows:      (AggregateRow | DailyRow)[];
  pw:        number;
  metricKey: 'costUsd' | 'calls';
  limit?:    number;
  emptyMsg?: string;
}) {
  if (rows.length === 0) {
    return (
      <Panel title={title} color={color} width={pw}>
        <Box paddingX={2}><Text color={C.muted}>{emptyMsg}</Text></Box>
      </Panel>
    );
  }

  const maxVal = Math.max(...rows.map(r => (r as unknown as Record<string, number>)[metricKey] ?? 0));

  return (
    <Panel title={title} color={color} width={pw}>
      <Box paddingX={1} flexDirection="column">
        <HeaderRow cols={cols} />
        {rows.slice(0, limit).map((r, i) => (
          <DataRow key={i} cols={cols} row={r} maxVal={maxVal} metricKey={metricKey} />
        ))}
      </Box>
    </Panel>
  );
}

// ─── Layout ───────────────────────────────────────────────────────────────────

interface Layout { dw: number; wide: boolean; pw: number; iw: number; bw: number }

function computeLayout(termWidth: number): Layout {
  let dw     = Math.min(300, Math.max(60, termWidth));
  const wide = dw >= 120;
  if (wide && dw % 3 !== 0) {
    dw -= dw % 3;
  }
  const pw   = wide ? Math.floor(dw / 3) : dw;
  const iw   = pw - 4;
  const bw   = Math.max(6, Math.min(16, Math.floor(iw * 0.14) + 4));
  return { dw, wide, pw, iw, bw };
}

// ─── Panels ───────────────────────────────────────────────────────────────────

function DailyPanel({ rows, L }: { rows: DailyRow[]; L: Layout }) {
  const cols = computeCols(L.iw, L.bw, ['day', 'bar', 'in', 'out', 'cost', 'calls']);
  return <TablePanel title="Daily Activity" color={C.pDaily} cols={cols} rows={rows} pw={L.pw} metricKey="costUsd" limit={14} emptyMsg="No activity in range" />;
}

function ProjectPanel({ rows, L }: { rows: AggregateRow[]; L: Layout }) {
  const cols = computeCols(L.iw, L.bw, ['bar', 'name', 'in', 'out', 'cost', 'sessions']);
  return <TablePanel title="By Project" color={C.pProject} cols={cols} rows={rows} pw={L.pw} metricKey="costUsd" emptyMsg="No project data" />;
}

function ModelPanel({ rows, L }: { rows: AggregateRow[]; L: Layout }) {
  const cols = computeCols(
    L.iw,
    L.bw,
    ['bar', 'name', 'in', 'out', 'cost', 'calls'],
    { in: 5, out: 5, cost: 6, calls: 6, name: 12 },
  );
  const stripped = rows.map((r) => {
    const noProvider = r.name.includes('/') ? r.name.split('/').slice(1).join('/') : r.name;
    return { ...r, name: noProvider };
  });
  return <TablePanel title="By Model" color={C.pModel} cols={cols} rows={stripped} pw={L.pw} metricKey="costUsd" emptyMsg="No model data" />;
}

function ActivityPanel({ rows, L }: { rows: AggregateRow[]; L: Layout }) {
  const cols = computeCols(L.iw, L.bw, ['bar', 'name', 'in', 'out', 'cost', 'calls']);
  return <TablePanel title="By Activity" color={C.pActiv} cols={cols} rows={rows} pw={L.pw} metricKey="costUsd" emptyMsg="No activity data" />;
}

function ToolsPanel({ rows, L }: { rows: AggregateRow[]; L: Layout }) {
  const cols = computeCols(L.iw, L.bw, ['bar', 'name', 'calls']);
  return <TablePanel title="Core Tools" color={C.pTools} cols={cols} rows={rows} pw={L.pw} metricKey="calls" emptyMsg="No tool usage" />;
}

function ShellPanel({ rows, L }: { rows: AggregateRow[]; L: Layout }) {
  const cols = computeCols(L.iw, L.bw, ['bar', 'name', 'calls']);
  return <TablePanel title="Shell Commands" color={C.pShell} cols={cols} rows={rows} pw={L.pw} metricKey="calls" emptyMsg="No shell usage" />;
}

function McpPanel({ rows, dw, bw }: { rows: AggregateRow[]; dw: number; bw: number }) {
  const iw   = dw - 4;
  const mbw  = Math.max(10, Math.min(20, Math.floor(iw * 0.15)));
  const cols = computeCols(iw, mbw, ['bar', 'name', 'calls']);
  return <TablePanel title="MCP Servers" color={C.pMcp} cols={cols} rows={rows} pw={dw} metricKey="calls" limit={6} emptyMsg="No MCP usage" />;
}

// ─── Overview ─────────────────────────────────────────────────────────────────

function MetricCell({ label, value, vColor, lw, cellWidth }: {
  label:     string;
  value:     string;
  vColor:    string;
  lw:        number;   // fixed label width shared across the row
  cellWidth: number;   // total cell width — vw is derived from this
}) {
  const vw = Math.max(3, cellWidth - lw - 1);
  return (
    <Box flexDirection="row" flexShrink={0} overflow="hidden">
      <Text color={C.muted}>{fitL(label, lw)}</Text>
      <Text color={C.dim}>{' '}</Text>
      <Text bold color={vColor}>{fitR(value, vw)}</Text>
    </Box>
  );
}

function Overview({ summary, rangeLabel, width }: {
  summary:    SummaryMetrics;
  rangeLabel: string;
  width:      number;
}) {
  const iw     = width - 4;
  const SEP_W  = 3;   // " │ "
  const N_COLS = 4;
  // Each of the first 3 cells gets the floored width; the last absorbs the remainder
  // so 4 cells + 3 separators = iw exactly — no trailing space.
  const cw     = Math.max(10, Math.floor((iw - SEP_W * (N_COLS - 1)) / N_COLS));
  const lastCw = iw - SEP_W * (N_COLS - 1) - (N_COLS - 1) * cw;
  // Fixed label column = longest label "Sessions" (8 chars)
  const LW     = 8;

  const row1: [string, string, string][] = [
    ['Cost',     formatMoney(summary.totalCost),      C.gold],
    ['Calls',    cint(summary.totalCalls),            C.blue],
    ['Sessions', cint(summary.totalSessions),         C.green],
    ['Cache',    formatPercent(summary.cacheHitRate), C.purple],
  ];
  const row2: [string, string, string][] = [
    ['In',      tok(summary.inputTokens),             C.cyan],
    ['Out',     tok(summary.outputTokens),            C.green],
    ['Cached',  tok(summary.cachedTokens),            C.amber],
    ['Written', tok(summary.writtenTokens),           C.salmon],
  ];

  function MetricRow({ cells }: { cells: [string, string, string][] }) {
    return (
      <Box paddingX={1} flexDirection="row" overflow="hidden">
        {cells.map(([label, val, vc], i) => (
          <React.Fragment key={i}>
            <MetricCell
              label={label} value={val} vColor={vc} lw={LW}
              cellWidth={i === N_COLS - 1 ? lastCw : cw}
            />
            {i < N_COLS - 1 ? <Text color={C.dim}>{' │ '}</Text> : null}
          </React.Fragment>
        ))}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={C.pOver} width={width} overflow="hidden">
      <Box paddingX={1} flexDirection="row">
        <Text bold color={C.brand}>⬡ agwatch</Text>
        <Text color={C.dim}>{' · '}</Text>
        <Text color={C.subtle}>{rangeLabel}</Text>
      </Box>
      <MetricRow cells={row1} />
      <MetricRow cells={row2} />
    </Box>
  );
}

// ─── Provider usage panel ────────────────────────────────────────────────────

function ProvidersPanel({ width, providers, loading, loadingText, spinner, statusText, statusIsError }: {
  width: number;
  providers: ProviderUsageData[];
  loading?: boolean;
  loadingText?: string;
  spinner?: string;
  statusText?: string;
  statusIsError?: boolean;
}) {
  if (providers.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={C.pProv} width={width}>
        <Box paddingX={1}>
          <Text bold color={C.pProv}>Providers</Text>
        </Box>
        {loading ? (
          <Box paddingX={2}>
            <Text color={C.brand}>{spinner ?? '◌'}</Text>
            <Text color={C.subtle}>{' '}{loadingText ?? 'Loading provider usage...'}</Text>
          </Box>
        ) : (
          <Box paddingX={2}>
            <Text color={C.muted}>No providers configured. Press </Text>
            <Text bold color={C.brand}>p</Text>
            <Text color={C.muted}> to set up.</Text>
          </Box>
        )}
      </Box>
    );
  }

  const iw = width - 4;
  const N_COLS = providers.length;
  const SEP = 3;
  const totalSep = SEP * (N_COLS - 1);
  const baseColW = Math.floor((iw - totalSep) / N_COLS);
  const lastColW = iw - totalSep - baseColW * (N_COLS - 1);
  const LABEL_W = 3;
  const BAR_PCT_GAP_W = 1;
  const PCT_W = 4;
  const GAP_W = 1;
  const RESET_W = 21;

  function colData(pct: number, cw: number) {
    const bw = Math.max(4, cw - LABEL_W - BAR_PCT_GAP_W - PCT_W - GAP_W - RESET_W);
    const segs = barSegments(pct, 100, bw);
    return { bw, segs };
  }

  const items = providers.map((p, i) => {
    const cw = i === N_COLS - 1 ? lastColW : baseColW;
    const d5h = colData(p.sessionUsedPct, cw);
    const dWk = colData(p.weeklyUsedPct, cw);
    const hasMo = p.monthlyUsedPct != null;
    const dMo = colData(hasMo ? p.monthlyUsedPct! : 0, cw);
    return { p, cw, ...d5h, segsWk: dWk.segs, segsMo: dMo.segs, hasMo };
  });

  function BarRow({ segs, label, pct, reset }: {
    segs: { str: string; color: string }[];
    label: string;
    pct: number;
    reset: string;
  }) {
    return (
      <Box flexDirection="row" overflow="hidden">
        <Text color={C.muted}>{fitL(label, LABEL_W)}</Text>
        {segs.map((s, j) => <Text key={j} color={s.color}>{s.str}</Text>)}
        <Text>{' '.repeat(BAR_PCT_GAP_W)}</Text>
        <Text color={C.white}>{fitR(pct + '%', PCT_W)}</Text>
        <Text>{' '.repeat(GAP_W)}</Text>
        <Text color={C.subtle}>{fitL(reset, RESET_W)}</Text>
      </Box>
    );
  }

  const sep = <Text color={C.dim}>{' │ '}</Text>;

  function FullRow({ renderCell }: { renderCell: (item: typeof items[number], i: number) => React.ReactNode }) {
    return (
      <Box paddingX={1} flexDirection="row">
        {items.map((item, i) => (
          <React.Fragment key={i}>
            <Box width={item.cw} flexDirection="row" overflow="hidden">
              {renderCell(item, i)}
            </Box>
            {i < N_COLS - 1 ? sep : null}
          </React.Fragment>
        ))}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={C.pProv} width={width}>
      <Box paddingX={1}>
        <Text bold color={C.pProv}>Providers</Text>
        {loading ? (
          <>
            <Text color={C.dim}>{' · '}</Text>
            <Text color={C.brand}>{spinner ?? '◌'}</Text>
            <Text color={C.subtle}>{' '}{loadingText ?? 'Refreshing usage...'}</Text>
          </>
        ) : statusText ? (
          <>
            <Text color={C.dim}>{' · '}</Text>
            <Text color={statusIsError ? C.salmon : C.subtle}>{statusText}</Text>
          </>
        ) : null}
      </Box>
      {(() => {
        const segments: Array<{ text: string; color: string; bold: boolean }> = [];
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const src = item.p.source ?? '--';
          const scraped = item.p.scrapedAt > 0 ? formatScrapedTime(item.p.scrapedAt) : '--';
          const suffix = ` (${src} · ${scraped})`;
          const name = `${item.p.providerLabel}${suffix}`;
          const cw = item.cw;
          const t = name.length > cw ? `${name.slice(0, Math.max(1, cw - 1))}…` : name;
          const pad = cw - t.length;
          const l = Math.floor(pad / 2);
          const r = pad - l;
          segments.push({ text: ' '.repeat(l) + t + ' '.repeat(r), color: item.p.color, bold: true });
          if (i < items.length - 1) segments.push({ text: ' │ ', color: C.dim, bold: false });
        }
        return (
          <Box paddingX={1}>
            {segments.map((seg, i) => (
              <Text key={i} bold={seg.bold} color={seg.color}>{seg.text}</Text>
            ))}
          </Box>
        );
      })()}
      <FullRow renderCell={(item) => <BarRow segs={item.segs} label="5h" pct={item.p.sessionUsedPct} reset={item.p.sessionResetDate} />} />
      <FullRow renderCell={(item) => <BarRow segs={item.segsWk} label="Wk" pct={item.p.weeklyUsedPct} reset={item.p.weeklyResetDate} />} />
      <FullRow renderCell={(item) =>
        item.hasMo
          ? <BarRow segs={item.segsMo} label="Mo" pct={item.p.monthlyUsedPct!} reset={item.p.monthlyResetDate!} />
          : <Box width={item.cw} />
      } />
    </Box>
  );
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────

function PeriodTabs({ active, width }: { active: TimeRange; width: number }) {
  const contentStr = '┤ ' + PERIODS.map((p, i) => PERIOD_LABELS[p] + (i < PERIODS.length - 1 ? ' · ' : '')).join('') + ' ├';
  const pricingTs = getPricingTimestamp();
  const pricingLabel = pricingTs ? ` Prices update: ${formatPricingDate(pricingTs)} │` : '';
  const credit = ' Developed by ';
  const rightLen = pricingLabel.length + credit.length + 8;
  const space = Math.max(0, width - contentStr.length - rightLen - 2);
  return (
    <Box width={width}>
      <Text color={C.dim}>{'┤ '}</Text>
      {PERIODS.map((p, i) => (
        <React.Fragment key={p}>
          {active === p
            ? <Text bold color={C.brand}>[{PERIOD_LABELS[p]}]</Text>
            : <Text color={C.muted}>{PERIOD_LABELS[p]}</Text>
          }
          {i < PERIODS.length - 1 ? <Text color={C.dim}>{' · '}</Text> : null}
        </React.Fragment>
      ))}
      <Text color={C.dim}>{' ├'}</Text>
      <Text>{' '.repeat(space)}</Text>
      {pricingLabel ? <Text color={C.subtle}>{pricingLabel}</Text> : null}
      <Text color={C.subtle}>{credit}</Text>
      <Text bold color="#FFB385">{'M0H4M3D'}</Text>
    </Box>
  );
}

function AgentTabs({ active, agents, width }: { active: string; agents: { id: string; label: string }[]; width: number }) {
  const inner = agents.map((a, i) => {
    const label = active === a.id
      ? a.label
      : a.label;
    return { label, active: active === a.id, sep: i < agents.length - 1 };
  });
  const contentStr = '┤ ' + inner.map(a => a.label + (a.sep ? ' │ ' : '')).join('') + ' ├';
  const pad = Math.max(0, Math.floor((width - contentStr.length) / 2));
  return (
    <Box width={width}>
      <Text>
        <Text>{' '.repeat(pad)}</Text>
        <Text color={C.dim}>{'┤ '}</Text>
        {inner.map((a, i) => (
          <React.Fragment key={i}>
            {a.active
              ? <Text bold color={C.brand}>{a.label}</Text>
              : <Text color={C.muted}>{a.label}</Text>
            }
            {a.sep ? <Text color={C.dim}>{' │ '}</Text> : null}
          </React.Fragment>
        ))}
        <Text color={C.dim}>{' ├'}</Text>
      </Text>
    </Box>
  );
}

// ─── Status bar ───────────────────────────────────────────────────────────────

function StatusBar({ width, watch }: { width: number; watch?: boolean }) {
  const binds: [string, string][] = [
    ['q',   'quit'],
    ['1-4', 'period'],
    ['u',   'usage data'],
    ['r',   'pricing'],
    ['v',   'provider usage'],
    ['a',   'refresh all'],
    ['p',   'providers menu'],
    ['↑↓',  'cycle'],
    ['←→',  'agent'],
  ];
  const parts: string[] = [];
  binds.forEach(([k, desc], i) => {
    parts.push(`${k} ${desc}`);
    if (i < binds.length - 1) parts.push(' · ');
  });
  if (watch) parts.push(' · ', '● ', 'watch');
  const contentStr = parts.join('');
  const innerWidth = width - 4;
  const pad = Math.max(0, Math.floor((innerWidth - contentStr.length) / 2));
  return (
    <Box borderStyle="single" borderColor={C.dim} width={width} paddingX={1}>
      <Text>
        <Text>{' '.repeat(pad)}</Text>
        {binds.map(([k, desc], i) => (
          <Text key={k}>
            <Text bold color={C.brand}>{k}</Text>
            <Text color={C.muted}>{` ${desc}`}</Text>
            {i < binds.length - 1 ? <Text color={C.dim}>{' · '}</Text> : null}
          </Text>
        ))}
        {watch ? (
          <Text>
            <Text color={C.dim}>{' · '}</Text>
            <Text color={C.green}>{'● '}</Text>
            <Text color={C.muted}>watch</Text>
          </Text>
        ) : null}
      </Text>
    </Box>
  );
}

// ─── Dashboard content ────────────────────────────────────────────────────────

function DashboardContent({
  data,
  period,
  L,
  providers,
  providersLoading,
  providersLoadingText,
  providersSpinner,
  providersStatusText,
  providersStatusIsError,
}: {
  data: DashboardData;
  period: TimeRange;
  L: Layout;
  providers: ProviderUsageData[];
  providersLoading?: boolean;
  providersLoadingText?: string;
  providersSpinner?: string;
  providersStatusText?: string;
  providersStatusIsError?: boolean;
}) {
  const { dw, wide, pw, bw } = L;

  if (data.summary.totalCalls === 0) {
    return (
      <Box borderStyle="round" borderColor={C.dim} width={dw} paddingX={2}>
        <Text color={C.muted}>No usage data for </Text>
        <Text color={C.white}>{PERIOD_LABELS[period]}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={dw}>
      <Overview summary={data.summary} rangeLabel={PERIOD_LABELS[period]} width={dw} />
      <ProvidersPanel
        width={dw}
        providers={providers}
        loading={providersLoading}
        loadingText={providersLoadingText}
        spinner={providersSpinner}
        statusText={providersStatusText}
        statusIsError={providersStatusIsError}
      />
      {wide ? (
        <>
          <Box width={dw}>
            <ProjectPanel rows={data.byProject}   L={L} />
            <ModelPanel    rows={data.byModel}    L={L} />
            <ActivityPanel rows={data.byActivity} L={L} />
          </Box>
          <Box width={dw}>
            <DailyPanel  rows={data.dailyActivity}  L={L} />
            <ToolsPanel  rows={data.tools}          L={L} />
            <ShellPanel  rows={data.shellCommands}  L={L} />
          </Box>
        </>
      ) : (
        <>
          <ProjectPanel  rows={data.byProject}     L={L} />
          <ModelPanel    rows={data.byModel}        L={L} />
          <ActivityPanel rows={data.byActivity}    L={L} />
          <DailyPanel    rows={data.dailyActivity}  L={L} />
          <ToolsPanel    rows={data.tools}          L={L} />
          <ShellPanel    rows={data.shellCommands}  L={L} />
        </>
      )}
      <McpPanel rows={data.mcpServers} dw={dw} bw={bw} />
    </Box>
  );
}

// ─── Interactive dashboard ────────────────────────────────────────────────────

function InteractiveDashboard({ initialData, initialPeriod, initialAgent, refreshSeconds, initialProviders }: {
  initialData:      DashboardData;
  initialPeriod:    TimeRange;
  initialAgent:     string;
  refreshSeconds?:  number;
  initialProviders: ProviderUsageData[];
}) {
  const { exit } = useApp();
  const { columns } = useWindowSize();
  const L = computeLayout(columns || 120);

  const [period, setPeriod] = useState<TimeRange>(initialPeriod);
  const [activeAgent, setActiveAgent] = useState(initialAgent);
  const [data, setData] = useState<DashboardData>(initialData);
  const [loading, setLoading] = useState(false);
  const [loadingText, setLoadingText] = useState<string>('Loading usage data...');
  const [providers, setProviders] = useState<ProviderUsageData[]>(initialProviders);
  const [showPopup, setShowPopup] = useState(false);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [providersLoadingText, setProvidersLoadingText] = useState('Loading provider usage...');
  const [providersLoadingBaseText, setProvidersLoadingBaseText] = useState('Loading provider usage...');
  const [providersLoadingStartedAt, setProvidersLoadingStartedAt] = useState<number | null>(null);
  const [providersSpinnerIdx, setProvidersSpinnerIdx] = useState(0);
  const [providersStatusText, setProvidersStatusText] = useState<string>('');
  const [providersStatusIsError, setProvidersStatusIsError] = useState(false);

  const providerSpinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

  const quitNow = useCallback(() => {
    fastQuitRequested = true;
    releaseBrowserHandles();
    exit();
    setTimeout(() => process.exit(0), 25);
  }, [exit]);

  const agents = [
    { id: 'all', label: 'All Agents' },
    ...getEnabledAgents().map(a => ({ id: a.id, label: a.label })),
  ];

  const reload = useCallback(async (p: TimeRange, agent: string, reason: string = `Loading ${PERIOD_LABELS[p]}...`) => {
    setLoading(true);
    setLoadingText(reason);
    try {
      const d = await loadDataForRange(p, agent === 'all' ? undefined : agent);
      setData(d);
      resizeTerminalForData(d, providers.length);
    } finally {
      setLoading(false);
    }
  }, [providers.length]);

  const setProviderStatusFromRows = useCallback((rows: ProviderUsageData[]) => {
    const errors = rows.filter((row) => !!row.error).map((row) => `${row.providerLabel}: ${row.error}`);
    if (errors.length === 0) {
      setProvidersStatusText('');
      setProvidersStatusIsError(false);
      return;
    }

    const shown = errors.slice(0, 2).join(' · ');
    const suffix = errors.length > 2 ? ` (+${errors.length - 2} more)` : '';
    setProvidersStatusText(shown + suffix);
    setProvidersStatusIsError(true);
  }, []);

  const beginProvidersLoading = useCallback((reason: string) => {
    setProvidersLoading(true);
    setProvidersLoadingBaseText(reason);
    setProvidersLoadingStartedAt(Date.now());
    setProvidersLoadingText(`${reason} (0s)`);
  }, []);

  const endProvidersLoading = useCallback(() => {
    setProvidersLoading(false);
    setProvidersLoadingStartedAt(null);
  }, []);

  const reloadProviders = useCallback(async (reason: string = 'Refreshing provider usage...') => {
    beginProvidersLoading(reason);
    setProvidersStatusText('');
    setProvidersStatusIsError(false);
    try {
      const rows = await refreshProvidersBackgroundOnly();
      setProviders(rows);
      setProviderStatusFromRows(rows);
    } finally {
      endProvidersLoading();
    }
  }, [beginProvidersLoading, endProvidersLoading, setProviderStatusFromRows]);

  const forceReloadProviders = useCallback(async (reason: string = 'Refreshing provider usage...') => {
    beginProvidersLoading(reason);
    setProvidersStatusText('');
    setProvidersStatusIsError(false);
    try {
      const rows = await forceRefreshProviders();
      setProviders(rows);
      setProviderStatusFromRows(rows);
    } finally {
      endProvidersLoading();
    }
  }, [beginProvidersLoading, endProvidersLoading, setProviderStatusFromRows]);

  useEffect(() => {
    reloadProviders('Loading provider usage...');
  }, [reloadProviders]);

  useEffect(() => {
    if (!providersLoading || providersLoadingStartedAt === null) {
      setProvidersLoadingText(providersLoadingBaseText);
      return;
    }

    const update = () => {
      const secs = Math.max(0, Math.floor((Date.now() - providersLoadingStartedAt) / 1000));
      setProvidersLoadingText(`${providersLoadingBaseText} (${secs}s)`);
    };

    update();
    const id = setInterval(update, 250);
    return () => clearInterval(id);
  }, [providersLoading, providersLoadingStartedAt, providersLoadingBaseText]);

  useEffect(() => {
    if (!providersLoading) {
      setProvidersSpinnerIdx(0);
      return;
    }
    const id = setInterval(() => {
      setProvidersSpinnerIdx((i) => (i + 1) % providerSpinnerFrames.length);
    }, 90);
    return () => clearInterval(id);
  }, [providersLoading]);

  useEffect(() => {
    if (!refreshSeconds || refreshSeconds <= 0) return;
    const id = setInterval(() => reload(period, activeAgent, 'Refreshing usage data...'), refreshSeconds * 1000);
    return () => clearInterval(id);
  }, [refreshSeconds, period, activeAgent, reload]);

  const switchPeriod = useCallback((p: TimeRange) => {
    if (p === period) return;
    setPeriod(p);
    reload(p, activeAgent, `Loading ${PERIOD_LABELS[p]}...`);
  }, [period, activeAgent, reload]);

  const refreshUsageData = useCallback(async () => {
    if (loading) return;
    await reload(period, activeAgent, 'Refreshing usage data...');
  }, [loading, reload, period, activeAgent]);

  const refreshPricingData = useCallback(async () => {
    if (loading) return;
    setLoading(true);
    setLoadingText('Refreshing pricing...');
    try {
      await refreshPricing();
      const d = await loadDataForRange(period, activeAgent === 'all' ? undefined : activeAgent);
      setData(d);
      resizeTerminalForData(d, providers.length);
    } finally {
      setLoading(false);
    }
  }, [loading, period, activeAgent, providers.length]);

  const refreshAllData = useCallback(async () => {
    if (loading || providersLoading) return;

    setLoading(true);
    setLoadingText('Refreshing all data...');
    beginProvidersLoading('Refreshing all data...');
    setProvidersStatusText('');
    setProvidersStatusIsError(false);

    try {
      await refreshPricing();
      const [d, p] = await Promise.all([
        loadDataForRange(period, activeAgent === 'all' ? undefined : activeAgent),
        forceRefreshProviders(),
      ]);
      setData(d);
      setProviders(p);
      setProviderStatusFromRows(p);
      resizeTerminalForData(d, p.length);
    } finally {
      setLoading(false);
      endProvidersLoading();
    }
  }, [
    loading,
    providersLoading,
    period,
    activeAgent,
    beginProvidersLoading,
    endProvidersLoading,
    setProviderStatusFromRows,
  ]);

  useInput((input, key) => {
    if (input === 'q') {
      quitNow();
      return;
    }
    if (showPopup) return;

    const pIdx = PERIODS.indexOf(period);
    const aIdx = agents.findIndex(a => a.id === activeAgent);
    if (key.upArrow) {
      switchPeriod(PERIODS[(pIdx - 1 + PERIODS.length) % PERIODS.length]);
    } else if (key.downArrow) {
      switchPeriod(PERIODS[(pIdx + 1) % PERIODS.length]);
    } else if (key.leftArrow) {
      const next = agents[(aIdx - 1 + agents.length) % agents.length];
      setActiveAgent(next.id);
      reload(period, next.id, 'Refreshing usage data...');
    } else if (key.rightArrow) {
      const next = agents[(aIdx + 1) % agents.length];
      setActiveAgent(next.id);
      reload(period, next.id, 'Refreshing usage data...');
    } else if (input === '1') switchPeriod('today');
    else if (input === '2') switchPeriod('7d');
    else if (input === '3') switchPeriod('30d');
    else if (input === '4') switchPeriod('month');
    else if (input === 'r') {
      refreshPricingData();
    } else if (input === 'u') {
      refreshUsageData();
    } else if (input === 'v') {
      if (!providersLoading) {
        forceReloadProviders('Refreshing provider usage...');
      } else {
        setProvidersLoadingBaseText('Still refreshing provider usage...');
      }
    } else if (input === 'a') {
      refreshAllData();
    } else if (input === 'p') {
      setShowPopup(true);
    }
  });

  return (
    <Box flexDirection="column" width={L.dw}>
      <PeriodTabs active={period} width={L.dw} />
      {showPopup ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={C.dim}
          width={L.dw}
          minHeight={20}
          justifyContent="center"
          alignItems="center"
          paddingY={2}
        >
          <Box>
            <ProviderPopup
              width={Math.min(64, L.dw - 8)}
              onClose={() => setShowPopup(false)}
              onQuit={quitNow}
              onProviderChanged={async () => {
                await forceReloadProviders('Loading provider usage...');
              }}
            />
          </Box>
        </Box>
      ) : (
        <>
          {loading
            ? (
              <Box borderStyle="round" borderColor={C.dim} width={L.dw} paddingX={2}>
                <Text color={C.muted}>{'◌  Loading '}</Text>
                <Text color={C.subtle}>{loadingText}</Text>
              </Box>
            )
            : <DashboardContent
              data={data}
              period={period}
              L={L}
              providers={providers}
              providersLoading={providersLoading}
              providersLoadingText={providersLoadingText}
              providersSpinner={providerSpinnerFrames[providersSpinnerIdx]}
              providersStatusText={providersStatusText}
              providersStatusIsError={providersStatusIsError}
            />
          }
          <AgentTabs active={activeAgent} agents={agents} width={L.dw} />
          <StatusBar width={L.dw} watch={!!refreshSeconds && refreshSeconds > 0} />
        </>
      )}
    </Box>
  );
}

// ─── Entry point ──────────────────────────────────────────────────────────────

const MIN_DASHBOARD_HEIGHT = 30;
const TARGET_DASHBOARD_WIDTH = 180;
let lastAppliedHeight: number | null = null;
let lastAppliedWidth: number | null = null;

function getMaxDashboardHeight(): number {
  return Math.max(60, Math.floor((process.stdout.rows || 50) * 0.9));
}

function supportsXTWINOPS(): boolean {
  const term = (process.env.TERM || '').toLowerCase();
  if (term.includes('screen') || term.includes('tmux')) return false;
  return true;
}

function restoreTerminal(): void {
}

process.on('exit', restoreTerminal);

process.on('SIGTERM', () => {
  restoreTerminal();
  process.exit(0);
});

function tablePanelHeight(rows: number, limit: number): number {
  if (rows <= 0) return 4;
  return 4 + Math.min(rows, limit);
}

function desiredDashboardHeight(data: DashboardData, providerCount: number): number {
  // period tabs (1) + agent tabs (1) + status bar (3: border + content + border)
  const chrome = 5;

  // Empty state: one "No usage data" panel (3 lines).
  if (data.summary.totalCalls === 0) {
    return Math.max(MIN_DASHBOARD_HEIGHT, chrome + 3 + 2);
  }

  // Overview: 2 borders + title + 2 metric rows.
  const overview = 5;
  // Providers panel: 2 borders + title + names row + 3 bar rows (5h, Wk, Mo).
  const providers = providerCount > 0 ? 7 : 4;

  const topRow = Math.max(
    tablePanelHeight(data.byProject.length, 12),
    tablePanelHeight(data.byModel.length, 12),
    tablePanelHeight(data.byActivity.length, 12),
  );

  const midRow = Math.max(
    tablePanelHeight(data.dailyActivity.length, 14),
    tablePanelHeight(data.tools.length, 12),
    tablePanelHeight(data.shellCommands.length, 12),
  );

  const mcp = tablePanelHeight(data.mcpServers.length, 6);

  const content = chrome + overview + providers + topRow + midRow + mcp;

  return Math.min(getMaxDashboardHeight(), Math.max(MIN_DASHBOARD_HEIGHT, content));
}

function resizeTerminalTo(height: number, width: number): void {
  if (lastAppliedHeight === height && lastAppliedWidth === width) return;
  if (!supportsXTWINOPS()) return;
  // When shrinking, Windows Terminal sometimes gives one fewer usable row than
  // requested in the alt screen buffer; +1 compensates so all content rows fit.
  const isShrinking = lastAppliedHeight !== null && height < lastAppliedHeight;
  process.stdout.write(`\x1b[8;${isShrinking ? height + 1 : height};${width}t`);
  lastAppliedHeight = height;
  lastAppliedWidth = width;
}

function resizeTerminalForData(data: DashboardData, providerCount: number): void {
  resizeTerminalTo(desiredDashboardHeight(data, providerCount), TARGET_DASHBOARD_WIDTH);
}

export async function runInkDashboard(
  period:          TimeRange = '7d',
  agent:           string    = 'all',
  refreshSeconds?: number,
): Promise<void> {
  fastQuitRequested = false;
  try {
    const data  = await loadDataForRange(period, agent === 'all' ? undefined : agent);
    const isTTY = process.stdin.isTTY && process.stdout.isTTY;
    const out = process.stdout;

    if (isTTY) {
      const config = loadConfig();
      const enabledProviders = (config.providers ?? []).filter((p) => p.enabled);
      const providerData: ProviderUsageData[] = enabledProviders.map((p) => {
        const def = SUPPORTED_PROVIDERS.find((sp) => sp.id === p.id);
        const base: ProviderUsageData = {
          providerId: p.id,
          providerLabel: p.label || def?.label || p.id,
          color: def?.color ?? C.subtle,
          sessionUsedPct: 0,
          weeklyUsedPct: 0,
          sessionResetDate: '--',
          weeklyResetDate: '--',
          scrapedAt: 0,
        };
        if (p.id === 'opencodego') {
          base.monthlyUsedPct = 0;
          base.monthlyResetDate = '--';
        }
        return base;
      });
      resizeTerminalForData(data, providerData.length);
      const { waitUntilExit } = render(
        <InteractiveDashboard
          initialData={data}
          initialPeriod={period}
          initialAgent={agent}
          refreshSeconds={refreshSeconds}
          initialProviders={providerData}
        />
      );
      await waitUntilExit();
    } else {
      const providerData = await refreshProvidersBackgroundOnly();
      const L = computeLayout(Number(process.env['COLUMNS'] ?? 80));
      const { unmount } = render(
        <Box flexDirection="column">
          <PeriodTabs active={period} width={L.dw} />
          <DashboardContent data={data} period={period} L={L} providers={providerData} />
        </Box>,
        { patchConsole: false }
      );
      unmount();
    }
  } finally {
    if (!fastQuitRequested) {
      void closeBrowser();
    }
  }
}
