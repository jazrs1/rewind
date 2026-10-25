// Quick build (beta), in the browser: course logistics never go to the model. A page or PDF whose title is clearly
// logistics (syllabus, schedule, grading, office hours, getting started, platform setup...) is dropped whole; in the
// rest, a line that is clearly logistics (an access code, MyLab or Canvas instructions, a due date, a grading
// percentage, office hours, a late-work policy, an email) is dropped. Lecture transcripts aren't filtered here (their
// lines carry times); the server prompt's rule covers them. A simple keyword filter: it errs toward keeping text.

/** Platforms students set up or log in to: never the subject. */
const PLATFORMS = String.raw`my ?lab|my ?math ?lab|mastering \w+|web ?assign|aleks|mc ?graw[- ]hill connect|zy ?books?|gradescope|honorlock|proctorio|respondus|lockdown browser|top ?hat|i ?clicker|perusall|piazza|ed discussion|hawkes|knewton|wiley ?plus|cengage|mindtap`;

const TITLE = new RegExp(
  String.raw`\b(syllabus|office hours?|grading|grades|grade (scale|breakdown|policy|policies)|course (schedule|calendar|policies|policy|information|info|logistics|overview|expectations|requirements)|schedule|calendar|due dates?|important dates|deadlines|access codes?|getting started|start here|welcome|orientation|about (this|the) course|course (introduction|intro|structure|components|format|map|tour)|how (this|the) course works|meet (your|the) (instructor|professor|teaching assistants?|tas?)|graded (components|work|items)|how to (use|navigate|submit|access)|canvas (help|instructions|tips|guide)|technical (help|support|requirements)|textbook (information|access)|required materials|instructor (information|info)|contact (information|info)|late (work|policy|submissions?)|make-?up (exams?|policy)|attendance|academic (honesty|integrity)|accommodations|exam (logistics|information|rules)|${PLATFORMS})\b`,
  "i",
);

// Capitalized and exact, so "we may 2" or "monotonic" aren't dates.
const DATE = String.raw`\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.? \d{1,2}\b|\b\d{1,2}/\d{1,2}(/\d{2,4})?\b|\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun)\b|\b11:59\b|\bmidnight\b`;
const NUM = String.raw`\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty`;
// No bare "final" ("One final step is to normalize the vector"); "two final exams" still matches via "exams".
const GRADED = String.raw`quiz(zes)?|projects?|exams?|midterms?|homeworks?|assignments?|labs?|papers?|presentations?|participation|discussions?|reflections?|check-?ins?`;
const LINE: RegExp[] = [
  // A list of what is graded: "10 programming quizzes", "Two individual projects", "2 exams" (short lines, list items).
  new RegExp(String.raw`^\s*[-*\u2022]?\s*(${NUM})\s+([a-z-]+\s+){0,2}(${GRADED})\b.{0,40}$`, "i"),
  // Two or more of those in one line: "10 quizzes, two projects and two exams".
  new RegExp(String.raw`\b(${NUM})\s+([a-z-]+\s+){0,2}(${GRADED})\b.{0,80}\b(${NUM})\s+([a-z-]+\s+){0,2}(${GRADED})\b`, "i"),
  /\b(graded (components?|work|items?|assessments?)|grade (breakdown|distribution|weights?)|course (components|requirements))\b/i,
  /\baccess codes?\b/i,
  /^\s*welcome\b/i,
  new RegExp(String.raw`\b(${PLATFORMS})\b`, "i"),
  /\boffice hours?\b/i,
  // Canvas (or any site) instructions: "Click Modules in the left menu", "Log in to Canvas".
  /\b(click|select|go to|navigate to|log ?in|sign ?in|sign up|register)\b.{0,60}\b(canvas|modules?|assignments? (tab|page)|the link|button|menu|sidebar|course page|portal|account)\b/i,
  // A due date or deadline with a date or a time ("due to symmetry, p = 1/2" is not one).
  new RegExp(String.raw`\b([Dd]ue(?! to\b)|DUE|[Dd]eadline|[Cc]loses|[Oo]pens|[Ss]ubmit by)\b.{0,50}(${DATE})`),
  // A grading weight: "Homework 20%", "Exams are worth 50%".
  /(\b\d{1,3}(\.\d+)?\s?%.{0,40}\b(grade|grading|homework|exams?|quiz(zes)?|participation|final|midterm|attendance|labs?|projects?|assignments?)\b)|(\b(grade|grading|homework|exams?|quiz(zes)?|participation|final|midterm|attendance|labs?|projects?|assignments?)\b.{0,40}\b\d{1,3}(\.\d+)?\s?%)/i,
  /\b(late (work|submissions?|penalty|policy)|make-?up (exams?|quiz(zes)?|policy)|extra credit|letter grade|grade scale|regrades?|attendance (policy|is required)|academic (honesty|integrity|misconduct))\b/i,
  /[\w.+-]+@[\w-]+\.[\w.]+/,
];

