# Background preparation and export jobs (1.1.0)

## Scope and behavior

The popup remains the format chooser. Automatic work only targets an article in the focused window's active tab on WeChat, Substack, Medium and Telegraph. It performs a bounded article check followed by the existing site extraction algorithms. There are no permanent page observers or automatic conversation snapshots. The switch in the popup disables new automatic work and clears unpinned cached articles.

WeChat extraction still refetches the article HTML from its own tab with that tab's cookies to recover original, unwatermarked image links. Raw HTML is parsed in the offscreen document. The existing one-second image/lazy-content wait remains. Automatic work neither embeds images nor loads the PDF font. Explicit Word/PDF exports fetch images; the existing WeChat image proxy receives image URLs. Automatic preparation therefore adds a same-page WeChat HTML request, but no article-body upload.

The session cache holds up to ten snapshots, with a 6 MiB serialized target and a 2 MiB individual-entry target. These are eviction budgets, not article size limits or promises about Chrome's internal storage accounting. Chrome may reject a write earlier; the accepted export continues with the full offscreen snapshot. Pinned snapshots may temporarily exceed the target. Long articles are never truncated. Browser restart, extension reload/update and private-window cleanup discard snapshots.

An export fixes its page identity, requested formats and snapshot. Navigation before capture finishes produces a retryable error, rather than exporting a different page. A completed capture remains usable for its accepted export after the source tab closes or navigates. A fresh export checks the current document and content fingerprint. Retrying failed formats uses the original snapshot while it remains in the session cache; after eviction, the UI asks for a fresh export.

## Lifetimes and failures

The service worker persists job metadata, serializes storage mutations and owns native downloads. An offscreen document owns DOM parsing, conversions, snapshots and Blob URLs. Closing the popup does not terminate an accepted task. Normal job metadata/history are local persistent data; article bodies are session/offscreen data. Private jobs are session-only, do not appear in ordinary history and are cleared when the last private window closes. Automatic preparation is disabled in private tabs.

Up to three jobs can be active. Identical active requests are deduplicated; the user can make a new export after completion. Files use `uniquify`, preserving earlier files with the same name. Each format tracks queued/building/downloading/complete/error/cancelled/uncertain. A successful download API call supplies an ID; only native `complete` makes a file successful. Partial failures expose individual results and retry only unfinished formats. A download with uncertain acceptance is not automatically retried, preventing duplicate files. Blob URLs survive until the corresponding native download ends.

Automatic preparation has a 15-second deadline; accepted extraction has a 60-second deadline. Joining an automatic operation extends its deadline. File generation has a three-minute bound per format; native downloads and save dialogs are not subject to that bound. Image requests have a ten-second request deadline and a 20 MiB response bound. Failed image embedding is disclosed as a warning. An unavailable PDF Unicode font fails the affected PDF instead of silently replacing Chinese text. Processing is serial for file conversions and the offscreen document closes when its operations, jobs and native Blob downloads are idle.

Chrome's worker may restart. Persisted jobs and browser download IDs allow reconciliation. Lost conversion work becomes an explicit failure; native download completion is still recovered. Extension/browser shutdown cannot guarantee unfinished processing resumes. No automatic resubmission occurs when native download acceptance cannot be established.

## Compatibility and release checks

The background path uses Chrome's offscreen document and `runtime.getContexts` APIs (full path: Chrome 116+). Feature detection selects the repaired on-demand popup fallback before any job is accepted when these APIs are absent; the fallback tells the user to keep the panel open. It does not switch an already accepted job to a second downloader.

This release adds `offscreen`, `webNavigation` and `alarms` permissions to the existing manifest. Browser updates may request permission review. Both Chrome and Edge ZIPs include the offscreen HTML/modules, locales and the bundled font. Edge installation, permission upgrade prompts and save-dialog behavior need browser-specific release checks when publishing; producing an Edge ZIP alone does not verify an Edge runtime.

Automated checks cover state/storage races with mocked APIs and real Chromium with controlled article fixtures. They check four formats' downloaded contents, Chinese PDF text, image embedding, navigation/freshness, lazy image display changes, popup lifetime, a real worker stop/restart, older-API fallback, history/preferences and existing site adapters. A long Chinese article exceeding the individual snapshot budget is exported in full. Live sites can change their DOM and still require site-specific maintenance. Fixture byte sizes are recorded for the tested documents; real long illustrated articles can exceed them, so quota failure remains a supported path.
