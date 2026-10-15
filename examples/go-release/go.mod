module github.com/emmett08/mas-host-examples/examples/go-release

go 1.24.0

require github.com/emmett08/mas-host/sdk/go v0.0.0-20261015210436-ad3c275fbfb2

// The repository setup command verifies and installs this exact SDK revision.
replace github.com/emmett08/mas-host/sdk/go => ../../.tools/mas-host/sdk/go
