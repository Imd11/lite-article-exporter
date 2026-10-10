# Lite Article Exporter

Lite Article Exporter is a Chrome extension that extracts the main content from web articles and exports it as Markdown, Word, PDF, or TXT.

It is built for people who save useful articles for research, writing, study, and long-term reference, but do not want to keep noisy web pages full of ads, sidebars, and broken formatting.

Chrome Web Store:
https://chromewebstore.google.com/detail/lite-article-exporter/cemcpicgpndenhnkegmohoncnjhnknie

## Features

- Extracts clean article content with Mozilla Readability
- Removes common page clutter and keeps the main text readable
- Exports to Markdown, Word, PDF, and TXT
- Preserves image links in Markdown/TXT; embeds available images in Word/PDF
- Prepares eligible articles in the focused tab before opening the popup
- Continues accepted export tasks after the popup closes, with per-format status and retry
- Works better on logged-in or dynamic pages by reading from the active tab when needed
- Stores export history and format preferences locally

## Why this exists

We live in a knowledge-heavy era, but saving good information is still harder than it should be. Useful articles often disappear into unread bookmarks or messy full-page saves. This project tries to make article collection simpler: keep the content, drop the clutter, and export into formats that are easier to reuse.

## Tech stack

- Manifest V3
- TypeScript
- Vite
- `@mozilla/readability`
- `turndown`
- `pdf-lib`

## Project structure

```text
lite-article-exporter/
├── public/                 # Manifest, locales, icons
├── src/background/         # Service worker
├── src/popup/              # Popup UI
├── src/utils/              # Extraction and export logic
├── scripts/                # Build and packaging helpers
├── docs/                   # Additional docs
└── packages/               # Generated release zips
```

## Local development

```bash
npm install
npm run build
```

Then open `chrome://extensions`, enable Developer Mode, click `Load unpacked`, and select the `dist/` directory.

For a packaged build:

```bash
npm run package
```

The generated zip will be written to `packages/`.

For regression checks:

```bash
npm ci
npm run lint
npm test
npx playwright install chromium
npm run test:browser
```

The browser suite uses an isolated profile, intercepted article fixtures and a temporary download directory. It does not read personal browser data.

## Permissions

- `host_permissions: <all_urls>`: reads article content for explicit exports and the limited automatic preparation described below
- `downloads`: saves exported files
- `storage`: stores local history and user preferences
- `tabs`: reads the current active tab URL for convenience
- `scripting`: extracts content from the currently opened page, especially for logged-in or dynamic sites
- `webNavigation`: invalidates snapshots when the document or SPA route changes
- `offscreen`: parses snapshots and generates files without keeping the popup open
- `alarms`: reconciles accepted jobs with native browser download states after the worker sleeps

Article processing happens locally. Word/PDF can fetch article images, including the existing `images.weserv.nl` proxy for WeChat images; automatic preparation does not fetch images or fonts. No article body is uploaded by the extension. See the [privacy policy](docs/privacy-policy.md) and [background preparation details](docs/background-preparation.md).

## Background preparation

Automatic preparation is enabled by default and can be turned off in the popup. It only runs for an eligible article in the focused, active tab on `mp.weixin.qq.com`, Substack, Medium or `telegraph.co.uk`. Home/feed pages, oversized pages and private tabs are excluded. Other sites and ChatGPT/Gemini/Grok/X remain available through explicit export.

Open an article, then open the extension: a prepared article can be downloaded immediately after choosing formats. If preparation is still running, Download queues the request and the job continues when ready. Clicking the icon still opens the format panel; it does not start a download by itself. Word/PDF generation and browser save dialogs can take additional time.

The cache is local session data, cleared by browser restart or extension reload/update. It is checked against the document, route and content fingerprint before use. A cache miss or quota limit falls back to explicit extraction without truncating the article. History reports completion only after the browser reports each file complete; earlier history entries are labeled as legacy records.

## Known limitations

- Some heavily scripted or anti-scraping pages may still fail
- Logged-in sites should usually be opened in a tab before exporting
- PDF export is intentionally lightweight and may not preserve complex layouts

## Roadmap

- Batch export from multiple URLs
- Better preview and cleanup before export
- More localization and keyboard shortcuts

## Contributing

Issues and pull requests are welcome. If you report a bug, include the target site, expected result, actual result, and which export format you used.

## License

MIT
