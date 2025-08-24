import { Router } from "itty-router";
import { parse } from "node-html-parser";

// Environment interface
interface Environment {
  WARMAP: KVNamespace;
  HERALD_WARMAP_URL: string;
  ATTACK_WINDOW_MIN?: string;
  DISCORD_WEBHOOK_URL?: string;
  DISCORD_WEBHOOK_URL_PLAYERS?: string; // player activity
  DISCORD_WEBHOOK_CAPTURE?: string; // capture activity
  TRACKED_PLAYERS?: string; // ⬅️ stringified JSON
  ACTIVITY_SESSION_MIN?: string; // ⬅️ minutes to treat as one "session" (default 30)
  CAPTURE_WINDOW_MIN?: string; // how recent a "captured" can be to alert (default 12)

  ACTIVITY_BIG_DELTA?: string; // default 500 if unset
  ACTIVITY_REPING_MIN?: string; // default 10 if unset
  STRICT_DELIVERY?: string
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
  leader?: string;
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

const UA_SUPPRESS_AFTER_CAPTURE_SEC = 120;

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

function parseRP(html: string): number | null {
  const doc = parse(html);
  // find a row whose first cell says Realmpoints (case/space tolerant)
  for (const tr of doc.querySelectorAll("tr")) {
    const cells = tr.querySelectorAll("td,th");
    if (cells.length < 2) continue;
    const left = (cells[0].textContent || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    if (!/realm\s*points|realmpoints/.test(left)) continue;

    const raw = (cells[1].textContent || "").replace(/[^\d]/g, "");
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
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

function captureWindowMs(env: Environment) {
  const min = Number(env.CAPTURE_WINDOW_MIN ?? "12"); // pick your default
  return Math.max(1, min) * 60_000;
}

function parseDfOwner(doc: ReturnType<typeof parse>): Realm {
  // Be liberal: look for any image in the DF panel and infer by filename.
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

  // Be strict: do NOT match plain "under" anywhere
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
    'img[src*="flame"]',
    'img[src*="onfire"]',
  ].join(", ");

  return !!node.querySelector(selector);
}

// --- Discord rate-limit gate ---
const RL_KEY = "discord:cooldown_until"; // ISO timestamp

// --- feature flag: strict delivery (env or KV override) ---
async function getStrictDelivery(env: Environment): Promise<boolean> {
  const kvOverride = await env.WARMAP.get("flags:strict_delivery"); // "1" or "0"
  const v = (kvOverride ?? String(env.STRICT_DELIVERY ?? "0")).trim();
  return v === "1";
}

async function discordCooldownActive(
  env: Environment,
  url: string
): Promise<boolean> {
  const key = cooldownKeyFor(url);
  const until = await env.WARMAP.get(key);
  return until ? Date.now() < Date.parse(until) : false;
}

async function setDiscordCooldown(env: Environment, url: string, secs: number) {
  const key = cooldownKeyFor(url);
  const until = new Date(Date.now() + secs * 1000).toISOString();
  await env.WARMAP.put(key, until, { expirationTtl: Math.ceil(secs) + 1 });
}

function capSeenKey(keepId: string, owner: Realm) {
  return `cap:seen:${keepId}:${owner}`;
}

async function hasAlertedCapture(
  env: Environment,
  keepId: string,
  owner: Realm
) {
  return !!(await env.WARMAP.get(capSeenKey(keepId, owner)));
}
async function markCaptureAlerted(
  env: Environment,
  keepId: string,
  owner: Realm
) {
  await safePutIfChanged(env, capSeenKey(keepId, owner), "1", {
    expirationTtl: CAP_ONCE_TTL_SEC,
  });
}
function parseRetryAfter(resp: Response): number {
  const ra =
    resp.headers.get("Retry-After") ??
    resp.headers.get("X-RateLimit-Reset-After");
  const n = Number(ra);
  // If Discord/CF omit headers, back off a safe 10s; if CF 1015, they usually send a big number.
  return Number.isFinite(n) && n > 0 ? n : 10;
}

async function noteCooldownSkip(env: Environment, url: string) {
  const k = `${cooldownKeyFor(url)}:skip:${Date.now()}`;
  await env.WARMAP.put(k, "1", { expirationTtl: 3600 }); // 1h
}

async function note429(env: Environment, url: string, secs: number) {
  const k = `discord:429:${cooldownKeyFor(url)}:${Date.now()}`;
  await env.WARMAP.put(k, String(secs), { expirationTtl: 3600 }); // 1h
}

async function postToDiscord(
  env: Environment,
  url: string,
  body: any
): Promise<boolean> {
  if (!url) {
    console.log("discord: missing webhook url");
    return false;
  }

  // Skip sends while we're in cooldown from a previous 429
  if (await discordCooldownActive(env, url)) {
    console.log("discord: cooldown active for", cooldownKeyFor(url));
      await noteCooldownSkip(env, url);  
    return false;
  }

  // Gentle pacing across ALL sends to this webhook URL
  await enforceWebhookPacing(env, url);

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "uthgard-herald-worker",
    },
    body: JSON.stringify(body),
  });

  if (resp.status === 429) {
    const secs = parseRetryAfter(resp);
    await setDiscordCooldown(env, url, secs);
     await note429(env, url, secs); 
    const txt = await resp.text().catch(() => "");
    console.log(
      "discord 429, backing off secs:",
      secs,
      "code:",
      txt.slice(0, 64)
    );
    return false;
  }

  if (!resp.ok) {
    console.log(
      "discord error",
      resp.status,
      await resp.text().catch(() => "...")
    );
    return false;
  }

  // Only record a successful send as the last-send time
  await noteWebhookSent(env, url);
  return true;
}

