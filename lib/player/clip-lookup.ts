// Which hosted clip plays a lecture moment. Pure, shared by the study session, the tutor and Ask (ClipTile).

/** A hosted clip: its URL, the lecture second its file starts at, and (when known) the second its clip ends. */
export interface HostedMedia {
  src: string;
  offset: number;
  end?: number;
}

/**
 * The moment's own question's clip when there is one; otherwise a hosted clip of the same lecture whose
 * [offset, end] holds the moment's second (both ends included). Demo question ids carry their lecture
 * (l20261013-q1 is Oct 13's), and a moment's date is YYYY-MM-DD. Null when nothing covers it.
 */
export function hostedClipAt(media: Record<string, HostedMedia> | null | undefined, at: { questionId?: string; date?: string | null; second: number }): HostedMedia | null {
  if (!media) return null;
  if (at.questionId && media[at.questionId]) return media[at.questionId];
  if (!at.date) return null;
  const lecture = `l${at.date.replace(/-/g, "")}-`;
  for (const [id, m] of Object.entries(media)) {
    if (id.startsWith(lecture) && m.end !== undefined && m.offset <= at.second && at.second <= m.end) return m;
  }
  return null;
}
