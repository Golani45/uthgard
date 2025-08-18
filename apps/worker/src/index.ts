import { Router } from "itty-router";
import { parse } from "node-html-parser";

// Environment interface
interface Environment {
  WARMAP: KVNamespace;
  HERALD_WARMAP_URL: string;
  ATTACK_WINDOW_MIN?: string;
  DISCORD_WEBHOOK_URL?: string;
  DISCORD_WEBHOOK_URL_PLAYERS?: string; // player activity
  TRACKED_PLAYERS?: string; // ⬅️ stringified JSON
  ACTIVITY_SESSION_MIN?: string; // ⬅️ minutes to treat as one "session" (default 30)
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

function normRealm(r: string): Realm | null {
  const t = r.toLowerCase();
  if (t.startsWith("alb")) return "Albion";
  if (t.startsWith("mid")) return "Midgard";
  if (t.startsWith("hib")) return "Hibernia";
  return null;
}

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

function headerIsUnderAttack(node: any): boolean {
  const text = normText(node?.textContent ?? "");
  return /\bunder\s*attack\b/.test(text);
}
function hasUnderAttack(s: string) {
  return /\bunder\s*attack\b/.test(normText(s));
}

// ---- Tiny HTML RP extractor for Worker (no cheerio) ----
function parseRP(html: string): number | null {
  const m = html.match(
    /(Realmpoints|Realm\s*points)<\/t[dh]>\s*<t[dh][^>]*>\s*([\d.,\u00A0]+)/i
  );
  if (!m) return null;
  const raw = m[2].replace(/[.,\u00A0]/g, "");
  return Number(raw) || 0;
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

function packForHash(wm: WarmapData) {
  return JSON.stringify({
    keeps: wm.keeps,
    events: wm.events,
    dfOwner: wm.dfOwner,
  });
}

function headerHasUAImage(node: any): boolean {
  if (!node?.querySelector) return false;

  // Be strict: do NOT match plain "under" anywhere.
  // Only match clear UA banner / flame image patterns.
  const selector = [
    // explicit alt text
    'img[alt*="under attack" i]',
    // common filenames/patterns seen for UA banners
    'img[src*="under_attack"]',
    'img[src*="/ua"]',
    'img[src*="/ua."]',
    'img[src$="/ua.png"]',
    // safe generics (keep but no "under")
    'img[src*="attack"]',
    'img[src*="flame"]',
    'img[src*="onfire"]',
  ].join(", ");

  return !!node.querySelector(selector);
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

    const headerSaysUnderAttack =
      headerIsUnderAttack(headerCell) || headerHasUAImage(headerCell);

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
  console.log("event rows found:", rows.length);

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

// NEW: alert once per ownership change (rising edge)
async function alertOnOwnershipChanges(
  env: Environment,
  payload: WarmapData,
  prev: WarmapData | null
) {
  const prevOwnerById = new Map(prev?.keeps.map((k) => [k.id, k.owner]) ?? []);
  for (const k of payload.keeps) {
    const ownKey = `own:${k.id}`;
    const prevKV = await env.WARMAP.get(ownKey);
    const baseline = prevKV ?? prevOwnerById.get(k.id) ?? null;

    if (baseline == null) {
      await safePutIfChanged(env, ownKey, k.owner);
      continue;
    }
    if (baseline !== k.owner) {
      const ok = await notifyDiscordCapture(env, {
        keepName: k.name,
        newOwner: k.owner,
        at: payload.updatedAt,
      });
      if (ok) await safePutIfChanged(env, ownKey, k.owner);
    }
  }
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

  const key = `alert:under:${e.keepId}:${e.at}`;
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
    console.log(
      "discord error",
      resp.status,
      await resp.text().catch(() => "...")
    );
    return false;
  }

  await safePutIfChanged(env, key, "1", { expirationTtl: 6 * 60 * 60 });
  console.log("discord sent", e.keepId, e.keep.name, e.at);
  return true;
}

async function notifyDiscordCapture(
  env: Environment,
  ev: { keepName: string; newOwner: Realm; at: string }
) {
  const url = env.DISCORD_WEBHOOK_URL;
  if (!url) return false;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "Uthgard Herald",
      embeds: [
        {
          title: `🏰 ${ev.keepName} was captured by ${ev.newOwner}`,
          color: REALM_COLOR[ev.newOwner],
          timestamp: ev.at,
          footer: { text: "Uthgard Herald watch" },
        },
      ],
    }),
  });
  return resp.ok;
}

