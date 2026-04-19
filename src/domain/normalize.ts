import type { UsageEvent } from './types.js';
import { classifyEvents } from './activity-classifier.js';

export function normalize(events: UsageEvent[]): UsageEvent[] {
  return classifyEvents(events);
}
