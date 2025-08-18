import { Router } from "itty-router";
import { parse } from "node-html-parser";

// Environment interface
interface Environment {
  WARMAP: KVNamespace;
  HERALD_WARMAP_URL: string;
  ATTACK_WINDOW_MIN?: string;
  DISCORD_WEBHOOK_URL?: string;
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

// Discord embed color per realm (integer, not hex string)
const REALM_COLOR: Record<Realm, number> = {
  Albion: 0xef4444, // red
  Midgard: 0x3b82f6, // blue
  Hibernia: 0x22c55e, // green
};

// Warmap types
interface WarmapData {
  updatedAt: string;
  keeps: Keep[];
  events: Event[];
  dfOwner: Realm;
}

type Realm = "Albion" | "Midgard" | "Hibernia";
type KeepType = "keep" | "relic";

interface Keep {
  id: string;
  name: string;
  type: KeepType;
  owner: Realm;
  underAttack: boolean;
  headerUnderAttack?: boolean;
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

function normText(s: string) {
  // replace NBSP and collapse spaces; drop punctuation that may appear in the banner
  return s
    .replace(/\u00A0/g, " ") // NBSP -> space
    .replace(/[()!?:]/g, "") // remove common punctuation
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

function hasUnderAttack(s: string) {
  return /\bunder\s+attack\b/.test(normText(s));
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

function parseDfOwner(doc: ReturnType<typeof parse>): Realm {
  // Be liberal: look for any image in the DF panel and infer by filename
  const img = doc.querySelector('img[src*="df"], img[alt*="Darkness Falls" i]');
  const src = img?.getAttribute("src")?.toLowerCase() ?? "";
  if (src.includes("alb")) return "Albion";
  if (src.includes("mid")) return "Midgard";
  if (src.includes("hib")) return "Hibernia";
  return "Midgard";
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

  const keeps: Keep[] = [];
  const keepDivs = doc.querySelectorAll("div.keepinfo");

  for (const div of keepDivs) {
    // --- name
    const name =
      div.querySelector("strong")?.text.trim() ||
      div.getAttribute("id")?.replace(/_/g, " ") ||
      "Unknown";

    // --- owner from CSS class
    const classes = (div.getAttribute("class") || "").toLowerCase();
    const realmKey =
      classes.match(/keepinfo_(alb|mid|hib|albion|midgard|hibernia)/)?.[1] ||
      "alb";
    const owner = ownerMap[realmKey] ?? "Albion";

    // --- level
    const levelText = div.querySelector("small")?.text ?? "";
    const levelMatch = levelText.match(/level\s+(\d+)/i);
    const level = levelMatch ? Number(levelMatch[1]) : null;

    // --- emblem URL
    const emblemSrc =
      div.querySelector('img[alt*="emblem" i]')?.getAttribute("src") ??
      div.querySelector('img[src*="emblem"]')?.getAttribute("src") ??
      null;
    const emblem = emblemSrc
      ? new URL(emblemSrc, "https://herald.uthgard.net/").toString()
      : null;

    // --- header cell text
    const headerCell = div.querySelector('td[align="center"]') ?? div;
    const rawHeader = (headerCell?.innerText ?? "").trim();

    // seed from header banner
    const headerSaysUnderAttack = hasUnderAttack(rawHeader);

    // scan lines for a guild, skipping name/level/emblem/under attack
    const lines = rawHeader
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    let claimedBy: string | null = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      const nline = normText(line);

      if (
        nline === normText(name) ||
        /level/.test(nline) ||
        /emblem/.test(nline) ||
        hasUnderAttack(line)
      ) {
        continue; // ignore non-guild lines
      }

      claimedBy = line.replace(/^claimed\s*by\s*:\s*/i, "").trim();
      break;
    }

    // safety: if we somehow captured the banner text, drop it
    if (claimedBy && hasUnderAttack(claimedBy)) claimedBy = null;

    keeps.push({
      id: slug(name),
      name,
      type: "keep",
      owner,
      underAttack: headerSaysUnderAttack, // seed
      headerUnderAttack: headerSaysUnderAttack, // NEW
      level,
      emblem,
      claimedBy,
      claimedAt: null,
    });
  }

  // quick lookup
  const byId = new Map(keeps.map((k) => [k.id, k]));

  // --- events table (your existing code) ---
  const events: WarmapData["events"] = [];
  const rows = doc.querySelectorAll("div.keepinfo table.TABLE tr");

  const bucketCounts = new Map<string, number>();
  for (const tr of rows) {
    const tds = tr.querySelectorAll("td");
    if (tds.length < 2) continue;

    const text = tds[0].text.replace(/\s+/g, " ").trim();
    const when = tds[tds.length - 1].text.trim();
    const at = relToIsoBucketed(when, bucketCounts);

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

  // apply under-attack window to set flames; OR with header flag
  const windowMs = attackWindowMin * 60_000;
  const now = Date.now();
  for (const event of events) {
    if (event.kind === "underAttack") {
      const keep: Keep | undefined = byId.get(event.keepId);
      if (keep && now - Date.parse(event.at) <= windowMs) {
        keep.underAttack = true; // ok to OR for the map
        keep.lastEvent = event.at;
      }
    }
  }

  events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return {
    updatedAt: new Date().toISOString(),
    keeps,
    dfOwner: parseDfOwner(doc),
    events: events.slice(0, 50),
  };
}

const EMBED_FOOTER = { text: "Uthgard Herald watch" };
// If you have a small square avatar to show on the webhook bot:
const WEBHOOK_USERNAME = "Uthgard Herald";
const WEBHOOK_AVATAR = ""; // e.g. https://your-cdn/avatar.png

// send once per unique event (keepId + timestamp)
// send once per unique event (keepId + timestamp)
// return true if Discord accepted the message
async function notifyDiscord(
  env: Environment,
  e: { keepId: string; at: string; keep: Keep }
): Promise<boolean> {
  const url = env.DISCORD_WEBHOOK_URL;
  if (!url) {
    console.log("discord: missing DISCORD_WEBHOOK_URL");
    return false;
  }

  const key = `alert:under:${e.keepId}:${e.at}`; // event-level dedupe
  if (await env.WARMAP.get(key)) {
    console.log("discord: event dedupe", key);
    return false;
  }

  const k = e.keep;
  const embed: any = {
    title: `⚔️ ${k.name} is under attack!`,
    color: REALM_COLOR[k.owner],
    fields: [
      { name: "Owner", value: k.owner, inline: true },
      { name: "Level", value: String(k.level ?? "—"), inline: true },
      { name: "Claimed by", value: k.claimedBy ?? "—", inline: true },
    ],
    timestamp: new Date(e.at).toISOString(),
    footer: { text: "Uthgard Herald watch" },
    ...(k.emblem ? { thumbnail: { url: k.emblem } } : {}),
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "Uthgard Herald", embeds: [embed] }),
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    console.log("discord: webhook failed", resp.status, t);
    return false;
  }

  // Discord returns 204 on success
  await env.WARMAP.put(key, "1", { expirationTtl: 6 * 60 * 60 });
  console.log("discord: webhook ok", resp.status, e.keepId, e.at);
  return true;
}

async function alertOnUnderAttackTransitions(
  env: Environment,
  payload: WarmapData
) {
  // 3a) Header-based: one alert per true->false transition
  for (const k of payload.keeps) {
    const prevKey = `ua:state:${k.id}`; // '1' while banner up, '0' otherwise
    const prev = (await env.WARMAP.get(prevKey)) === "1";
    const curr = !!k.headerUnderAttack; // <-- banner only

    if (curr && !prev) {
      const ok = await notifyDiscord(env, {
        keepId: k.id,
        at: payload.updatedAt,
        keep: k,
      });
      if (ok) await env.WARMAP.put(prevKey, "1"); // sticky while banner is up
    } else if (!curr && prev) {
      await env.WARMAP.put(prevKey, "0"); // banner went down, arm future alerts
    }
  }

  // 3b) Fallback: if a keep has NO banner but we do see a fresh “under attack” event,
  // send exactly once per event timestamp.
  const minuteNow = Math.floor(Date.parse(payload.updatedAt) / 60000);
  const byId = new Map(payload.keeps.map((k) => [k.id, k]));
  for (const ev of payload.events) {
    if (ev.kind !== "underAttack") continue;
    const k = byId.get(ev.keepId);
    if (!k) continue;
    if (k.headerUnderAttack) continue; // banner path already handled
    const dedupeKey = `alert:evt:${ev.keepId}:${ev.at}`;
    if (await env.WARMAP.get(dedupeKey)) continue;
    const ok = await notifyDiscord(env, {
      keepId: ev.keepId,
      at: ev.at,
      keep: k,
    });
    if (ok)
      await env.WARMAP.put(dedupeKey, "1", { expirationTtl: 24 * 60 * 60 });
  }
}

async function getOrUpdateWarmap(env: Environment, maxAgeMs = 30_000) {
  const existing = await env.WARMAP.get<WarmapData>("warmap", "json");
  if (existing) {
    const age = Date.now() - Date.parse(existing.updatedAt);
    if (!Number.isNaN(age) && age < maxAgeMs) return existing;
  }
  // Stale or missing → refresh now
  return await updateWarmap(env);
}

const router = Router();

router.get("/api/warmap.json", async (_req, env: Environment) => {
  try {
    const data = await getOrUpdateWarmap(env, 30_000);
    return createJsonResponse(data);
  } catch (e: any) {
    return createJsonResponse(
      { ok: false, error: String(e?.message ?? e) },
      502
    );
  }
});

router.get("/admin/test-hook", async (_req, env: Environment) => {
  const now = new Date().toISOString();
  await notifyDiscord(env, {
    keepId: "test-keep",
    at: now,
    keep: {
      id: "test-keep",
      name: "Test Keep",
      type: "keep",
      owner: "Midgard",
      underAttack: true,
      level: 10,
      claimedBy: "Test Guild",
      claimedAt: null,
      emblem: null,
    },
  });
  return new Response("sent");
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

router.post("/admin/update", async (_req, env: Environment) => {
  try {
    const payload = await updateWarmap(env);
    return createJsonResponse({ ok: true, updatedAt: payload.updatedAt });
  } catch (e: any) {
    return createJsonResponse(
      { ok: false, error: String(e?.message ?? e) },
      502
    );
  }
});

router.all("*", () => new Response("Not found", { status: 404 }));

router.get("/", () => new Response("OK"));
router.get("/favicon.ico", () => new Response("", { status: 204 }));

async function alertUnderAttacks(
  env: Environment,
  payload: WarmapData,
  windowMin: number
) {
  const windowMs = windowMin * 60_000;
  const now = Date.now();

  // quick lookup
  const byId = new Map(payload.keeps.map((k) => [k.id, k]));

  // 1) Event-based alerts (what you already had)
  const alertedFromEvent = new Set<string>();
  for (const e of payload.events) {
    if (e.kind !== "underAttack") continue;
    if (now - Date.parse(e.at) > windowMs) continue;

    const k = byId.get(e.keepId);
    if (!k) continue;

    await notifyDiscord(env, { keepId: e.keepId, at: e.at, keep: k });
    alertedFromEvent.add(e.keepId);
  }

  // 2) Header-only alerts (no recent event row)
  for (const k of payload.keeps) {
    if (!k.underAttack) continue;
    if (alertedFromEvent.has(k.id)) continue;

    // (Optional) minute bucket so re-alerts can happen if it stays on fire a long time
    const minuteBucket = Math.floor(Date.parse(payload.updatedAt) / 60000);
    const headerKey = `alert:under:header:${k.id}:${minuteBucket}`;

    if (await env.WARMAP.get(headerKey)) {
      console.log("header dedupe", headerKey);
      continue;
    }

    const sent = await notifyDiscord(env, {
      keepId: k.id,
      at: payload.updatedAt,
      keep: k,
    });

    if (sent) {
      await env.WARMAP.put(headerKey, "1", {
        expirationTtl: Number(env.ATTACK_WINDOW_MIN ?? "7") * 60,
      });
    }
  }
}

async function updateWarmap(env: Environment): Promise<WarmapData> {
  const res = await fetch(env.HERALD_WARMAP_URL as string, {
    headers: {
      "user-agent": "UthgardHeraldBot/1.0 (+contact)",
      "cache-control": "no-cache",
    },
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  if (!res.ok) throw new Error(`Herald ${res.status}`);

  const html = await res.text();
  const windowMin = Number(env.ATTACK_WINDOW_MIN ?? "7");

  // buildWarmapFromHtml already sets k.underAttack from header OR recent event window
  const payload = buildWarmapFromHtml(html, windowMin);

  // 🔔 only on state transitions
  await alertOnUnderAttackTransitions(env, payload);

  await env.WARMAP.put("warmap", JSON.stringify(payload));
  return payload;
}

export default {
  fetch: (req: Request, env: Environment, ctx: ExecutionContext) =>
    router.handle(req, env, ctx),

  // BEFORE:
  // scheduled: async (_evt: ScheduledEvent, env: Environment) => {
  //   try { await updateWarmap(env); } catch (e) { ... }
  // },

  // AFTER:
  scheduled: (
    event: ScheduledEvent,
    env: Environment,
    ctx: ExecutionContext
  ) => {
    ctx.waitUntil(
      (async () => {
        try {
          console.log("cron tick", new Date().toISOString());
          await updateWarmap(env);
        } catch (err) {
          console.error("cron update failed:", err);
        }
      })()
    );
  },
};
