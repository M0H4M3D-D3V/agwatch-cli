import type { UsageEvent } from './types.js';
import { classifyEvents } from './activity-classifier.js';
import { nonNegativeNumber } from '../utils/numbers.js';

export function normalize(events: UsageEvent[]): UsageEvent[] {
  return classifyEvents(events.map((event) => ({
    ...event,
    inputTokens: nonNegativeNumber(event.inputTokens),
    outputTokens: nonNegativeNumber(event.outputTokens),
    cachedTokens: nonNegativeNumber(event.cachedTokens),
    writtenTokens: nonNegativeNumber(event.writtenTokens),
    costUsd: nonNegativeNumber(event.costUsd),
    callCount: nonNegativeNumber(event.callCount),
  })));
}
