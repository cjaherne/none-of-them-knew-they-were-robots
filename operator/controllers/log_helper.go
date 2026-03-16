package controllers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

type logEntry struct {
	ID        string                 `json:"id"`
	TaskID    string                 `json:"taskId,omitempty"`
	Timestamp string                 `json:"timestamp"`
	Level     string                 `json:"level"`
	Source    string                 `json:"source"`
	Message   string                 `json:"message"`
	Metadata  map[string]interface{} `json:"metadata,omitempty"`
	Category  string                 `json:"category,omitempty"`
}

var logAPIURL string
var logCounter int64

func SetLogAPIURL(url string) {
	logAPIURL = url
}

func postLogEntry(taskID, level, source, message, category string, metadata map[string]interface{}) {
	if logAPIURL == "" {
		return
	}

	logCounter++
	entry := logEntry{
		ID:        fmt.Sprintf("k8s-%d-%d", time.Now().UnixNano(), logCounter),
		TaskID:    taskID,
		Timestamp: time.Now().UTC().Format(time.RFC3339Nano),
		Level:     level,
		Source:    source,
		Message:   message,
		Metadata:  metadata,
		Category:  category,
	}

	body, err := json.Marshal(entry)
	if err != nil {
		return
	}

	client := &http.Client{Timeout: 5 * time.Second}
	req, err := http.NewRequest("POST", logAPIURL+"/internal/log", bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return
	}
	defer resp.Body.Close()
}
