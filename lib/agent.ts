import OpenAI from "openai";
import { getPlayerPool, getInjuries, Player } from "./data-source";
import { logger } from "./logger";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "get_player_pool",
      description: "Returns tonight's available player pool with stats and projections",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_injuries",
      description: "Returns recent ESPN injury news articles for NBA players",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "optimize_lineup",
      description: "Runs a greedy optimizer to build the best lineup within salary cap constraints",
      parameters: {
        type: "object",
        properties: {
          salary_cap: {
            type: "number",
            description: "Maximum total salary (default 50000)",
          },
          exclude_player_ids: {
            type: "array",
            items: { type: "number" },
            description: "Player IDs to exclude from consideration (e.g., injured players)",
          },
        },
        required: [],
      },
    },
  },
];

interface LineupPlayer extends Player {
  slot: string;
}

interface OptimizeResult {
  lineup: LineupPlayer[];
  totalSalary: number;
  totalProjFP: number;
}

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

  const slots = ["PG", "SG", "SF", "PF", "C", "G", "F", "UTIL"];
  const minSalary = Math.min(...candidates.map((c) => c.projection.salary));

  const chosenIds = new Set<number>();
  const lineup: Array<Player & { slot: string }> = [];
  let remaining = salaryCap;

  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const slotsLeft = slots.length - i - 1;
    const maxSpendThisPick = remaining - slotsLeft * minSalary;

    const pick = candidates.find(
      (c) =>
        !chosenIds.has(c.playerId) &&
        c.slots.includes(slot) &&
        c.projection.salary <= maxSpendThisPick,
    );

    if (!pick) {
      const cheapest = candidates
        .filter((c) => !chosenIds.has(c.playerId) && c.slots.includes(slot))
        .sort((a, b) => a.projection.salary - b.projection.salary)[0];
      if (cheapest && cheapest.projection.salary <= remaining) {
        chosenIds.add(cheapest.playerId);
        remaining -= cheapest.projection.salary;
        lineup.push({ ...cheapest, slot });
      }
      continue;
    }

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
  if (name === "get_player_pool") {
    const data = await getPlayerPool();
    return {
      count: data.players.length,
      players: data.players.map((p) => ({
        playerId: p.playerId,
        name: p.name,
        team: p.teamAbbr,
        position: p.position,
        slots: p.slots,
        salary: p.projection.salary,
        projectedFP: p.projection.fantasyPoints,
        value: (p.projection.fantasyPoints / (p.projection.salary / 1000)).toFixed(2),
      })),
    };
  }

  if (name === "get_injuries") {
    const data = await getInjuries();
    return {
      source: data.source,
      count: data.count,
      articles: data.articles.slice(0, 20).map((article) => ({
        headline: article.headline ?? "",
        description: (article.description ?? "").slice(0, 200),
        published: article.published ?? "",
      })),
    };
  }

  if (name === "optimize_lineup") {
    const { salary_cap = 50000, exclude_player_ids = [] } = args;
    const poolData = await getPlayerPool();
    const result = greedyOptimize(
      poolData.players,
      salary_cap,
      exclude_player_ids
    );

    return {
      lineup: result.lineup.map((p) => ({
        playerId: p.playerId,
        name: p.name,
        team: p.teamAbbr,
        position: p.position,
        slot: p.slot,
        salary: p.projection.salary,
        projectedFP: p.projection.fantasyPoints,
        value: (p.projection.fantasyPoints / (p.projection.salary / 1000)).toFixed(2),
      })),
      totalSalary: result.totalSalary,
      totalProjFP: result.totalProjFP,
    };
  }

  throw new Error(`Unknown tool: ${name}`);
}

interface BuildLineupResult {
  lineup: Array<{
    playerId: number;
    name: string;
    team: string;
    position: string;
    slot: string;
    salary: number;
    projectedFP: number;
    value: string;
    reasoning?: string;
  }>;
  totalSalary: number;
  totalProjectedFP: number;
  summary: string;
  toolCallTrace: string[];
}

