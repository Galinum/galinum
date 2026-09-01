import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(file));
    else files.push(file);
  }
  return files;
}

function slug(value) {
  return value
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function routeFor(file, docsRoot) {
  const route = relative(docsRoot, file).replace(/\.(md|mdx)$/, "");
  return route === "index" ? "/" : `/${route.replace(/\/index$/, "")}`;
}

export function checkDocs(docsRoot) {
  const failures = [];
  const contentFiles = walk(docsRoot).filter((file) => [".md", ".mdx"].includes(extname(file)));
  const routes = new Map(contentFiles.map((file) => [routeFor(file, docsRoot), file]));
  const config = JSON.parse(readFileSync(join(docsRoot, "docs.json"), "utf8"));
  const contract = JSON.parse(readFileSync(join(docsRoot, config.navigation.tabs.find((tab) => tab.openapi)?.openapi), "utf8"));

  for (const tab of config.navigation.tabs) {
    for (const group of tab.groups ?? []) {
      for (const page of group.pages ?? []) {
        const operation = /^(GET|POST|PUT|PATCH|DELETE) (.+)$/.exec(page);
        if (operation) {
          if (!contract.paths?.[operation[2]]?.[operation[1].toLowerCase()]) failures.push(`navigation operation is missing from OpenAPI: ${page}`);
        } else if (!routes.has(page === "index" ? "/" : `/${page}`)) failures.push(`navigation page is missing: ${page}`);
      }
    }
  }

  for (const asset of [config.logo?.light, config.logo?.dark, config.favicon].filter(Boolean)) {
    if (!existsSync(join(docsRoot, asset))) failures.push(`configured asset is missing: ${asset}`);
  }

  for (const file of contentFiles) {
    const contents = readFileSync(file, "utf8");
    const markdownLinks = [...contents.matchAll(/\]\((\/[^)\s]+)\)/g)].map((match) => match[1]);
    const componentLinks = [...contents.matchAll(/\bhref=["'](\/[^"']+)["']/g)].map((match) => match[1]);
    for (const link of [...markdownLinks, ...componentLinks]) {
      const [target, anchor] = link.split("#");
      const destination = routes.get(target || routeFor(file, docsRoot));
      if (!destination) {
        failures.push(`${relative(docsRoot, file)} links to missing page ${target}`);
        continue;
      }
      if (anchor) {
        const targetContents = readFileSync(destination, "utf8");
        const anchors = new Set([...targetContents.matchAll(/^#{1,6}\s+(.+)$/gm)].map((heading) => slug(heading[1])));
        if (!anchors.has(anchor)) failures.push(`${relative(docsRoot, file)} links to missing anchor ${target}#${anchor}`);
      }
    }
  }

  return failures;
}

function main() {
  const docsRoot = resolve(import.meta.dirname, "../apps/docs");
  const failures = checkDocs(docsRoot);
  if (failures.length) {
    failures.forEach((failure) => process.stderr.write(`${failure}\n`));
    process.exit(1);
  }
  process.stdout.write("VERIFIED docs navigation, OpenAPI routes, assets, pages, anchors, and internal links\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
