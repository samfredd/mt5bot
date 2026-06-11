import pino from "pino";
import { config } from "../config.js";

// Redact anything secret-shaped so credentials can never leak into logs.
export const logger = pino({
  level: config.NODE_ENV === "production" ? "info" : "debug",
  redact: {
    paths: [
      "password",
      "passwordHash",
      "passwordEnc",
      "*.password",
      "*.token",
      "*.secret",
      "headers.authorization",
      "req.headers.authorization",
    ],
    censor: "[REDACTED]",
  },
});
