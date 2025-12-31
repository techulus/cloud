package logs

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

const stateFileName = "log-positions.json"

type State struct {
	positions map[string]string
	mu        sync.RWMutex
}

type stateFile struct {
	Positions map[string]string `json:"positions"`
}

func NewState() *State {
	return &State{
		positions: make(map[string]string),
	}
}

func (s *State) GetPosition(containerID string) string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.positions[containerID]
}

func (s *State) SetPosition(containerID, position string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.positions[containerID] = position
}

func (s *State) RemovePosition(containerID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.positions, containerID)
}

func (s *State) Load(dataDir string) error {
	path := filepath.Join(dataDir, stateFileName)

	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}

	var sf stateFile
	if err := json.Unmarshal(data, &sf); err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if sf.Positions != nil {
		s.positions = sf.Positions
	}

	return nil
}

func (s *State) Save(dataDir string) error {
	s.mu.RLock()
	sf := stateFile{
		Positions: make(map[string]string, len(s.positions)),
	}
	for k, v := range s.positions {
		sf.Positions[k] = v
	}
	s.mu.RUnlock()

	data, err := json.MarshalIndent(sf, "", "  ")
	if err != nil {
		return err
	}

	path := filepath.Join(dataDir, stateFileName)
	return os.WriteFile(path, data, 0600)
}
