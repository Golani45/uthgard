import { DatePipe, DecimalPipe } from "@angular/common";
import { NgModule } from "@angular/core";
import { BrowserModule } from "@angular/platform-browser";
import { ButtonModule } from "primeng/button";
import { CardModule } from "primeng/card";
import { TableModule } from "primeng/table";
import { AppRoutingModule } from "./app-routing.module";
import { UthgardHomePageComponent } from "./pages/uthgard-home.component";

@NgModule({
  imports: [
    BrowserModule,
    ButtonModule,
    TableModule,
    CardModule,
    AppRoutingModule,
  ],
  declarations: [UthgardHomePageComponent],
  providers: [DatePipe, DecimalPipe],
  bootstrap: [UthgardHomePageComponent],
})
export class AppModule {}
