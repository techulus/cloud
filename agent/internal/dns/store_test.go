package dns

import (
	"reflect"
	"testing"
)

func TestRecordStoreUpdateHashMatchesHashRecordsWithoutMutatingInput(t *testing.T) {
	records := []DnsRecord{
		{Name: "z.internal", Ips: []string{"10.0.0.2", "10.0.0.1"}},
		{Name: "a.internal", Ips: []string{"10.0.1.2", "10.0.1.1"}},
	}
	original := []DnsRecord{
		{Name: records[0].Name, Ips: append([]string(nil), records[0].Ips...)},
		{Name: records[1].Name, Ips: append([]string(nil), records[1].Ips...)},
	}

	store := NewRecordStore()
	store.Update(records)

	if got, want := store.Hash(), HashRecords(records); got != want {
		t.Fatalf("hash = %q, want %q", got, want)
	}
	if !reflect.DeepEqual(records, original) {
		t.Fatalf("Update mutated records: got %#v, want %#v", records, original)
	}
}
