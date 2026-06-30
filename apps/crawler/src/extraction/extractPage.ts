import type { Page } from "playwright";
import type { ContentBlock, ExtractedPage, TableJSON } from "@clg/shared";
import { resolveUrl } from "@clg/shared";

interface RawExtraction {
  page_title: string;
  lang: string | null;
  visible_text: string;
  content_blocks: ContentBlock[];
  raw_links: { href: string; text: string }[];
}

/**
 * Extract structured content from a loaded page (Section 20). The DOM walk runs
 * in the browser via page.evaluate and returns blocks in document order so the
 * chunker can split by heading. Tables are preserved as JSON.
 */
export async function extractPage(page: Page, requestedUrl: string): Promise<ExtractedPage> {
  const finalUrl = page.url();

  const raw = await page.evaluate((): RawExtraction => {
    const blocks: ContentBlock[] = [];

    const cellText = (el: Element): string => (el.textContent ?? "").replace(/\s+/g, " ").trim();

    const parseTable = (table: HTMLTableElement): TableJSON => {
      const caption = table.querySelector("caption");
      const headerCells = Array.from(table.querySelectorAll("thead th, tr th"));
      const headers = headerCells.map((c) => cellText(c)).filter(Boolean);
      const rows: string[][] = [];
      for (const tr of Array.from(table.querySelectorAll("tbody tr, tr"))) {
        const cells = Array.from(tr.querySelectorAll("td"));
        if (cells.length === 0) continue;
        rows.push(cells.map((c) => cellText(c)));
      }
      return {
        caption: caption ? cellText(caption) : null,
        headers,
        rows,
      };
    };

    const selector = "h1, h2, h3, p, ul, ol, table";
    const elements = Array.from(document.querySelectorAll(selector));
    for (const el of elements) {
      const tag = el.tagName.toLowerCase();
      // Skip elements nested inside a list/table we already handle as a unit.
      if ((tag === "p" || tag === "ul" || tag === "ol") && el.closest("table, li")) continue;

      if (tag === "h1" || tag === "h2" || tag === "h3") {
        const text = cellText(el);
        if (text) blocks.push({ type: "heading", level: Number(tag[1]) as 1 | 2 | 3, text });
      } else if (tag === "p") {
        const text = cellText(el);
        if (text) blocks.push({ type: "paragraph", text });
      } else if (tag === "ul" || tag === "ol") {
        const items = Array.from(el.querySelectorAll(":scope > li")).map((li) => cellText(li)).filter(Boolean);
        if (items.length) blocks.push({ type: "list", items });
      } else if (tag === "table") {
        blocks.push({ type: "table", table: parseTable(el as HTMLTableElement) });
      }
    }

    const main = document.querySelector("main") ?? document.body;
    return {
      page_title: document.title ?? "",
      lang: document.documentElement.getAttribute("lang"),
      visible_text: (main as HTMLElement)?.innerText ?? "",
      content_blocks: blocks,
      raw_links: Array.from(document.querySelectorAll("a[href]")).map((a) => ({
        href: (a as HTMLAnchorElement).getAttribute("href") ?? "",
        text: (a.textContent ?? "").replace(/\s+/g, " ").trim(),
      })),
    };
  });

  const internal_links = raw.raw_links
    .map((l) => ({ url: resolveUrl(l.href, finalUrl), text: l.text }))
    .filter((l): l is { url: string; text: string } => l.url !== null);

  const headings = raw.content_blocks
    .filter((b): b is Extract<ContentBlock, { type: "heading" }> => b.type === "heading")
    .map((b) => ({ tag: `h${b.level}` as "h1" | "h2" | "h3", text: b.text }));
  const paragraphs = raw.content_blocks
    .filter((b): b is Extract<ContentBlock, { type: "paragraph" }> => b.type === "paragraph")
    .map((b) => b.text);
  const lists = raw.content_blocks
    .filter((b): b is Extract<ContentBlock, { type: "list" }> => b.type === "list")
    .map((b) => b.items);
  const tables = raw.content_blocks
    .filter((b): b is Extract<ContentBlock, { type: "table" }> => b.type === "table")
    .map((b) => b.table);

  const raw_html = await page.content();

  return {
    requested_url: requestedUrl,
    final_url: finalUrl,
    page_title: raw.page_title,
    lang: raw.lang,
    visible_text: raw.visible_text,
    headings,
    paragraphs,
    lists,
    tables,
    internal_links,
    content_blocks: raw.content_blocks,
    raw_html,
  };
}
