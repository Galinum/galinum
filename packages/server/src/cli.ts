#!/usr/bin/env node

import { startPushWorker } from "./push-worker.js";
import { createServer } from "node:http";
import { createApp } from "./app.js";
import { nodeAdapter } from "./node-adapter.js";
import { createLocalProduct } from "./local-product.js";
import { createPostgresProduct } from "./postgres-product.js";
import { FileMediaStore, MemoryMediaStore } from "./local-media-store.js";
import { serverConfig } from "./server-config.js";

if (process.argv[2] === "--help") {
  process.stdout.write("Usage: galinum-server\n");
  process.exit(0);
}

const config = serverConfig(process.env);
if (config.warning) process.stderr.write(`${config.warning}\n`);

const productOptions = {
  pushEncryptionKey: process.env.GALINUM_PUSH_ENCRYPTION_KEY,
  secretKey: process.env.GALINUM_SECRET_KEY,
  publishableKey: process.env.GALINUM_PUBLISHABLE_KEY,
  media: config.mediaDirectory
    ? new FileMediaStore(config.mediaDirectory, config.publicOrigin)
    : new MemoryMediaStore(config.publicOrigin),
};
const product = process.env.DATABASE_URL
  ? await createPostgresProduct({ ...productOptions, connectionString: process.env.DATABASE_URL })
  : createLocalProduct(productOptions);
const worker = startPushWorker(() => product.push.runDue(), Number(process.env.GALINUM_PUSH_WORKER_INTERVAL_MS ?? 1000), () => process.stderr.write("Push worker could not complete one or more campaigns\n"));
const server = createServer(nodeAdapter(createApp(product.handlers, product.media)));
server.listen(config.port, config.host, () => {
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : config.port;
  process.stdout.write(`Galinum listening on http://${config.host}:${boundPort}\n`);
  process.stdout.write(`Project: ${product.projectId}\n`);
  if (!process.env.GALINUM_SECRET_KEY) process.stdout.write(`Local secret key: ${product.secretKey}\n`);
  if (!process.env.GALINUM_PUBLISHABLE_KEY) process.stdout.write(`Local publishable key: ${product.publishableKey}\n`);
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await worker.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await product.close();
}
process.on("SIGTERM", () => { void shutdown(); });
process.on("SIGINT", () => { void shutdown(); });
