-- CreateEnum
CREATE TYPE "CrawlStatus" AS ENUM ('IDLE', 'QUEUED', 'DISCOVERING', 'VALIDATING', 'EXTRACTING', 'PARSING', 'COMPLETED', 'FAILED', 'STOPPED');

-- CreateEnum
CREATE TYPE "LinkStatus" AS ENUM ('PENDING', 'QUEUED', 'VALID_COURSE_PAGE', 'VALID_ADMISSION_PAGE', 'POSSIBLE_REQUIREMENT_PAGE', 'LOW_CONFIDENCE_PAGE', 'BROKEN_LINK', 'REDIRECTED', 'BLOCKED', 'DUPLICATE', 'NOT_RELEVANT', 'PDF_DEFERRED', 'REJECTED_CROSS_CONTEXT');

-- CreateEnum
CREATE TYPE "CrawlContextType" AS ENUM ('ELIGIBILITY', 'SCHOLARSHIP');

-- CreateEnum
CREATE TYPE "PageClass" AS ENUM ('COURSE_PAGE', 'COURSE_LISTING', 'ELIGIBILITY_PAGE', 'ADMISSIONS_PAGE', 'INTERNATIONAL_ADMISSIONS_PAGE', 'SCHOLARSHIP_PAGE', 'SCHOLARSHIP_LISTING', 'FUNDING_PAGE', 'NAVIGATION_PAGE', 'DOCUMENT', 'IRRELEVANT', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('PENDING', 'LOW_CONFIDENCE', 'NEEDS_REVIEW', 'APPROVED', 'REJECTED', 'DUPLICATE');

-- CreateEnum
CREATE TYPE "DegreeLevel" AS ENUM ('Bachelor', 'Diploma', 'Other');

-- CreateEnum
CREATE TYPE "ParserType" AS ENUM ('ai', 'rule_based');

-- CreateEnum
CREATE TYPE "JobType" AS ENUM ('DISCOVER', 'VALIDATE', 'EXTRACT', 'PARSE', 'EXPORT');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'DEAD_LETTER');

-- CreateEnum
CREATE TYPE "CrawlAction" AS ENUM ('DISCOVER_LINKS', 'SCORE_LINK', 'VALIDATE_LINK', 'EXTRACT_PAGE', 'CLEAN_CONTENT', 'CHUNK_CONTENT', 'PARSE_CRITERIA', 'VALIDATE_SNIPPET', 'STORE_CRITERIA', 'EXPORT_DATA');

-- CreateEnum
CREATE TYPE "LogStatus" AS ENUM ('OK', 'WARN', 'ERROR');

-- CreateEnum
CREATE TYPE "ExportType" AS ENUM ('CSV', 'EXCEL');

