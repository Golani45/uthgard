import { HttpClient } from "@angular/common/http";
import { inject, Injectable } from "@angular/core";
import { Observable } from "rxjs";
import { environment } from "../../environments/environment";
import { ActivityFeed } from "../models/activity-feed";
import { LastWeekBoard } from "../models/last-week-board";

@Injectable({
  providedIn: "root",
})
export class UthgardService {
  private http = inject(HttpClient);
  private base = environment.dataBaseUrl;

  /**
   * Constructor
   *
   * @param {HttpClient} _httpClient Http client
   */
  constructor(private readonly _httpClient: HttpClient) {}

  getRvR(): Observable<ActivityFeed> {
    return this.http.get<ActivityFeed>(`${this.base}/activity-rvr.json`);
  }

  getPvE(): Observable<ActivityFeed> {
    return this.http.get<ActivityFeed>(`${this.base}/activity-pve.json`);
  }

  getLastWeek(): Observable<LastWeekBoard> {
    return this.http.get<LastWeekBoard>(
      `${this.base}/leaderboards/last-week.json`
    );
  }
}
