# Rust: exact order quotation

`order.rs` is an application function. MAS generates its Cargo package, worker
entry point and registration from `agents.toml` and `topology.yaml`.

The `order` agent prices 1–32 unique item lines, applies a discount, rounds tax,
adds shipping and checks the caller's budget. Values are integer minor units of
one currency. Discount rounds down; tax rounds to nearest with halves up, and
shipping is added after tax. These are explicit illustrative pricing rules.

`input.yaml` yields subtotal **4700**, discount **235**, tax **893**, total **5658**
and `within_budget: true`. `reject.yaml` changes the budget to **5657** and yields
`within_budget: false`; a rejected quote is a successful computation.

Invalid quantities, duplicate SKUs and overflowing sums fail the operation.
Quantities are bounded at 1,000,000 and unit prices at 1,000,000,000,000; checked
arithmetic also rejects an aggregate that exceeds `u64`. Intermediate percentage
calculations use `u128` without losing precision.

See the root README for build/run commands. The application unit tests are
compiled through the host-generated `.mas/build/native-0/Cargo.toml` package;
the repository test command runs them after building the example.
