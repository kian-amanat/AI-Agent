## Expected

This is a **resume** task: the prompt names no files beyond the entry point and
describes no steps. The work already in the tree defines the job, and the three
`TODO` comments in `CommandPalette.tsx` say what is left:

1. close on `Escape` (a keyboard handler),
2. run the selected command on `Enter`,
3. register at least one real command in `src/commands.mjs`,

and then the component has to be rendered from `src/App.tsx`, which currently
never mentions it.

The failure this catches is re-deriving the task from scratch: rewriting the
palette from a blank file, or "finishing" it without ever rendering it.

## Not expected

- Deleting the half-built component and starting over.
- Leaving the TODOs in place with the work done around them.
