import { Realm } from "../types/realm";

export interface PlayerSnap {
  name: string;
  realm: Realm;
  className?: string;
  guild?: string;
  level?: number;
  realmRank?: string;
  totalRP: number;
  levelPercent?: number | null; // if you can parse bubbles/percent
  takenAt: string; // ISO
}
