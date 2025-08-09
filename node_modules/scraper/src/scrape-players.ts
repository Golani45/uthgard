import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs/promises";
import path from "path";
import { CONSTANTS } from "../constants";
import { PlayerSnap } from "../models/player-snap";
import { ScraperHelper } from "../utils/scraper-helper";

const OUTPUT_DIR = path.resolve(process.cwd(), "data/public");
const AXIOS_CONFIG = {
  timeout: 15_000,
  headers: { "user-agent": "uthgard-tools (+your site)" },
};

/**
 * Fetch character data from URL
 *
 * @param {string} url URL to fetch
 * @returns  {PlayerSnap | null} Player snapshot or null if failed
 */
async function fetchCharacter(url: string): Promise<PlayerSnap | null> {
  try {
    const response = await axios.get(url, AXIOS_CONFIG);
    const cheerioInstance = cheerio.load(response.data);

    const name = cheerioInstance("h1,.char-name").first().text().trim();
    if (!name) return null;

    const realmText =
      cheerioInstance(".char-realm").text() ||
      cheerioInstance("td:contains('Realm')").next().text();

    const realmPointsText =
      cheerioInstance(".char-rp").text() ||
      cheerioInstance("td:contains('Realm Points')").next().text() ||
      cheerioInstance("td:contains('Realm points')").next().text();

    return {
      name,
      realm: ScraperHelper.parseRealm(realmText),
      className: cheerioInstance(".char-class").text().trim() || undefined,
      guild: cheerioInstance(".char-guild").text().trim() || undefined,
      level: ScraperHelper.parseLevel(cheerioInstance(".char-level").text()),
      realmRank: cheerioInstance(".char-rr").text().trim() || undefined,
      totalRP: ScraperHelper.parseRealmPoints(realmPointsText),
      levelPercent: null,
      takenAt: new Date().toISOString(),
    };
  } catch (error) {
    console.error(
      "Failed to fetch character:",
      url,
      error instanceof Error ? error.message : error
    );
    return null;
  }
}

async function writeJsonFile(filePath: string, data: any): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

async function appendNdjsonFile(
  filePath: string,
  playerSnapshots: PlayerSnap[]
): Promise<void> {
  const lines = playerSnapshots.map((player) =>
    JSON.stringify({
      name: player.name,
      totalRP: player.totalRP,
      level: player.level ?? null,
      realmRank: player.realmRank ?? null,
      realm: player.realm,
      takenAt: player.takenAt,
    })
  );
  await fs.appendFile(filePath, lines.join("\n") + "\n");
}

async function main(): Promise<void> {
  await fs.mkdir(path.join(OUTPUT_DIR, "players"), { recursive: true });

  const playerSnapshots: PlayerSnap[] = [];
  const playerUrls: string[] = [CONSTANTS.URLS.PLAYERS_UTHGARD];
  // Process URLs concurrently for better performance
  const fetchPromises = playerUrls.map(fetchCharacter);
  const results = await Promise.allSettled(fetchPromises);

  results.forEach((result, index) => {
    if (result.status === "fulfilled" && result.value) {
      playerSnapshots.push(result.value);
    } else if (result.status === "rejected") {
      console.error(
        `Failed to process URL ${playerUrls[index]}:`,
        result.reason
      );
    }
  });

  // Write today's snapshot
  await writeJsonFile(path.join(OUTPUT_DIR, "today.json"), {
    players: playerSnapshots,
    updatedAt: new Date().toISOString(),
  });

  // Write daily NDJSON
  const dateStamp = ScraperHelper.createDateStamp();
  const dailyFile = path.join(OUTPUT_DIR, "days", `${dateStamp}.ndjson`);

  await fs.mkdir(path.dirname(dailyFile), { recursive: true });

  try {
    await fs.access(dailyFile);
  } catch {
    await fs.writeFile(dailyFile, "");
  }

  await appendNdjsonFile(dailyFile, playerSnapshots);

  console.log(`Successfully scraped ${playerSnapshots.length} players`);
}

main().catch(console.error);
