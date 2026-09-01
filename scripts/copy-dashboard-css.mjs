import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
mkdirSync(resolve(root, "packages/dashboard/dist"), { recursive: true });
copyFileSync(
  resolve(root, "packages/dashboard/src/tokens.css"),
  resolve(root, "packages/dashboard/dist/tokens.css"),
);
