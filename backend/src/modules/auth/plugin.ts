import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fastifyJwt from "@fastify/jwt";
import { config } from "../../config.js";

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

export async function authPlugin(app: FastifyInstance) {
  await app.register(fastifyJwt, { secret: config.JWT_SECRET, sign: { expiresIn: config.JWT_EXPIRES_IN } });

  app.decorate("authenticate", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      await reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.decorate("requireRole", (...roles: JwtUser["role"][]) => {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        await req.jwtVerify();
      } catch {
        return reply.code(401).send({ error: "unauthorized" });
      }
      if (!roles.includes(req.user.role)) {
        return reply.code(403).send({ error: "forbidden" });
      }
    };
  });
}
