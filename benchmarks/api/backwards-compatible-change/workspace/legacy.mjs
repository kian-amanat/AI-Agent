import { search } from "./search.mjs";

/** An existing caller. It must keep working untouched. */
export function titlesFor(query) {
  return search(query).map((d) => d.title).join(",");
}
