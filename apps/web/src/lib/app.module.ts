import { CommonModule, DatePipe, DecimalPipe } from "@angular/common";
import { NgModule } from "@angular/core";
import { BrowserModule } from "@angular/platform-browser";
import { BrowserAnimationsModule } from "@angular/platform-browser/animations";
import { ButtonModule } from "primeng/button";
import { CardModule } from "primeng/card";
import { TableModule } from "primeng/table";
import { AppRoutingModule } from "./app-routing.module";
import { AppComponent } from "./app/app.component";
import { UthgardHomePageComponent } from "./pages/uthgard-home.component";
import { HttpClient } from "@angular/common/http";

@NgModule({
  imports: [
    BrowserModule,
    ButtonModule,
    TableModule,
    CardModule,
    AppRoutingModule,
    BrowserAnimationsModule,
    CommonModule,
    TableModule,
  ],
  declarations: [UthgardHomePageComponent, AppComponent],
  providers: [DatePipe, DecimalPipe],
  bootstrap: [AppComponent],
})
export class AppModule {}
