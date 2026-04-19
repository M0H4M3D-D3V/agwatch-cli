export interface UsageSourceAdapter {
  getSessions(range: import('../domain/types.js').TimeRangeFilter): Promise<import('../domain/types.js').RawSession[]>;
  getMessages(sessionIds: string[]): Promise<import('../domain/types.js').RawMessage[]>;
  getParts?(messageIds: string[]): Promise<import('../domain/types.js').RawPart[]>;
}
