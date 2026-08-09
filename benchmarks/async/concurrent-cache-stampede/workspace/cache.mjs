let fetchCount = 0;
export function getFetchCount() { return fetchCount; }
export function resetFetchCount() { fetchCount = 0; }

/** Stands in for a slow remote call. */
let shouldFail = false;
export function setShouldFail(v) { shouldFail = v; }
async function fetchUser(id) {
  fetchCount++;
  await new Promise((r) => setTimeout(r, 20));
  if (shouldFail) throw new Error("upstream down");
  return { id, name: `user-${id}` };
}

const cache = new Map();

/** BUG: concurrent misses each start their own fetch. */
export async function getUser(id) {
  if (cache.has(id)) return cache.get(id);
  const user = await fetchUser(id);
  cache.set(id, user);
  return user;
}