async function alertOnUnderAttackTransitions(
  env: Environment,
  payload: WarmapData
) {
  let sentHeader = 0,
    skippedHeader = 0,
    resetHeader = 0;

  const windowMin = Number(env.ATTACK_WINDOW_MIN ?? "7");
  const ttlSec = windowMin * 240; // UA state "on" TTL
  const suppressTtl = windowMin * 60; // rising-edge dedupe TTL

  for (const k of payload.keeps) {
    const prevKey = `ua:state:${k.id}`;
    const startKey = `alert:ua:start:${k.id}`;

    const prevRaw = await env.WARMAP.get(prevKey);
    const prev = !!(prevRaw && prevRaw !== "0");
    const curr = !!k.headerUnderAttack;

    if (curr && !prev) {
      // Rising edge
      const alreadyStarted = !!(await env.WARMAP.get(startKey));
      console.log("UA rise:", k.id, k.name, "startKey?", alreadyStarted);

      if (!alreadyStarted) {
        const ok = await notifyDiscord(env, {
          keepId: k.id,
          at: payload.updatedAt,
          keep: k,
        });
        if (ok) {
          await safePutIfChanged(env, startKey, String(Date.now()), {
            expirationTtl: suppressTtl,
          });
        }
      }

      // Mark UA state "on" (timestamp value, long TTL)
      await safePutIfChanged(env, prevKey, String(Date.now()), {
        expirationTtl: ttlSec,
      });
      sentHeader++;
    } else if (curr && prev) {
      // Still flaming. If we somehow missed the first alert, send it now.
      const alreadyStarted = !!(await env.WARMAP.get(startKey));
      console.log("UA still:", k.id, k.name, "startKey?", alreadyStarted);

      if (!alreadyStarted) {
        const ok = await notifyDiscord(env, {
          keepId: k.id,
          at: payload.updatedAt,
          keep: k,
        });
        if (ok) {
          await safePutIfChanged(env, startKey, String(Date.now()), {
            expirationTtl: suppressTtl,
          });
          sentHeader++;
        }
      } else {
        skippedHeader++; // no-op; don't spam KV by refreshing prevKey
      }
    } else if (!curr && prev) {
      // Falling edge
      console.log("UA fall:", k.id, k.name);
      await safePutIfChanged(env, prevKey, "0");
      resetHeader++;
    }
  }

  console.log(
    `header UA — sent:${sentHeader} skipped:${skippedHeader} reset:${resetHeader}`
  );

  // Fallback: UA events with no visible banner
  const byId = new Map(payload.keeps.map((k) => [k.id, k]));
  let considered = 0,
    deduped = 0,
    sent = 0,
    missing = 0;

  for (const ev of payload.events) {
    if (ev.kind !== "underAttack") continue;
    const k = byId.get(ev.keepId);
    if (!k) {
      missing++;
      continue;
    }
    if (k.headerUnderAttack) continue; // header path already handles

    considered++;
    const key = `alert:ua:nobanner:${ev.keepId}`;
    if (await env.WARMAP.get(key)) {
      deduped++;
      continue;
    }

    const ok = await notifyDiscord(env, {
      keepId: ev.keepId,
      at: ev.at,
      keep: k,
    });
    if (ok) {
      await safePutIfChanged(env, key, "1", { expirationTtl: suppressTtl });
      sent++;
    }
  }

  console.log(
    `fallback UA — considered:${considered} deduped:${deduped} missing:${missing} sent:${sent}`
  );
}

async function getOrUpdateWarmap(
  env: Environment,
  maxAgeMs = 30_000,
  silent = false
) {
  const existing = await env.WARMAP.get<WarmapData>("warmap", "json");
  if (existing) {
    const age = Date.now() - Date.parse(existing.updatedAt);
    if (!Number.isNaN(age) && age < maxAgeMs) return existing;
  }
  return await updateWarmap(env, { silent: true, store: false });
}

type Tracked = { id: string; name: string; realm: string; url: string };

