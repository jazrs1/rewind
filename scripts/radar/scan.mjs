#!/usr/bin/env node
// Lite exam radar: finds moments where the lecturer flags exam material.
// Usage: node scripts/radar/scan.mjs [--speaker <name>] <file.transcript.json...>
// JSON hits go to stdout; a human-readable summary goes to stderr.

import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTEXT_SEC = 20;

export function loadPhrases(path = join(HERE, 'phrases.json')) {
  return JSON.parse(readFileSync(path, 'utf8')).map((p) => ({
    phrase: p.phrase,
    kind: p.kind ?? null,
    re: new RegExp(p.pattern, 'i'),
  }));
}

// Case-insensitive substring match, so "Kapoor" matches "Firstname Kapoor".
export function speakerMatches(speaker, wanted) {
  if (!wanted) return true;
  return typeof speaker === 'string' && speaker.toLowerCase().includes(wanted.toLowerCase());
}

// Segments that overlap [start - 20 s, start + 20 s]. Context includes every speaker.
export function contextFor(segments, start) {
  const lo = start - CONTEXT_SEC;
  const hi = start + CONTEXT_SEC;
  return segments
    .filter((s) => s.start <= hi && (s.end ?? s.start) >= lo)
    .map((s) => ({ start: s.start, end: s.end ?? null, speaker: s.speaker ?? null, text: s.text }));
}

// One hit per (segment, phrase).
export function scanTranscript(transcript, file, phrases, { speaker } = {}) {
  const segments = Array.isArray(transcript.segments) ? transcript.segments : [];
  const hits = [];
  for (const seg of segments) {
    if (typeof seg.text !== 'string' || !speakerMatches(seg.speaker, speaker)) continue;
    for (const p of phrases) {
      if (!p.re.test(seg.text)) continue;
      hits.push({
        file,
        start: seg.start,
        speaker: seg.speaker ?? null,
        phrase: p.phrase,
        kind: p.kind,
        text: seg.text,
        context: contextFor(segments, seg.start),
      });
    }
  }
  return hits;
}

export function formatTime(sec) {
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function summarize(hits, phrases, files) {
  const lines = [`Exam radar: ${hits.length} hit(s) in ${files.length} file(s)`, '', 'Hits by kind and phrase:'];
  const width = Math.max(...phrases.map((p) => p.phrase.length));
  const kinds = [...new Set(phrases.map((p) => p.kind))];
  for (const kind of kinds) {
    lines.push(`  ${kind ?? '(no kind)'}: ${hits.filter((h) => h.kind === kind).length}`);
    for (const p of phrases.filter((x) => x.kind === kind)) {
      const n = hits.filter((h) => h.phrase === p.phrase).length;
      lines.push(`    ${p.phrase.padEnd(width)}  ${n}`);
    }
  }
  for (const f of files) {
    const fileHits = hits.filter((h) => h.file === f);
    lines.push('', `${basename(f)}: ${fileHits.length} hit(s)`);
    for (const h of fileHits) {
      const text = h.text.length > 90 ? h.text.slice(0, 87) + '...' : h.text;
      lines.push(`  ${formatTime(h.start).padStart(8)}  [${h.kind}: ${h.phrase}] ${text}`);
    }
  }
  return lines.join('\n');
}

export function parseArgs(argv) {
  const files = [];
  let speaker = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--speaker') speaker = argv[++i] ?? null;
    else if (argv[i].startsWith('--speaker=')) speaker = argv[i].slice('--speaker='.length);
    else files.push(argv[i]);
  }
  return { files, speaker };
}

function main() {
  const { files, speaker } = parseArgs(process.argv.slice(2));
  if (!files.length) {
    process.stderr.write('Usage: node scripts/radar/scan.mjs [--speaker <name>] <file.transcript.json...>\n');
    process.exit(2);
  }
  const phrases = loadPhrases();
  const hits = [];
  for (const file of files) {
    const transcript = JSON.parse(readFileSync(file, 'utf8'));
    hits.push(...scanTranscript(transcript, file, phrases, { speaker }));
  }
  process.stdout.write(JSON.stringify(hits, null, 2) + '\n');
  process.stderr.write(summarize(hits, phrases, files) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
