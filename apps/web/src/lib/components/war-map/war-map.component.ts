import { CommonModule } from "@angular/common";
import { FormsModule } from "@angular/forms"; // <-- add this
import {
  Component,
  inject,
  input,
  OnDestroy,
  OnInit,
  signal,
} from "@angular/core";
import { KeepGeo } from "../../models/keep-geo";
import { Realm } from "../../types/realm";
import { WarMapService } from "../../services/warmap/war-map.service";
import { combineLatest, Subscription } from "rxjs";

type Marker = KeepGeo & {
  realm: Realm;
  underAttack: boolean;
  title: string;
};

@Component({
  selector: "ac-war-map",
  standalone: true,
  imports: [CommonModule, FormsModule], // <-- include FormsModule
  templateUrl: "./war-map.component.html",
  styleUrls: ["./war-map.component.scss"],
})
export class WarMapComponent implements OnInit, OnDestroy {
  private svc = inject(WarMapService);

  width = input<number>(1024);
  maxWidth = input<string>("100%");

  editMode = location.search.includes("edit=1");
  placingId: string | null = null;

  geo = signal<KeepGeo[]>([]);
  dfOwner = signal<Realm>("Neutral");
  markers = signal<Marker[]>([]);

  private subscriptions: Subscription[] = [];

  constructor(private readonly _warMapService: WarMapService) {}

  ngOnInit(): void {
    this.establishSubscriptions();
  }

  ngOnDestroy(): void {
    this.subscriptions.forEach((s) => s.unsubscribe());
  }

  private establishSubscriptions() {
    const geo$ = this._warMapService.geo$;
    const status$ = this._warMapService.status$;

    this.subscriptions.push(
      combineLatest([geo$, status$]).subscribe(([geo, status]) => {
        this.geo.set(geo);
        this.dfOwner.set(status.darknessFallsOwner); // set once

        const markers = this.geo()
          .filter((g) => g.x >= 0 && g.y >= 0) // <- no status filter
          .map((g) => {
            const st = status.keeps[g.id];
            const realm = st?.realm ?? "Neutral";
            const underAttack = !!st?.underAttack;
            const ts = st?.lastChanged
              ? new Date(st.lastChanged).toLocaleString()
              : "";
            const name = toPrettyName(g.id);
            return {
              ...g,
              realm,
              underAttack,
              title: `${name}\nOwner: ${realm}${
                ts ? `\nLast changed: ${ts}` : ""
              }`,
            };
          });
        this.markers.set(markers);
      })
    );
  }

  // pass id so you can special-case relics
  iconFor(realm: Realm, id?: string) {
    if (id && /relic/.test(id)) return "assets/icons/relic.svg";
    switch (realm) {
      case "Albion":
        return "assets/icons/keep-alb.svg";
      case "Midgard":
        return "assets/icons/keep-mid.svg";
      case "Hibernia":
        return "assets/icons/keep-hib.svg";
      default:
        return "assets/icons/keep-alb.svg";
    }
  }

  onMapClick(evt: MouseEvent) {
    if (!this.editMode || !this.placingId) return;
    const el = evt.currentTarget as HTMLElement; // .map container
    const r = el.getBoundingClientRect();
    const x = (evt.clientX - r.left) / r.width;
    const y = (evt.clientY - r.top) / r.height;
    console.log(
      `{ "id": "${this.placingId}", "x": ${x.toFixed(3)}, "y": ${y.toFixed(
        3
      )} },`
    );
  }

  dfBadge() {
    switch (this.dfOwner()) {
      case "Albion":
        return "A";
      case "Midgard":
        return "M";
      case "Hibernia":
        return "H";
      default:
        return "?";
    }
  }
}

function toPrettyName(id: string) {
  return id.replace(/-/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}
