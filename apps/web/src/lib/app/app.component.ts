import { DatePipe, DecimalPipe } from "@angular/common";
import { Component } from "@angular/core";
import { RouterOutlet } from "@angular/router";

/**
 * Uthgard home page
 */
@Component({
  selector: "ac-root",
  standalone: true,
  imports: [RouterOutlet],
  providers: [DatePipe, DecimalPipe],
  templateUrl: "./app.component.html",
  styleUrls: ["./app.component.scss"],
})
export class AppComponent {}
