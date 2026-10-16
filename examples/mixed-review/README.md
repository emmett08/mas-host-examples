# Mixed languages: independently checked purchase review

This example combines **Go orchestration**, **Rust exposure arithmetic** and a
**C++ overdue-balance policy**, with an optional **Python entry agent**. Its illustrative business rules use supplied
balances; they do not access accounts or make a purchase.

`make mixed-python` enters through `python_reviewer`, which requests the Go
`reviewer` through MAS. This demonstrates Python → Go → Rust/C++ communication
without changing the purchase input or implementing a second transport.
`make mixed` enters at Go directly.

The `reviewer` agent requests `exposure` and `arrears` in parallel. The host
records each child's result. Go then recomputes both reports independently and
accepts a decision only if every report field agrees. Approval requires both
policies to pass. Topology permits only coordinator–specialist traffic; the
specialists cannot call one another or accept requests directly from `client`.

`input.json` produces projected commitment **200000**, remaining capacity
**50000**, overdue balance **5000**, oldest overdue age **7**, and
`approved: true`. `reject.json` exceeds both declared policies and produces
`approved: false`. A refused proposal completes normally.

Monetary inputs lie in 0–1,000,000,000,000 minor units of one currency. A positive
purchase and 1–64 invoice records are required. Ages lie in 0–36,500 days. An
invoice with zero outstanding balance contributes neither debt nor overdue age.
These limits keep all three languages' calculations exact within 64-bit integers.

Only application functions, ordinary tests and the two configurations are
authored here. MAS generates and launches all worker executables. The Go module
uses the pinned SDK installed by the repository's setup command. See the root
README for build/run commands. Unit tests include deliberately corrupted reports,
inclusive policy boundaries, zero balances and invalid amounts.
