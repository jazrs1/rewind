// POST /api/tutor/study: one tutor turn in the full-screen study session. Dev only. The same handler, limits and checks
// as /api/tutor (../handler.ts); the topic rule is the exam's coverage topics, which this route looks up itself.

import { handleDevTutor } from "../handler";

export async function POST(req: Request) {
  return handleDevTutor(req, { study: true });
}
