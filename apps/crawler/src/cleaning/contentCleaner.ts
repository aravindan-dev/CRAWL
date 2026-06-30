import type { ContentBlock, ExtractedPage } from "@clg/shared";

/** Boilerplate phrases to drop wholesale (Section 23). */
const BOILERPLATE_PATTERNS = [
  /cookie/i,
  /privacy policy/i,
  /terms (of|&) (use|service)/i,
  /all rights reserved/i,
  /©\s*\d{4}/,
  /\bshare (on|via)\b/i,
  /follow us/i,
  /sign in/i,
  /skip to (main )?content/i,
  /back to top/i,
  /subscribe to (our )?newsletter/i,
];

const MIN_LINE_LENGTH = 25;

function isBoilerplate(text: string): boolean {
  return BOILERPLATE_PATTERNS.some((re) => re.test(text));
}

/**
 * Keep a short line only when it is a list item or table-ish content; otherwise
 * lines under MIN_LINE_LENGTH are nav/menu noise (Section 23).
 */
function keepShortContext(block: ContentBlock): boolean {
  return block.type === "list" || block.type === "table";
}

export interface CleanedContent {
  blocks: ContentBlock[];
  cleaned_text: string;
  tables: ExtractedPage["tables"];
}

/**
 * Remove navigation/boilerplate from an extracted page while preserving the
 * admission-relevant content + DOM order needed for heading-aware chunking.
 */
export function cleanContent(page: ExtractedPage): CleanedContent {
  const seen = new Set<string>();
  const blocks: ContentBlock[] = [];

  for (const block of page.content_blocks) {
    if (block.type === "table") {
      blocks.push(block);
      continue;
    }
    if (block.type === "list") {
      const items = block.items.map((i) => i.trim()).filter((i) => i && !isBoilerplate(i));
      if (items.length) blocks.push({ type: "list", items });
      continue;
    }

    const text = block.text.replace(/\s+/g, " ").trim();
    if (!text || isBoilerplate(text)) continue;
    if (text.length < MIN_LINE_LENGTH && !keepShortContext(block) && block.type !== "heading") {
      continue;
    }
    // Drop repeated menu text (same line appearing many times).
    const key = `${block.type}:${text.toLowerCase()}`;
    if (block.type === "paragraph" && seen.has(key)) continue;
    seen.add(key);
    blocks.push(block.type === "heading" ? { ...block, text } : { type: "paragraph", text });
  }

  const cleaned_text = blocksToText(blocks);
  const tables = blocks.filter((b): b is Extract<ContentBlock, { type: "table" }> => b.type === "table").map((b) => b.table);

  return { blocks, cleaned_text, tables };
}

export function blocksToText(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === "heading") parts.push(`\n${"#".repeat(b.level)} ${b.text}`);
    else if (b.type === "paragraph") parts.push(b.text);
    else if (b.type === "list") parts.push(b.items.map((i) => `- ${i}`).join("\n"));
    else if (b.type === "table") parts.push(tableToText(b.table));
  }
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function tableToText(table: { caption: string | null; headers: string[]; rows: string[][] }): string {
  const lines: string[] = [];
  if (table.caption) lines.push(table.caption);
  if (table.headers.length) lines.push(table.headers.join(" | "));
  for (const row of table.rows) lines.push(row.join(" | "));
  return lines.join("\n");
}
