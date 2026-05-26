/**
 * lib/agent.ts
 * -----------------------------------------------------------------------------
 * OpenAI-powered multi-agent lineup builder.
 *
 * Flow:
 *   1. Coordinator (gpt-4o-mini) decides which tools to call given the user's request.
 *   2. We execute those tools locally (no real network — they read from data/).
 *   3. Coordinator synthesizes a final lineup with per-pick reasoning (gpt-4o).
 *
 * Three tools registered:
 *   - get_player_pool:   returns tonight's eligible players with salary + projection
 *   - get_injuries:      returns recent injury articles (live ESPN + cached fallback)
 *   - optimize_lineup:   greedy lineup builder under $50K cap, position-aware
 *
 * No streaming. Full loop completes in 3-5 seconds.
 * -----------------------------------------------------------------------------
 */

import OpenAI from "openai";
import {
  getPlayerPool,
  getInjuries,
  filterByInjuryStatus,
  Player,
} from "./data-source";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- Tool schemas (OpenAI function-calling format) ----------
const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "get_player_pool",
      description:
        "Returns every player available for tonight's slate, with computed fantasy projection and projected salary. Call this first.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_injuries",
      description:
        "Returns recent injury news articles from ESPN. Use to flag risk on selected players or surface backup-becomes-starter opportunities.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "optimize_lineup",
      description:
        "Runs a greedy lineup optimizer that maximizes total projected fantasy points under a salary cap, respecting DK position slots. Returns the chosen 8 players.",
      parameters: {
        type: "object",
        properties: {
          salary_cap: {
            type: "number",
            description: "Total budget. Default 50000.",
          },
          exclude_player_ids: {
            type: "array",
            items: { type: "number" },
            description: "Player IDs to exclude (e.g. ruled-out players).",
          },
        },
        required: [],
      },
    },
  },
];

// ---------- Tool implementations ----------
const POSITION_SLOTS = ["PG", "SG", "SF", "PF", "C", "G", "F", "UTIL"];

function greedyOptimize(
  pool: Player[],
  salaryCap = 50000,
  excludeIds: number[] = [],
): { lineup: Array<Player & { slot: string }>; totalSalary: number; totalProjFP: number } {
  const candidates = pool
    .filter((p) => !excludeIds.includes(p.playerId))
    .map((p) => ({
      ...p,
      value: p.projection.fantasyPoints / (p.projection.salary / 1000),
    }))
    .sort((a, b) => b.value - a.value);

  const chosenIds = new Set<number>();
  const lineup: Array<Player & { slot: string }> = [];
  let remaining = salaryCap;
  // Reserve roughly $3000 per remaining slot to avoid blowing the cap on the first picks
  const RESERVE_PER_SLOT = 3000;

  for (const slot of POSITION_SLOTS) {
    const slotsLeft = POSITION_SLOTS.length - lineup.length - 1;
    const usable = remaining - slotsLeft * RESERVE_PER_SLOT;

    const pick = candidates.find(
      (c) =>
        !chosenIds.has(c.playerId) &&
        c.slots.includes(slot) &&
        c.projection.salary <= usable,
    );

    if (!pick) continue; // best-effort; we'll fill what we can
    chosenIds.add(pick.playerId);
    remaining -= pick.projection.salary;
    lineup.push({ ...pick, slot });
  }

  return {
    lineup,
    totalSalary: salaryCap - remaining,
    totalProjFP: lineup.reduce((s, p) => s + p.projection.fantasyPoints, 0),
  };
}

