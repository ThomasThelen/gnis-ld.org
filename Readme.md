# gnis-ld.org

Frontend for https://gnis-ld.org

## Building

To build the source, run from the project root:

```
npm ci
npm run build
```

`npm run watch` rebuilds on change during development.

### Docker

Container images are built and published automatically by GitHub Actions (`.github/workflows/docker-publish.yml`) to `ghcr.io/dataoneorg/gnis-ld`. Any merges to `main` update the `latest` tag.

To build an image locally:

`docker build -t gnis-ld:dev .`

### Differentiating Between Production & Development

The main difference between production and development builds is the base URL. For example, development builds that are deployed on the develop cluster have address `stage.gnis-ld.org` while production builds have `gnis-ld.org`. This value is controlled by the `BASE` environment variable, read in `config.app.js` (the SPARQL endpoint is likewise controlled by `USGS_ENDPOINT_URL`, and the data path by `USGS_DATA_PATH`).

## Running

```
npm ci
npm run build
node lib/js/server.js -p 3006
```

The server renders pug views directly from `lib/webapp/_layouts` and serves compiled assets from `dist/`.


## Acknowledgments
Work on this package was supported by:
  - NSF OIA grant [2033521](https://www.nsf.gov/awardsearch/showAward?AWD_ID=2033521) to Krzysztof Janowicz
