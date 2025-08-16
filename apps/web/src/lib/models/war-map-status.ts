import { Realm } from "../types/realm";
import { KeepStatus } from "./keep-status";

export interface WarMapStatus {
  timestamp: string;
  darknessFallsOwner: Realm;
  keeps: Record<string, KeepStatus>;
  relics: {
    captured: Record<Realm, string[]>;
  };
}
