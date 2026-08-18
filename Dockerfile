# Dockerfile for GNIS-LD frontend
FROM node:24-alpine
LABEL org.opencontainers.image.authors="DataONE <support@dataone.org>"

# web server (config.app.ts)
EXPOSE 3006

# source code
WORKDIR /src/app
COPY . .

# install dependencies and build client assets
RUN npm ci && npm run build

# entrypoint
CMD ["npm", "start", "--", "-p", "3006"]
