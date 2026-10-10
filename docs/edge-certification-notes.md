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
| `tabs` / `scripting` | Read explicit exports and eligible articles in the focused active tab for optional automatic preparation |
| `downloads` | Save exported files to the user's local downloads folder |
| `storage` | Persist download history locally on the user's device |
| `host_permissions (<all_urls>)` | Support requested URLs and limited automatic preparation; WeChat preparation refetches its same-page HTML |
| `offscreen` | Parse article snapshots and generate files independently of the popup |
| `webNavigation` | Discard outdated snapshots after document or route changes |
| `alarms` | Reconcile accepted jobs with native browser downloads |

## Privacy

Article processing happens locally. Explicit Word/PDF exports fetch article images, including the existing WeChat image proxy. Article bodies are not uploaded. Session snapshots are temporary; normal export history stays locally on the device. Private tabs are not automatically prepared and private exports do not enter ordinary history. Automatic preparation can be disabled in the popup. See [background preparation details](background-preparation.md).
