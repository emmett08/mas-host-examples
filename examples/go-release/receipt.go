package release

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// Receipt binds the accepted decision to the admitted effect identity. Recovery
// must verify both against the host journal before recording a resolution.
type Receipt struct {
	Version      string   `json:"version"`
	InvocationID string   `json:"invocation_id"`
	Output       Decision `json:"output"`
}

func writeReceipt(path, invocationID string, decision Decision) error {
	if invocationID == "" {
		return fmt.Errorf("receipt requires an admitted invocation identity")
	}
	raw, err := json.Marshal(Receipt{Version: "release-receipt/1", InvocationID: invocationID, Output: decision})
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer file.Close()
	n, err := file.Write(raw)
	if err != nil {
		return err
	}
	if n != len(raw) {
		return io.ErrShortWrite
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	// fsync the directory as well as the file before the demonstration crash.
	directory, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
