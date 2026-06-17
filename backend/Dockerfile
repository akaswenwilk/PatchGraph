FROM golang:1.24.4-alpine AS build

WORKDIR /app

COPY go.mod ./
COPY cmd ./cmd
COPY internal ./internal

RUN go build -o /patchgraph-server ./cmd/server

# Build the Go language server (gopls) so it can be copied into the runtime image.
RUN go install golang.org/x/tools/gopls@v0.18.1

FROM golang:1.24.4-alpine

WORKDIR /app

# git: existing runtime dependency.
# nodejs/npm: required to run the TypeScript language server.
# The go toolchain (from the golang base image) is required by gopls at runtime.
RUN apk add --no-cache git nodejs npm

# Install the TypeScript language server (and the typescript it depends on) globally.
RUN npm install -g typescript@5.8.3 typescript-language-server@4.3.4

COPY --from=build /patchgraph-server /usr/local/bin/patchgraph-server
COPY --from=build /go/bin/gopls /usr/local/bin/gopls

EXPOSE 8080

ENTRYPOINT ["patchgraph-server"]
