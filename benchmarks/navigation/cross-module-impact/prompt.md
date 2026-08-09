`formatMoney(cents)` in `src/lib/money.mjs` must start taking a currency code as its second argument: `formatMoney(cents, currency)`, defaulting to `"USD"` when omitted is NOT acceptable — every existing call site must be updated to pass its module's currency explicitly.

Each calling module already knows its currency; look for a `CURRENCY` constant near the call.
