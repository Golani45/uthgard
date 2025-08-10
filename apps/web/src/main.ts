import "zone.js";
import { platformBrowser } from "@angular/platform-browser";
import { AppModule } from "./lib/app.module";

platformBrowser()
  .bootstrapModule(AppModule)
  .catch((err) => console.error(err));
