import OpenAI from "openai";
import { getPlayerPool, getInjuries, Player } from "./data-source";

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
  excludeIds: number[] = []
): OptimizeResult {
  const slots = ["PG", "SG", "SF", "PF", "C", "G", "F", "UTIL"];
  const lineup: LineupPlayer[] = [];
  const chosenIds = new Set<number>();
  let remainingCap = salaryCap;

  const candidates = pool
    .filter((p) => !excludeIds.includes(p.playerId))
    .map((p) => ({
      ...p,
      value: p.projection.fantasyPoints / (p.projection.salary / 1000),
    }))
    .sort((a, b) => b.value - a.value);

  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const slotsRemaining = slots.length - i;
    const reservePerSlot = 3000;
    const maxSpend = remainingCap - (slotsRemaining - 1) * reservePerSlot;

    const pick = candidates.find(
      (p) =>
        !chosenIds.has(p.playerId) &&
        p.slots.includes(slot) &&
        p.projection.salary <= maxSpend
    );

    if (pick) {
      lineup.push({ ...pick, slot });
      chosenIds.add(pick.playerId);
      remainingCap -= pick.projection.salary;
    }
  }

  const totalSalary = lineup.reduce((sum, p) => sum + p.projection.salary, 0);
  const totalProjFP = lineup.reduce(
    (sum, p) => sum + p.projection.fantasyPoints,
    0
  );

  return { lineup, totalSalary, totalProjFP };
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
        headline: article.headline,
        description: article.description.slice(0, 200),
        published: article.published,
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
  const systemPrompt = `You are FanDraft, an AI coach for daily fantasy basketball. Tonight's game is Spurs @ Thunder, WCF Game 5 (8:30 PM ET, series tied 2-2).

Your task: Build an 8-player lineup under $50,000 salary cap.

Process:
1. Call get_player_pool first to see available players
2. Call get_injuries to check for any ruled-out players
3. Call optimize_lineup (passing exclude_player_ids for anyone ruled out)
4. Return your picks with sharp two-sentence reasoning for each player

Focus on value, matchup advantages, and injury considerations.`;

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userRequest },
  ];

  const toolCallTrace: string[] = [];
  let optimizerRan = false;
  let latestLineup: any = null;

  for (let iteration = 0; iteration < 5; iteration++) {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      tools,
      tool_choice: "auto",
      temperature: 0.3,
    });

    const assistantMessage = response.choices[0].message;
    messages.push(assistantMessage);

    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      break;
    }

    for (const toolCall of assistantMessage.tool_calls) {
      if (toolCall.type !== "function") continue;
      
      const toolName = toolCall.function.name;
      const toolArgs = JSON.parse(toolCall.function.arguments);

      toolCallTrace.push(`${toolName}(${JSON.stringify(toolArgs)})`);

      const result = await executeTool(toolName, toolArgs);

      if (toolName === "optimize_lineup") {
        optimizerRan = true;
        latestLineup = result;
      }

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }
  }

  if (!optimizerRan) {
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

  const synthesis = JSON.parse(
    synthesisResponse.choices[0].message.content || "{}"
  );

  const reasoningMap = new Map(
    synthesis.picks?.map((p: any) => [p.playerId, p.reasoning]) || []
  );

  const lineupWithReasoning = latestLineup.lineup.map((player: any) => ({
    ...player,
    reasoning: reasoningMap.get(player.playerId) || "Strategic pick for lineup balance.",
  }));

  return {
    lineup: lineupWithReasoning,
    totalSalary: latestLineup.totalSalary,
    totalProjectedFP: latestLineup.totalProjFP,
    summary: synthesis.summary || "Lineup optimized for maximum value.",
    toolCallTrace,
  };
}
