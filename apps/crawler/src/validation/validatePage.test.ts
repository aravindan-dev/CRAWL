import { describe, it, expect } from "vitest";
import { classifyPage } from "./validatePage.js";
import { LinkStatus, type ExtractedPage } from "@clg/shared";

function pageOf(partial: Partial<ExtractedPage>): ExtractedPage {
  return {
    requested_url: "https://ex.edu/x",
    final_url: "https://ex.edu/x",
    page_title: "",
    lang: "en",
    visible_text: "",
    headings: [],
    paragraphs: [],
    lists: [],
    tables: [],
    internal_links: [],
    content_blocks: [],
    raw_html: "",
    ...partial,
  };
}

const LONG_COURSE_TEXT =
  "This Bachelor of Nursing course prepares students for clinical practice. Entry requirements: " +
  "applicants must hold a senior secondary certificate. International students require IELTS 6.5. " +
  "Admission is competitive and applications open in August. ".repeat(5);

describe("classifyPage — bot-challenge detection", () => {
  it("classifies a Cloudflare 'Just a moment...' page as BLOCKED even with HTTP 200", () => {
    const r = classifyPage({
      httpStatus: 200,
      requestedUrl: "https://ex.edu/x",
      page: pageOf({ page_title: "Just a moment...", visible_text: "Verifying you are human" }),
    });
    expect(r.status).toBe(LinkStatus.BLOCKED);
    expect(r.reason).toBe("bot-challenge");
  });

  it("detects the challenge from the raw html when title/text are empty", () => {
    const r = classifyPage({
      httpStatus: 200,
      requestedUrl: "https://ex.edu/x",
      page: pageOf({ raw_html: '<script src="https://challenges.cloudflare.com/x.js"></script>' }),
    });
    expect(r.status).toBe(LinkStatus.BLOCKED);
    expect(r.reason).toBe("bot-challenge");
  });

  it("detects a 403-delivered challenge as bot-challenge (not just http 403)", () => {
    const r = classifyPage({
      httpStatus: 403,
      requestedUrl: "https://ex.edu/x",
      page: pageOf({ page_title: "Attention Required! | Cloudflare" }),
    });
    expect(r.reason).toBe("bot-challenge");
    expect(r.status).toBe(LinkStatus.BLOCKED);
  });

  it("does NOT flag a normal course page containing the word 'moment'", () => {
    const r = classifyPage({
      httpStatus: 200,
      requestedUrl: "https://ex.edu/x",
      page: pageOf({ page_title: "Bachelor of Nursing", visible_text: LONG_COURSE_TEXT }),
    });
    expect(r.reason).not.toBe("bot-challenge");
    expect(r.status).toBe(LinkStatus.VALID_COURSE_PAGE);
  });

  it("still classifies plain http 4xx/5xx without challenge markers by status", () => {
    const r = classifyPage({
      httpStatus: 404,
      requestedUrl: "https://ex.edu/x",
      page: pageOf({ page_title: "Some page" }),
    });
    expect(r.status).toBe(LinkStatus.BROKEN_LINK);
  });
});
