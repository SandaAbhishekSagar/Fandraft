/**
 * lib/data-source.ts
 * -----------------------------------------------------------------------------
 * Data source for the FanDraft agent. Tries live ESPN for injuries (which works
 * fine from Vercel). Reads the cached player pool from /data/players.json
 * (NBA Stats blocks most cloud IPs, so we always serve cached).
 *
 * Your OpenAI tools call these functions. They don't know or care whether the
 * data is live or cached — that's the point.
 * -----------------------------------------------------------------------------
 */

import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const LIVE_TIMEOUT_MS = 2500;

const NBA_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
};

function readFallback<T>(filename: string): T {
  const p = path.join(DATA_DIR, filename);
  const raw = fs.readFileSync(p, "utf-8");
  return JSON.parse(raw) as T;
}

async function fetchWithTimeout(url: string, opts: RequestInit = {}, ms = LIVE_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// ---------- Types ----------
export interface Player {
  playerId: number;
  name: string;
  jersey: string;
  position: string;
  teamAbbr: string;
  teamId: number;
  headshot: string;
  slots: string[];
  stats: {
    gp: number;
    min: number;
    pts: number;
    reb: number;
    ast: number;
    stl: number;
    blk: number;
    tov: number;
  };
  projection: {
    fantasyPoints: number;
    salary: number;
    value: number;
    source: "postseason_avg" | "regular_avg";
  };
}

export interface PlayerPool {
  generatedAt: string;
  season: string;
  game: string;
  players: Player[];
  __source: "live" | "fallback";
}

export interface Injury {
  headline: string;
  description: string;
  published: string;
  link: string;
}

// ---------- Tonight ----------
export function getTonight() {
  return readFallback<{
    date: string;
    tipoff_et: string;
    game_label: string;
    series_state: string;
    away: { abbr: string; name: string; teamId: number };
    home: { abbr: string; name: string; teamId: number };
  }>("tonight.json");
}

// ---------- Player pool ----------
export async function getPlayerPool(): Promise<PlayerPool> {
  // Cached only. See README: NBA Stats blocks Vercel IPs.
  const cached = readFallback<Omit<PlayerPool, "__source">>("players.json");
  return { ...cached, __source: "fallback" };
}

// ---------- Injuries ----------
export async function getInjuries(): Promise<{ articles: Injury[]; __source: "live" | "fallback" }> {
  try {
    const data = await fetchWithTimeout(
      "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/news?limit=50",
      { headers: { "User-Agent": NBA_HEADERS["User-Agent"] } },
    );
    const articles = (data.articles || []).map((a: any) => ({
      headline: a.headline,
      description: a.description,
      published: a.published,
      link: a.links?.web?.href || "",
    }));
    return { articles, __source: "live" };
  } catch (err) {
    console.warn("[data-source] ESPN live failed, using fallback:", (err as Error).message);
    const cached = readFallback<{ articles: Injury[] }>("injuries.json");
    return { ...cached, __source: "fallback" };
  }
}

// ---------- Helpers ----------
export function headshotUrl(playerId: number): string {
  return `https://cdn.nba.com/headshots/nba/latest/1040x760/${playerId}.png`;
}

export function filterByInjuryStatus(pool: PlayerPool, injuries: Injury[]) {
  const flagged: Record<number, string[]> = {};
  for (const p of pool.players) {
    const hits = injuries.filter(
      (i) =>
        i.headline?.toLowerCase().includes(p.name.toLowerCase()) ||
        i.description?.toLowerCase().includes(p.name.toLowerCase()),
    );
    if (hits.length) flagged[p.playerId] = hits.map((h) => h.headline);
  }
  return flagged;
}
