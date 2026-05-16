package provider

import "fmt"

type AdapterError struct {
	Provider  string
	Model     string
	Reason    string
	Retryable bool
	Err       error
}

func (e AdapterError) Error() string {
	if e.Err == nil {
		return fmt.Sprintf("embedding provider=%s model=%s failed: %s", e.Provider, e.Model, e.Reason)
	}
	return fmt.Sprintf("embedding provider=%s model=%s failed: %s: %v", e.Provider, e.Model, e.Reason, e.Err)
}

func (e AdapterError) Unwrap() error {
	return e.Err
}

func (e AdapterError) IsRetryable() bool {
	return e.Retryable
}

func (e AdapterError) ErrorSource() string {
	return e.Provider
}

func (e AdapterError) ErrorReason() string {
	return e.Reason
}

func (e AdapterError) ErrorProvider() string {
	return e.Provider
}

func (e AdapterError) ErrorModel() string {
	return e.Model
}
