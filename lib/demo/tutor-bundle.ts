// Reads something once and remembers it, except a failure: a rejected read is forgotten, so the next call tries again
// instead of every later call failing on a cached rejection.

export function onceUnlessFailed<T>(read: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | null = null;
  return () => {
    cached ??= read().catch((e) => {
      cached = null;
      throw e;
    });
    return cached;
  };
}
