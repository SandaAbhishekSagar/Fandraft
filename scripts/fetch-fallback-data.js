#!/usr/bin/env node
/**
 * FanDraft fallback data crawler (v2 — bulk endpoint)
 * -----------------------------------------------------------------------------
 * v1 used playerprofilev2 per-player, which is currently returning HTTP 500s
 * intermittently. v2 uses leaguedashplayerstats which returns the entire league
 * in a single request, then filters to Spurs + Thunder rosters locally.
 *
 * Two requests instead of 30+. Faster, more reliable.
 *
 * Output: data/*.json files your Next.js app reads at runtime.
 *
 * Usage:
 *   node scripts/fetch-fallback-data.js
 *
 * No API keys required.
 * -----------------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");

const OUTPUT_DIR = path.join(__dirname, "..", "data");
const SEASON = "2025-26";

const TONIGHT = {
  date: "2026-05-26",
  tipoff_et: "8:30 PM",
  game_label: "WCF Game 5",
  series_state: "Tied 2-2",
  away: { abbr: "SAS", name: "San Antonio Spurs", teamId: 1610612759 },
  home: { abbr: "OKC", name: "Oklahoma City Thunder", teamId: 1610612760 },
};

const NBA_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.nba.com/",
  Origin: "https://www.nba.com",
  Connection: "keep-alive",
  "x-nba-stats-origin": "stats",
  "x-nba-stats-token": "true",
};

const DK_SCORING = { PTS: 1.0, REB: 1.25, AST: 1.5, STL: 2.0, BLK: 2.0, TOV: -0.5 };

function positionSlots(pos) {
  if (!pos) return ["UTIL"];
  const slots = new Set(["UTIL"]);
  const p = pos.toUpperCase();
  if (p.includes("G")) { slots.add("PG"); slots.add("SG"); slots.add("G"); }
  if (p.includes("F")) { slots.add("SF"); slots.add("PF"); slots.add("F"); }
  if (p.includes("C")) { slots.add("C"); }
  return Array.from(slots);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeJson(filename, payload) {
  const fullpath = path.join(OUTPUT_DIR, filename);
  fs.writeFileSync(fullpath, JSON.stringify(payload, null, 2));
  const kb = (fs.statSync(fullpath).size / 1024).toFixed(1);
  console.log(`  ✓ wrote ${filename} (${kb} KB)`);
}

async function fetchWithRetry(url, opts = {}, retries = 3, delayMs = 1500) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, opts);
      if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
      return await res.json();
    } catch (err) {
      console.warn(`  ! attempt ${attempt} failed: ${err.message}`);
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, delayMs * attempt));
    }
  }
}

function headshotUrl(playerId) {
  return `https://cdn.nba.com/headshots/nba/latest/1040x760/${playerId}.png`;
}

async function fetchTeamRoster(teamId, teamAbbr) {
  console.log(`\n→ Roster for ${teamAbbr} (teamId=${teamId})`);
  const url =
    `https://stats.nba.com/stats/commonteamroster?LeagueID=00&Season=${SEASON}&TeamID=${teamId}`;
  const data = await fetchWithRetry(url, { headers: NBA_HEADERS });
  const rs = data.resultSets.find((r) => r.name === "CommonTeamRoster");
  const headers = rs.headers;
  const idx = (k) => headers.indexOf(k);
  const roster = rs.rowSet.map((row) => ({
    playerId: row[idx("PLAYER_ID")],
    name: row[idx("PLAYER")],
    jersey: row[idx("NUM")],
    position: row[idx("POSITION")],
    height: row[idx("HEIGHT")],
    weight: row[idx("WEIGHT")],
    teamAbbr,
    teamId,
    headshot: headshotUrl(row[idx("PLAYER_ID")]),
  }));
  console.log(`  ${roster.length} players on ${teamAbbr}`);
  return roster;
}

/**
 * Bulk endpoint: returns one row per player, league-wide. We just look up the
 * players we care about. This is the v1 -> v2 change.
 *
 * Param notes:
 *   - PerMode=PerGame for averages
 *   - SeasonType=Playoffs for postseason; we also fetch Regular Season as fallback
 *   - Most params are required-but-empty (NBA API quirk)
 */
