import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs/promises";
import path from "path";
import { PlayerSnap } from "../models/player-snap";
import { ScraperHelper } from "../utils/scraper-helper";

// NEW: load the maintained list
import tracked from "../tracked-players.json";

type Tracked = {
  id: string;
  name: string;
  realm: "Albion" | "Midgard" | "Hibernia";
  url: string;
};

const OUTPUT_DIR = path.resolve(process.cwd(), "data/public");
const AXIOS_CONFIG = {
  timeout: 15000,
  headers: { "user-agent": "uthgard-tools (+your site)" },
};

// robust RP extractor
function extractRealmPoints($: cheerio.CheerioAPI): number {
  // Try multiple label variants the Herald uses
  const txt =
    $('td:contains("Realmpoints")').next().text().trim() ||
    $('td:contains("Realm points")').next().text().trim() ||
    $('td:contains("Realm Points")').next().text().trim();

  return ScraperHelper.parseRealmPoints(txt);
}

async function fetchCharacter(url: string): Promise<PlayerSnap | null> {
  try {
    const { data } = await axios.get(url, AXIOS_CONFIG);
    const $ = cheerio.load(data);

    // name from detail table header or H1
    const name =
      $("h1,.char-name").first().text().trim() ||
      $('td:contains("Player")').next().text().trim();
    if (!name) return null;

    const realmText =
      $(".char-realm").text().trim() ||
      $('td:contains("Realm")').next().text().trim();

    const totalRP = extractRealmPoints($);

    return {
      name,
      realm: ScraperHelper.parseRealm(realmText),
      className: $(".char-class").text().trim() || undefined,
      guild: $(".char-guild").text().trim() || undefined,
      level: ScraperHelper.parseLevel($(".char-level").text()),
      realmRank: $(".char-rr").text().trim() || undefined,
      totalRP,
      levelPercent: null,
      takenAt: new Date().toISOString(),
    };
  } catch (err) {
    console.error(
      "Failed to fetch",
      url,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

async function writeJson(filePath: string, data: any) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

async function appendNdjson(filePath: string, rows: PlayerSnap[]) {
  const lines = rows.map((p) =>
    JSON.stringify({
      name: p.name,
      totalRP: p.totalRP,
      level: p.level ?? null,
      realmRank: p.realmRank ?? null,
      realm: p.realm,
      takenAt: p.takenAt,
    })
  );
  await fs.appendFile(filePath, lines.join("\n") + "\n");
}

async function main() {
  await fs.mkdir(path.join(OUTPUT_DIR, "players"), { recursive: true });

  // If you want to be gentle with the Herald, fetch sequentially with a small delay
  const playerSnapshots: PlayerSnap[] = [];
  for (const p of tracked as Tracked[]) {
    const snap = await fetchCharacter(p.url);
    if (snap) playerSnapshots.push(snap);
    await new Promise((r) => setTimeout(r, 600)); // 0.6s between requests
  }

  await writeJson(path.join(OUTPUT_DIR, "today.json"), {
    players: playerSnapshots,
    updatedAt: new Date().toISOString(),
  });

  const dateStamp = ScraperHelper.createDateStamp();
  const dailyFile = path.join(OUTPUT_DIR, "days", `${dateStamp}.ndjson`);
  await fs.mkdir(path.dirname(dailyFile), { recursive: true });
  try {
    await fs.access(dailyFile);
  } catch {
    await fs.writeFile(dailyFile, "");
  }
  await appendNdjson(dailyFile, playerSnapshots);

  console.log(`Successfully scraped ${playerSnapshots.length} players`);
}

main().catch(console.error);