// ---- Check tracked players every cron tick ----
async function checkTrackedPlayers(env: Environment) {
  if (!env.TRACKED_PLAYERS) return;

  let players: Tracked[];
  try {
    players = JSON.parse(env.TRACKED_PLAYERS);
  } catch {
    console.log("TRACKED_PLAYERS is not valid JSON");
    return;
  }

  const sessionMin = Number(env.ACTIVITY_SESSION_MIN ?? "30"); // default 30m

  for (const p of players) {
    try {
      const res = await fetch(p.url, {
        headers: {
          "user-agent": "uthgard-tools (+your site)",
          "cache-control": "no-cache",
        },
        cf: { cacheTtl: 0, cacheEverything: false },
      });
      if (!res.ok) {
        console.log("fetch failed", p.id, res.status);
        continue;
      }

      const html = await res.text();
      const rp = parseRP(html);
      if (rp == null) {
        console.log("no RP found", p.id);
        continue;
      }

      // KV keys
      const rpKey = `rp:${p.id}`; // last seen RP total
      const activeKey = `rp:active:${p.id}`; // set while in an "active session"

      const prevRaw = await env.WARMAP.get(rpKey);
      if (prevRaw == null) {
        // First ever baseline — store and move on (no alert)
        await env.WARMAP.put(rpKey, String(rp));
        continue;
      }

      const prev = Number(prevRaw);
      const increased = rp > prev;

      if (rp < prev) {
        await safePutIfChanged(env, rpKey, String(rp));
        await safeDelete(env, activeKey);
        continue;
      }

      if (increased) {
        // Have we already alerted for the current session?
        const isActive = await env.WARMAP.get(activeKey);

        if (!isActive) {
          const delta = rp - prev;
          await notifyDiscordPlayer(env, p, delta);
        }

        // Refresh the session window: as long as we keep seeing increases
        // within the TTL, no new "active" alert will fire.
        await env.WARMAP.put(activeKey, "1", {
          expirationTtl: sessionMin * 60, // seconds
        });
      }

      // Always update last seen RP
      await safePutIfChanged(env, rpKey, String(rp));
    } catch (e: any) {
      console.log("error for", p.id, String(e?.message ?? e));
    }

    // Be gentle with the Herald
    await new Promise((r) => setTimeout(r, 300));
  }
}

const router = Router();

router.get("/api/warmap.json", async (_req, env: Environment) => {
  try {
    const data = await getOrUpdateWarmap(env, 30_000, /* silent */ true);
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
    const payload = await updateWarmap(env, { silent: false, store: false });
    return createJsonResponse({ ok: true, updatedAt: payload.updatedAt });
  } catch (e: any) {
    return createJsonResponse(
      { ok: false, error: String(e?.message ?? e) },
      502
    );
  }
});

// === Add with the other routes ===
router.get("/admin/peek", async (_req, env: Environment) => {
  const wm = await env.WARMAP.get<WarmapData>("warmap", "json");
  if (!wm) return new Response("no warmap", { status: 404 });

  const headerUAs = wm.keeps.filter((k) => k.headerUnderAttack);
  const uaEvents = wm.events.filter((e) => e.kind === "underAttack");

  // did UA events match a keep id?
  const ids = new Set(wm.keeps.map((k) => k.id));
  const unmatched = uaEvents.filter((e) => !ids.has(e.keepId)).slice(0, 10);

  return createJsonResponse({
    updatedAt: wm.updatedAt,
    keeps: wm.keeps.length,
    headerUA_count: headerUAs.length,
    headerUA_names: headerUAs.map((k) => k.name),
    uaEvents_count: uaEvents.length,
    uaEvents_sample: uaEvents
      .slice(0, 5)
      .map((e) => ({ keepId: e.keepId, keep: e.keepName, at: e.at })),
    uaEvents_unmatched_sample: unmatched.map((e) => ({
      keepId: e.keepId,
      keep: e.keepName,
    })),
  });
});

// === DEBUG: why a flaming keep didn't alert ===
router.get("/admin/debug-ua", async (_req, env: Environment) => {
  const wm = await env.WARMAP.get<WarmapData>("warmap", "json");
  if (!wm) return new Response("no warmap", { status: 404 });

  const flaming = wm.keeps.filter((k) => k.headerUnderAttack);
  const rows = [];
  for (const k of flaming) {
    const prevKey = `ua:state:${k.id}`;
    const startKey = `alert:ua:start:${k.id}`;
    const prevVal = await env.WARMAP.get(prevKey);
    const startVal = await env.WARMAP.get(startKey);
    rows.push({
      id: k.id,
      name: k.name,
      headerUA: true,
      uaState_value: prevVal ?? null, // timestamp string or null
      uaStart_value: startVal ?? null, // timestamp string or null
    });
  }

  // also show a couple of last UA events we parsed
  const uaEvents = wm.events
    .filter((e) => e.kind === "underAttack")
    .slice(0, 5);
  return createJsonResponse({
    updatedAt: wm.updatedAt,
    flamingCount: flaming.length,
    flaming: rows,
    uaEvents_sample: uaEvents.map((e) => ({ keepId: e.keepId, at: e.at })),
  });
});

router.post("/admin/reset-ua", async (req, env: Environment) => {
  const url = new URL(req.url);
  const keepId = url.searchParams.get("keep");
  if (!keepId) return new Response("missing ?keep=<slug>", { status: 400 });
  await safePutIfChanged(env, `ua:state:${keepId}`, "0");
  await safeDelete(env, `alert:ua:nobanner:${keepId}`);
  return new Response(`reset ${keepId}`);
});

