import { PrismaClient } from "@prisma/client";
import { config } from "../config.js";

// Prisma resolves DATABASE_URL directly from process.env rather than through
// the application config. Supply the safe local default when no deployment
// secret manager has provided one, so normal development no longer needs .env.
process.env.DATABASE_URL ??= config.DATABASE_URL;

export const prisma = new PrismaClient();
