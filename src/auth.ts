import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}
const secret = () => {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 24)
    throw new Error("JWT_SECRET must be set to at least 24 characters");
  return process.env.JWT_SECRET;
};
export const makeToken = (userId: string) =>
  jwt.sign({ sub: userId }, secret(), { expiresIn: "7d" });
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "Sign in to continue." });
  try {
    const payload = jwt.verify(token, secret());
    if (typeof payload === "string" || !payload.sub) throw new Error("Invalid token");
    req.userId = payload.sub;
    next();
  } catch {
    return res
      .status(401)
      .json({ error: "Your session is invalid or expired. Please sign in again." });
  }
}
