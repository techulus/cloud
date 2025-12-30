package retry

import (
	"context"
	"fmt"
	"math/rand"
	"time"
)

type BackoffConfig struct {
	InitialDelay time.Duration
	MaxDelay     time.Duration
	Multiplier   float64
	MaxRetries   int
	Jitter       float64
}

var StopBackoff = BackoffConfig{
	InitialDelay: 500 * time.Millisecond,
	MaxDelay:     30 * time.Second,
	Multiplier:   2.0,
	MaxRetries:   10,
	Jitter:       0.1,
}

var DeployBackoff = BackoffConfig{
	InitialDelay: 1 * time.Second,
	MaxDelay:     10 * time.Second,
	Multiplier:   1.5,
	MaxRetries:   5,
	Jitter:       0.1,
}

var ConfigBackoff = BackoffConfig{
	InitialDelay: 500 * time.Millisecond,
	MaxDelay:     5 * time.Second,
	Multiplier:   2.0,
	MaxRetries:   5,
	Jitter:       0.1,
}

var ForceRemoveBackoff = BackoffConfig{
	InitialDelay: 500 * time.Millisecond,
	MaxDelay:     30 * time.Second,
	Multiplier:   2.0,
	MaxRetries:   10,
	Jitter:       0.1,
}

func WithBackoff(ctx context.Context, config BackoffConfig, check func() (done bool, err error)) error {
	delay := config.InitialDelay

	for attempt := 1; attempt <= config.MaxRetries; attempt++ {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		done, err := check()
		if done {
			return nil
		}

		if attempt == config.MaxRetries {
			if err != nil {
				return fmt.Errorf("failed after %d attempts: %w", config.MaxRetries, err)
			}
			return fmt.Errorf("failed after %d attempts: condition not met", config.MaxRetries)
		}

		jitteredDelay := addJitter(delay, config.Jitter)

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(jitteredDelay):
		}

		delay = time.Duration(float64(delay) * config.Multiplier)
		if delay > config.MaxDelay {
			delay = config.MaxDelay
		}
	}

	return fmt.Errorf("failed after %d attempts", config.MaxRetries)
}

func addJitter(delay time.Duration, jitterFraction float64) time.Duration {
	if jitterFraction <= 0 {
		return delay
	}
	jitter := float64(delay) * jitterFraction * (rand.Float64()*2 - 1)
	return delay + time.Duration(jitter)
}