async function fetchLeagueDashStats(seasonType) {
  const params = new URLSearchParams({
    College: "", Conference: "", Country: "",
    DateFrom: "", DateTo: "",
    Division: "", DraftPick: "", DraftYear: "",
    GameScope: "", GameSegment: "", Height: "",
    LastNGames: "0", LeagueID: "00", Location: "",
    MeasureType: "Base", Month: "0",
    OpponentTeamID: "0", Outcome: "",
    PORound: "0", PaceAdjust: "N",
    PerMode: "PerGame", Period: "0",
    PlayerExperience: "", PlayerPosition: "",
    PlusMinus: "N", Rank: "N",
    Season: SEASON, SeasonSegment: "",
    SeasonType: seasonType,
    ShotClockRange: "", StarterBench: "",
    TeamID: "0", TwoWay: "",
    VsConference: "", VsDivision: "",
    Weight: "",
  });
  const url = `https://stats.nba.com/stats/leaguedashplayerstats?${params.toString()}`;
  console.log(`\n→ League-wide ${seasonType} stats`);
  const data = await fetchWithRetry(url, { headers: NBA_HEADERS });
  const rs = data.resultSets[0];
  const headers = rs.headers;
  const idx = (k) => headers.indexOf(k);

  // Build a Map from PLAYER_ID -> stats object
  const byId = new Map();
  for (const row of rs.rowSet) {
    byId.set(row[idx("PLAYER_ID")], {
      gp: row[idx("GP")],
      min: row[idx("MIN")],
      pts: row[idx("PTS")],
      reb: row[idx("REB")],
      ast: row[idx("AST")],
      stl: row[idx("STL")],
      blk: row[idx("BLK")],
      tov: row[idx("TOV")],
      fgPct: row[idx("FG_PCT")],
      fg3Pct: row[idx("FG3_PCT")],
      ftPct: row[idx("FT_PCT")],
    });
  }
  console.log(`  got ${byId.size} player stat rows`);
  return byId;
}

function computeFantasyPoints(stats) {
  if (!stats) return 0;
  return (
    stats.pts * DK_SCORING.PTS +
    stats.reb * DK_SCORING.REB +
    stats.ast * DK_SCORING.AST +
    stats.stl * DK_SCORING.STL +
    stats.blk * DK_SCORING.BLK +
    stats.tov * DK_SCORING.TOV
  );
}

function computeSalary(projFP) {
  const raw = 3000 + projFP * 250;
  return Math.max(3000, Math.min(11000, Math.round(raw / 100) * 100));
}

async function fetchEspnInjuries() {
  console.log("\n→ ESPN injury feed");
  const url = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/news?limit=50";
  const data = await fetchWithRetry(url, { headers: { "User-Agent": NBA_HEADERS["User-Agent"] } });
  return (data.articles || []).map((a) => ({
    headline: a.headline,
    description: a.description,
    type: a.type,
    published: a.published,
    categories: (a.categories || []).map((c) => ({ type: c.type, description: c.description })),
    link: a.links && a.links.web && a.links.web.href,
  }));
}

async function fetchEspnScoreboard() {
  console.log("\n→ ESPN scoreboard for 2026-05-26");
  const url = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=20260526";
  return await fetchWithRetry(url, { headers: { "User-Agent": NBA_HEADERS["User-Agent"] } });
}

