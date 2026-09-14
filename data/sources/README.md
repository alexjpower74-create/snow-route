# Sources

- `nrn-gfw-sample-streets.geojson`: the Statistics Canada National Road Network (NRN) road segments, Newfoundland and Labrador edition 7.0, for the
  26 streets the SAMPLE data uses in Grand Falls-Windsor (164+ segments with NID, street and place names). Extracted locally from
  <https://geo.statcan.gc.ca/nrn_rrn/nl/nrn_rrn_nl_GPKG.zip> (one request, fetched 2026-09-14T20:02:47Z, 23,858,147 bytes, sha256
  `5250ddf9e017ea0f3caa6e2eff11c382cad4ff021875ae1a4ecad169ef946270`; the 24 MB archive itself is not kept in the repo).
  Contains information licensed under the Open Government Licence – Canada (`open-government-licence-canada.html`, fetched 2026-09-14T20:02:49Z).
- `robots/`: the robots.txt files checked before any download (DECISIONS.md 68): overpass-api.de disallows `/api/` (the old source, removed),
  download.geofabrik.de disallows `*.osm.pbf` and `*.shp.zip`, ftp.maps.canada.ca disallows `/pub`, open.canada.ca allows the dataset page
  (Crawl-delay 20), geo.statcan.gc.ca has none (404).
- `openfreemap-home.html`: <https://openfreemap.org/>, fetched 2026-09-14T16:26:17Z (one request each, same User-Agent). Holds the terms quoted
  in DECISIONS.md 62: commercial use allowed, no limits, no registration or API keys, no SLA, and the required attribution.
- `openfreemap-quick-start.html`: <https://openfreemap.org/quick_start/>, fetched 2026-09-14T16:24:56Z. Holds the attribution markup used
  verbatim in `app/public/owner/owner.js` and the Leaflet + MapLibre GL setup.