export async function buildLineup(
  userRequest: string
): Promise<BuildLineupResult> {
  const start = Date.now();
  logger.info("agent", "buildLineup started", { request: userRequest.slice(0, 120) });

  const systemPrompt = `You are FanDraft, an AI coach for daily fantasy basketball. Tonight's game is Spurs @ Thunder, WCF Game 5 (8:30 PM ET, series tied 2-2).

Your task: Build an 8-player lineup under $50,000 salary cap.

Process:
1. Call get_player_pool first to see available players
2. Call get_injuries to check for any ruled-out players
3. Call optimize_lineup (passing exclude_player_ids for anyone ruled out)
4. Return your picks with sharp two-sentence reasoning for each player

Focus on value, matchup advantages, and injury considerations.

ALWAYS call get_player_pool first, then get_injuries, then optimize_lineup. Do this regardless of how the user phrases their request — even "hi" or one-word inputs mean "build me tonight's lineup."`;

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userRequest },
  ];

  const toolCallTrace: string[] = [];
  let optimizerRan = false;
  let latestLineup: any = null;

  for (let iteration = 0; iteration < 5; iteration++) {
    logger.debug("agent", `Loop iteration ${iteration + 1}`);

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      tools,
      tool_choice: iteration === 0
        ? { type: "function", function: { name: "get_player_pool" } }
        : "auto",
      temperature: 0.3,
    });

    const assistantMessage = response.choices[0].message;
    messages.push(assistantMessage);

    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      logger.info("agent", `Loop finished at iteration ${iteration + 1} (no tool calls)`);
      break;
    }

    for (const toolCall of assistantMessage.tool_calls) {
      if (toolCall.type !== "function") continue;

      const toolName = toolCall.function.name;
      const toolArgs = JSON.parse(toolCall.function.arguments);
      const toolTrace = `${toolName}(${JSON.stringify(toolArgs)})`;
      toolCallTrace.push(toolTrace);

      logger.info("agent", `Tool call: ${toolTrace}`);

      try {
        const result = await executeTool(toolName, toolArgs);

        if (toolName === "optimize_lineup") {
          optimizerRan = true;
          latestLineup = result;
          logger.info("agent", "optimize_lineup result", {
            players: (result as any).lineup?.length,
            totalSalary: (result as any).totalSalary,
            totalProjFP: (result as any).totalProjFP,
          });
        } else {
          logger.debug("agent", `Tool ${toolName} returned`, {
            keys: Object.keys(result as object),
          });
        }

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        });
      } catch (toolError) {
        logger.error("agent", `Tool ${toolName} threw an error`, {
          error: toolError instanceof Error ? toolError.message : String(toolError),
        });
        throw toolError;
      }
    }
  }

  if (!optimizerRan) {
    logger.warn("agent", "Optimizer never ran — force-running fallback");
    toolCallTrace.push("optimize_lineup(forced_fallback)");
    const poolData = await getPlayerPool();
    latestLineup = greedyOptimize(poolData.players, 50000, []);
    latestLineup = {
      lineup: latestLineup.lineup.map((p: LineupPlayer) => ({
        playerId: p.playerId,
        name: p.name,
        team: p.teamAbbr,
        position: p.position,
        slot: p.slot,
        salary: p.projection.salary,
        projectedFP: p.projection.fantasyPoints,
        value: (p.projection.fantasyPoints / (p.projection.salary / 1000)).toFixed(2),
      })),
      totalSalary: latestLineup.totalSalary,
      totalProjFP: latestLineup.totalProjFP,
    };
  }

  logger.info("agent", "Starting synthesis call (gpt-4o)");

  messages.push({
    role: "user",
    content: `Now provide a final summary as JSON with this exact structure:
{
  "summary": "Brief 2-3 sentence overview of the lineup strategy",
  "picks": [
    { "playerId": 123456, "reasoning": "Two sharp sentences explaining this pick" }
  ]
}`,
  });

  const synthesisResponse = await openai.chat.completions.create({
    model: "gpt-4o",
    messages,
    response_format: { type: "json_object" },
    temperature: 0.5,
  });

  const rawSynthesis = synthesisResponse.choices[0].message.content || "{}";
  logger.debug("agent", "Synthesis raw response", { length: rawSynthesis.length });

  const synthesis = JSON.parse(rawSynthesis);

  const reasoningMap = new Map(
    synthesis.picks?.map((p: any) => [p.playerId, p.reasoning]) || []
  );

  const lineupWithReasoning = latestLineup.lineup.map((player: any) => ({
    ...player,
    reasoning: reasoningMap.get(player.playerId) || "Strategic pick for lineup balance.",
  }));

  const durationMs = Date.now() - start;
  logger.info("agent", "buildLineup complete", {
    durationMs,
    toolCalls: toolCallTrace.length,
    lineupSize: lineupWithReasoning.length,
  });

  return {
    lineup: lineupWithReasoning,
    totalSalary: latestLineup.totalSalary,
    totalProjectedFP: latestLineup.totalProjFP,
    summary: synthesis.summary || "Lineup optimized for maximum value.",
    toolCallTrace,
  };
}
