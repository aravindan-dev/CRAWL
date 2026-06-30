-- Raw-SQL constraints that Prisma cannot express in schema.prisma.
-- Applied by `pnpm db:migrate` after `prisma db push`. Idempotent (safe to
-- re-run) via pg_constraint existence checks.
--
-- Acceptance criterion #12: the database must reject a CourseCriteria row whose
-- criteria_url is missing or not a valid http(s) URL. NOT NULL is in the
-- schema; this adds the format + non-empty CHECK.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'course_criteria_criteria_url_check'
  ) THEN
    ALTER TABLE "course_criteria"
      ADD CONSTRAINT course_criteria_criteria_url_check
      CHECK (criteria_url ~ '^https?://' AND length(criteria_url) > 0);
  END IF;
END $$;

-- source_snippet must be present (non-empty) for every stored record.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'course_criteria_source_snippet_check'
  ) THEN
    ALTER TABLE "course_criteria"
      ADD CONSTRAINT course_criteria_source_snippet_check
      CHECK (length(source_snippet) > 0);
  END IF;
END $$;

-- confidence_score must be within [0, 1].
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'course_criteria_confidence_range_check'
  ) THEN
    ALTER TABLE "course_criteria"
      ADD CONSTRAINT course_criteria_confidence_range_check
      CHECK (confidence_score >= 0 AND confidence_score <= 1);
  END IF;
END $$;
