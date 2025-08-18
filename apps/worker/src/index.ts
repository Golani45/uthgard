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

function headerIsUnderAttack(node: any) {
  const txt = normText(node.innerText ?? "");
  if (/\bunder\s*attack\b/.test(txt)) return true;
  // also accept image-based banners
  const img = node.querySelector?.(
    'img[src*="attack"], img[src*="flame"], img[alt*="attack" i]'
  );
  return !!img;
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
    const headerSaysUnderAttack = headerIsUnderAttack(headerCell);

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
  const rows = doc.querySelectorAll("table.TABLE tr");

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
async function alertOnOwnershipChanges(env: Environment, payload: WarmapData) {
  for (const k of payload.keeps) {
    const ownKey = `own:${k.id}`; // last owner we recorded
    const prev = await env.WARMAP.get(ownKey);

    if (!prev) {
      // first time seeing this keep
      await env.WARMAP.put(ownKey, k.owner);
      continue;
    }

    if (prev !== k.owner) {
      // owner actually changed
      const ok = await notifyDiscordCapture(env, {
        keepName: k.name,
        newOwner: k.owner,
        at: payload.updatedAt,
      });
      if (ok) {
        await env.WARMAP.put(ownKey, k.owner);
        // OPTIONAL tiny rate-limit if keeps flip-flop:
        // await env.WARMAP.put(`own:rl:${k.id}`, "1", { expirationTtl: 120 });
      }
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
  // 1) Header-based rising edge
  for (const k of payload.keeps) {
    const prevKey = `ua:state:${k.id}`;
    const prev = (await env.WARMAP.get(prevKey)) === "1";
    const curr = !!k.headerUnderAttack;
    if (curr && !prev) {
      const ok = await notifyDiscord(env, {
        keepId: k.id,
        at: payload.updatedAt,
        keep: k,
      });
      if (ok) await env.WARMAP.put(prevKey, "1");
    } else if (!curr && prev) {
      await env.WARMAP.put(prevKey, "0");
    }
  }

  // 2) Fallback: event rows when there is NO banner
  const windowMin = Number(env.ATTACK_WINDOW_MIN ?? "7");
  const suppressTtl = windowMin * 60; // seconds
  const byId = new Map(payload.keeps.map((k) => [k.id, k]));

  for (const ev of payload.events) {
    if (ev.kind !== "underAttack") continue;
    const k = byId.get(ev.keepId);
    if (!k || k.headerUnderAttack) continue; // banner path already handled

    // single alert per keep while it's "under attack" without a banner
    const key = `alert:ua:nobanner:${ev.keepId}`;
    if (await env.WARMAP.get(key)) continue;

    const ok = await notifyDiscord(env, {
      keepId: ev.keepId,
      at: ev.at,
      keep: k,
    });
    if (ok) await env.WARMAP.put(key, "1", { expirationTtl: suppressTtl });
  }
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
  return await updateWarmap(env, { silent });
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
        await env.WARMAP.put(rpKey, String(rp));
        await env.WARMAP.delete(activeKey);
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
      await env.WARMAP.put(rpKey, String(rp));
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
    const payload = await updateWarmap(env, { silent: false });
    return createJsonResponse({ ok: true, updatedAt: payload.updatedAt });
  } catch (e: any) {
    return createJsonResponse(
      { ok: false, error: String(e?.message ?? e) },
      502
    );
  }
});

router.get("/", () => new Response("OK"));
router.get("/favicon.ico", () => new Response("", { status: 204 }));
router.all("*", () => new Response("Not found", { status: 404 }));

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

async function updateWarmap(
  env: Environment,
  opts?: { silent?: boolean }
): Promise<WarmapData> {
  const res = await fetch(env.HERALD_WARMAP_URL, {
    headers: {
      "user-agent": "UthgardHeraldBot/1.0 (+contact)",
      "cache-control": "no-cache",
    },
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  if (!res.ok) throw new Error(`Herald ${res.status}`);

  const html = await res.text();
  const windowMin = Number(env.ATTACK_WINDOW_MIN ?? "7");
  const payload = buildWarmapFromHtml(html, windowMin);

  if (!opts?.silent) {
    await alertOnUnderAttackTransitions(env, payload); // your existing rising-edge logic
    await alertOnOwnershipChanges(env, payload); // <-- new stable capture alerts
  }

  await env.WARMAP.put("warmap", JSON.stringify(payload));
  return payload;
}

export default {
  fetch: (req: Request, env: Environment, ctx: ExecutionContext) =>
    router.handle(req, env, ctx),

  scheduled: (_event: any, env: Environment, ctx: ExecutionContext) => {
    ctx.waitUntil(
      updateWarmap(env, { silent: false }).catch((err) =>
        console.error("cron update failed:", err)
      )
    );
    ctx.waitUntil(
      checkTrackedPlayers(env).catch((err) =>
        console.error("tracked players failed:", err)
      )
    );
  },
};
