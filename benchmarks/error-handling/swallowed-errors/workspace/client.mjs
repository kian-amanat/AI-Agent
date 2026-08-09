let transport = async () => { throw new Error("not configured"); };
export function setTransport(fn) { transport = fn; }

/** Returns the user, or null when there is none. */
export async function fetchUser(id) {
  try {
    const res = await transport(`/api/users/${id}`);
    if (res.status === 404) return null;
    return res.body;
  } catch {
    // BUG: a network failure is indistinguishable from "no such user".
    return null;
  }
}
