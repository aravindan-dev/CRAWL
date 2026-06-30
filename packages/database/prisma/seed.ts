import { prisma } from "../src/client.js";
import { hashUrl, canonicalizeUrl } from "@clg/shared";

/**
 * Seed 5 sample universities + a couple of demo CourseCriteria records so the
 * dashboard has something to show before any crawl runs. Idempotent: re-running
 * upserts rather than duplicating.
 */

const universities = [
  {
    name: "University of Toronto",
    country: "Canada",
    base_url: "https://www.utoronto.ca",
    notes: "Sample seed — large public research university.",
  },
  {
    name: "University of Melbourne",
    country: "Australia",
    base_url: "https://www.unimelb.edu.au",
    notes: "Sample seed — Australian Group of Eight.",
  },
  {
    name: "University of Manchester",
    country: "United Kingdom",
    base_url: "https://www.manchester.ac.uk",
    notes: "Sample seed — UK Russell Group.",
  },
  {
    name: "National University of Singapore",
    country: "Singapore",
    base_url: "https://www.nus.edu.sg",
    notes: "Sample seed — leading Asian university.",
  },
  {
    name: "University of Auckland",
    country: "New Zealand",
    base_url: "https://www.auckland.ac.nz",
    notes: "Sample seed — New Zealand flagship university.",
  },
];

async function main() {
  console.log("Seeding universities…");
  const created: { id: string; name: string }[] = [];
  for (const u of universities) {
    // No natural unique key on (name, base_url) in schema, so look up first.
    const existing = await prisma.university.findFirst({
      where: { name: u.name, base_url: u.base_url },
    });
    const row = existing ?? (await prisma.university.create({ data: u }));
    created.push({ id: row.id, name: row.name });
  }

  const demoUni = created[0];
  if (demoUni) {
    const criteriaUrl = canonicalizeUrl(
      "https://www.utoronto.ca/academics/computer-science/admission-requirements",
    );
    console.log("Seeding demo course-criteria record…");
    await prisma.courseCriteria.upsert({
      where: {
        university_id_canonical_course_key_criteria_url: {
          university_id: demoUni.id,
          canonical_course_key: "bachelor of computer science",
          criteria_url: criteriaUrl,
        },
      },
      create: {
        university_id: demoUni.id,
        university_name: demoUni.name,
        course_name: "Bachelor of Computer Science",
        canonical_course_key: "bachelor of computer science",
        degree_level: "Bachelor",
        criteria:
          "Completed Grade 12 with Mathematics (Calculus recommended) and a minimum overall average of 75%.",
        criteria_url: criteriaUrl,
        source_snippet:
          "Applicants must have completed Grade 12 with Calculus and Vectors, with a minimum overall average of 75%.",
        required_subjects: ["Mathematics", "Calculus"],
        minimum_marks: "75% overall",
        entrance_exam: null,
        english_requirement: "IELTS 6.5 / TOEFL iBT 100",
        confidence_score: 0.82,
        parser_type: "rule_based",
        source_language: "en",
        review_status: "PENDING",
      },
      update: {},
    });

    // url_hash demo for a discovered link.
    const demoLinkUrl = "https://www.utoronto.ca/admissions";
    await prisma.discoveredLink.upsert({
      where: {
        university_id_url_hash: {
          university_id: demoUni.id,
          url_hash: hashUrl(demoLinkUrl),
        },
      },
      create: {
        university_id: demoUni.id,
        url: demoLinkUrl,
        canonical_url: canonicalizeUrl(demoLinkUrl),
        url_hash: hashUrl(demoLinkUrl),
        link_text: "Admissions",
        link_score: 25,
        depth: 1,
        status: "VALID_ADMISSION_PAGE",
        http_status: 200,
      },
      update: {},
    });
  }

  console.log(`Seed complete: ${created.length} universities.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
