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
import { WarMapStatus } from "src/lib/models/war-map-status";

type Marker = KeepGeo & {
  realm: Realm;
  underAttack: boolean;
  title: string;
  owned: boolean;
  claimedBy: string | null;
  emblem: string | null;
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

  width = input<number>(1124);
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
      combineLatest([geo$, status$]).subscribe(
        ([geo, status]: [KeepGeo[], WarMapStatus]) => {
          this.geo.set(geo);
          this.dfOwner.set(status.darknessFallsOwner);

          const markers = this.geo()
            .map((g) => {
              const isRelic = g.type === "relic";

              // Realm: relic keeps from id, normal keeps from status
              const realm: Realm | undefined = isRelic
                ? this.idToRealm(g.id) // <- derive from prefix
                : status.keeps[g.id]?.realm; // <- from worker

              if (!realm) return null; // <- skip unknown/missing

              const st = status.keeps[g.id];
              const underAttack = !isRelic && !!st?.underAttack;

              // Claimed by (normal keeps only)
              const claimedBy = !isRelic ? st?.claimedBy : undefined;

              // Optional: show captured enemy relics on hover for that realm
              const captured = status.relics?.captured?.[realm] ?? []; // array like ["Mid Power", ...]
              const name = toPrettyName(g.id);

              return {
                ...g,
                realm,
                underAttack,
                title:
                  `${name}\nOwner: ${realm}` +
                  (claimedBy ? `\nClaimed by: ${claimedBy}` : "") +
                  (isRelic && captured.length
                    ? `\nCaptured: ${captured.join(", ")}`
                    : ""),
              } as Marker;
            })
            .filter((m): m is Marker => !!m);

          this.markers.set(markers);
        }
      )
    );
  }

  private idToRealm(id: string): Realm {
    if (id.startsWith("alb-")) return "Albion";
    if (id.startsWith("mid-")) return "Midgard";
    return "Hibernia";
  }

  // pass id so you can special-case relics
  iconFor(m: Marker) {
    if (m.type === "relic") {
      // Relic keep icon = realm-specific; no neutral
      switch (m.realm) {
        case "Albion":
          return "assets/icons/relics/relic-map-alb.png";
        case "Midgard":
          return "assets/icons/relics/relic-map-mid.png";
        case "Hibernia":
          return "assets/icons/relics/relic-map-hib.png";
        default:
          return "assets/icons/relics/relic-map-mid.png";
      }
    }
    // Keep icon
    switch (m.realm) {
      case "Albion":
        return "assets/icons/keep-alb.svg";
      case "Midgard":
        return "assets/icons/keep-mid.svg";
      case "Hibernia":
        return "assets/icons/keep-hib.svg";
      default:
        return "assets/icons/keep-mid.svg";
    }
  }

  private homeRealmForRelic(id: string): Realm | null {
    if (!/relic/.test(id)) return null;
    if (id.startsWith("alb-")) return "Albion";
    if (id.startsWith("mid-")) return "Midgard";
    if (id.startsWith("hib-")) return "Hibernia";
    return null;
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
