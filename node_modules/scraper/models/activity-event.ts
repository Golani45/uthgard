export interface ActivityEvent {
  at?: string;
  name?: string;
  realm?: string;
  event?: string;
  from?: number | null;
  to?: number;
  level?: number;
  xpDeltaPct?: number;
  rpDelta?: number;
}
