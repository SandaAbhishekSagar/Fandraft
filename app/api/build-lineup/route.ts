import { buildLineup } from "@/lib/agent";
import { logger } from "@/lib/logger";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: Request) {
  const start = Date.now();

  if (!process.env.OPENAI_API_KEY) {
    logger.error("route", "OPENAI_API_KEY is not set");
    return NextResponse.json(
      { error: "OPENAI_API_KEY is not configured. Add it in your Vercel environment variables." },
      { status: 500 }
    );
  }

  let body: { request?: string };
  try {
    body = await req.json();
  } catch (parseError) {
    logger.error("route", "Failed to parse request body", {
      error: String(parseError),
    });
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.request || typeof body.request !== "string" || body.request.trim() === "") {
    logger.warn("route", "Rejected: request field missing or empty", { body });
    return NextResponse.json(
      { error: "Request must be a non-empty string" },
      { status: 400 }
    );
  }

  logger.info("route", "Build lineup request received", {
    request: body.request.slice(0, 120),
  });

  try {
    const result = await buildLineup(body.request);
    const ms = Date.now() - start;

    logger.info("route", "Build lineup succeeded", {
      durationMs: ms,
      players: result.lineup.length,
      totalSalary: result.totalSalary,
      totalProjectedFP: result.totalProjectedFP,
      toolCallTrace: result.toolCallTrace,
    });

    return NextResponse.json(result);
  } catch (error) {
    const ms = Date.now() - start;

    logger.error("route", "Build lineup failed", {
      durationMs: ms,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    const errorMessage =
      error instanceof Error ? error.message : "An unexpected error occurred";

    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
