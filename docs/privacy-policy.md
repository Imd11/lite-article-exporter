# Lite Article Exporter Privacy Policy / 隐私政策

Last updated / 更新日期: 2026-10-10

This policy applies to Lite Article Exporter for Google Chrome and Microsoft Edge, published by IMD Labs.

## Data used for exports

The extension accesses the page selected for export, including article or conversation text, titles, URLs, links, image references and available author metadata. Exported conversations may include personal messages that the user chooses to save. These data are used to generate Markdown, Word, PDF and TXT files on the user's device.

On supported WeChat, Substack, Medium and Telegraph article pages, the extension may prepare the article in advance in the focused window's active tab. This temporary local preparation makes later exports faster. Conversations are captured only for an explicit export, and automatic preparation is disabled in private browsing windows.

The extension does not operate an account system, include advertising or analytics, sell user data, use user data for unrelated purposes, or use it to determine creditworthiness or for lending. It does not upload article bodies or conversation text to an extension backend. The publisher does not receive users' exported content or local export history.

## Local storage and retention

- Format preferences, export history and normal export-task metadata are stored in the browser's local extension storage. History includes titles, URLs, export times, formats and results; it is limited to the most recent 20 records.
- Article snapshots use temporary session storage and the local processing document. Session data are cleared when the browser restarts or the extension is reloaded or updated, and unneeded snapshots may be evicted earlier.
- Private-window job data use session-only storage and are excluded from normal export history. Private article and job data are cleared when the last private window closes. Temporary cleanup identifiers may remain until cancellation of an outstanding download is confirmed; they contain no article title, URL or body.
- Exported files remain in the user's chosen download location until the user deletes them. Clearing export history does not delete downloaded files.

Users can clear export history in the popup, delete exported files, reload the extension to clear session caches, or remove the extension to remove its local extension storage.

## Network requests and third parties

Explicit exports may request the selected article and its image resources. Word and PDF exports may download images for embedding. WeChat images may be requested through the existing `images.weserv.nl` image proxy; the proxy receives the requested image URL. Websites and image providers receive normal network-request information, such as the requested resource URL and the user's IP address, and apply their own privacy policies. Automatic preparation does not download images or fonts.

All executable JavaScript is bundled in the extension package. Network requests for page content or images do not load remote executable code.

## Permissions

`tabs` and `scripting` identify and extract the selected page. Host access supports articles and images on different websites. `webNavigation` detects document and route changes to reject stale snapshots. `offscreen` performs local parsing and file conversion after the popup closes. `downloads` saves files and verifies download outcomes. `storage` retains local preferences, history and temporary task data. `alarms` supports bounded task recovery and cleanup. These permissions support the export features described above.

Lite Article Exporter's use and transfer of user data adhere to the Chrome Web Store User Data Policy, including its Limited Use requirements, and the Microsoft Edge Add-ons developer policies.

Contact: jinhang.yang11@gmail.com

---

## 中文说明

本政策适用于 IMD Labs 发布的 Lite Article Exporter Chrome 和 Microsoft Edge 扩展。

扩展会读取用户选择导出的页面正文、对话消息、标题、链接、图片引用及可用的作者信息，在用户设备上生成 Markdown、Word、PDF 或 TXT 文件。对话内容可能包含用户选择保存的私人消息。在微信公众号、Substack、Medium 和 Telegraph 等支持的文章页面，扩展会在当前聚焦窗口的活动标签页提前进行本地准备，以加快后续导出；不会自动抓取对话，也不会在隐私窗口自动准备文章。

格式偏好、普通导出任务信息和最近 20 条下载记录保存在浏览器的本地扩展存储中。记录包含标题、网址、时间、格式和导出结果。正文快照使用会话存储及本地处理文档，浏览器重启、扩展重新加载或更新时清除，也可能因缓存淘汰而提前清除。隐私窗口的任务数据仅保留在会话中，不进入普通下载记录，并在最后一个隐私窗口关闭时清除；尚未完成的下载取消可能临时保留不含标题、网址或正文的清理标识。

用户可在弹窗清空下载记录、删除下载的文件、重新加载扩展以清理会话缓存，或卸载扩展以移除本地扩展存储。清空记录不会删除已下载文件。

显式导出可能请求文章及其图片。Word、PDF 导出可能下载并嵌入图片；微信图片可能通过现有的 `images.weserv.nl` 代理请求，代理会接收到请求的图片网址。来源网站及图片服务会接收到资源网址、IP 地址等常规网络请求信息，并适用各自的隐私政策。后台自动准备不会下载图片或字体。扩展的可执行代码均随安装包提供，不加载远程可执行代码。

扩展没有账号系统、广告或分析追踪，不向扩展后端上传文章正文或对话内容；发布者不会收到用户导出的内容及本地下载记录。用户数据仅用于上述导出功能，不出售、不用于无关用途，也不用于信用评估或贷款。用户数据的使用与传输遵守 Chrome Web Store User Data Policy（包括 Limited Use 要求）及 Microsoft Edge 扩展开发者政策。

联系邮箱：jinhang.yang11@gmail.com
