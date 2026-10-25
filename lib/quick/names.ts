// Quick build (beta), in the browser: other people's names never leave the device in lecture lines (Q-SEC 3). Only
// the lecturer's lines are sent (lib/quick/export.ts lectureChunks; other speakers' lines are dropped), and in them any
// other person's name becomes "a student": "Sam is right" -> "a student is right", "Priya's question" -> "a
// student's question". The names come from the transcript's other speakers, the people the course export names (the
// roster it has), and a conservative list of common first names that aren't also everyday words. The lecturer's own
// name is kept.

/** Common first names that aren't English words (no Will, Mark, Grace, Hope, Bill, May, Rose, Art...). Capitalised only. */
export const FIRST_NAMES = [
  "Aaliyah", "Aaron", "Abigail", "Adrian", "Aiden", "Alejandro", "Alexander", "Alexis", "Alyssa", "Amanda", "Andrea",
  "Andrew", "Angela", "Anthony", "Ashley", "Benjamin", "Brandon", "Brian", "Brianna", "Caleb", "Camila",
  "Carlos", "Catherine", "Charlotte", "Christian", "Christopher", "Daniel", "David", "Deepak", "Diego", "Dmitri",
  "Elijah", "Elizabeth", "Emily", "Emma", "Ethan", "Fatima", "Gabriel", "Hannah", "Hiroshi", "Isabella", "Jacob",
  "Jasmine", "Jason", "Jennifer", "Jessica", "Jonathan", "Jordan", "Joseph", "Joshua", "Juan", "Justin", "Kaitlyn",
  "Kevin", "Kimberly", "Laura", "Lauren", "Liam", "Lucas", "Madison", "Maria", "Megan", "Mei", "Melissa",
  "Michael", "Michelle", "Mohammed", "Muhammad", "Natalie", "Nathan", "Nicholas", "Nicole", "Noah", "Olivia", "Omar",
  "Priya", "Rachel", "Rahul", "Rebecca", "Ryan", "Samantha", "Samuel", "Sarah", "Sebastian", "Sofia", "Sophia",
  "Stephanie", "Steven", "Tyler", "Valentina", "Vanessa", "Victoria", "Wei", "Xavier", "Yuki", "Zachary", "Zoe",
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TITLE = /^(dr|prof|professor|mr|mrs|ms|mx)\.?$/i;

/** A person's name as the words to look for: the full name, then each part of it long enough to be a name. */
function partsOf(name: string): string[] {
  const words = name
    .replace(/[,()]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !TITLE.test(w));
  const out = new Set<string>();
  if (words.length > 1) out.add(words.join(" "));
  for (const w of words) if (/^[A-Z][\p{L}'-]{2,}$/u.test(w)) out.add(w);
  return [...out];
}

/**
 * Everyone whose name should become "a student" in these lines: the other speakers, the people the export names, and
 * the first-name list, minus the lecturer's own name (and words like "Lecturer" or "Speaker").
 */
export function namesToStrip(o: { speakers: (string | null)[]; lecturer: string | null; people?: string[] }): string[] {
  const words = (n: string) => n.split(/\s+/).map((w) => w.toLowerCase());
  // Never the lecturer (M3): their label's words are kept, and so is every word of a name from `people` that shares
  // one of them ("Dr. Rivera" keeps "Alex Rivera" whole). Never from other speakers: they are other people, so only the
  // shared word is kept ("Sam Lee" next to "Dr. Lee" still loses "Sam").
  const kept = new Set(o.lecturer ? partsOf(o.lecturer).flatMap(words) : []);
  const lecturerWords = new Set(kept);
  for (const s of o.people ?? []) {
    const ps = partsOf(s);
    if (ps.some((p) => words(p).some((w) => lecturerWords.has(w)))) ps.flatMap(words).forEach((w) => kept.add(w));
  }
  const sources = [...o.speakers.filter((x): x is string => !!x && x !== o.lecturer), ...(o.people ?? [])];
  const names = new Set<string>();
  for (const s of sources) {
    for (const p of partsOf(s)) if (!/^(Lecturer|Speaker|Student|Unknown|Host|Participant|Guest)\b/i.test(p)) names.add(p);
  }
  for (const n of FIRST_NAMES) names.add(n);
  return [...names].filter((n) => !words(n).some((w) => kept.has(w))).sort((a, b) => b.length - a.length);
}

/** The line with every one of these names (and its possessive) as "a student" / "a student's". Capitalised matches only. */
export function stripNames(text: string, names: string[]): string {
  if (!names.length) return text;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(${names.map(escape).join("|")})(['’]s)?(?![\\p{L}\\p{N}])`, "gu");
  return text.replace(re, (_m, _name, poss) => (poss ? "a student's" : "a student"));
}
