// Run: node scripts/radar/test.mjs
// Uses only the invented transcript in fixtures/; no real course text.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPhrases, scanTranscript, contextFor, formatTime, parseArgs, speakerMatches } from './scan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'fake-lecture.transcript.json');
const transcript = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const phrases = loadPhrases();

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const pairs = (hits) => hits.map((h) => `${h.start} ${h.phrase}`).sort();

test('phrases.json has every phrase from the task', () => {
  const names = phrases.map((p) => p.phrase);
  for (const p of ['on the exam', 'on the quiz', 'will be tested', 'you need to know', 'make sure you know',
    'important', 'common mistake', 'students always get', 'I will ask', 'remember this',
    'if you recall', 'interview question', 'ask in exams', 'take away from this', 'you should know']) {
    assert.ok(names.includes(p), `missing ${p}`);
  }
});

test('every phrase has a known kind; new phrases are tagged as in T8', () => {
  const KINDS = ['exam', 'importance', 'common-mistake', 'interview', 'recall'];
  for (const p of phrases) assert.ok(KINDS.includes(p.kind), `${p.phrase} has kind ${p.kind}`);
  const kindOf = Object.fromEntries(phrases.map((p) => [p.phrase, p.kind]));
  assert.equal(kindOf['if you recall'], 'recall');
  assert.equal(kindOf['interview question'], 'interview');
  assert.equal(kindOf['ask in exams'], 'exam');
  assert.equal(kindOf['take away from this'], 'importance');
  assert.equal(kindOf['you should know'], 'importance');
  assert.equal(kindOf['common mistake'], 'common-mistake');
  assert.equal(kindOf['on the exam'], 'exam');
});

const FIXTURE2 = join(HERE, 'fixtures', 'fake-lecture-2.transcript.json');
const transcript2 = JSON.parse(readFileSync(FIXTURE2, 'utf8'));

test("professor's-wording phrases hit the invented lines, with kind on each hit", () => {
  const hits = scanTranscript(transcript2, 'fake2', phrases, { speaker: 'Lecturer A' });
  assert.deepEqual(hits.map((h) => `${h.start} ${h.kind}: ${h.phrase}`), [
    '0 recall: if you recall',
    '15 interview: interview question',
    '30 exam: ask in exams',
    '45 exam: ask in exams',
    '60 importance: take away from this',
    '75 importance: you should know',
  ]);
});

test('near misses do not hit ("I recall the name", "an interviewer", ...)', () => {
  const hit = (text) => phrases.filter((p) => p.re.test(text)).map((p) => p.phrase);
  for (const seg of transcript2.segments.filter((s) => s.start >= 90 && s.start < 150)) {
    assert.deepEqual(hit(seg.text), [], seg.text);
  }
  assert.deepEqual(hit('I recall the name.'), []);
  assert.deepEqual(hit('He was an interviewer.'), []);
  // The student's line hits, but --speaker drops it.
  assert.deepEqual(hit(transcript2.segments[10].text), ['interview question']);
});

test('regex variants match paraphrases and skip near misses', () => {
  const hit = (text) => phrases.filter((p) => p.re.test(text)).map((p) => p.phrase);
  assert.deepEqual(hit('This could be on your midterm.'), ['on the exam']);
  assert.deepEqual(hit("It's gonna be tested."), ['will be tested']);
  assert.deepEqual(hit("I'm going to ask you this."), ['I will ask']);
  assert.deepEqual(hit('People tend to mix these up.'), ['students always get']);
  assert.deepEqual(hit('The examples on the slide are fine.'), []);
  assert.deepEqual(hit('Unimportant detail.'), []);
});

test('scan finds every flagged moment in the fake lecture', () => {
  const hits = scanTranscript(transcript, 'fake', phrases);
  assert.deepEqual(pairs(hits), [
    '10 on the exam',
    '100 I will ask',
    '100 make sure you know',
    '100 on the quiz',
    '130 you need to know',
    '25 important',
    '40 common mistake',
    '55 students always get',
  ]);
  for (const h of hits) {
    assert.equal(h.file, 'fake');
    assert.equal(typeof h.text, 'string');
    assert.ok(Array.isArray(h.context) && h.context.length > 0);
  }
});

test('--speaker keeps only that speaker (substring, any case)', () => {
  const hits = scanTranscript(transcript, 'fake', phrases, { speaker: 'lecturer a' });
  assert.ok(hits.length > 0);
  assert.ok(hits.every((h) => h.speaker === 'Lecturer A'));
  assert.ok(!pairs(hits).includes('25 important'), 'student question excluded');
  assert.ok(!pairs(hits).includes('130 you need to know'), 'null speaker excluded');
  assert.equal(speakerMatches(null, 'x'), false);
  assert.equal(speakerMatches(null, null), true);
});

test('context spans 20 s before to 20 s after', () => {
  const ctx = contextFor(transcript.segments, 55);
  assert.deepEqual(ctx.map((s) => s.start), [25, 40, 55, 70]);
});

test('formatTime and parseArgs', () => {
  assert.equal(formatTime(65), '1:05');
  assert.equal(formatTime(3725.4), '1:02:05');
  assert.deepEqual(parseArgs(['a.json', '--speaker', 'Lecturer A', 'b.json']), { files: ['a.json', 'b.json'], speaker: 'Lecturer A' });
  assert.deepEqual(parseArgs(['--speaker=X', 'a.json']), { files: ['a.json'], speaker: 'X' });
});

test('CLI prints JSON to stdout and counts grouped by kind to stderr', () => {
  const res = spawnSync(process.execPath, [join(HERE, 'scan.mjs'), '--speaker', 'Lecturer A', FIXTURE, FIXTURE2], {
    encoding: 'utf8',
  });
  assert.equal(res.status, 0);
  const hits = JSON.parse(res.stdout);
  assert.equal(hits.length, 12);
  for (const h of hits) {
    assert.deepEqual(Object.keys(h), ['file', 'start', 'speaker', 'phrase', 'kind', 'text', 'context']);
  }
  assert.match(res.stderr, /Exam radar: 12 hit\(s\) in 2 file\(s\)/);
  // Kind totals: exam 3 + 2, importance 1 + 2, common-mistake 2, recall 1, interview 1.
  assert.match(res.stderr, /\n {2}exam: 5\n/);
  assert.match(res.stderr, /\n {2}importance: 3\n/);
  assert.match(res.stderr, /\n {2}common-mistake: 2\n/);
  assert.match(res.stderr, /\n {2}recall: 1\n/);
  assert.match(res.stderr, /\n {2}interview: 1\n/);
  assert.match(res.stderr, /\n {4}on the exam\s+1\n/);
  assert.match(res.stderr, /\n {4}ask in exams\s+2\n/);
  assert.match(res.stderr, /\n {4}remember this\s+0\n/);
  assert.match(res.stderr, /1:40\s+\[exam: on the quiz\]/);
});

let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`ok   ${t.name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${t.name}\n     ${e.message}`);
  }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
if (failed) process.exitCode = 1;
