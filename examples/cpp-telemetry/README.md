# C++: bounded telemetry window

The `telemetry` agent evaluates an integer sample window against inclusive
thresholds. It reports the extrema, sum, floor of the arithmetic mean, breach
count and first breach index (`-1` when none). A window is acceptable when its
breach count does not exceed `max_breaches`.

`input.json` reports **2** breaches, mean floor **436**, first breach index **3**
and `acceptable: false`. Raising `max_breaches` to **2** accepts the same window.
`reject.json` permits no breaches and therefore also fails the domain check.

The application limits windows to 1–1024 samples and values to
−1,000,000…1,000,000, proving that accumulation fits a signed 64-bit integer.
Negative means round towards negative infinity. Units are chosen by the caller;
for example, values can represent tenths of a degree. No floating point crosses
the protocol boundary.

MAS supplies the worker entry point; `tests/telemetry_test.cpp` is an ordinary
standalone unit-test executable. See the root README for build and run commands.
