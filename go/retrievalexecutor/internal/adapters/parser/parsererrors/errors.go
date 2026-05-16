package parsererrors

import "fmt"

const (
	CodeUnsupportedFormat  = "unsupported-format"
	CodeDependencyMissing  = "dependency-missing"
	CodeBackendUnavailable = "parser-backend-unavailable"
	CodeParseFailed        = "parse-failed"
	CodeFileReadFailed     = "file-read-failed"
)

type AdapterError struct {
	Code      string
	Source    string
	Message   string
	Retryable bool
	Err       error
}

func (e AdapterError) Error() string {
	base := fmt.Sprintf("%s: %s", e.Code, e.Message)
	if e.Source != "" {
		base = fmt.Sprintf("%s (%s)", base, e.Source)
	}
	if e.Err == nil {
		return base
	}
	return fmt.Sprintf("%s: %v", base, e.Err)
}

func (e AdapterError) Unwrap() error {
	return e.Err
}

func (e AdapterError) IsRetryable() bool {
	return e.Retryable
}

func (e AdapterError) ErrorSource() string {
	return e.Source
}

func (e AdapterError) ErrorCode() string {
	return e.Code
}

func UnsupportedFormat(source string, message string, err error) error {
	return AdapterError{
		Code:      CodeUnsupportedFormat,
		Source:    source,
		Message:   message,
		Retryable: false,
		Err:       err,
	}
}

func DependencyMissing(source string, message string, err error) error {
	return AdapterError{
		Code:      CodeDependencyMissing,
		Source:    source,
		Message:   message,
		Retryable: false,
		Err:       err,
	}
}

func BackendUnavailable(source string, message string, retryable bool, err error) error {
	return AdapterError{
		Code:      CodeBackendUnavailable,
		Source:    source,
		Message:   message,
		Retryable: retryable,
		Err:       err,
	}
}

func ParseFailed(source string, message string, err error) error {
	return AdapterError{
		Code:      CodeParseFailed,
		Source:    source,
		Message:   message,
		Retryable: false,
		Err:       err,
	}
}

func FileReadFailed(source string, message string, retryable bool, err error) error {
	return AdapterError{
		Code:      CodeFileReadFailed,
		Source:    source,
		Message:   message,
		Retryable: retryable,
		Err:       err,
	}
}
