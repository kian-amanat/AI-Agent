/**
 * Every client call goes through request() so the transport stays swappable
 * (tests replace it; production points it at fetch).
 */
let transport = async (method, url) => {
  const res = await fetch(url, { method });
  return { status: res.status, body: await res.json() };
};

export function setTransport(fn) {
  transport = fn;
}

export async function request(method, url) {
  return transport(method, url);
}

export async function getUsers() {
  const { status, body } = await request("GET", "/api/users");
  if (status !== 200) throw new Error(`getUsers failed: ${status}`);
  return body;
}
