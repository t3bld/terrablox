import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  return NextResponse.json({
    status: "ok",
    message: "TerraBLox API is running",
    version: "0.1.0",
  });
}

