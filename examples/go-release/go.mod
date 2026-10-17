module github.com/emmett08/mas-host-examples/examples/go-release

go 1.24.0

require github.com/emmett08/mas-host/sdk/go v0.0.0-20261017102102-b3f56be76c38

// The repository setup command verifies and installs this exact SDK revision.
replace github.com/emmett08/mas-host/sdk/go => ../../.tools/mas-host/sdk/go