// --- helpers for sims ---
function mkKeepPartial(id: string, name: string, owner: Realm): Keep {
  return {
    id,
    name,
    type: "keep",
    owner,
    underAttack: false,
    headerUnderAttack: false,
    level: null,
    claimedBy: null,
    claimedAt: null,
    emblem: null,
  };
}
function nowIso() {
  return new Date().toISOString();
}

function capDedupKey(keepId: string, newOwner: Realm, atIso: string) {
  // minute-bucket to tolerate timing diffs between paths
  const bucket = new Date(atIso);
  bucket.setSeconds(0, 0);
  return `cap:any:${keepId}:${newOwner}:${bucket.toISOString()}`;
}

// --- Discord rate-limit gate (per webhook) ---
function cooldownKeyFor(url: string) {
  // stable key per webhook URL (strip query)
  try {
    const u = new URL(url);
    return `discord:cooldown:${u.pathname}`; // path uniquely identifies the webhook
  } catch {
    return `discord:cooldown:${url.slice(-16)}`;
  }
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
      /^(.+?) (?:has been|was)\s+captured by (?:the\s+forces\s+of\s+)?(Albion|Midgard|Hibernia)(?:\s+led\s+by\s+(.+))?/i
    );
    if (m) {
      const keepName = m[1].trim();
      const newOwner = m[2] as Realm;
      const leader = m[3]?.trim() ?? null;
      events.push({
        at,
        kind: "captured",
        keepId: slug(keepName),
        keepName,
        newOwner,
        raw: text,
        ...(leader ? { leader } : {}),
      } as Event & { leader?: string });
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
    events: events.slice(0, 200),
  };
}

// NEW: alert once per ownership change (rising edge) with recency guard + leader passthrough
// --- alert when ownership flips (rising edge), with Fix A once-per keep+owner gate
// --- alert when ownership flips (rising edge), with transition-scoped once gate
// --- alert when ownership flips (rising edge), with unified dedupe + baseline advance
// --- alert when ownership flips (rising edge), STRICT_DELIVERY gating
async function alertOnOwnershipChanges(
  env: Environment,
  payload: WarmapData,
  prev: WarmapData | null
) {
const STRICT_DELIVERY = await getStrictDelivery(env);


  // index the most recent "captured" event by keep
  const recentCapturedByKeep = new Map<string, Event>();
  for (const e of payload.events) {
    if (e.kind !== "captured") continue;
    const prior = recentCapturedByKeep.get(e.keepId);
    if (!prior || Date.parse(e.at) > Date.parse(prior.at)) {
      recentCapturedByKeep.set(e.keepId, e);
    }
  }


  // fall back to previous snapshot's owners if we don't have a KV baseline yet
  const prevOwnerById = new Map(prev?.keeps.map((k) => [k.id, k.owner]) ?? []);

  // helper to apply baseline + post-capture UA state changes
  async function applyPostCaptureStateAndBaseline(
    keepId: string,
    newOwner: Realm
  ) {
    await Promise.all([
      safePut(env, `own:${keepId}`, newOwner), // advance baseline
      safeDelete(env, `alert:ua:start:${keepId}`),
      safePutIfChanged(env, `ua:state:${keepId}`, "0"),
      safePutIfChanged(env, `ua:suppress:${keepId}`, "1", {
        expirationTtl: UA_SUPPRESS_AFTER_CAPTURE_SEC,
      }),
    ]);
  }

  for (const k of payload.keeps) {
    const ownKey = `own:${k.id}`;
    const prevKV = await env.WARMAP.get(ownKey);
    const baseline = (prevKV ?? prevOwnerById.get(k.id)) as Realm | null;

    // first sighting — seed baseline and move on
    if (baseline == null) {
      await safePut(env, ownKey, k.owner);
      continue;
    }

    // no change
    if (baseline === k.owner) continue;

    // require a fresh captured event within the capture window
    const CAP_WINDOW_MS = captureWindowMs(env);
    const ev = recentCapturedByKeep.get(k.id);
    const evFresh = !!ev && Date.now() - Date.parse(ev.at) <= CAP_WINDOW_MS;
    if (!evFresh) {
      // We saw owner flipped but don't have a fresh event—advance baseline quietly.
      await safePut(env, ownKey, k.owner);
      continue;
    }

    // transition-scoped once key (baseline -> current owner)
    const transitionOnceKey = capOnceTransitionKey(k.id, baseline, k.owner);
    if (await env.WARMAP.get(transitionOnceKey)) {
      await safePut(env, ownKey, k.owner);
      continue;
    }

    // PRE-FLIGHT: honor events-path dedupe too (shared keys)
    const onceKey = capOnceKey(k.id, k.owner); // once-per new owner
    if (await env.WARMAP.get(onceKey)) {
      await safePut(env, ownKey, k.owner);
      continue;
    }

    const kAny = capDedupKey(k.id, k.owner, ev.at); // minute bucket
    if (await env.WARMAP.get(kAny)) {
      await safePut(env, ownKey, k.owner);
      continue;
    }

    if (await hasAlertedCapture(env, k.id, k.owner)) {
      await safePut(env, ownKey, k.owner);
      continue;
    }

    // local transition dedupe (short TTL)
    const transition = `${baseline}->${k.owner}`;
    const dedupeKey = `cap:${k.id}:${transition}`;
    if (await env.WARMAP.get(dedupeKey)) {
      await safePut(env, ownKey, k.owner);
      continue;
    }

    // send capture
    const ok = await notifyDiscordCapture(env, {
      keepName: k.name,
      newOwner: k.owner,
      at: ev.at,
      leader: (ev as any).leader,
    });

    // If sent, stamp shared dedupe keys (only on success)
    if (ok) {
      await Promise.all([
        markCaptureAlerted(env, k.id, k.owner), // cap:seen
        safePutIfChanged(env, kAny, "1", { expirationTtl: 6 * 60 * 60 }),
        safePutIfChanged(env, onceKey, "1", { expirationTtl: CAP_ONCE_TTL_SEC }),
        safePutIfChanged(env, transitionOnceKey, "1", {
          expirationTtl: CAP_ONCE_TTL_SEC,
        }),
        safePut(env, dedupeKey, "1", { expirationTtl: 900 }),
      ]);
    }

    // Baseline + UA state moves:
    // - STRICT_DELIVERY=1 -> only if ok (so we retry next tick if send failed/cooldown)
    // - default (0)       -> always (previous behavior)
    if (ok || !STRICT_DELIVERY) {
      await applyPostCaptureStateAndBaseline(k.id, k.owner);
    }
  }
}


