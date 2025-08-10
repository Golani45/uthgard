import { NgModule } from "@angular/core";
import { RouterModule, Routes } from "@angular/router";
import { UthgardHomePageComponent } from "./pages/uthgard-home.component";

const routes: Routes = [
  { path: "", component: UthgardHomePageComponent },
  // { path: 'players', component: PlayersPage },
  { path: "**", redirectTo: "" },
];

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule],
})
export class AppRoutingModule {}
