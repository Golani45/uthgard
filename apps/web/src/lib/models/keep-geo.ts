import { Keep } from "../types/keep";
import { Realm } from "../types/realm";

export interface KeepGeo {
  id: string;
  y: number;
  x: number;
  type?: Keep;
  realm: Realm;
  underAttack: boolean;
  title: string;
}