/** A title that is clearly logistics. */
export function isLogisticsTitle(title: string): boolean {
  return TITLE.test(title);
}

/** A line that is clearly logistics. */
export function isLogisticsLine(line: string): boolean {
  return LINE.some((re) => re.test(line));
}

/** The text without its logistics lines. */
export function withoutLogistics(text: string): string {
  return text
    .split("\n")
    .filter((l) => !isLogisticsLine(l))
    .join("\n")
    .trim();
}

/** A page (or PDF page) as what may be sent: null when it's logistics, else its text without the logistics lines. */
/**
 * The instructions for graded work: a programming assignment or quiz spec ("you will return…", "Input format",
 * "Sample output", "Submit on Gradescope"). Practice is never built from graded work, so a page or a PDF's first page
 * with two or more of these markers is left out whole (one alone could be a lecture's own exercise).
 */
const SPEC: RegExp[] = [
  /\byou will (return|write|implement|be given|need to|submit|complete|code)\b/i,
  /\byou (must|should|need to) (return|write|implement|submit)\b/i,
  /\byour (task|job|goal|function|program|code|solution|submission) (is|should|must|will)\b/i,
  /\b(write|implement|complete|code) (a|the|this|your) (function|method|class|program|solution)\b/i,
  /\b(input|output) format\b|\bconstraints\s*:|\b(sample|example) (input|output)\b|\bexpected output\b|\btest cases?\b|\bstarter code\b|\bboilerplate\b|\bfunction signature\b/i,
  /\b(gradescope|stepik|leetcode|hackerrank|autograder|zybooks)\b/i,
  /\b(programming|coding) (quiz|assignment|exercise|problem|project|question)\b/i,
  /\b(project|assignment|quiz|homework|lab|problem set)\s*\d+\b.{0,40}\b(due|submit|instructions|description|specification|spec|rubric)\b/i,
];
export function specMarkers(text: string): number {
  return SPEC.filter((re) => re.test(text)).length;
}
export function isAssignmentSpec(text: string): boolean {
  return specMarkers(text) >= 2;
}

export function subjectText(title: string, text: string): string | null {
  if (isLogisticsTitle(title) || isAssignmentSpec(`${title}\n${text}`)) return null;
  const kept = withoutLogistics(text);
  return kept || null;
}

/**
 * A generated question (stem, choices and quote) about how the course runs rather than its subject: what is graded,
 * how many quizzes or projects, grading, the syllabus, policies, staff. Quick build never keeps one (lib/quick/service.ts).
 */
const ABOUT_COURSE: RegExp[] = [
  // "this course" / "the course's" with a grading word ("A course has two prerequisites" is a graph question).
  /\b(this course|the course's)\b.{0,60}\b(quiz(zes)?|projects?|exams?|midterms?|components?|grades?|grading|graded)\b/i,
  /\bhow many\b.{0,40}\b(quiz(zes)?|projects?|exams?|midterms?|homeworks?)\b/i,
  /\b(graded (components?|work|items?|assessments?)|syllabus|grading (policy|scale|breakdown)|grade (breakdown|scale|weight)|office hours?|late (work|policy|penalty|submissions?)|make-?up (exam|policy)|extra credit|academic (integrity|honesty)|teaching assistants?)\b/i,
];
/** About how the course's material is laid out (which video, module, page or week covers what), not the subject. */
const ABOUT_LAYOUT: RegExp[] = [
  // No pages/files/links/sections/units: "Which pages does the working set include?", "Which header file includes printf?".
  /\b(which|what)\s+(\w+\s+){0,2}(videos?|readings?|modules?|weeks?|lessons?|recordings?|chapters?)\b.{0,80}\b(cover|covers|discuss|discusses|explain|explains|introduce|introduces|include|includes|is about|are about|teach|teaches)\b/i,
  // "this" / "that" only, and no page/unit/course: "of the page table", "in the unit circle", "in the course of".
  /\b(in|of|from) (this|that) (module|week|lesson|reading list|playlist)\b/i,
  /\b(video|reading|module|page) (topic|title|list)s?\b/i,
];
export function aboutCourseLogistics(text: string): boolean {
  // Built from graded work's instructions ("you will return the number of values…"): never kept.
  if (/\byou will (return|write|implement|be given|submit)\b|\byour (task|function|program|submission) (is|should|must|will)\b/i.test(text)) return true;
  if (ABOUT_LAYOUT.some((re) => re.test(text))) return true;
  // "How many assignments/attempts/labs/credits" only with "course" in the text ("How many probe attempts…" is hashing).
  if (/\bcourse\b/i.test(text) && /\bhow many\b.{0,40}\b(assignments?|labs?|credits?|attempts?)\b/i.test(text)) return true;
  // Two logistics lines, not counting the short graded-list form (choices "3 projects" / "5 projects" are answers).
  return ABOUT_COURSE.some((re) => re.test(text)) || text.split("\n").filter((l) => LINE.slice(1).some((re) => re.test(l))).length >= 2;
}
