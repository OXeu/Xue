FROM golang:alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=1 GOOS=linux go build -o /app/main .

FROM alpine:latest
RUN apk --no-cache add ca-certificates
COPY --from=builder /app/main /app/main
WORKDIR /app
CMD ["/app/main"]