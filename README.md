# Lite Article Exporter

Lite Article Exporter is a Chrome extension that extracts the main content from web articles and exports it as Markdown, Word, PDF, or TXT.

It is built for people who save useful articles for research, writing, study, and long-term reference, but do not want to keep noisy web pages full of ads, sidebars, and broken formatting.

Chrome Web Store:
https://chromewebstore.google.com/detail/lite-article-exporter/cemcpicgpndenhnkegmohoncnjhnknie

## Features

- Extracts clean article content with Mozilla Readability
- Removes common page clutter and keeps the main text readable
- Exports to Markdown, Word, PDF, and TXT
- Preserves image links instead of downloading and embedding large assets
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

## Permissions

- `host_permissions: <all_urls>`: fetches article content from user-requested pages
- `downloads`: saves exported files
- `storage`: stores local history and user preferences
- `tabs`: reads the current active tab URL for convenience
- `scripting`: extracts content from the currently opened page, especially for logged-in or dynamic sites

All processing happens locally in the extension. No article content is uploaded to a remote server by this project.

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