function capOnceTransitionKey(
  keepId: string,
  prevOwner: Realm,
  newOwner: Realm
) {
  return `cap:once:${keepId}:${prevOwner}->${newOwner}`;
}

function capOnceKey(keepId: string, newOwner: Realm) {
  return `cap:once:${keepId}:${newOwner}`;
}
const CAP_ONCE_TTL_SEC = 20 * 60; // 20 minutes

const EMBED_FOOTER = { text: "Uthgard Herald watch" };
// If you have a small square avatar to show on the webhook bot:
const WEBHOOK_USERNAME = "Uthgard Herald";
const WEBHOOK_AVATAR = ""; // e.g. https://your-cdn/avatar.png

//flame
async function notifyDiscord(
  env: Environment,
  e: { keepId: string; at: string; keep: Keep }
): Promise<boolean> {
  const url = env.DISCORD_WEBHOOK_URL; // UA/capture webhook
  const key = `alert:under:${e.keepId}:${e.at}`;
  if (await env.WARMAP.get(key)) return false;

  const k = e.keep;
  const embed = {
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

  const ok = await postToDiscord(env, url!, {
    username: "Uthgard Herald",
    embeds: [embed],
  });
  if (ok) await safePutIfChanged(env, key, "1", { expirationTtl: 6 * 60 * 60 });
  return ok;
}

//keep capture
async function notifyDiscordCapture(
  env: Environment,
  ev: { keepName: string; newOwner: Realm; at: string; leader?: string }
) {
  const url = env.DISCORD_WEBHOOK_CAPTURE;
  const leaderSuffix = ev.leader ? ` — led by ${ev.leader}` : "";
  const embed = {
    title: `🏰 ${ev.keepName} was captured by ${ev.newOwner}${leaderSuffix}`,
    color: REALM_COLOR[ev.newOwner],
    timestamp: ev.at,
    footer: { text: "Uthgard Herald watch" },
  };
  return await postToDiscord(env, url!, {
    username: "Uthgard Herald",
    embeds: [embed],
  });
}

//player
async function notifyDiscordPlayer(
  env: Environment,
  p: { name: string; realm: string },
  delta: number
): Promise<boolean> {
  const url = env.DISCORD_WEBHOOK_URL_PLAYERS ?? env.DISCORD_WEBHOOK_URL;
  if (!url) {
    console.log("no webhook configured for player alerts");
    return false;
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

  return await postToDiscord(env, url, {
    username: "Uthgard Herald",
    embeds: [embed],
  });
}

async function alertOnUnderAttackTransitions(
  env: Environment,
  payload: WarmapData
) {
  let sentHeader = 0,
    skippedHeader = 0,
    resetHeader = 0;

  const windowMin = Number(env.ATTACK_WINDOW_MIN ?? "7");
  const ttlSec = windowMin * 240; // UA “on” TTL — long enough for a siege
  const suppressTtl = windowMin * 60; // per-window dedupe for fallback

  type BatchItem = {
    embed: any;
    onOk: () => Promise<void>;
    kind: "header" | "fallback";
  };
  const batch: BatchItem[] = [];

  // ---------- HEADER PATH (primary & reliable) ----------
  for (const k of payload.keeps) {
    const prevKey = `ua:state:${k.id}`; // “on” state (timestamp or "0")
    const sessionKey = `alert:ua:start:${k.id}`; // one-per-siege
    const dedupeKey = `alert:under:${k.id}:${payload.updatedAt}`;

    const prevRaw = await env.WARMAP.get(prevKey);
    const prev = !!(prevRaw && prevRaw !== "0");
    const curr = !!k.headerUnderAttack;
    const hasSession = !!(await env.WARMAP.get(sessionKey));

    // --- NEW: short post-capture UA suppressor ---
    const suppressKey = `ua:suppress:${k.id}`;
    const isSuppressed = !!(await env.WARMAP.get(suppressKey));
    if (isSuppressed) {
      // Make sure we don't resurrect sessions during suppression
      await safePutIfChanged(env, prevKey, "0");
      await safeDelete(env, sessionKey);
      // Skip any UA send for this keep this tick
      continue;
    }

    // Rising edge
    if (curr && !prev) {
      if (!hasSession && !(await env.WARMAP.get(dedupeKey))) {
        const embed = {
          title: `⚔️ ${k.name} is under attack!`,
          color: REALM_COLOR[k.owner],
          fields: [
            { name: "Owner", value: k.owner, inline: true },
            { name: "Level", value: String(k.level ?? "—"), inline: true },
            { name: "Claimed by", value: k.claimedBy ?? "—", inline: true },
          ],
          timestamp: new Date(payload.updatedAt).toISOString(),
          footer: { text: "Uthgard Herald watch" },
          ...(k.emblem ? { thumbnail: { url: k.emblem } } : {}),
        };

        batch.push({
          embed,
          kind: "header",
          onOk: async () => {
            // begin siege session & per-payload dedupe
            await safePutIfChanged(env, sessionKey, "1", {
              expirationTtl: ttlSec,
            });
            await safePutIfChanged(env, dedupeKey, "1", {
              expirationTtl: 6 * 60 * 60,
            });

            // mark UA “on”
            await safePutIfChanged(env, prevKey, String(Date.now()), {
              expirationTtl: ttlSec,
            });
            sentHeader++;
          },
        });
      } else {
        // no send, but ensure UA state is “on”
        await safePutIfChanged(env, prevKey, String(Date.now()), {
          expirationTtl: ttlSec,
        });
        skippedHeader++;
      }
    }
    // Still flaming — don’t resend, just keep TTL fresh
    else if (curr && prev) {
      await safePutIfChanged(env, prevKey, String(Date.now()), {
        expirationTtl: ttlSec,
      });
      if (hasSession) {
        await safePutIfChanged(env, sessionKey, "1", { expirationTtl: ttlSec });
      }
      skippedHeader++;
    }
    // Flame went out — clear state and end session
    else if (!curr && prev) {
      await safePutIfChanged(env, prevKey, "0");
      await safeDelete(env, sessionKey);
      // optional: also clear any old header throttle if you ever used it
      await safeDelete(env, `alert:ua:header:${k.id}`);
      resetHeader++;
    }
  }

  // ---------- FALLBACK PATH (events table when no banner) ----------
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

    // If header is flaming, header path governs sessioning
    if (k.headerUnderAttack) continue;

    // --- NEW: suppressor also applies to fallback path ---
    if (await env.WARMAP.get(`ua:suppress:${k.id}`)) {
      continue;
    }

    considered++;

    const nobannerKey = `alert:ua:nobanner:${ev.keepId}`;
    const dedupeKey = `alert:under:${ev.keepId}:${ev.at}`;
    if (await env.WARMAP.get(nobannerKey)) {
      deduped++;
      continue;
    }
    if (await env.WARMAP.get(dedupeKey)) {
      deduped++;
      continue;
    }

    const embed = {
      title: `⚔️ ${k.name} is under attack!`,
      color: REALM_COLOR[k.owner],
      fields: [
        { name: "Owner", value: k.owner, inline: true },
        { name: "Level", value: String(k.level ?? "—"), inline: true },
        { name: "Claimed by", value: k.claimedBy ?? "—", inline: true },
      ],
      timestamp: new Date(ev.at).toISOString(),
      footer: { text: "Uthgard Herald watch" },
      ...(k.emblem ? { thumbnail: { url: k.emblem } } : {}),
    };

    batch.push({
      embed,
      kind: "fallback",
      onOk: async () => {
        await safePutIfChanged(env, nobannerKey, "1", {
          expirationTtl: suppressTtl,
        });
        await safePutIfChanged(env, dedupeKey, "1", {
          expirationTtl: 6 * 60 * 60,
        });

        // Mark a siege session so header & fallback behave as one
        await safePutIfChanged(env, `alert:ua:start:${ev.keepId}`, "1", {
          expirationTtl: ttlSec,
        });

        // Also mark UA “on” so subsequent ticks treat it as flaming even if the next event is late
        await safePutIfChanged(
          env,
          `ua:state:${ev.keepId}`,
          String(Date.now()),
          { expirationTtl: ttlSec }
        );

        sent++;
      },
    });
  }

  // ---------- send ----------
  if (batch.length > 0 && env.DISCORD_WEBHOOK_URL) {
    for (let i = 0; i < batch.length; i += 10) {
      const slice = batch.slice(i, i + 10);
      const embeds = slice.map((b) => b.embed);
      const ok = await postToDiscord(env, env.DISCORD_WEBHOOK_URL, {
        username: "Uthgard Herald",
        embeds,
      });
      if (ok) await Promise.all(slice.map((b) => b.onOk()));
    }
  }

  console.log(
    `header UA — sent:${sentHeader} skipped:${skippedHeader} reset:${resetHeader}`
  );
  console.log(
    `fallback UA — considered:${considered} deduped:${deduped} missing:${missing} sent:${sent}`
  );
}

const WEBHOOK_MIN_INTERVAL_MS = 2200; // ~40/min max, under Discord’s 30/min effective cap

function lastSendKeyFor(url: string) {
  return `discord:last:${cooldownKeyFor(url)}`;
}

async function enforceWebhookPacing(
  env: Environment,
  url: string,
  minMs = WEBHOOK_MIN_INTERVAL_MS
) {
  const k = lastSendKeyFor(url);
  const lastRaw = await env.WARMAP.get(k);
  const last = lastRaw ? Number(lastRaw) : 0;
  const now = Date.now();
  const wait = last ? minMs - (now - last) : 0;
  if (wait > 0) {
    await new Promise((r) => setTimeout(r, wait));
  }
}

async function noteWebhookSent(env: Environment, url: string) {
  await env.WARMAP.put(lastSendKeyFor(url), String(Date.now()), {
    expirationTtl: 60 * 60,
  }); // keep for an hour
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
// expects: notifyDiscordPlayer(...) -> Promise<boolean>
async function checkTrackedPlayers(env: Environment, onlyId?: string) {
  if (!env.TRACKED_PLAYERS) return;

  let players: Tracked[];
  try {
    players = JSON.parse(env.TRACKED_PLAYERS);
  } catch {
    console.log("TRACKED_PLAYERS is not valid JSON");
    return;
  }

  const sessionMin = Number(env.ACTIVITY_SESSION_MIN ?? "30"); // main cooldown
  const bigDelta = Number(env.ACTIVITY_BIG_DELTA ?? "500"); // bypass threshold
  const repingMin = Number(env.ACTIVITY_REPING_MIN ?? "10"); // heartbeat window
  const REPING_MS = Math.max(1, repingMin) * 60_000;

  for (const p of players) {
    if (onlyId && p.id !== onlyId) continue;

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
      const rp = parseRP(html); // lifetime RP
      if (rp == null) {
        console.log("no RP found", p.id);
        continue;
      }

      const rpKey = `rp:${p.id}`; // baseline total RP
      const activeKey = `rp:active:${p.id}`; // “in session” flag
      const lastKey = `rp:last:${p.id}`; // last time we actually pinged

      const prevRaw = await env.WARMAP.get(rpKey);

      if (prevRaw == null) {
        // first sighting — store baseline, no alert
        await safePutIfChanged(env, rpKey, String(rp));
      } else {
        const prev = Number(prevRaw);

        if (!Number.isFinite(prev)) {
          // corrupted baseline, reset it
          await safePutIfChanged(env, rpKey, String(rp));
          await safeDelete(env, activeKey);
          await safeDelete(env, lastKey);
        } else if (rp < prev) {
          // rollover/reset: drop session and reset baseline
          await safePutIfChanged(env, rpKey, String(rp));
          await safeDelete(env, activeKey);
          await safeDelete(env, lastKey);
        } else if (rp > prev) {
          // gained RPs since last tick
          const delta = rp - prev;
          const isActive = !!(await env.WARMAP.get(activeKey));
          const lastRaw = await env.WARMAP.get(lastKey);
          const lastTs = lastRaw ? Number(lastRaw) : 0;
          const canReping = !lastTs || Date.now() - lastTs > REPING_MS;

          // notify if:
          //   - no active session yet, OR
          //   - the gain is big enough, OR
          //   - we're past the heartbeat window (reping) while gains continue
          if (!isActive || delta >= bigDelta || canReping) {
            const ok = await notifyDiscordPlayer(env, p, delta);
            if (ok) {
              await safePutIfChanged(env, activeKey, "1", {
                expirationTtl: sessionMin * 60, // seconds
              });
              await safePutIfChanged(env, lastKey, String(Date.now()));
            }
          }

          // Always advance the baseline to the new lifetime total
          await safePutIfChanged(env, rpKey, String(rp));
        } else {
          // equal RPs — do nothing; let the active session expire naturally
        }
      }
    } catch (e: any) {
      console.log("error for", p.id, String(e?.message ?? e));
    }

    // be gentle with the Herald
    await new Promise((r) => setTimeout(r, 300));
  }
}

  // --- metrics helpers (KV count / clear) ---
async function countByPrefix(env: Environment, prefix: string): Promise<number> {
  const list = await env.WARMAP.list({ prefix, limit: 1000 });
  return list.keys.length;
}
async function clearByPrefix(env: Environment, prefix: string): Promise<number> {
  const list = await env.WARMAP.list({ prefix, limit: 1000 });
  await Promise.allSettled(list.keys.map(k => safeDelete(env, k.name)));
  return list.keys.length;
}
// metric prefixes derived from webhooks
function skipPrefixFor(url?: string | null): string | null {
  if (!url) return null;
  return `${cooldownKeyFor(url)}:skip:`;
}
function r429PrefixFor(url?: string | null): string | null {
  if (!url) return null;
  return `discord:429:${cooldownKeyFor(url)}:`;
}

const router = Router();

router.get("/admin/ping-capture", async (_req, env: Environment) => {
  const ok = await postToDiscord(env, env.DISCORD_WEBHOOK_CAPTURE!, {
    username: "Uthgard Herald",
    embeds: [{ title: "🏰 Ping (Capture)", description: "Capture webhook reachable", timestamp: new Date().toISOString() }],
  });
  return createJsonResponse({ ok });
});

router.get("/admin/ping-players", async (_req, env: Environment) => {
  const ok = await postToDiscord(env, env.DISCORD_WEBHOOK_URL_PLAYERS ?? env.DISCORD_WEBHOOK_URL!, {
    username: "Uthgard Herald",
    embeds: [{ title: "🧑‍🤝‍🧑 Ping (Players)", description: "Players webhook reachable", timestamp: new Date().toISOString() }],
  });
  return createJsonResponse({ ok });
});


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

router.get("/admin/ping", async (_req, env: Environment) => {
  const ok = await postToDiscord(env, env.DISCORD_WEBHOOK_URL!, {
    username: "Uthgard Herald",
    embeds: [{ title: "✅ Ping", description: "Webhook reachable", timestamp: new Date().toISOString() }],
  });
  return createJsonResponse({ ok });
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

router.get("/admin/debug-captures", async (_req, env: Environment) => {
  const wm = await env.WARMAP.get<WarmapData>("warmap", "json");
  if (!wm) return createJsonResponse({ error: "no warmap" }, 404);

  const recentEvents = wm.events
    .filter((e) => e.kind === "captured")
    .slice(0, 10);

  // Compare current owner with baseline to see if rising-edge would trigger
  const rows = [];
  for (const k of wm.keeps) {
    const ownKey = `own:${k.id}`;
    const baseline = await env.WARMAP.get(ownKey);
    rows.push({
      id: k.id,
      name: k.name,
      owner: k.owner,
      baseline: baseline ?? null,
    });
  }

  return createJsonResponse({
    updatedAt: wm.updatedAt,
    recentCaptureEvents: recentEvents,
    ownerBaselines: rows,
    note: "Ownership alert fires when owner != baseline; baseline is set on first sight.",
  });
});

router.get("/admin/test-capture", async (req, env: Environment) => {
  const q = new URL(req.url).searchParams;
  const keep = q.get("keep") ?? "Test Keep";
  const realm = (q.get("realm") as Realm) ?? "Midgard";
  const ok = await notifyDiscordCapture(env, {
    keepName: keep,
    newOwner: realm,
    at: new Date().toISOString(),
  });
  return createJsonResponse({ ok, keep, realm });
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
  await safeDelete(env, `alert:ua:start:${keepId}`); // NEW
  await safeDelete(env, `alert:ua:nobanner:${keepId}`);
  await safeDelete(env, `alert:ua:header:${keepId}`);
  return new Response(`reset ${keepId}`);
});

// -------- Simulate a header "flame" (UA) rising edge ----------
router.get("/admin/sim-ua", async (req, env: Environment) => {
  const q = new URL(req.url).searchParams;
  const keepName = q.get("keep") ?? "Test Keep";
  const owner = (q.get("realm") as Realm) ?? "Midgard";
  const id = slug(keepName);

  // Build a fake warmap snapshot with the keep flaming
  const payload: WarmapData = {
    updatedAt: nowIso(),
    dfOwner: owner,
    keeps: [
      {
        ...mkKeepPartial(id, keepName, owner),
        headerUnderAttack: true,
        underAttack: true,
      },
    ],
    events: [],
  };

  console.log(JSON.stringify({ tag: "SIM_UA", id, keepName, owner }));
  await alertOnUnderAttackTransitions(env, payload);
  return createJsonResponse({
    ok: true,
    note: "UA simulation executed",
    id,
    keepName,
    owner,
  });
});

router.get("/admin/env-check", async (_req, env: Environment) => {
  return createJsonResponse({
    has: {
      DISCORD_WEBHOOK_URL: !!env.DISCORD_WEBHOOK_URL,
      DISCORD_WEBHOOK_CAPTURE: !!env.DISCORD_WEBHOOK_CAPTURE,
      DISCORD_WEBHOOK_URL_PLAYERS: !!env.DISCORD_WEBHOOK_URL_PLAYERS,
    },
  });
});

router.post(
  "/admin/scan-players",
  async (req, env: Environment, ctx: ExecutionContext) => {
    const id = new URL(req.url).searchParams.get("id") ?? undefined;
    // run in background so the request doesn’t time out when you have 15–20 players
    ctx.waitUntil(checkTrackedPlayers(env, id));
    return new Response(id ? `scanning ${id}` : "scanning all");
  }
);

router.get("/admin/ops", async (req, env: Environment) => {
  const url = new URL(req.url);
  const q = url.searchParams;

  const keepId = q.get("keep") ?? undefined;
  const realm = (q.get("realm") as Realm) ?? undefined;
  const prev = (q.get("prev") as Realm) ?? undefined;
  const action = q.get("action") ?? undefined;

  // ----- helpers -----
  const now = Date.now();
  const stamp = (d?: string | null) => (d ? new Date(d).toISOString() : null);
  const secsLeft = (iso?: string | null) =>
    iso ? Math.max(0, Math.ceil((Date.parse(iso) - now) / 1000)) : 0;

  async function readWebhookState(name: string, url?: string | null) {
    if (!url) return { name, configured: false };
    const cdKey = cooldownKeyFor(url);
    const lastKey = lastSendKeyFor(url);
    const [until, last] = await Promise.all([
      env.WARMAP.get(cdKey),
      env.WARMAP.get(lastKey),
    ]);
    return {
      name,
      configured: true,
      cooldown_key: cdKey,
      cooldown_until: stamp(until),
      cooldown_secs_remaining: secsLeft(until),
      last_send_key: lastKey,
      last_send_ms: last ? Number(last) : null,
      last_send_iso: last ? new Date(Number(last)).toISOString() : null,
    };
  }

  // ----- actions (mutations) -----
  if (action === "clear-cooldowns") {
    const targets = [
      env.DISCORD_WEBHOOK_URL,
      env.DISCORD_WEBHOOK_CAPTURE,
      env.DISCORD_WEBHOOK_URL_PLAYERS,
    ].filter(Boolean) as string[];

    for (const u of targets) {
      await Promise.allSettled([
        safeDelete(env, cooldownKeyFor(u)),
        safeDelete(env, lastSendKeyFor(u)),
      ]);
    }
    return createJsonResponse({ ok: true, did: "clear-cooldowns", count: targets.length });
  }

  if (action === "reset-ua") {
    if (!keepId) return createJsonResponse({ ok: false, error: "missing ?keep" }, 400);
    await Promise.allSettled([
      safePutIfChanged(env, `ua:state:${keepId}`, "0"),
      safeDelete(env, `alert:ua:start:${keepId}`),
      safeDelete(env, `alert:ua:nobanner:${keepId}`),
      safeDelete(env, `alert:ua:header:${keepId}`),
      safeDelete(env, `ua:suppress:${keepId}`),
    ]);
    return createJsonResponse({ ok: true, did: "reset-ua", keep: keepId });
  }

  if (action === "reset-all-ua") {
    const prefixes = ["ua:state:", "alert:ua:start:", "alert:ua:nobanner:", "alert:ua:header:", "ua:suppress:"];
    let cleared = 0;
    for (const p of prefixes) cleared += await clearByPrefix(env, p);
    return createJsonResponse({ ok: true, did: "reset-all-ua", cleared });
  }

  if (action === "clear-cap") {
    if (!keepId || !realm) {
      return createJsonResponse({ ok: false, error: "missing ?keep and/or ?realm" }, 400);
    }
    const keys = [
      capOnceKey(keepId, realm),
      capSeenKey(keepId, realm),
    ];
    if (prev) keys.push(capOnceTransitionKey(keepId, prev, realm));

    for (const k of keys) await safeDelete(env, k);
    return createJsonResponse({ ok: true, did: "clear-cap", keep: keepId, realm, prev: prev ?? null });
  }

  if (action === "strict-on") {
    await env.WARMAP.put("flags:strict_delivery", "1");
    return createJsonResponse({ ok: true, strict_delivery: true });
  }
  if (action === "strict-off") {
    await env.WARMAP.put("flags:strict_delivery", "0");
    return createJsonResponse({ ok: true, strict_delivery: false });
  }

  if (action === "clear-metrics") {
    let cleared = 0;
    const prefixes = [
      r429PrefixFor(env.DISCORD_WEBHOOK_URL),
      r429PrefixFor(env.DISCORD_WEBHOOK_CAPTURE),
      r429PrefixFor(env.DISCORD_WEBHOOK_URL_PLAYERS ?? env.DISCORD_WEBHOOK_URL),
      skipPrefixFor(env.DISCORD_WEBHOOK_URL),
      skipPrefixFor(env.DISCORD_WEBHOOK_CAPTURE),
      skipPrefixFor(env.DISCORD_WEBHOOK_URL_PLAYERS ?? env.DISCORD_WEBHOOK_URL),
    ].filter(Boolean) as string[];
    for (const p of prefixes) cleared += await clearByPrefix(env, p);
    return createJsonResponse({ ok: true, did: "clear-metrics", cleared });
  }

  // ----- read-only health snapshot -----
  const wm = await env.WARMAP.get<WarmapData>("warmap", "json");
  const warmap = wm
    ? {
        updatedAt: wm.updatedAt,
        ageSec: Math.round((now - Date.parse(wm.updatedAt)) / 1000),
        keeps: wm.keeps.length,
        events: wm.events.length,
        headerUA_names: wm.keeps.filter(k => k.headerUnderAttack).map(k => k.name),
      }
    : { updatedAt: null, ageSec: null, keeps: 0, events: 0 };

  // metrics (last hour) per webhook
  const strictDeliveryKV = await env.WARMAP.get("flags:strict_delivery");
  const strictDelivery = (strictDeliveryKV ?? String(env.STRICT_DELIVERY ?? "0")).trim() === "1";

  async function metricBundle(url?: string | null) {
    const skipP = skipPrefixFor(url);
    const r429P = r429PrefixFor(url);
    const cooldownSkips = skipP ? await countByPrefix(env, skipP) : 0;
    const r429s = r429P ? await countByPrefix(env, r429P) : 0;
    return { cooldown_skips: cooldownSkips, r429_last_hour: r429s };
  }

  const metrics = {
    ua: await metricBundle(env.DISCORD_WEBHOOK_URL),
    capture: await metricBundle(env.DISCORD_WEBHOOK_CAPTURE),
    players: await metricBundle(env.DISCORD_WEBHOOK_URL_PLAYERS ?? env.DISCORD_WEBHOOK_URL),
  };

  const [uaState, capState] = await (async () => {
    if (!keepId) return [{}, {}];

    const baselineOwner = await env.WARMAP.get(`own:${keepId}`);
    const suppress = await env.WARMAP.get(`ua:suppress:${keepId}`);
    const uaOn = await env.WARMAP.get(`ua:state:${keepId}`);
    const uaStart = await env.WARMAP.get(`alert:ua:start:${keepId}`);

    const capOnce =
      realm ? await env.WARMAP.get(capOnceKey(keepId, realm)) : null;
    const capSeen =
      realm ? await env.WARMAP.get(capSeenKey(keepId, realm)) : null;
    const transOnce =
      realm && prev
        ? await env.WARMAP.get(capOnceTransitionKey(keepId, prev, realm))
        : null;

    return [
      {
        keepId,
        ua_state_value: uaOn ?? null,
        ua_start_value: uaStart ?? null,
        ua_suppress_value: suppress ?? null,
        baseline_owner: (baselineOwner as Realm) ?? null,
      },
      {
        keepId,
        realm: realm ?? null,
        cap_once: capOnce ?? null,
        cap_seen: capSeen ?? null,
        cap_transition_once: transOnce ?? null,
      },
    ];
  })();

  const webhooks = await Promise.all([
    readWebhookState("UA/Generic", env.DISCORD_WEBHOOK_URL ?? null),
    readWebhookState("Capture", env.DISCORD_WEBHOOK_CAPTURE ?? null),
    readWebhookState("Players", env.DISCORD_WEBHOOK_URL_PLAYERS ?? null),
  ]);

  return createJsonResponse({
    ok: true,
    now: new Date(now).toISOString(),
    strict_delivery: strictDelivery,
    warmap,
    webhooks,
    metrics,
    ...(keepId ? { uaState, capState } : {}),
    hint: "Actions: ?action=strict-on|strict-off | ?action=clear-cooldowns | ?action=clear-metrics | ?action=reset-all-ua | ?action=reset-ua&keep=<id> | ?action=clear-cap&keep=<id>&realm=<Realm>[&prev=<Realm>]. Add ?keep=<id>[&realm=<Realm>][&prev=<Realm>] to inspect keys.",
  });
});


// -------- Simulate a recent "captured" event path -------------
router.get("/admin/sim-capture-event", async (req, env: Environment) => {
  const q = new URL(req.url).searchParams;
  const keepName = q.get("keep") ?? "Test Keep";
  const newOwner = (q.get("realm") as Realm) ?? "Midgard";
  const minutesAgo = Number(q.get("ago") ?? "2");
  const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const id = slug(keepName);

  const payload: WarmapData = {
    updatedAt: nowIso(),
    dfOwner: newOwner,
    keeps: [mkKeepPartial(id, keepName, newOwner)],
    events: [{ at, kind: "captured", keepId: id, keepName, newOwner }],
  };

  console.log(
    JSON.stringify({ tag: "SIM_CAPTURE_EVENT", id, keepName, newOwner, at })
  );
  await alertOnRecentCapturesFromEvents(env, payload);
  return createJsonResponse({ ok: true, id, keepName, newOwner, at });
});

// -------- Simulate ownership-change (rising-edge) path --------
router.get("/admin/sim-ownership", async (req, env: Environment) => {
  const q = new URL(req.url).searchParams;
  const keepName = q.get("keep") ?? "Test Keep";
  const prevOwner = (q.get("prev") as Realm) ?? "Albion";
  const nowOwner = (q.get("now") as Realm) ?? "Midgard";
  const id = slug(keepName);

  // Prime baseline so the change is detected
  await env.WARMAP.put(`own:${id}`, prevOwner);

  const payload: WarmapData = {
    updatedAt: nowIso(),
    dfOwner: nowOwner,
    keeps: [mkKeepPartial(id, keepName, nowOwner)],
    events: [],
  };

  console.log(
    JSON.stringify({ tag: "SIM_OWNERSHIP", id, keepName, prevOwner, nowOwner })
  );
  await alertOnOwnershipChanges(env, payload, null);
  return createJsonResponse({ ok: true, id, keepName, prevOwner, nowOwner });
});

// -------- Simulate player activity alert ----------------------
router.get("/admin/sim-player", async (req, env: Environment) => {
  const q = new URL(req.url).searchParams;
  const id = q.get("id") ?? "saz";
  const name = q.get("name") ?? "Saz";
  const realm = (q.get("realm") as Realm) ?? "Midgard";
  const delta = Number(q.get("delta") ?? "500");

  console.log(JSON.stringify({ tag: "SIM_PLAYER", id, name, realm, delta }));
  await notifyDiscordPlayer(env, { name, realm }, delta);
  return createJsonResponse({ ok: true, id, name, realm, delta });
});

// -------- KV dump helper (inspect state quickly) --------------
router.get("/admin/kv-dump", async (req, env: Environment) => {
  const p = new URL(req.url).searchParams.get("prefix") ?? "";
  const keys = [
    "ua:state:",
    "alert:ua:header:",
    "alert:under:",
    "cap:event:",
    "own:",
    "rp:",
    "rp:active:",
  ].filter((k) => k.startsWith(p) || p === "");

  const out: Record<string, string | null> = {};
  for (const k of keys) {
    // just sample a few known keys by combining prefix with common ids
    out[k + "<example>"] = await env.WARMAP.get(k + "<example>");
  }
  return createJsonResponse({ prefix: p, sample: out });
});

router.get("/admin/dump-keep-header", async (_req, env: Environment) => {
  const html = await (
    await fetch(env.HERALD_WARMAP_URL, {
      cf: { cacheTtl: 0 },
      headers: { "cache-control": "no-cache" },
    })
  ).text();
  const doc = parse(html);
  const keepDivs = doc.querySelectorAll("div.keepinfo");
  const sample = keepDivs.slice(0, 5).map((div) => ({
    id: (
      div.querySelector("strong")?.text.trim() ||
      div.getAttribute("id") ||
      "Unknown"
    )
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, ""),
    headerText:
      (div.querySelector('td[align="center"]') ?? div).innerText?.trim() ?? "",
    headerHtml:
      (div.querySelector('td[align="center"]') ?? div).innerHTML ?? "",
  }));
  return createJsonResponse({ sample });
});

router.get("/admin/debug-player", async (req, env: Environment) => {
  const id = new URL(req.url).searchParams.get("id")!;
  const rpKey = `rp:${id}`;
  const activeKey = `rp:active:${id}`;
  const [rp, active] = await Promise.all([
    env.WARMAP.get(rpKey),
    env.WARMAP.get(activeKey),
  ]);
  return createJsonResponse({
    id,
    rpBaseline: rp ?? null,
    activeSession: !!active,
  });
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

// --- alert from recent "captured" rows, unified dedupe, no baseline short-circuit
// --- alert from recent "captured" rows, unified dedupe, STRICT_DELIVERY gating
async function alertOnRecentCapturesFromEvents(
  env: Environment,
  payload: WarmapData
) {
  const now = Date.now();
  const WINDOW_MS = captureWindowMs(env);
  const STRICT_DELIVERY = await getStrictDelivery(env);


  // helper: post-capture UA/session state changes
  async function applyPostCaptureState(keepId: string) {
    await Promise.all([
      safeDelete(env, `alert:ua:start:${keepId}`),
      safePutIfChanged(env, `ua:state:${keepId}`, "0"),
      safePutIfChanged(env, `ua:suppress:${keepId}`, "1", {
        expirationTtl: UA_SUPPRESS_AFTER_CAPTURE_SEC,
      }),
    ]);
  }

  for (const ev of payload.events) {
    if (ev.kind !== "captured") continue;

    const atMs = Date.parse(ev.at);
    if (Number.isNaN(atMs) || now - atMs > WINDOW_MS) continue;

    // Unified dedupe gates (shared with ownership path)
    const onceKey = capOnceKey(ev.keepId, ev.newOwner!); // 20 min
    if (await env.WARMAP.get(onceKey)) continue;

    const kAny = capDedupKey(ev.keepId, ev.newOwner!, ev.at); // 6 h
    if (await env.WARMAP.get(kAny)) continue;

    if (await hasAlertedCapture(env, ev.keepId, ev.newOwner!)) continue; // 20 min

    // Send
    const ok = await notifyDiscordCapture(env, {
      keepName: ev.keepName,
      newOwner: ev.newOwner!,
      at: ev.at,
      leader: (ev as any).leader,
    });

    // Stamp dedupe keys ONLY on success
    if (ok) {
      await Promise.all([
        markCaptureAlerted(env, ev.keepId, ev.newOwner!),
        safePutIfChanged(env, kAny, "1", { expirationTtl: 6 * 60 * 60 }),
        safePutIfChanged(env, onceKey, "1", { expirationTtl: CAP_ONCE_TTL_SEC }),
      ]);
    }

    // UA/session state moves:
    // - STRICT_DELIVERY=1 -> only if ok (so we can retry later)
    // - default (0)       -> always (previous behavior)
    if (ok || !STRICT_DELIVERY) {
      await applyPostCaptureState(ev.keepId);
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
