const DOCS = [
  { id: 1, title: "alpha" }, { id: 2, title: "alfalfa" }, { id: 3, title: "beta" },
  { id: 4, title: "alpine" }, { id: 5, title: "gamma" }, { id: 6, title: "alabaster" },
];

/** Returns every document whose title contains `query`. */
export function search(query) {
  return DOCS.filter((d) => d.title.includes(String(query ?? "")));
}
