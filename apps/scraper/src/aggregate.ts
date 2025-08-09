import dayjs from "dayjs";
import isoWeek from "dayjs/plugin/isoWeek";
import utc from "dayjs/plugin/utc";
import fs from "fs";
import path from "path";
import { CONSTANTS } from "../constants";
import { ActivityEvent } from "../models/activity-event";
import { Today } from "../types/today";
import { ScraperHelper } from "../utils/scraper-helper";

dayjs.extend(isoWeek);
dayjs.extend(utc);

const OUTPUT_ROOT: string = path.resolve(process.cwd(), "data/public");

/**
 * Load previous today.json
 *
 * @returns {Today | null} Previous today.json data
 */
function loadPreviousToday(): Today | null {
  const previousTodayPath = path.join(OUTPUT_ROOT, "today.json.prev");
  return ScraperHelper.readJsonFile<Today>(previousTodayPath, null as any);
}

/**
 * Save current today.json as previous
 * @param {Today} currentToday Current today.json data
 */
function savePreviousToday(currentToday: Today): void {
  const previousTodayPath = path.join(OUTPUT_ROOT, "today.json.prev");
  fs.writeFileSync(previousTodayPath, JSON.stringify(currentToday));
}

/**
 * Main aggregation function
 */
async function main(): Promise<void> {
  const currentToday = ScraperHelper.readJsonFile<Today>(
    path.join(OUTPUT_ROOT, "today.json"),
    {
      players: [],
      updatedAt: new Date().toISOString(),
    }
  );
  const previousToday: Today | null = loadPreviousToday();

  // Recent RvR/PvE events (last 60 minutes)
  const activityCutoffTime: number =
    Date.now() - CONSTANTS.ACTIVITY_CUTOFF_MINUTES * 60 * 1000;

  const rvrActivity = ScraperHelper.readJsonFile<{
    updatedAt?: string;
    events: ActivityEvent[];
  }>(path.join(OUTPUT_ROOT, "activity-rvr.json"), { events: [] });
  const pveActivity = ScraperHelper.readJsonFile<{
    updatedAt?: string;
    events: ActivityEvent[];
  }>(path.join(OUTPUT_ROOT, "activity-pve.json"), { events: [] });

  if (previousToday) {
    const previousPlayersByName = new Map(
      previousToday.players.map((player) => [player.name, player])
    );

    for (const currentPlayer of currentToday.players) {
      const previousPlayer = previousPlayersByName.get(currentPlayer.name);
      if (!previousPlayer) continue;

      const realmPointsDelta: number =
        currentPlayer.totalRP - previousPlayer.totalRP;

      if (realmPointsDelta > 0) {
        rvrActivity.events.push({
          at: currentToday.updatedAt,
          name: currentPlayer.name,
          realm: currentPlayer.realm,
          rpDelta: realmPointsDelta,
        });
      }

      if ((currentPlayer.level ?? 0) > (previousPlayer.level ?? 0)) {
        pveActivity.events.push({
          at: currentToday.updatedAt,
          name: currentPlayer.name,
          realm: currentPlayer.realm,
          event: "levelUp",
          from: previousPlayer.level ?? null,
          to: currentPlayer.level,
        });
      } else if (
        (currentPlayer.level ?? 50) < 50 &&
        currentPlayer.levelPercent != null &&
        previousPlayer.levelPercent != null
      ) {
        const levelPercentDelta =
          currentPlayer.levelPercent - previousPlayer.levelPercent;
        if (levelPercentDelta > 0) {
          pveActivity.events.push({
            at: currentToday.updatedAt,
            name: currentPlayer.name,
            realm: currentPlayer.realm,
            event: "xpGain",
            level: currentPlayer.level,
            xpDeltaPct: levelPercentDelta,
          });
        }
      }
    }
  }

  // Prune events older than cutoff time
  rvrActivity.events = ScraperHelper.filterEventsByTime(
    rvrActivity.events,
    activityCutoffTime
  );
  pveActivity.events = ScraperHelper.filterEventsByTime(
    pveActivity.events,
    activityCutoffTime
  );

  ScraperHelper.writeJsonFile(path.join(OUTPUT_ROOT, "activity-rvr.json"), {
    updatedAt: currentToday.updatedAt,
    events: rvrActivity.events,
  });
  ScraperHelper.writeJsonFile(path.join(OUTPUT_ROOT, "activity-pve.json"), {
    updatedAt: currentToday.updatedAt,
    events: pveActivity.events,
  });

  // Last week RP leaderboard (sum of daily deltas)
  const today: dayjs.Dayjs = dayjs.utc();
  const weekStart: dayjs.Dayjs = today.isoWeekday(1).subtract(7, "day"); // last week Monday
  const weekEnd: dayjs.Dayjs = today.isoWeekday(7).subtract(7, "day"); // last week Sunday

  const playerTotals = new Map<
    string,
    { realm: string; totalRP: number; lastWeekRP: number }
  >();

  // Helper: ensure map entry exists
  function ensurePlayerEntry(playerName: string, playerRealm: string) {
    if (!playerTotals.has(playerName)) {
      playerTotals.set(playerName, {
        realm: playerRealm,
        totalRP: 0,
        lastWeekRP: 0,
      });
    }
    return playerTotals.get(playerName)!;
  }

  // Gather today's latest totals for display
  for (const player of currentToday.players) {
    ensurePlayerEntry(player.name, player.realm).totalRP = player.totalRP;
  }

  // Compute lastWeek by summing daily deltas
  const daysDirectory: string = path.join(OUTPUT_ROOT, "days");
  if (fs.existsSync(daysDirectory)) {
    const dailyFiles = fs
      .readdirSync(daysDirectory)
      .filter(ScraperHelper.isValidDateFile);

    for (const fileName of dailyFiles) {
      const fileDate = dayjs(fileName.slice(0, 10));
      if (fileDate.isBefore(weekStart) || fileDate.isAfter(weekEnd)) continue;

      const fileContent: string = fs.readFileSync(
        path.join(daysDirectory, fileName),
        "utf8"
      );
      const dailyEntries = ScraperHelper.parseNdjsonLines(fileContent);

      // Compute per-player delta for the day: max - min RP in that file
      const playersByName = new Map<
        string,
        { min: number; max: number; realm: string }
      >();

      for (const entry of dailyEntries) {
        const existingEntry = playersByName.get(entry.name) || {
          min: entry.totalRP,
          max: entry.totalRP,
          realm: entry.realm,
        };
        existingEntry.min = Math.min(existingEntry.min, entry.totalRP);
        existingEntry.max = Math.max(existingEntry.max, entry.totalRP);
        playersByName.set(entry.name, existingEntry);
      }

      for (const [playerName, playerData] of playersByName) {
        const playerTotal = ensurePlayerEntry(playerName, playerData.realm);
        playerTotal.lastWeekRP += Math.max(0, playerData.max - playerData.min);
      }
    }
  }

  const leaderboardRows = [...playerTotals.entries()]
    .map(([playerName, playerData]) => ({
      name: playerName,
      realm: playerData.realm,
      totalRP: playerData.totalRP,
      lastWeekRP: playerData.lastWeekRP,
    }))
    .sort((a, b) => b.lastWeekRP - a.lastWeekRP)
    .slice(0, CONSTANTS.MAX_LEADERBOARD_ENTRIES);

  ScraperHelper.writeJsonFile(
    path.join(OUTPUT_ROOT, "leaderboards", "last-week.json"),
    {
      weekStart: weekStart.format("YYYY-MM-DD"),
      weekEnd: weekEnd.format("YYYY-MM-DD"),
      updatedAt: currentToday.updatedAt,
      rows: leaderboardRows,
    }
  );

  // Rotate previous today file
  savePreviousToday(currentToday);
  console.log(
    "Aggregated: RvR events",
    rvrActivity.events.length,
    "PvE events",
    pveActivity.events.length
  );
}

main().catch(console.error);
