FROM golang:1.24-alpine AS grpcurl-build
RUN go install github.com/fullstorydev/grpcurl/cmd/grpcurl@v1.9.3

FROM node:22-alpine
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=grpcurl-build /go/bin/grpcurl /usr/local/bin/grpcurl
COPY --chown=node:node index.html styles.css app.js server.mjs logo.svg favicon.svg ./
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node","server.mjs"]
