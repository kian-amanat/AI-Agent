## Expected

App Router conventions: the new page lives at `app/posts/page.tsx` and
default-exports a component. It imports `getPosts` from `lib/posts` and renders the
titles by mapping over the result — not by hardcoding the three titles that happen
to be in the fixture today.

`app/page.tsx` gains a link to `/posts`.

## Not expected

- `pages/posts.tsx` (this app uses the App Router).
- Copying the post titles into the page as literals.
- Removing the existing home page content.
