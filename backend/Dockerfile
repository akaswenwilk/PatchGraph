FROM golang:1.24.4-alpine AS build

WORKDIR /app

COPY go.mod ./
COPY cmd ./cmd
COPY internal ./internal

RUN go build -o /patchgraph-server ./cmd/server

FROM alpine:3.22

WORKDIR /app

COPY --from=build /patchgraph-server /usr/local/bin/patchgraph-server

EXPOSE 8080

ENTRYPOINT ["patchgraph-server"]
