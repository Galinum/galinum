import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const page = new URL("skill/claude-code.mdx", root);
const original = readFileSync(page, "utf8");
let output = original;
for (const [name, fence] of [["SKILL.md", "````"], ["references/api.md", "`````"]]) {
  const marker = `<Accordion title=".claude/skills/galinum/${name}">`;
  const markerIndex = output.indexOf(marker);
  if (markerIndex < 0) throw new Error(`Missing skill accordion: ${name}`);
  const start = output.indexOf(`${fence}markdown\n`, markerIndex);
  const end = output.indexOf(`\n${fence}\n`, start + fence.length);
  if (start < 0 || end < 0) throw new Error(`Missing skill fence: ${name}`);
  const source = readFileSync(new URL(`skill/galinum/${name}`, root), "utf8").trim();
  output = output.slice(0, start) + `${fence}markdown\n${source}` + output.slice(end);
}
if (process.argv.includes("--check")) {
  if (original !== output) throw new Error("Skill page embeds are stale");
} else {
  writeFileSync(page, output);
}
console.log("VERIFIED skill page embeds");
