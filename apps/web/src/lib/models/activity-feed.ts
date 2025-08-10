import { AcitivityEvent } from "./activity-event";

export interface ActivityFeed {
  updatedAt: string;
  events: AcitivityEvent[];
}
