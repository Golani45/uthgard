import { Realm } from "../types/realm";

export interface KeepStatus {
  realm: Realm;
  underAttack?: boolean;
  lastChanged?: string;
  claimedBy?: string | null;
  emblem?: string | null;
}
