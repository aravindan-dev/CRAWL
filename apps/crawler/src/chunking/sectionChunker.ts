import type { ContentBlock, Section, TableJSON } from "@clg/shared";

const MAX_CHUNK_CHARS = 6000;

export interface ChunkContext {
  source_url: string;
  page_title: string;
  university_id: string;
}

interface Accumulator {
  heading: string | null;
  bodyParts: string[];
  tables: TableJSON[];
}

/**
 * Split cleaned blocks into Sections (Section 24): break on h1/h2/h3, attach
 * paragraphs/lists/tables to the current heading, cap each chunk at 6000 chars
 * (repeating the heading across overflow chunks).
 */
export function chunkSections(blocks: ContentBlock[], ctx: ChunkContext): Section[] {
  const sections: Section[] = [];
  let acc: Accumulator = { heading: null, bodyParts: [], tables: [] };
  let chunkIndex = 0;

  const flush = () => {
    const body = acc.bodyParts.join("\n").trim();
    if (!body && acc.tables.length === 0) return;
    for (const piece of splitBody(body)) {
      sections.push({
        heading: acc.heading,
        body: piece,
        tables: acc.tables,
        source_url: ctx.source_url,
        page_title: ctx.page_title,
        university_id: ctx.university_id,
        chunk_index: chunkIndex++,
      });
    }
    acc = { heading: acc.heading, bodyParts: [], tables: [] };
  };

  for (const block of blocks) {
    if (block.type === "heading") {
      flush();
      acc = { heading: block.text, bodyParts: [], tables: [] };
    } else if (block.type === "paragraph") {
      acc.bodyParts.push(block.text);
    } else if (block.type === "list") {
      acc.bodyParts.push(block.items.map((i) => `- ${i}`).join("\n"));
    } else if (block.type === "table") {
      acc.tables.push(block.table);
      acc.bodyParts.push(tableToText(block.table));
    }
  }
  flush();

  return sections;
}

/** Split a body string into <= MAX_CHUNK_CHARS pieces on paragraph boundaries. */
function splitBody(body: string): string[] {
  if (body.length <= MAX_CHUNK_CHARS) return body ? [body] : [];
  const paras = body.split(/\n{2,}/);
  const pieces: string[] = [];
  let current = "";
  for (const p of paras) {
    if ((current + "\n\n" + p).length > MAX_CHUNK_CHARS && current) {
      pieces.push(current.trim());
      current = p;
    } else {
      current = current ? `${current}\n\n${p}` : p;
    }
    // A single oversized paragraph: hard-split.
    while (current.length > MAX_CHUNK_CHARS) {
      pieces.push(current.slice(0, MAX_CHUNK_CHARS));
      current = current.slice(MAX_CHUNK_CHARS);
    }
  }
  if (current.trim()) pieces.push(current.trim());
  return pieces;
}

function tableToText(table: TableJSON): string {
  const lines: string[] = [];
  if (table.caption) lines.push(table.caption);
  if (table.headers.length) lines.push(table.headers.join(" | "));
  for (const row of table.rows) lines.push(row.join(" | "));
  return lines.join("\n");
}
