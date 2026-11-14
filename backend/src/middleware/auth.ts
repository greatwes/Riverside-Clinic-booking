import type { NextFunction, Request, Response } from "express";

export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.API_KEY;
  const provided = req.header("X-API-Key");

  if (!expected) {
    // Misconfigured server: fail closed rather than silently accepting every request.
    res.status(500).json({ error: "server is missing API_KEY configuration" });
    return;
  }

  if (!provided || provided !== expected) {
    res.status(401).json({ error: "missing or invalid API key" });
    return;
  }

  next();
}
