import type { ProviderUsageLimit } from './types.js';
import { clampPct } from './format-utils.js';

export async function extractUsageLimitsFromPage(page: any, signal?: AbortSignal): Promise<ProviderUsageLimit[]> {
  signal?.throwIfAborted();
  const rows = await page.evaluate(() => {
    const contextRe = /usage|quota|limit|window|rolling|hour|day|week|month|session|token|request|credit|allowance|capacity|用量|额度|限制|小时|每周|每月/i;
    const excludedRe = /discount|tax|saving|profile|completion|battery/i;
    const candidates: Array<{ label: string; percent: number; reset: string }> = [];
    const elements = Array.from(document.querySelectorAll('section, article, li, tr, dl, [role="progressbar"], div'));

    for (const element of elements.slice(0, 4_000)) {
      const isProgressbar = element.getAttribute('role') === 'progressbar';
      let scope = element;
      if (isProgressbar) {
        scope = element.parentElement?.closest('section, article, li, tr, dl') ?? element.parentElement ?? element;
        let ancestor = element.parentElement;
        for (let depth = 0; depth < 5 && ancestor; depth++, ancestor = ancestor.parentElement) {
          const ancestorText = (ancestor.innerText ?? '').replace(/\s+/g, ' ').trim();
          if (
            ancestorText.length <= 600
            && contextRe.test(ancestorText)
            && (ancestor.querySelector('h1,h2,h3,h4,h5,h6,dt') || /(?:reset|resets|重置)/i.test(ancestorText))
          ) {
            scope = ancestor;
            break;
          }
        }
      }
      if (!isProgressbar) {
        const nestedCard = Array.from(element.children).some((child) => {
          if (!child.matches('section, article, li, tr, dl, div')) return false;
          const childText = (child as HTMLElement).innerText ?? '';
          return child.querySelector('[role="progressbar"]') != null || /\d+(?:\.\d+)?\s*%/.test(childText);
        });
        if (nestedCard) continue;
      }

      const htmlElement = scope as HTMLElement;
      const text = (htmlElement.innerText ?? '').replace(/\s+/g, ' ').trim();
      const labelledBy = element.getAttribute('aria-labelledby');
      const labelledText = labelledBy
        ? labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ')
        : '';
      const ariaLabel = element.getAttribute('aria-label') ?? labelledText;
      const contextText = `${ariaLabel} ${text}`.trim();
      if (!contextText || contextText.length > 600 || excludedRe.test(contextText) || !contextRe.test(contextText)) continue;

      const ariaValue = isProgressbar
        ? Number.parseFloat(element.getAttribute('aria-valuenow') ?? '')
        : Number.NaN;
      const ariaMin = isProgressbar
        ? Number.parseFloat(element.getAttribute('aria-valuemin') ?? '0')
        : Number.NaN;
      const ariaMax = isProgressbar
        ? Number.parseFloat(element.getAttribute('aria-valuemax') ?? '100')
        : Number.NaN;
      const pctMatch = text.match(/(\d+(?:\.\d+)?)\s*%/);
      const ratioMatch = text.match(/(?:used|consumed)\D{0,20}(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/i);
      const ratioPercent = ratioMatch && Number.parseFloat(ratioMatch[2]) > 0
        ? (Number.parseFloat(ratioMatch[1]) / Number.parseFloat(ratioMatch[2])) * 100
        : Number.NaN;
      let percent = Number.isFinite(ariaValue)
        ? Number.isFinite(ariaMin) && Number.isFinite(ariaMax) && ariaMax > ariaMin
          ? ((ariaValue - ariaMin) / (ariaMax - ariaMin)) * 100
          : ariaValue
        : pctMatch
          ? Number.parseFloat(pctMatch[1])
          : ratioPercent;
      if (!Number.isFinite(percent) || percent < 0) continue;
      if (/\b(?:remaining|left)\b/i.test(contextText)) percent = 100 - percent;

      const heading = scope.querySelector('h1,h2,h3,h4,h5,h6,dt');
      const headingText = heading?.getAttribute('aria-label') || (heading as HTMLElement | null)?.innerText || ariaLabel;
      const beforePercent = pctMatch ? text.slice(0, pctMatch.index).trim() : text;
      const rawLabel = (headingText || beforePercent).replace(/\b(?:used|usage|utilization)\b/gi, '').trim();
      const contextualLabel = contextText.match(/([\p{L}][\p{L}\d _-]{0,60}(?:usage|quota|limit|window|hour|day|week|month|session|用量|额度|限制|小时|每周|每月))/iu)?.[1];
      const meaningfulLabel = /\p{L}/u.test(rawLabel) ? rawLabel : contextualLabel ?? '';
      const label = meaningfulLabel.slice(0, 80);
      if (!label || /^(?:usage|quota|limit|usage limit)$/i.test(label)) continue;
      const resetMatch = text.match(/(?:reset|resets|重置)(?:\s+(?:in|at|on))?\s*[:\-]?\s*([^|,;]{1,60})/i);
      candidates.push({ label, percent, reset: resetMatch?.[1]?.trim() || '--' });
    }
    return candidates;
  });
  signal?.throwIfAborted();

  const seen = new Set<string>();
  const limits: ProviderUsageLimit[] = [];
  for (const row of rows as Array<{ label: string; percent: number; reset: string }>) {
    const key = `${row.label.toLowerCase()}:${row.percent}:${row.reset}`;
    if (seen.has(key)) continue;
    seen.add(key);
    limits.push({ label: row.label, usedPercent: clampPct(row.percent), resetDate: row.reset });
  }
  return limits;
}
