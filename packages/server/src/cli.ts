#!/usr/bin/env node

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
  secretKey: process.env.GALINUM_SECRET_KEY,
  publishableKey: process.env.GALINUM_PUBLISHABLE_KEY,
  media: config.mediaDirectory
    ? new FileMediaStore(config.mediaDirectory, config.publicOrigin)
    : new MemoryMediaStore(config.publicOrigin),
};
const product = process.env.DATABASE_URL
  ? await createPostgresProduct({ ...productOptions, connectionString: process.env.DATABASE_URL })
  : createLocalProduct(productOptions);
const server = createServer(nodeAdapter(createApp(product.handlers, product.media)));
server.listen(config.port, config.host, () => {
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : config.port;
  process.stdout.write(`Galinum listening on http://${config.host}:${boundPort}\n`);
  process.stdout.write(`Project: ${product.projectId}\n`);
  if (!process.env.GALINUM_SECRET_KEY) process.stdout.write(`Local secret key: ${product.secretKey}\n`);
  if (!process.env.GALINUM_PUBLISHABLE_KEY) process.stdout.write(`Local publishable key: ${product.publishableKey}\n`);
});