router.get("/", () => new Response("OK"));
router.get("/favicon.ico", () => new Response("", { status: 204 }));
router.all("*", () => new Response("Not found", { status: 404 }));

async function safePutIfChanged(
  env: Environment,
  key: string,
  value: string,
  opts?: { expirationTtl?: number }
) {
  try {
    const curr = await env.WARMAP.get(key);
    if (curr === value && !opts?.expirationTtl) return; // nothing to do
    await env.WARMAP.put(key, value, opts);
  } catch (e: any) {
    console.log("KV putIfChanged failed:", key, String(e?.message ?? e));
  }
}

async function notifyDiscordPlayer(
  env: Environment,
  p: { name: string; realm: string },
  delta: number
) {
  const url = env.DISCORD_WEBHOOK_URL_PLAYERS ?? env.DISCORD_WEBHOOK_URL;
  if (!url) {
    console.log("no webhook configured for player alerts");
    return;
  }
  const realm = normRealm(p.realm) ?? "Midgard";

  const color = REALM_COLOR[realm];
  const embed = {
    title: `🟢 ${p.name} is active`,
    description: `+${delta.toLocaleString()} RPs gained`,
    color,
    fields: [{ name: "Realm", value: realm, inline: true }],
    timestamp: new Date().toISOString(),
    footer: { text: "Poofter Saz Watch" },
  };

  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "Uthgard Herald", embeds: [embed] }),
  });
}

async function safePut(
  env: Environment,
  key: string,
  value: string,
  opts?: { expirationTtl?: number }
) {
  try {
    await env.WARMAP.put(key, value, opts);
  } catch (e: any) {
    console.log("KV put failed:", key, String(e?.message ?? e));
  }
}

async function safeDelete(env: Environment, key: string) {
  try {
    await env.WARMAP.delete(key);
  } catch (e: any) {
    console.log("KV delete failed:", key, String(e?.message ?? e));
  }
}

async function alertOnRecentCapturesFromEvents(
  env: Environment,
  payload: WarmapData
) {
  const now = Date.now();
  const WINDOW_MS = 10 * 60_000; // last 10 minutes
  for (const ev of payload.events) {
    if (ev.kind !== "captured") continue;
    const atMs = Date.parse(ev.at);
    if (Number.isNaN(atMs) || now - atMs > WINDOW_MS) continue;

    const key = `cap:event:${ev.keepId}:${ev.at}`;
    if (await env.WARMAP.get(key)) continue;

    const ok = await notifyDiscordCapture(env, {
      keepName: ev.keepName,
      newOwner: ev.newOwner!, // present for captured
      at: ev.at,
    });
    if (ok) {
      await safePutIfChanged(env, key, "1", { expirationTtl: 6 * 60 * 60 });
    }
  }
}

async function updateWarmap(
  env: Environment,
  opts?: { silent?: boolean; store?: boolean }
): Promise<WarmapData> {
  const prev = await env.WARMAP.get<WarmapData>("warmap", "json");

  const u = new URL(env.HERALD_WARMAP_URL);
  u.searchParams.set("_", String(Math.floor(Date.now() / 30_000)));

  const res = await fetch(u.toString(), {
    headers: {
      "user-agent": "UthgardHeraldBot/1.0",
      "cache-control": "no-cache",
      pragma: "no-cache",
    },
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  if (!res.ok) throw new Error(`Herald ${res.status}`);

  const html = await res.text();
  const payload = buildWarmapFromHtml(
    html,
    Number(env.ATTACK_WINDOW_MIN ?? "7")
  );

  // Only write when changed (and only if store !== false)
  if (opts?.store !== false) {
    const prevHash = prev ? packForHash(prev) : null;
    const nextHash = packForHash(payload);
    if (prevHash !== nextHash) {
      await safePutIfChanged(env, "warmap", JSON.stringify(payload));
    }
  }

  if (!opts?.silent) {
    await alertOnUnderAttackTransitions(env, payload);
    await alertOnOwnershipChanges(env, payload, prev ?? null);
    await alertOnRecentCapturesFromEvents(env, payload);
  }
  return payload;
}

export default {
  fetch: (req: Request, env: Environment, ctx: ExecutionContext) =>
    router.handle(req, env, ctx),

  // IMPORTANT: run warmap update first, and keep player checks from starving the tick
  scheduled: async (_event: any, env: Environment, ctx: ExecutionContext) => {
    try {
      // Run alerts first and await them so the cron definitely pushes Discord messages
      await updateWarmap(env, { silent: false });

      // Kick player checks into the background, but keep them lightweight per tick
      ctx.waitUntil(
        checkTrackedPlayers(env).catch((err) =>
          console.error("tracked players failed:", err)
        )
      );
    } catch (err) {
      console.error("cron update failed:", err);
    }
  },
};
