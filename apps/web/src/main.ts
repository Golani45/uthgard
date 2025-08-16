import "zone.js";
import { bootstrapApplication } from "@angular/platform-browser";
import { AppComponent } from "./lib/app/app.component";
import { provideRouter } from "@angular/router";
import { UthgardHomePageComponent } from "./lib/pages/uthgard-home.component";
import { DatePipe, DecimalPipe } from "@angular/common";
import { provideHttpClient } from "@angular/common/http";
import { provideAnimationsAsync } from "@angular/platform-browser/animations/async";
import { providePrimeNG } from "primeng/config";
import Aura from "@primeuix/themes/aura";

bootstrapApplication(AppComponent, {
  providers: [
    provideRouter([
      { path: "", component: UthgardHomePageComponent },
      { path: "**", redirectTo: "" },
    ]),
    provideHttpClient(),
    DatePipe,
    DecimalPipe,
    provideAnimationsAsync(),
    providePrimeNG({
      theme: {
        preset: Aura,
      },
    }),
  ],
});
