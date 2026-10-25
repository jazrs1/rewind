// POST /api/tutor: one tutor turn beside a question (the practice and rewind panel). Dev only. The handler, and what it
// checks before any of the reply is sent, is in ./handler.ts.

import { handleDevTutor } from "./handler";

export async function POST(req: Request) {
  return handleDevTutor(req);
}
