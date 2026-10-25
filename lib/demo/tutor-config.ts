// What the demo practice pages give the tutor panel: the public demo's live tutor (app/api/demo/tutor/route.ts), no
// graded work, and for each question its lecture's date and tape colour for the mini-tape chips. Pure data from the
// bundle, so the demo pages stay static.

import type { TutorConfig } from "../../components/tutor/types.ts";
import type { DemoBundle } from "./bundle.ts";

export function demoTutorConfig(bundle: DemoBundle): TutorConfig {
  const moments: TutorConfig["moments"] = {};
  [...bundle.sets]
    .sort((a, b) => a.id.localeCompare(b.id))
    .forEach((set, i) => {
      for (const q of set.seed.questions) moments[q.id] = { date: set.id, shell: ((i % 4) + 1) as 1 | 2 | 3 | 4 };
    });
  return { endpoint: "/api/demo/tutor", demo: true, graded: null, gradedIds: [], moments, session: "" };
}
