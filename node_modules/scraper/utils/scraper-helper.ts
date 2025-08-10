import { Realm } from "../types/realm";
import fs from "fs";
import path from "path";

export class ScraperHelper {
  static parseRealm(realmText: string): Realm {
    if (/alb/i.test(realmText)) return "Albion";
    if (/mid/i.test(realmText)) return "Midgard";
    if (/hib/i.test(realmText)) return "Hibernia";
    return "Unknown";
  }

  static parseLevel(levelText: string): number | undefined {
    const match = levelText.match(/\d+/);
    return match ? parseInt(match[0], 10) : undefined;
  }

  static parseRealmPoints(rpText: string): number {
    return parseInt(rpText.replace(/[^\d]/g, ""), 10) || 0;
  }

  static createDateStamp(date: Date = new Date()): string {
    const utcDate = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
    );
    return utcDate.toISOString().slice(0, 10);
  }

  static readJsonFile<T>(filePath: string, fallback: T): T {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      return fallback;
    }
  }

  static writeJsonFile(filePath: string, data: any): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  }

  static sumNumbers(numbers: number[]): number {
    return numbers.reduce((accumulator, current) => accumulator + current, 0);
  }

  static filterEventsByTime(events: any[], cutoffTime: number): any[] {
    return events.filter((event) => new Date(event.at).getTime() >= cutoffTime);
  }

  static isValidDateFile(fileName: string): boolean {
    return /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(fileName);
  }

  static parseNdjsonLines(content: string): any[] {
    return content
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
}
