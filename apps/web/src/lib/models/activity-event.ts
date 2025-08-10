export interface AcitivityEvent {
  at: string;
  name: string;
  realm: string;
  rpDelta?: number;
  event?: "levelUp" | "xpGain";
  level?: number;
  xpDeltaPercentage?: number;
}
