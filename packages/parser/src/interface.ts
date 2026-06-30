/**
 * Parser contract (Section 25). Concrete parsers (rule-based, Ollama, paid
 * providers) all implement EligibilityParser. The orchestrator routes between
 * them and enforces the URL invariant + snippet validation downstream.
 */
export type {
  EligibilityParser,
  ParserInput,
  ParsedCourseCriteria,
  CandidateChunk,
  Section,
  TableJSON,
  DegreeLevel,
  ParserType,
} from "@clg/shared";
