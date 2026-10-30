# Dockerfile for GNIS-LD frontend
FROM node:26-alpine
LABEL org.opencontainers.image.authors="DataONE <support@dataone.org>"

EXPOSE 3006

# source code
WORKDIR /src/app
COPY . .

# install dependencies and build the website
RUN npm ci && npm run build

# entrypoint
CMD ["npm", "start", "--", "-p", "3006"]
