import fs from "fs";
import path from "path";

export interface Player {
  playerId: number;
  name: string;
  jersey: string;
  position: string;
  height?: string;
  weight?: string;
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
    source: string;
  };
}

export interface InjuryArticle {
  headline: string;
  description: string;
  type: string;
  published: string;
  categories: Array<{
    type: string;
    description: string;
  }>;
}

export interface Injury {
  generatedAt: string;
  source: string;
  count: number;
  articles: InjuryArticle[];
}

export interface Tonight {
  date: string;
  tipoff_et: string;
  game_label: string;
  series_state: string;
  away: {
    abbr: string;
    name: string;
    teamId: number;
  };
  home: {
    abbr: string;
    name: string;
    teamId: number;
  };
}

interface PlayerPool {
  generatedAt: string;
  season: string;
  game: string;
  players: Player[];
  __source: string;
}

/**
 * Reads and returns the player pool from cached data
 */
export async function getPlayerPool(): Promise<PlayerPool> {
  const filePath = path.join(process.cwd(), "data", "players.json");
  const fileContent = fs.readFileSync(filePath, "utf-8");
  const data = JSON.parse(fileContent);
  
  return {
    ...data,
    __source: "fallback",
  };
}

/**
 * Fetches injury data from ESPN with fallback to cached data
 */
export async function getInjuries(): Promise<Injury> {
  const ESPN_URL = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/news?limit=50";
  
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    
    const response = await fetch(ESPN_URL, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
    });
    
    clearTimeout(timeout);
    
    if (!response.ok) {
      throw new Error(`ESPN API returned ${response.status}`);
    }
    
    const liveData = await response.json();
    
    return {
      generatedAt: new Date().toISOString(),
      source: "espn_live",
      count: liveData.articles?.length || 0,
      articles: liveData.articles || [],
    };
  } catch (error) {
    console.warn("Failed to fetch live injuries from ESPN, using fallback:", error);
    
    const filePath = path.join(process.cwd(), "data", "injuries.json");
    const fileContent = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(fileContent);
  }
}

/**
 * Reads tonight's game data synchronously
 */
export function getTonight(): Tonight {
  const filePath = path.join(process.cwd(), "data", "tonight.json");
  const fileContent = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(fileContent);
}

/**
 * Returns the NBA headshot URL for a given player ID
 */
export function headshotUrl(playerId: number): string {
  return `https://cdn.nba.com/headshots/nba/latest/1040x760/${playerId}.png`;
}
