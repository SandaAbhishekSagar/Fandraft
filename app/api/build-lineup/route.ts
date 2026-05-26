import { buildLineup } from "@/lib/agent";
import { NextResponse } from "next/server";

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function POST(req: Request) {
  try {
    const body = await req.json();

    if (!body.request || typeof body.request !== "string" || body.request.trim() === "") {
      return NextResponse.json(
        { error: "Request must be a non-empty string" },
        { status: 400 }
      );
    }

    const result = await buildLineup(body.request);

    return NextResponse.json(result);
  } catch (error) {
    console.error("Error building lineup:", error);
    
    const errorMessage = error instanceof Error ? error.message : "An unexpected error occurred";
    
    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}
