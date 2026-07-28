package metrics

import (
	"bytes"
	"fmt"

	dto "github.com/prometheus/client_model/go"
	"github.com/prometheus/common/expfmt"
	"github.com/prometheus/common/model"
	"techulus/cloud-agent/internal/routeowners"
)

// EnrichTraefik adds service_id only when Traefik's service label has an
// explicit owner in the registry. Parsing and encoding preserve all metric
// types, escaped labels, and timestamps according to the exposition format.
func EnrichTraefik(data []byte, owners *routeowners.Registry) ([]byte, error) {
	parser := expfmt.NewTextParser(model.LegacyValidation)
	families, err := parser.TextToMetricFamilies(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("parse Prometheus metrics: %w", err)
	}
	var output bytes.Buffer
	encoder := expfmt.NewEncoder(&output, expfmt.NewFormat(expfmt.TypeTextPlain))
	for _, family := range families {
		for _, metric := range family.Metric {
			labels := metric.Label[:0]
			var serviceID string
			owned := false
			for _, label := range metric.Label {
				if label.GetName() == "service_id" {
					continue
				}
				if label.GetName() == "service" {
					serviceID, owned = owners.Lookup(label.GetValue())
				}
				labels = append(labels, label)
			}
			metric.Label = labels
			if owned {
				name, value := "service_id", serviceID
				metric.Label = append(metric.Label, &dto.LabelPair{Name: &name, Value: &value})
			}
		}
		if err := encoder.Encode(family); err != nil {
			return nil, err
		}
	}
	return output.Bytes(), nil
}
