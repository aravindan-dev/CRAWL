import { describe, it, expect, vi, afterEach } from "vitest";
import { AnthropicEligibilityParser, type AnthropicParserConfig } from "./anthropic.js";
import type { ParserInput } from "@clg/shared";

const INPUT: ParserInput = {
  university_name: "Example University",
  source_url: "https://example.edu/courses/bsc-nursing",
  page_title: "Bachelor of Nursing",
  cleaned_text: "Bachelor of Nursing entry requirements: IELTS 6.5.",
  tables: [],
  sections: [],
};

const ENVELOPE_BODY = JSON.stringify({
  content: [{ type: "text", text: JSON.stringify({ courses: [] }) }],
});

function mockFetchOnce(status = 200, body = ENVELOPE_BODY) {
  const fn = vi.fn().mockResolvedValue({ ok: status < 400, status, text: () => Promise.resolve(body), json: () => Promise.resolve(JSON.parse(body)) });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

const baseConfig: AnthropicParserConfig = {
  apiKey: "sk-ant-test",
  maxInputChars: 12000,
  timeoutMs: 5000,
};

describe("AnthropicEligibilityParser — native Anthropic API (no baseUrl/model override)", () => {
  it("calls /v1/messages with x-api-key + anthropic-version header, model in body", async () => {
    const fetchMock = mockFetchOnce();
    const parser = new AnthropicEligibilityParser(baseConfig);
    await parser.parseEligibility(INPUT);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers.authorization).toBeUndefined();
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("claude-sonnet-4-6");
    expect(body.anthropic_version).toBeUndefined();
  });

  it("respects a custom native baseUrl when no model override is given", async () => {
    const fetchMock = mockFetchOnce();
    const parser = new AnthropicEligibilityParser({ ...baseConfig, baseUrl: "https://api.anthropic.com" });
    await parser.parseEligibility(INPUT);
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
  });
});

describe("AnthropicEligibilityParser — AWS Bedrock (baseUrl + model both set)", () => {
  const bedrockConfig: AnthropicParserConfig = {
    ...baseConfig,
    apiKey: "BedrockAPIKey-5wvf-at-285527662889",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
  };

  it("calls the Bedrock invoke path with the model URL-encoded", async () => {
    const fetchMock = mockFetchOnce();
    const parser = new AnthropicEligibilityParser(bedrockConfig);
    await parser.parseEligibility(INPUT);

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-5-sonnet-20241022-v2%3A0/invoke",
    );
  });

  it("uses Authorization: Bearer <key>, NOT x-api-key or anthropic-version header", async () => {
    const fetchMock = mockFetchOnce();
    const parser = new AnthropicEligibilityParser(bedrockConfig);
    await parser.parseEligibility(INPUT);

    const [, init] = fetchMock.mock.calls[0]!;
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer BedrockAPIKey-5wvf-at-285527662889");
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers["anthropic-version"]).toBeUndefined();
  });

  it("puts anthropic_version: bedrock-2023-05-31 in the BODY and omits the model field", async () => {
    const fetchMock = mockFetchOnce();
    const parser = new AnthropicEligibilityParser(bedrockConfig);
    await parser.parseEligibility(INPUT);

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(body.anthropic_version).toBe("bedrock-2023-05-31");
    expect(body.model).toBeUndefined();
    expect(body.system).toBeTruthy();
    expect(body.messages).toHaveLength(1);
  });

  it("still parses the response envelope correctly (Bedrock's Anthropic response shape matches native)", async () => {
    const withCourse = JSON.stringify({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            courses: [
              {
                university_name: "Example University",
                course_name: "Bachelor of Nursing",
                degree_level: "Bachelor",
                criteria: "IELTS 6.5",
                required_subjects: [],
                minimum_marks: null,
                entrance_exam: null,
                english_requirement: "IELTS 6.5",
                criteria_url: INPUT.source_url,
                source_snippet: "IELTS 6.5",
                confidence_score: 0.9,
                parser_type: "ai",
                source_language: "en",
              },
            ],
          }),
        },
      ],
    });
    mockFetchOnce(200, withCourse);
    const parser = new AnthropicEligibilityParser(bedrockConfig);
    const records = await parser.parseEligibility(INPUT);
    expect(records).toHaveLength(1);
    expect(records[0]!.course_name).toBe("Bachelor of Nursing");
  });

  it("throws with the response body on a non-2xx Bedrock status (surfaced to the orchestrator's fallback chain)", async () => {
    mockFetchOnce(403, "AccessDeniedException: model access not granted");
    const parser = new AnthropicEligibilityParser(bedrockConfig);
    await expect(parser.parseEligibility(INPUT)).rejects.toThrow(/Anthropic HTTP 403/);
  });
});

describe("AnthropicEligibilityParser — Bedrock detection boundary", () => {
  it("treats baseUrl WITHOUT a model override as native (not enough to trigger Bedrock mode)", async () => {
    const fetchMock = mockFetchOnce();
    const parser = new AnthropicEligibilityParser({ ...baseConfig, baseUrl: "https://api.anthropic.com" });
    await parser.parseEligibility(INPUT);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/v1/messages");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBeDefined();
  });

  it("treats model WITHOUT a baseUrl override as native (matches the documented .env contract)", async () => {
    const fetchMock = mockFetchOnce();
    const parser = new AnthropicEligibilityParser({ ...baseConfig, model: "claude-sonnet-4-6" });
    await parser.parseEligibility(INPUT);
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
  });
});
