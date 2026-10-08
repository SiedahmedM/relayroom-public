#!/usr/bin/env node
import { resolve } from "node:path";
import { startServer } from "./server.js";

const pepper = process.env.RELAYROOM_SECRET_PEPPER;
if (!pepper) {
  console.error("RELAYROOM_SECRET_PEPPER is required. Generate one with: openssl rand -base64 32");
  process.exit(1);
}

const running = await startServer({
  port: Number.parseInt(process.env.PORT ?? "8787", 10),
  host: process.env.HOST ?? "127.0.0.1",
  databasePath: resolve(process.env.RELAYROOM_DB ?? "./relayroom.db"),
  pepper,
  ...(process.env.RELAYROOM_PUBLIC_URL ? { publicUrl: process.env.RELAYROOM_PUBLIC_URL } : {}),
  retentionHours: Number.parseInt(process.env.RELAYROOM_RETENTION_HOURS ?? "72", 10),
  trustedProxyAddresses: (process.env.RELAYROOM_TRUSTED_PROXIES ?? "").split(",").map((ip) => ip.trim()).filter(Boolean),
});

console.log(`RelayRoom listening at ${running.url}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await running.close();
    process.exit(0);
  });
}
