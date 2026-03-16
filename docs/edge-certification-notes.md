# Edge Add-ons Certification Notes — Lite Article Exporter

No account registration or login is required. The extension is ready to use immediately after installation.

## Basic Usage

1. Click the extension icon in the browser toolbar to open the panel.
2. Paste any article URL into the input field (e.g. `https://en.wikipedia.org/wiki/Microsoft_Edge`).
3. Select one or more export formats: **Markdown**, **Word (.docx)**, **PDF**, or **TXT**.
4. Click **Download** — the file will be saved to the system's default downloads folder automatically.

## Dynamic / JavaScript-Rendered Pages

For pages that use dynamic loading (e.g. news sites, blog platforms):

1. Open the target page in a browser tab and wait for it to fully load.
2. Click the extension icon.
3. Paste the same URL and click **Download** — the extension will extract content from the already-loaded tab.

## Download History

- The lower section of the panel displays past exports.
- Searchable by article title or URL.
- History can be cleared with the **Clear All** button.

## Permissions Explained

| Permission | Reason |
|---|---|
| `tabs` / `scripting` | Read page content from already-open tabs, only when triggered by the user |
| `downloads` | Save exported files to the user's local downloads folder |
| `storage` | Persist download history locally on the user's device |
| `host_permissions (<all_urls>)` | Support content extraction from any domain the user has open — no background requests are made |

## Privacy

The extension does **not** collect any user data and does **not** send requests to any third-party servers. All processing happens locally in the browser.
