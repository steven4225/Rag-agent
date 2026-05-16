FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go/retrievalexecutor/go.mod go/retrievalexecutor/go.sum ./
RUN go mod download
COPY go/retrievalexecutor/ ./
RUN CGO_ENABLED=0 go build -o /app/service ./cmd/retrieval-service

FROM alpine:3.20
RUN apk add --no-cache ca-certificates
USER 1000
COPY --from=build /app/service /app/service
EXPOSE 8090
ENTRYPOINT ["/app/service"]
