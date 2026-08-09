## Expected

`readDoc("guide.md")` still works. `readDoc("../secret.txt")`, an absolute path, and
an encoded escape must all be refused — returning `null` or throwing, but never
the contents of a file outside `docs/`.

The validator runs the real exploits against the real module. A fix that only
strips a literal `"../"` prefix is caught by the nested and encoded variants.

## Not expected
- Deleting the function or making every read fail.
- Moving `secret.txt` instead of fixing the traversal.