-- CreateTable
CREATE TABLE "university" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "base_url" TEXT NOT NULL,
    "crawl_status" "CrawlStatus" NOT NULL DEFAULT 'IDLE',
    "total_links_found" INTEGER NOT NULL DEFAULT 0,
    "total_valid_links" INTEGER NOT NULL DEFAULT 0,
    "total_courses_extracted" INTEGER NOT NULL DEFAULT 0,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "university_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discovered_link" (
    "id" TEXT NOT NULL,
    "university_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "final_url" TEXT,
    "canonical_url" TEXT,
    "url_hash" TEXT NOT NULL,
    "page_title" TEXT,
    "link_text" TEXT,
    "link_score" INTEGER NOT NULL DEFAULT 0,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "status" "LinkStatus" NOT NULL DEFAULT 'PENDING',
    "http_status" INTEGER,
    "is_duplicate" BOOLEAN NOT NULL DEFAULT false,
    "crawl_context" "CrawlContextType" NOT NULL DEFAULT 'ELIGIBILITY',
    "page_class" "PageClass",
    "content_verified" BOOLEAN NOT NULL DEFAULT false,
    "evidence" TEXT,
    "eligibility_url" TEXT,
    "screenshot_path" TEXT,
    "html_path" TEXT,
    "text_path" TEXT,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "discovered_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "page_snapshot" (
    "id" TEXT NOT NULL,
    "university_id" TEXT NOT NULL,
    "discovered_link_id" TEXT NOT NULL,
    "crawl_context" "CrawlContextType" NOT NULL DEFAULT 'ELIGIBILITY',
    "url" TEXT NOT NULL,
    "final_url" TEXT NOT NULL,
    "page_title" TEXT,
    "source_language" TEXT,
    "raw_html_path" TEXT,
    "cleaned_text_path" TEXT,
    "screenshot_path" TEXT,
    "extracted_text" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "page_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "course_criteria" (
    "id" TEXT NOT NULL,
    "university_id" TEXT NOT NULL,
    "discovered_link_id" TEXT,
    "university_name" TEXT NOT NULL,
    "course_name" TEXT NOT NULL,
    "canonical_course_key" TEXT NOT NULL,
    "degree_level" "DegreeLevel" NOT NULL DEFAULT 'Other',
    "criteria" TEXT,
    "criteria_url" TEXT NOT NULL,
    "source_snippet" TEXT NOT NULL,
    "required_subjects" JSONB NOT NULL DEFAULT '[]',
    "minimum_marks" TEXT,
    "entrance_exam" TEXT,
    "english_requirement" TEXT,
    "confidence_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "parser_type" "ParserType" NOT NULL,
    "source_language" TEXT NOT NULL DEFAULT 'en',
    "review_status" "ReviewStatus" NOT NULL DEFAULT 'PENDING',
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "course_criteria_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crawl_log" (
    "id" TEXT NOT NULL,
    "university_id" TEXT,
    "discovered_link_id" TEXT,
    "action" "CrawlAction" NOT NULL,
    "status" "LogStatus" NOT NULL,
    "message" TEXT,
    "duration_ms" INTEGER,
    "error_stack" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crawl_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crawl_job" (
    "id" TEXT NOT NULL,
    "university_id" TEXT,
    "job_type" "JobType" NOT NULL,
    "crawl_context" "CrawlContextType" NOT NULL DEFAULT 'ELIGIBILITY',
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "stats" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crawl_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "export" (
    "id" TEXT NOT NULL,
    "export_type" "ExportType" NOT NULL,
    "file_path" TEXT NOT NULL,
    "total_records" INTEGER NOT NULL DEFAULT 0,
    "scope" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "export_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "university_crawl_status_idx" ON "university"("crawl_status");

-- CreateIndex
CREATE INDEX "university_sort_order_idx" ON "university"("sort_order");

-- CreateIndex
CREATE INDEX "discovered_link_university_id_status_idx" ON "discovered_link"("university_id", "status");

-- CreateIndex
CREATE INDEX "discovered_link_university_id_content_verified_idx" ON "discovered_link"("university_id", "content_verified");

-- CreateIndex
CREATE INDEX "discovered_link_university_id_crawl_context_idx" ON "discovered_link"("university_id", "crawl_context");

-- CreateIndex
CREATE INDEX "discovered_link_status_idx" ON "discovered_link"("status");

-- CreateIndex
CREATE INDEX "discovered_link_link_score_idx" ON "discovered_link"("link_score");

-- CreateIndex
CREATE INDEX "discovered_link_updated_at_idx" ON "discovered_link"("updated_at");

-- CreateIndex
CREATE INDEX "discovered_link_content_verified_updated_at_idx" ON "discovered_link"("content_verified", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "discovered_link_university_id_url_hash_crawl_context_key" ON "discovered_link"("university_id", "url_hash", "crawl_context");

-- CreateIndex
CREATE INDEX "page_snapshot_university_id_idx" ON "page_snapshot"("university_id");

-- CreateIndex
CREATE INDEX "page_snapshot_discovered_link_id_idx" ON "page_snapshot"("discovered_link_id");

-- CreateIndex
CREATE INDEX "course_criteria_university_id_idx" ON "course_criteria"("university_id");

-- CreateIndex
CREATE INDEX "course_criteria_review_status_idx" ON "course_criteria"("review_status");

-- CreateIndex
CREATE INDEX "course_criteria_confidence_score_idx" ON "course_criteria"("confidence_score");

-- CreateIndex
CREATE INDEX "course_criteria_created_at_idx" ON "course_criteria"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "course_criteria_university_id_canonical_course_key_criteria_key" ON "course_criteria"("university_id", "canonical_course_key", "criteria_url");

-- CreateIndex
CREATE INDEX "crawl_log_university_id_idx" ON "crawl_log"("university_id");

-- CreateIndex
CREATE INDEX "crawl_log_action_idx" ON "crawl_log"("action");

-- CreateIndex
CREATE INDEX "crawl_log_status_idx" ON "crawl_log"("status");

-- CreateIndex
CREATE INDEX "crawl_log_created_at_idx" ON "crawl_log"("created_at");

-- CreateIndex
CREATE INDEX "crawl_job_university_id_idx" ON "crawl_job"("university_id");

-- CreateIndex
CREATE INDEX "crawl_job_job_type_status_idx" ON "crawl_job"("job_type", "status");

-- CreateIndex
CREATE INDEX "crawl_job_status_idx" ON "crawl_job"("status");

-- CreateIndex
CREATE INDEX "export_created_at_idx" ON "export"("created_at");

-- AddForeignKey
ALTER TABLE "discovered_link" ADD CONSTRAINT "discovered_link_university_id_fkey" FOREIGN KEY ("university_id") REFERENCES "university"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_snapshot" ADD CONSTRAINT "page_snapshot_university_id_fkey" FOREIGN KEY ("university_id") REFERENCES "university"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_snapshot" ADD CONSTRAINT "page_snapshot_discovered_link_id_fkey" FOREIGN KEY ("discovered_link_id") REFERENCES "discovered_link"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_criteria" ADD CONSTRAINT "course_criteria_university_id_fkey" FOREIGN KEY ("university_id") REFERENCES "university"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_criteria" ADD CONSTRAINT "course_criteria_discovered_link_id_fkey" FOREIGN KEY ("discovered_link_id") REFERENCES "discovered_link"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crawl_log" ADD CONSTRAINT "crawl_log_university_id_fkey" FOREIGN KEY ("university_id") REFERENCES "university"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crawl_log" ADD CONSTRAINT "crawl_log_discovered_link_id_fkey" FOREIGN KEY ("discovered_link_id") REFERENCES "discovered_link"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crawl_job" ADD CONSTRAINT "crawl_job_university_id_fkey" FOREIGN KEY ("university_id") REFERENCES "university"("id") ON DELETE SET NULL ON UPDATE CASCADE;

