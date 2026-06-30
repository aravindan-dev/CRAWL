import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function main() {
  const logPath = resolve("storage", "crawler.log");
  if (!existsSync(logPath)) {
    console.log("No crawler.log found.");
    return;
  }
  const content = readFileSync(logPath, "utf8");
  const lines = content.trim().split("\n");
  console.log(`=== LAST 100 LINES OF CRAWLER.LOG ===`);
  const start = Math.max(0, lines.length - 100);
  for (let i = start; i < lines.length; i++) {
    console.log(`${i + 1}: ${lines[i]}`);
  }
}

main();
