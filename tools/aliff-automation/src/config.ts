import "dotenv/config";

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined) return def;
  return /^(1|true|yes)$/i.test(v.trim());
}
function num(v: string | undefined, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export const config = {
  email: process.env.ALIFF_EMAIL ?? "",
  password: process.env.ALIFF_PASSWORD ?? "",
  baseUrl: process.env.ALIFF_BASE_URL ?? "https://super-admin-v2.aliff.in",
  loginUrl: process.env.ALIFF_LOGIN_URL ?? "https://super-admin-v2.aliff.in/login",
  // Optional single combined file (overrides the two split files when set).
  inputFile: process.env.INPUT_FILE ?? "",
  // The two files produced by "Build Aliff input files" (transform-input.ts).
  inputUniversitiesFile:
    process.env.INPUT_UNIVERSITIES_FILE ?? "data/aliff-input-universities-international.xlsx",
  inputCoursesFile:
    process.env.INPUT_COURSES_FILE ?? "data/aliff-input-courses-international.xlsx",
  dryRun: bool(process.env.DRY_RUN, true), // SAFE DEFAULT
  overwrite: bool(process.env.OVERWRITE, false),
  headless: bool(process.env.HEADLESS, false),
  limit: num(process.env.LIMIT, 0),
  retries: num(process.env.RETRIES, 2),
  process: (process.env.PROCESS ?? "both").toLowerCase() as "universities" | "courses" | "both",
  checkpointEvery: 25,
  // When true, dump the Filters panel / form HTML to ./screenshots/*.html on the
  // first few rows so exact selectors can be locked in after a DRY_RUN. Auto-on
  // during a dry run unless explicitly disabled with DEBUG_DOM=false.
  debugDom: bool(process.env.DEBUG_DOM, bool(process.env.DRY_RUN, true)),
};

export function assertCredentials(): void {
  if (!config.email || !config.password) {
    throw new Error(
      "Missing ALIFF_EMAIL / ALIFF_PASSWORD. Set them in tools/aliff-automation/.env (never hardcode).",
    );
  }
}

/**
 * Portal selectors — BEST-GUESS using accessible locators. The live portal's
 * exact markup is unknown, so adjust these after the first DRY_RUN by checking
 * the screenshots in ./screenshots. Each entry lists fallbacks tried in order.
 *
 * Locator syntax used by the automation:
 *   label:<text>        -> page.getByLabel(text)
 *   placeholder:<text>  -> page.getByPlaceholder(text)
 *   role:<role>|<name>  -> page.getByRole(role, { name })
 *   text:<text>         -> page.getByText(text, { exact:false })
 *   css:<selector>      -> page.locator(selector)
 */
export const selectors = {
  login: {
    email: ["label:Email", "placeholder:Email", "css:input[type=email]", "css:input[name=email]"],
    password: ["label:Password", "placeholder:Password", "css:input[type=password]", "css:input[name=password]"],
    submit: ["role:button|Login", "role:button|Sign in", "css:button[type=submit]"],
    // A selector that exists only after a successful login (dashboard).
    loggedIn: ["text:Dashboard", "text:Manage", "css:nav"],
  },
  nav: {
    manageUniversities: ["role:link|Manage Universities", "text:Manage Universities"],
    universities: ["role:link|Universities", "text:Universities"],
    manageCourses: ["role:link|Manage Courses", "text:Manage Courses"],
    courses: ["role:link|Courses", "text:Courses"],
  },
  list: {
    searchBox: ["css:input", "placeholder:Search", "css:input[type=search]"],
    // Calibrated to the live portal: "Add +" button navigates to .../university/form.
    addUniversity: ["role:button|Add", "css:a[href$='/university/form']"],
    addCourse: ["role:button|Add", "css:a[href$='/course/form']"],
    // Edit = the pencil <a> in the row -> .../form?universityId=N (or courseId=N).
    editInRow: ["css:a[href*='/university/form?universityId=']", "css:a[href*='/course/form?courseId=']", "role:link|Edit"],
  },
  // Filters panel (course list). Opened via the Filters button (a Radix DIALOG
  // trigger — icon-only, no accessible name: <button data-slot="dialog-trigger"
  // aria-haspopup="dialog"> wrapping an <svg class="lucide lucide-funnel"> and a
  // rose numeric badge). Confirmed from a live DOM dump 2026-07-11. It opens a
  // MODAL DIALOG (not a slide-over sheet) with Status / Country / University /
  // Course Category / Course Level dropdowns and Reset / Done buttons. We scope
  // the course list to ONE university here BEFORE searching the course name, so a
  // same-named course at another university can never be picked.
  filters: {
    // Exact selector confirmed live: the lucide-funnel icon's own <button>.
    openButton: [
      "css:button[data-slot='dialog-trigger']:has(svg.lucide-funnel)",
      "css:button:has(svg.lucide-funnel)",
      "role:button|Filters",
      "css:button[aria-label='Filters']",
    ],
    // The University combobox inside the panel — type the name, pick the option.
    university: [
      "css:input[placeholder='Select University']",
      "xpath://label[contains(normalize-space(.),'University')]/following::input[1]",
      "role:combobox|University",
    ],
    // "Done" applies the chosen filters and closes the panel.
    done: ["role:button|Done", "css:button:has-text('Done')"],
    reset: ["role:button|Reset"],
  },
  universityForm: {
    name: ["css:input[name='name']", "placeholder:Enter university name"],
    // Country is a combobox on the LOCATION tab; required when CREATING.
    country: ["css:input[placeholder='Select Country']"],
    locationTab: ["role:button|Location"],
    // The 3 link inputs share placeholder "https://example.com…"; target each by
    // the input immediately following its label (positional, order-independent).
    // Fixed: use xpath: prefix (not css:) for XPath expressions.
    eligibility: [
      "xpath://label[contains(normalize-space(.),'University Eligibility Criteria Links')]/following::input[1]",
      "css:input[placeholder='https://example.com, https://example.org']:nth-of-type(1)",
    ],
    scholarship: [
      "xpath://label[contains(normalize-space(.),'University Scholarship Links')]/following::input[1]",
      "css:input[placeholder='https://example.com, https://example.org']:nth-of-type(2)",
    ],
    fee: [
      "xpath://label[contains(normalize-space(.),'University Fee Links')]/following::input[1]",
      "css:input[placeholder='https://example.com, https://example.org']:nth-of-type(3)",
    ],
    brochure: [
      "xpath://label[contains(normalize-space(.),'Brochure Link')]/following::input[1]",
      "label:Brochure Link",
    ],
    logo: ["label:University Logo", "css:input[type=file]"],
    notes: [
      "xpath://label[contains(normalize-space(.),'Description')]/following::textarea[1]",
      "label:Description",
    ],
    save: ["role:button|Save", "role:button|Update", "role:button|Submit", "css:button[type=submit]"],
  },
  courseForm: {
    name: ["css:input[name='name']", "placeholder:e.g. Computer Science"],
    university: ["css:input[placeholder='Select a university']", "css:input[role='combobox']"],
    campus: ["css:input[placeholder='e.g. London Campus']", "label:Campus Location"],
    degreeLevel: ["css:input[placeholder='Select Course Level']", "label:Course Level"],
    category: ["css:input[placeholder='Select Course Category']", "label:Course Category"],
    // Fixed: use xpath: prefix for XPath expressions + CSS fallbacks.
    courseUrl: [
      "xpath://label[contains(normalize-space(.),'Additional Information Links')]/following::input[1]",
      "css:input[placeholder='https://example.com, https://example.org']:nth-of-type(1)",
    ],
    // CRITICAL: course eligibility is the 2nd of the 4 link inputs — target by its label.
    eligibility: [
      "xpath://label[contains(normalize-space(.),'Course Eligibility Criteria Links')]/following::input[1]",
      "css:input[placeholder='https://example.com, https://example.org']:nth-of-type(2)",
    ],
    scholarship: [
      "xpath://label[contains(normalize-space(.),'Course Scholarship Links')]/following::input[1]",
      "css:input[placeholder='https://example.com, https://example.org']:nth-of-type(3)",
    ],
    fee: [
      "xpath://label[contains(normalize-space(.),'Course Fee Links')]/following::input[1]",
      "css:input[placeholder='https://example.com, https://example.org']:nth-of-type(4)",
    ],
    save: ["role:button|Save", "role:button|Create Course", "role:button|Update", "css:button[type=submit]"],
  },
};
