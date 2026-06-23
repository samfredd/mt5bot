import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fastifyJwt from "@fastify/jwt";
import { config } from "../../config.js";
import { isTokenRevoked } from "./service.js";

export interface JwtUser {
  id: string;
  email: string;
  role: "ADMIN" | "MANAGER" | "VIEWER";
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    user: JwtUser;
  }
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole: (...roles: JwtUser["role"][]) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

// A non-expiring session: when JWT_EXPIRES_IN is one of these, tokens are
// signed with no `exp` claim so the user is never auto-logged-out by age.
// Revocation (logout / admin) still works — it keys off `iat`, not `exp`.
const NEVER = new Set(["never", "none", "off", "0", ""]);

export async function authPlugin(app: FastifyInstance) {
  const neverExpires = NEVER.has(config.JWT_EXPIRES_IN.trim().toLowerCase());
  await app.register(fastifyJwt, {
    secret: config.JWT_SECRET,
    // Omit `expiresIn` entirely for a permanent session — passing it (even as
    // a large value) still stamps an `exp`, which would eventually log you out.
    sign: neverExpires ? {} : { expiresIn: config.JWT_EXPIRES_IN },
  });

  // Reject a structurally-valid token that has been revoked (logout).
  const revoked = (req: FastifyRequest) =>
    isTokenRevoked(req.user.id, (req.user as { iat?: number }).iat);

  app.decorate("authenticate", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: "unauthorized" });
    }
    if (await revoked(req)) return reply.code(401).send({ error: "session ended — please sign in again" });
  });

  app.decorate("requireRole", (...roles: JwtUser["role"][]) => {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        await req.jwtVerify();
      } catch {
        return reply.code(401).send({ error: "unauthorized" });
      }
      if (await revoked(req)) return reply.code(401).send({ error: "session ended — please sign in again" });
      if (!roles.includes(req.user.role)) {
        return reply.code(403).send({ error: "forbidden" });
      }
    };
  });
}