async function buildPlayerPool() {
  // 1. Get both rosters (2 small requests)
  const sasRoster = await fetchTeamRoster(TONIGHT.away.teamId, TONIGHT.away.abbr);
  const okcRoster = await fetchTeamRoster(TONIGHT.home.teamId, TONIGHT.home.abbr);
  const rosters = [...sasRoster, ...okcRoster];

  // 2. Get postseason stats in ONE bulk request
  let postseasonStats = new Map();
  try {
    postseasonStats = await fetchLeagueDashStats("Playoffs");
  } catch (err) {
    console.warn("  ! Playoffs fetch failed:", err.message);
  }

  // 3. Regular-season as fallback for anyone missing postseason data
  let regularStats = new Map();
  try {
    regularStats = await fetchLeagueDashStats("Regular Season");
  } catch (err) {
    console.warn("  ! Regular Season fetch failed:", err.message);
  }

  // 4. Merge — prefer postseason
  console.log("\n→ Building projections");
  const allPlayers = [];
  for (const player of rosters) {
    const post = postseasonStats.get(player.playerId);
    const reg = regularStats.get(player.playerId);
    const stats = (post && post.gp >= 1) ? post : reg;
    const source = (post && post.gp >= 1) ? "postseason_avg" : "regular_avg";

    if (!stats || stats.gp < 1) {
      console.log(`    · ${player.name}: no stats, skipping`);
      continue;
    }

    const projFP = computeFantasyPoints(stats);
    const salary = computeSalary(projFP);
    const slots = positionSlots(player.position);

    allPlayers.push({
      ...player,
      slots,
      stats: {
        gp: stats.gp, min: stats.min,
        pts: stats.pts, reb: stats.reb, ast: stats.ast,
        stl: stats.stl, blk: stats.blk, tov: stats.tov,
      },
      projection: {
        fantasyPoints: Number(projFP.toFixed(1)),
        salary,
        value: Number((projFP / (salary / 1000)).toFixed(2)),
        source,
      },
    });

    const tag = source === "postseason_avg" ? "PO" : "RS";
    console.log(
      `    · ${player.name.padEnd(22)} (${(player.position || "?").padEnd(3)}) [${tag}]  ${projFP.toFixed(1).padStart(5)} FP  $${salary}`
    );
  }

  return allPlayers;
}

(async () => {
  console.log("==========================================================");
  console.log(" FanDraft fallback data crawler (v2 - bulk endpoint)");
  console.log(` Tonight: ${TONIGHT.away.name} @ ${TONIGHT.home.name}`);
  console.log(` ${TONIGHT.game_label} · ${TONIGHT.date} · ${TONIGHT.tipoff_et} ET`);
  console.log("==========================================================");

  ensureDir(OUTPUT_DIR);
  writeJson("tonight.json", TONIGHT);

  let players = [];
  try {
    players = await buildPlayerPool();
    writeJson("players.json", {
      generatedAt: new Date().toISOString(),
      season: SEASON,
      game: `${TONIGHT.away.abbr} @ ${TONIGHT.home.abbr}`,
      players,
    });
  } catch (err) {
    console.error("\n!! Player pool fetch failed:", err.message);
  }

  try {
    const injuries = await fetchEspnInjuries();
    writeJson("injuries.json", {
      generatedAt: new Date().toISOString(),
      source: "espn_news_feed",
      count: injuries.length,
      articles: injuries,
    });
  } catch (err) { console.error("\n!! ESPN injuries fetch failed:", err.message); }

  try {
    const board = await fetchEspnScoreboard();
    writeJson("scoreboard.json", { generatedAt: new Date().toISOString(), raw: board });
  } catch (err) { console.error("\n!! ESPN scoreboard fetch failed:", err.message); }

  const headshots = {};
  for (const p of players) headshots[p.playerId] = p.headshot;
  writeJson("headshots.json", headshots);

  console.log("\n==========================================================");
  console.log(" Summary");
  console.log("==========================================================");
  console.log(` Players collected:  ${players.length}`);
  console.log(` Postseason stats:   ${players.filter((p) => p.projection.source === "postseason_avg").length}`);
  console.log(` Regular season:     ${players.filter((p) => p.projection.source === "regular_avg").length}`);
  console.log(` Output directory:   ${OUTPUT_DIR}`);
  for (const f of fs.readdirSync(OUTPUT_DIR)) {
    const stat = fs.statSync(path.join(OUTPUT_DIR, f));
    console.log(`   ${f.padEnd(20)} ${(stat.size / 1024).toFixed(1)} KB`);
  }
  console.log("\nDone. Commit data/ to git and you're set for tomorrow.\n");
})().catch((err) => {
  console.error("\nFATAL:", err);
  process.exit(1);
});