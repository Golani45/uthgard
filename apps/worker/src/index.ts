import { Router } from "itty-router";
import { parse } from "node-html-parser";

// Environment interface
interface Environment {
  WARMAP: KVNamespace;
  HERALD_WARMAP_URL: string;
  ATTACK_WINDOW_MIN?: string;
}

type Event = {
  at: string; // ISO
  kind:
    | "captured"
    | "underAttack"
    | "claimed"
    | "upgraded"
    | "relicMoved"
    | "other";
  keepId: string;
  keepName: string;
  actorRealm?: Realm;
  prevOwner?: Realm;
  newOwner?: Realm;
  guild?: string; // for claimed
  level?: number; // for upgraded
  raw?: string;
};

// Warmap types
interface WarmapData {
  updatedAt: string;
  keeps: Keep[];
  events: Event[];
}

type Realm = "Albion" | "Midgard" | "Hibernia";
type KeepType = "keep" | "relic";

interface Keep {
  id: string;
  name: string;
  type: KeepType;
  owner: Realm;
  underAttack: boolean;
  lastEvent?: string;
  level?: number | null;
  claimedBy?: string | null;
  claimedAt?: string | null; // ISO
  emblem?: string | null;
}

// Response utility
function createJsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}

const ownerMap: Record<string, Realm> = {
  alb: "Albion",
  albion: "Albion",
  mid: "Midgard",
  midgard: "Midgard",
  hib: "Hibernia",
  hibernia: "Hibernia",
};

