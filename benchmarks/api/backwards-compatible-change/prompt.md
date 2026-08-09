`search(query)` needs to support pagination: callers should be able to pass `{ limit, offset }`.

Existing callers pass only a query string and must keep working exactly as they do today.
