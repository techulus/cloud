package agent

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	agenthttp "techulus/cloud-agent/internal/http"
)

const (
	reconcileFailureBaseBackoff = 5 * time.Second
	reconcileFailureMaxBackoff  = 5 * time.Minute
)

type reconcileActionFailure struct {
	Key          string
	Kind         reconcileActionKind
	DeploymentID string
	Description  string
	LastError    string
	Attempts     int
	NextRetryAt  time.Time
}

func (a *Agent) reconcileActionKey(action reconcileAction) string {
	target := action.DeploymentID
	if target == "" && action.Actual != nil {
		target = action.Actual.ID
	}

	var desired any
	switch action.Kind {
	case actionDeployMissingContainer, actionStopExpectedContainer, actionStartContainer, actionRedeployContainer:
		desired = action.Expected
	case actionUpdateDNS:
		desired = a.expectedState.Dns
	case actionUpdateTraefik:
		desired = a.expectedState.Traefik
	case actionUpdateCertificates:
		desired = a.expectedState.Traefik.Certificates
	case actionWriteChallengeRoute:
		desired = a.expectedState.Traefik.ChallengeRoute
	case actionUpdateWireGuard, actionStartWireGuard:
		desired = a.expectedState.Wireguard
	default:
		desired = action.Description
	}

	payload, _ := json.Marshal(desired)
	digest := sha256.Sum256(payload)
	return fmt.Sprintf("%s:%s:%s", action.Kind, target, hex.EncodeToString(digest[:8]))
}

func reconcileFailureBackoff(attempts int, key string) time.Duration {
	backoff := reconcileFailureBaseBackoff
	for i := 1; i < attempts && backoff < reconcileFailureMaxBackoff; i++ {
		backoff *= 2
	}
	if backoff >= reconcileFailureMaxBackoff {
		return reconcileFailureMaxBackoff
	}
	digest := sha256.Sum256([]byte(key))
	jitterWindow := backoff / 5
	jitter := time.Duration(
		binary.BigEndian.Uint64(digest[:8]) % uint64(jitterWindow+1),
	)
	if backoff+jitter > reconcileFailureMaxBackoff {
		return reconcileFailureMaxBackoff
	}
	return backoff + jitter
}

func (a *Agent) recordReconcileFailure(action reconcileAction, err error, now time.Time) reconcileActionFailure {
	key := a.reconcileActionKey(action)
	a.reconcileFailureMutex.Lock()
	defer a.reconcileFailureMutex.Unlock()

	failure := a.reconcileFailures[key]
	failure.Key = key
	failure.Kind = action.Kind
	failure.DeploymentID = action.DeploymentID
	failure.Description = action.Description
	failure.LastError = err.Error()
	failure.Attempts++
	failure.NextRetryAt = now.Add(reconcileFailureBackoff(failure.Attempts, key))
	a.reconcileFailures[key] = failure
	return failure
}

func (a *Agent) clearReconcileFailure(action reconcileAction) {
	key := a.reconcileActionKey(action)
	a.reconcileFailureMutex.Lock()
	defer a.reconcileFailureMutex.Unlock()
	delete(a.reconcileFailures, key)
}

func (a *Agent) clearReconcileFailures() {
	a.reconcileFailureMutex.Lock()
	defer a.reconcileFailureMutex.Unlock()
	clear(a.reconcileFailures)
}

func (a *Agent) nextEligibleReconcileAction(actions []reconcileAction, now time.Time) (reconcileAction, bool, time.Time) {
	activeKeys := make(map[string]struct{}, len(actions))
	keys := make([]string, len(actions))
	for i, action := range actions {
		keys[i] = a.reconcileActionKey(action)
		activeKeys[keys[i]] = struct{}{}
	}

	a.reconcileFailureMutex.Lock()
	defer a.reconcileFailureMutex.Unlock()
	for key := range a.reconcileFailures {
		if _, active := activeKeys[key]; !active {
			delete(a.reconcileFailures, key)
		}
	}

	var earliestRetry time.Time
	for i, action := range actions {
		failure, failed := a.reconcileFailures[keys[i]]
		if !failed || !now.Before(failure.NextRetryAt) {
			return action, true, earliestRetry
		}
		if earliestRetry.IsZero() || failure.NextRetryAt.Before(earliestRetry) {
			earliestRetry = failure.NextRetryAt
		}
	}

	return reconcileAction{}, false, earliestRetry
}

func (a *Agent) SnapshotReconciliationFailures() []agenthttp.ReconciliationFailure {
	a.reconcileFailureMutex.Lock()
	defer a.reconcileFailureMutex.Unlock()

	failures := make([]agenthttp.ReconciliationFailure, 0, len(a.reconcileFailures))
	for _, failure := range a.reconcileFailures {
		failures = append(failures, agenthttp.ReconciliationFailure{
			Action:       string(failure.Kind),
			DeploymentID: failure.DeploymentID,
			Description:  failure.Description,
			LastError:    failure.LastError,
			Attempts:     failure.Attempts,
			NextRetryAt:  failure.NextRetryAt,
		})
	}
	sort.Slice(failures, func(i, j int) bool {
		if failures[i].Action != failures[j].Action {
			return failures[i].Action < failures[j].Action
		}
		return failures[i].DeploymentID < failures[j].DeploymentID
	})
	return failures
}
