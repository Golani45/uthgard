import { Component, OnInit } from "@angular/core";
import { AcitivityEvent } from "../models/activity-event";
import { LastWeekBoard } from "../models/last-week-board";
import { catchError, combineLatest, Subscription } from "rxjs";
import { CommonModule } from "@angular/common";
import { HttpClient } from "@angular/common/http";
import { TableModule } from "primeng/table";
import { UthgardService } from "../services/uthgard/uthgard.service";
import { WarMapComponent } from "../../../../web/src/lib/components/war-map/war-map.component";

/**
 * Uthgard home page
 */
@Component({
  selector: "ac-uthgard-home",
  standalone: true,
  imports: [CommonModule, TableModule, WarMapComponent],
  templateUrl: "./uthgard-home.component.html",
  styleUrls: ["./uthgard-home.component.scss"],
})
export class UthgardHomePageComponent implements OnInit {
  public rvr: AcitivityEvent[] = [];
  public pve: AcitivityEvent[] = [];
  public board: LastWeekBoard | null = null;

  private subscriptions: Subscription[] = [];

  /**
   * Constructor
   *
   * @param {UthgardService} _uthgardService Uthgard service
   */
  constructor(private readonly _uthgardService: UthgardService) {}

  /**
   * Angular lifecycle hook
   */
  ngOnInit() {
    this.subscribeToEvents();
  }

  /**
   * Angular lifecycle hook
   */
  ngOnDestroy() {
    this.subscriptions.forEach((subscription: Subscription) =>
      subscription.unsubscribe()
    );
  }

  /**
   * Subscribe to events
   */
  private subscribeToEvents(): void {
    const getRvr = this._uthgardService.getRvR().pipe(catchError(() => []));
    const getPve = this._uthgardService.getPvE().pipe(catchError(() => []));
    const getLastWeek = this._uthgardService
      .getLastWeek()
      .pipe(catchError(() => []));

    this.subscriptions.push(
      combineLatest([getRvr, getPve, getLastWeek]).subscribe(
        ([rvr, pve, lastWeek]) => {
          this.rvr = rvr?.events ?? [];
          this.pve = pve?.events ?? [];
          this.board = lastWeek;
        }
      )
    );
  }
}
