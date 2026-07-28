package logs

import (
	"reflect"
	"testing"

	"techulus/cloud-agent/internal/routeowners"
)

func TestTraefikCollectorProcessLineQueuesRetainedFields(t *testing.T) {
	owners := routeowners.NewRegistry()
	owners.Merge(map[string]string{"http-opaque": "service-42"})
	collector := NewTraefikCollector(nil, owners)
	collector.processLine([]byte(`{
		"ClientHost":"192.0.2.10",
		"DownstreamContentSize":321,
		"DownstreamStatus":201,
		"Duration":12500000,
		"RequestHost":"api.example.com",
		"RequestMethod":"POST",
		"RequestPath":"/v1/items",
		"RouterName":"http-opaque@file",
		"StartUTC":"2026-07-23T10:11:12Z",
		"time":"",
		"ClientAddr":"ignored:1234",
		"OriginStatus":503,
		"TLSVersion":"1.3",
		"msg":"ignored"
	}`))

	want := []HTTPLogEntry{{
		ServiceId: "service-42",
		Host:      "api.example.com",
		Method:    "POST",
		Path:      "/v1/items",
		Status:    201,
		Duration:  12.5,
		Size:      321,
		ClientIP:  "192.0.2.10",
		Timestamp: "2026-07-23T10:11:12Z",
	}}
	if !reflect.DeepEqual(collector.queue, want) {
		t.Fatalf("queued entries = %#v, want %#v", collector.queue, want)
	}
}

func TestTraefikCollectorDropsUnknownRouter(t *testing.T) {
	collector := NewTraefikCollector(nil, routeowners.NewRegistry())
	collector.processLine([]byte(`{"RequestHost":"example.com","RouterName":"unknown@file"}`))
	if len(collector.queue) != 0 {
		t.Fatal("unknown router was queued")
	}
}