async function executeTool(name: string, args: any) {
  switch (name) {
    case "get_player_pool": {
      const pool = await getPlayerPool();
      // Trim payload to keep token use low
      return {
        game: pool.game,
        source: pool.__source,
        players: pool.players.map((p) => ({
          playerId: p.playerId,
          name: p.name,
          team: p.teamAbbr,
          position: p.position,
          slots: p.slots,
          salary: p.projection.salary,
          projectedFP: p.projection.fantasyPoints,
          value: p.projection.value,
        })),
      };
    }
    case "get_injuries": {
      const data = await getInjuries();
      // Only the headlines + first 200 chars of each to keep payload small
      return {
        source: data.__source,
        articles: data.articles.slice(0, 20).map((a) => ({
          headline: a.headline,
          description: (a.description || "").slice(0, 200),
        })),
      };
    }
    case "optimize_lineup": {
      const pool = await getPlayerPool();
      const result = greedyOptimize(
        pool.players,
        args?.salary_cap ?? 50000,
        args?.exclude_player_ids ?? [],
      );
      return {
        lineup: result.lineup.map((p) => ({
          playerId: p.playerId,
          slot: p.slot,
          name: p.name,
          team: p.teamAbbr,
          salary: p.projection.salary,
          projectedFP: p.projection.fantasyPoints,
          headshot: p.headshot,
        })),
        totalSalary: result.totalSalary,
        totalProjectedFP: Number(result.totalProjFP.toFixed(1)),
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------- Main entry: run the agent ----------
export interface LineupResponse {
  lineup: Array<{
    playerId: number;
    slot: string;
    name: string;
    team: string;
    salary: number;
    projectedFP: number;
    headshot: string;
    reasoning: string;
  }>;
  totalSalary: number;
  totalProjectedFP: number;
  summary: string;
  toolCallTrace: Array<{ tool: string; args: any }>;
}

export async function buildLineup(userRequest: string): Promise<LineupResponse> {
  const systemPrompt = `You are FanDraft, an AI fantasy basketball analyst for tonight's NBA WCF Game 5: San Antonio Spurs at Oklahoma City Thunder, 8:30 PM ET, series tied 2-2.

Your job: build an 8-player DFS lineup under a $50,000 salary cap. Standard DraftKings slots: PG, SG, SF, PF, C, G (guard), F (forward), UTIL (any).

Process:
1. Call get_player_pool to see who's playing tonight.
2. Call get_injuries to scan for ruled-out players or news that creates value plays.
3. Call optimize_lineup, passing exclude_player_ids for anyone you determined is ruled out.
4. Return the lineup with sharp, specific reasoning for each pick.

Reasoning style: short, confident, specific. Reference matchups, recent form, injury context. No filler. Sound like a sharp analyst, not a textbook. Two sentences max per pick.`;

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userRequest },
  ];

  const toolCallTrace: Array<{ tool: string; args: any }> = [];
  let lastResult: any = null;

  // Tool-calling loop — bounded to 5 iterations as a safety net
  for (let iter = 0; iter < 5; iter++) {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      tools,
      tool_choice: "auto",
      temperature: 0.3,
    });

    const choice = response.choices[0];
    const msg = choice.message;
    messages.push(msg);

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      // Coordinator is done calling tools
      break;
    }

    for (const tc of msg.tool_calls) {
      if (tc.type !== "function") continue;
      const args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
      toolCallTrace.push({ tool: tc.function.name, args });
      const result = await executeTool(tc.function.name, args);
      if (tc.function.name === "optimize_lineup") lastResult = result;
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(result),
      });
    }
  }

  // If the optimizer never ran, force it now (safety net)
  if (!lastResult) {
    lastResult = await executeTool("optimize_lineup", {});
  }

  // Final synthesis call with gpt-4o for prose quality
  const synthPrompt = `Given the lineup below for tonight's Spurs @ Thunder WCF Game 5, write a short reasoning bubble for each pick.

Lineup:
${JSON.stringify(lastResult.lineup, null, 2)}

Return ONLY valid JSON with this exact shape (no markdown fences, no commentary):
{
  "summary": "A 1-sentence framing of the overall lineup strategy.",
  "picks": [
    { "playerId": <number>, "reasoning": "<two-sentence sharp analyst take>" },
    ...
  ]
}`;

  const synthResponse = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: synthPrompt },
    ],
    temperature: 0.5,
    response_format: { type: "json_object" },
  });

  const synth = JSON.parse(synthResponse.choices[0].message.content || "{}");
  const reasoningById: Record<number, string> = {};
  for (const p of synth.picks || []) reasoningById[p.playerId] = p.reasoning;

  return {
    lineup: lastResult.lineup.map((p: any) => ({
      ...p,
      reasoning: reasoningById[p.playerId] || "Strong value at this slot.",
    })),
    totalSalary: lastResult.totalSalary,
    totalProjectedFP: lastResult.totalProjectedFP,
    summary: synth.summary || "Lineup optimized for ceiling in tonight's Game 5.",
    toolCallTrace,
  };
}
