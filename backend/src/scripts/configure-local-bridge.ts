import { readFile } from "node:fs/promises";
import { prisma } from "../lib/prisma.js";
import { updateOperationalConfig } from "../modules/system/operational-config.js";

const [bridgeUrl, keyFile] = process.argv.slice(2);
if (!bridgeUrl || !keyFile) {
  throw new Error("usage: configure-local-bridge <bridge-url> <bridge-key-file>");
}

const bridgeKey = (keyFile === "-"
  ? await new Promise<string>((resolve, reject) => {
      let value = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { value += chunk; });
      process.stdin.on("end", () => resolve(value));
      process.stdin.on("error", reject);
    })
  : await readFile(keyFile, "utf8")).trim();
if (!bridgeKey) throw new Error("bridge key file is empty");

await updateOperationalConfig({ mt5BridgeUrl: bridgeUrl, mt5BridgeApiKey: bridgeKey });
await prisma.$disconnect();
console.log("Local MT5 bridge settings saved to the database.");
// This is a one-shot launcher command. Some imported runtime modules keep
// handles alive, so terminate after Prisma has flushed and disconnected.
process.exit(0);
