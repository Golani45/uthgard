import { Injectable, inject } from "@angular/core";
import { HttpClient } from "@angular/common/http";
import { timer, switchMap, map, catchError, tap, shareReplay } from "rxjs";
import { environment } from "src/environments/environment";
import { KeepGeo } from "../../models/keep-geo";
import { WarMapStatus } from "../../models/war-map-status";

type Realm = "Albion" | "Midgard" | "Hibernia" | "Neutral";
type WorkerWarmap = {
  updatedAt: string;
  dfOwner?: Realm;
  keeps: Array<{
    id: string;
    owner: Exclude<Realm, "Neutral">;
    underAttack?: boolean;
    lastEvent?: string;
  }>;
};

@Injectable({ providedIn: "root" })
export class WarMapService {
  private http = inject(HttpClient);

  geo$ = this.http.get<KeepGeo[]>("assets/keeps-geo.json").pipe(shareReplay(1));

  private poll$ = timer(0, 30_000);

  status$ = this.poll$.pipe(
    switchMap(() => {
      const url = new URL(
        "/api/warmap.json",
        environment.apiBaseUrl
      ).toString();
      return this.http.get<WorkerWarmap>(url).pipe(
        tap(() => console.log("[warmap] GET", url)),
        map((w) => this.mapWorkerToStatus(w)),
        catchError((err) => {
          console.warn("[warmap] worker fetch failed, falling back", err);
          return this.http.get<WarMapStatus>(
            "data/keeps-status.json?ts=" + Date.now()
          );
        })
      );
    }),
    shareReplay(1)
  );

  private mapWorkerToStatus(w: WorkerWarmap): WarMapStatus {
    const keeps: Record<
      string,
      {
        realm: Exclude<Realm, "Neutral">;
        underAttack?: boolean;
        lastChanged?: string;
      }
    > = {};
    for (const k of w.keeps ?? []) {
      keeps[k.id] = {
        realm: k.owner,
        underAttack: !!k.underAttack,
        lastChanged: k.lastEvent ?? w.updatedAt,
      };
    }
    return {
      timestamp: w.updatedAt ?? new Date().toISOString(),
      darknessFallsOwner: (w.dfOwner ?? "Neutral") as any,
      keeps,
    } as WarMapStatus;
  }
}
