import { LastWeekRow } from "./last-week-row";

export interface LastWeekBoard {
  weekStart: string;
  weekEnd: string;
  updatedAt: string;
  rows: LastWeekRow[];
}