function slug(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function parseRelative(s: string): { ms: number; bucket: string } {
  // normalize: strip () and "ago"
  const t = s
    .toLowerCase()
    .replace(/[()]/g, "")
    .replace(/\bago\b/g, "")
    .trim();
  // accept many variants
  const m = t.match(
    /(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\b/
  );
  if (!m) return { ms: 0, bucket: "now" };
  const n = Number(m[1]);
  // use first letter to bucket: m|h|d
  const u = m[2][0]; // m/h/d
  const ms =
    u === "m" ? n * 60_000 : u === "h" ? n * 3_600_000 : n * 86_400_000;
  return { ms, bucket: `${n}${u}` };
}

function relToIsoBucketed(
  s: string,
  bucketCounts: Map<string, number>,
  stepMs = 60_000 // spread by 1 minute each
): string {
  const { ms, bucket } = parseRelative(s);
  const idx = bucketCounts.get(bucket) ?? 0;
  bucketCounts.set(bucket, idx + 1);
  // move each subsequent event in the same bucket slightly earlier
  return new Date(Date.now() - ms - idx * stepMs).toISOString();
}

function buildWarmapFromHtml(html: string, attackWindowMin = 7): WarmapData {
  const doc = parse(html);

  // --- 1) Keeps + owner + level/emblem/claimedBy from the header ---
  const keeps: Keep[] = [];
  const keepDivs = doc.querySelectorAll("div.keepinfo");

  for (const div of keepDivs) {
    // name
    const name =
      div.querySelector("strong")?.text.trim() ||
      div.getAttribute("id")?.replace(/_/g, " ") ||
      "Unknown";

    // owner from class keepinfo_{alb|mid|hib}
    const classes = (div.getAttribute("class") || "").toLowerCase();
    const realmKey =
      classes.match(/keepinfo_(alb|mid|hib|albion|midgard|hibernia)/)?.[1] ||
      "alb";
    const owner = ownerMap[realmKey] ?? "Albion";

    // level e.g. "<small>(Level 8 keep)</small>"
    const levelText = div.querySelector("small")?.text ?? "";
    const levelMatch = levelText.match(/level\s+(\d+)/i);
    const level = levelMatch ? Number(levelMatch[1]) : null;

    // emblem image near header (alt contains "Emblem" or src contains "emblem")
    const emblemSrc =
      div.querySelector('img[alt*="emblem" i]')?.getAttribute("src") ??
      div.querySelector('img[src*="emblem"]')?.getAttribute("src") ??
      null;
    const emblem = emblemSrc
      ? new URL(emblemSrc, "https://herald.uthgard.net/").toString()
      : null;

    // claimedBy: header cell shows guild as plain text after <br/>
    const headerCell = div.querySelector('td[align="center"]') ?? div;
    let claimedBy: string | null = null;
    if (headerCell) {
      const lines = headerCell.innerText
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);

      // take the last meaningful line that isn't name/level/emblem
      while (lines.length) {
        const last = lines[lines.length - 1];
        if (
          last === name ||
          /^\(.*level/i.test(last) ||
          /level/i.test(last) ||
          /emblem/i.test(last)
        ) {
          lines.pop();
          continue;
        }
        claimedBy = last;
        break;
      }
    }

    keeps.push({
      id: slug(name),
      name,
      type: "keep",
      owner,
      underAttack: false,
      level,
      emblem,
      claimedBy,
      claimedAt: null,
    });
  }

  // quick lookup by id
  const byId = new Map(keeps.map((k) => [k.id, k]));

  // --- 2) Events from each keep’s history table ---
  const events: WarmapData["events"] = [];
  const rows = doc.querySelectorAll("div.keepinfo table.TABLE tr");

  // track how many events we saw in each relative-time "bucket" (e.g., 3h, 2d)
  const bucketCounts = new Map<string, number>();

  for (const tr of rows) {
    const tds = tr.querySelectorAll("td");
    if (tds.length < 2) continue;

    const text = tds[0].text.replace(/\s+/g, " ").trim();
    const when = tds[tds.length - 1].text.trim();

    // bucketed timestamp (spreads events 1 minute apart within same bucket)
    const at = relToIsoBucketed(when, bucketCounts);

    // "X has been captured by the forces of Realm"
    let m = text.match(
      /^(.+?) has been captured by the forces of (Albion|Midgard|Hibernia)/i
    );
    if (m) {
      const keepName = m[1].trim();
      const newOwner = m[2] as Realm;
      events.push({
        at,
        kind: "captured",
        keepId: slug(keepName),
        keepName,
        newOwner,
        raw: text,
      });
      continue;
    }

    // "X is/was under attack"
    m = text.match(/^(.+?) (?:is|was) under attack/i);
    if (m) {
      const keepName = m[1].trim();
      events.push({
        at,
        kind: "underAttack",
        keepId: slug(keepName),
        keepName,
        raw: text,
      });
      continue;
    }
  }

  // --- 3) Flames from recent under-attack events ---
  const windowMs = attackWindowMin * 60_000;
  const now = Date.now();
  for (const e of events) {
    if (e.kind !== "underAttack") continue;
    const k = byId.get(e.keepId);
    if (!k) continue;
    const t = Date.parse(e.at);
    if (!Number.isNaN(t) && now - t <= windowMs) {
      k.underAttack = true;
      k.lastEvent = e.at;
    }
  }

  // newest first + cap
  events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return {
    updatedAt: new Date().toISOString(),
    keeps,
    events: events.slice(0, 50),
  };
}

const router = Router();

router.get("/api/warmap.json", async (_request, environment: Environment) => {
  const data = await environment.WARMAP.get<WarmapData>("warmap", "json");
  return createJsonResponse(
    data ?? {
      updatedAt: new Date().toISOString(),
      keeps: [],
      events: [],
    }
  );
});

router.post("/admin/kv-test", async (_request, environment: Environment) => {
  const currentTimestamp = new Date().toISOString();
  await environment.WARMAP.put(
    "warmap",
    JSON.stringify({
      updatedAt: currentTimestamp,
      keeps: [],
      events: [],
    })
  );
  return new Response("ok");
});

router.post("/admin/update", async (_request, environment: Environment) => {
  try {
    const res = await fetch((environment as any).HERALD_WARMAP_URL, {
      headers: {
        "user-agent": "UthgardHeraldBot/1.0 (+contact)",
        "cache-control": "no-cache",
      },
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    if (!res.ok) {
      return createJsonResponse(
        { ok: false, error: `Herald ${res.status}` },
        502
      );
    }

    const html = await res.text();
    const payload = buildWarmapFromHtml(
      html,
      Number((environment as any).ATTACK_WINDOW_MIN ?? "7")
    );

    await environment.WARMAP.put("warmap", JSON.stringify(payload));
    return createJsonResponse({ ok: true, updatedAt: payload.updatedAt });
  } catch (err) {
    console.error("update error:", err);
    return createJsonResponse({ ok: false, error: "update failed" }, 500);
  }
});

router.all("*", () => new Response("Not found", { status: 404 }));

router.get("/", () => new Response("OK"));
router.get("/favicon.ico", () => new Response("", { status: 204 }));

export default {
  fetch: (
    request: Request,
    environment: Environment,
    context: ExecutionContext
  ) =>
    router.handle(request, environment, context).catch((err: unknown) => {
      console.error("Unhandled error:", err);
      return new Response("Internal Server Error", { status: 500 });
    }),
  scheduled: async (_event: ScheduledEvent, environment: Environment) => {
    const payload: WarmapData = {
      updatedAt: new Date().toISOString(),
      keeps: [],
      events: [],
    };
    await environment.WARMAP.put("warmap", JSON.stringify(payload));
  },
};
