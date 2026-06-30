import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function main() {
  const logPath = resolve("storage", "crawler.log");
  if (!existsSync(logPath)) {
    console.log("No crawler.log found.");
    return;
  }

  console.log("=== PARSING CRAWLER.LOG FOR ERRORS ===");
  const content = readFileSync(logPath, "utf8");
  const lines = content.split("\n");
  
  let errorCount = 0;
  const errorLines: string[] = [];

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.includes("error") || lower.includes("fail") || lower.includes("exception") || lower.includes("reject")) {
      errorCount++;
      if (errorLines.length < 50) {
        errorLines.push(line);
      }
    }
  }

  console.log(`Total lines with error/fail keywords: ${errorCount} out of ${lines.length} total lines.`);
  console.log("\nSample error lines (up to 50):");
  if (errorLines.length === 0) {
    console.log("None");
  } else {
    errorLines.forEach((l, idx) => console.log(`${idx + 1}: ${l.trim()}`));
  }
}

main();
