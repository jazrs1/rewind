// The only web origins allowed to talk to the extension's bridge. Kept next to manifest.json,
// whose externally_connectable.matches must list exactly these (as "<origin>/*"); a test
// (test/bridge.test.js) fails if the two drift apart or a wildcard host appears, and
// lib/brand/site.test.ts fails if the production entries aren't the app's own (lib/brand/site.ts).
// localhost:3000 is for dev.

var ALLOWED_APP_ORIGINS = ['http://localhost:3000', 'https://rewindit.org', 'https://www.rewindit.org'];
