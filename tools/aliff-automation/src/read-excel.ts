import { readFileSync } from "node:fs";
import XLSX from "xlsx";

export interface UniversityRecord {
  rowNumber: number;
  university_name: string;
  country: string;
  base_url?: string;
  university_eligibility_url?: string;
  university_scholarship_url?: string;
  university_fee_url?: string;
  notes?: string;
  brochure_link?: string;
  university_logo?: string;
}

export interface CourseRecord {
  rowNumber: number;
  university_name: string;
  country?: string;
  course_name: string;
  degree_level?: string;
  campus?: string;
  course_category?: string;
  course_url?: string;
  course_eligibility_url?: string;
  course_scholarship_url?: string;
  course_fee_url?: string;
  additional_information_link?: string;
  notes?: string;
}

/** Map many possible header spellings to canonical field names. */
const HEADER_ALIASES: Record<string, string> = {
  name: "university_name",
  university: "university_name",
  universityname: "university_name",
  uni: "university_name",
  country: "country",
  baseurl: "base_url",
  website: "base_url",
  url: "base_url",
  universityeligibilityurl: "university_eligibility_url",
  universityeligibility: "university_eligibility_url",
  universityeligibilitycriterialinks: "university_eligibility_url",
  universityscholarshipurl: "university_scholarship_url",
  universityscholarshiplinks: "university_scholarship_url",
  universityfeeurl: "university_fee_url",
  universityfeelinks: "university_fee_url",
  brochurelink: "brochure_link",
  brochure: "brochure_link",
  universitylogo: "university_logo",
  logo: "university_logo",
  notes: "notes",
  description: "notes",
  coursename: "course_name",
  course: "course_name",
  degreelevel: "degree_level",
  courselevel: "degree_level",
  level: "degree_level",
  campus: "campus",
  campuslocation: "campus",
  coursecategory: "course_category",
  category: "course_category",
  courseurl: "course_url",
  courselink: "course_url",
  courseeligibilityurl: "course_eligibility_url",
  courseeligibility: "course_eligibility_url",
  courseeligibilitycriterialinks: "course_eligibility_url",
  coursescholarshipurl: "course_scholarship_url",
  coursescholarshiplinks: "course_scholarship_url",
  coursefeeurl: "course_fee_url",
  coursefeelinks: "course_fee_url",
  additionalinformationlink: "additional_information_link",
  additionalinfo: "additional_information_link",
};

function normKey(h: string): string {
  const k = h.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  return HEADER_ALIASES[k] ?? k;
}

function str(v: unknown): string {
  return v === undefined || v === null ? "" : String(v).trim();
}

export interface ParsedInput {
  universities: UniversityRecord[];
  courses: CourseRecord[];
  totalRows: number;
}

/**
 * Read xlsx/csv and split into UNIQUE university records + per-course records.
 * A row is a course row if it has a course_name; otherwise it contributes only
 * university-level data.
 */
export function readInput(filePath: string): ParsedInput {
  const wb = XLSX.read(readFileSync(filePath));
  const sheet = wb.Sheets[wb.SheetNames[0]!];
  if (!sheet) throw new Error(`No sheet found in ${filePath}`);
  const raw: Record<string, unknown>[] = XLSX.utils.sheet_to_json(sheet, { defval: "" });

  const universities = new Map<string, UniversityRecord>();
  const courses: CourseRecord[] = [];
  let rowNumber = 1;

  for (const r of raw) {
    rowNumber++;
    const row: Record<string, string> = {};
    for (const [k, v] of Object.entries(r)) row[normKey(k)] = str(v);

    const uniName = row.university_name ?? "";
    if (!uniName) continue;

    // Accumulate university-level info (unique per name). First non-empty wins.
    const existing = universities.get(uniName.toLowerCase());
    const uni: UniversityRecord = existing ?? {
      rowNumber,
      university_name: uniName,
      country: row.country ?? "",
    };
    const setIfEmpty = (k: keyof UniversityRecord, val: string) => {
      if (val && !uni[k]) (uni[k] as string) = val;
    };
    setIfEmpty("country", row.country ?? "");
    setIfEmpty("base_url", row.base_url ?? "");
    setIfEmpty("university_eligibility_url", row.university_eligibility_url ?? "");
    setIfEmpty("university_scholarship_url", row.university_scholarship_url ?? "");
    setIfEmpty("university_fee_url", row.university_fee_url ?? "");
    setIfEmpty("brochure_link", row.brochure_link ?? "");
    setIfEmpty("university_logo", row.university_logo ?? "");
    if (!row.course_name) setIfEmpty("notes", row.notes ?? ""); // notes on uni rows only
    universities.set(uniName.toLowerCase(), uni);

    // Course row?
    if (row.course_name) {
      courses.push({
        rowNumber,
        university_name: uniName,
        country: row.country,
        course_name: row.course_name,
        degree_level: row.degree_level,
        campus: row.campus,
        course_category: row.course_category,
        course_url: row.course_url,
        course_eligibility_url: row.course_eligibility_url,
        course_scholarship_url: row.course_scholarship_url,
        course_fee_url: row.course_fee_url,
        additional_information_link: row.additional_information_link,
        notes: row.notes,
      });
    }
  }

  return {
    universities: [...universities.values()],
    courses,
    totalRows: rowNumber - 1,
  };
}
