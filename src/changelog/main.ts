import { t } from "../utils/i18n";
import type { TranslationKey } from "../utils/i18n";

interface ChangelogEntry {
  key: TranslationKey;
}

interface ChangelogVersion {
  version: string;
  date: string;
  entries: ChangelogEntry[];
}

const CHANGELOG: ChangelogVersion[] = [
  {
    version: "1.0.4",
    date: "2026-04-16",
    entries: [
      { key: "changelog104Item1" },
      { key: "changelog104Item2" },
      { key: "changelog104Item3" }
    ]
  },
  {
    version: "1.0.3",
    date: "2026-04-16",
    entries: [
      { key: "changelog103Item1" },
      { key: "changelog103Item2" },
      { key: "changelog103Item3" }
    ]
  },
  {
    version: "1.0.2",
    date: "2026-03-16",
    entries: [
      { key: "changelog102Item1" },
      { key: "changelog102Item2" }
    ]
  },
  {
    version: "0.1.1",
    date: "2026-03-07",
    entries: [
      { key: "changelog011Item1" },
      { key: "changelog011Item2" },
      { key: "changelog011Item3" }
    ]
  },
  {
    version: "0.1.0",
    date: "2025-10-13",
    entries: [
      { key: "changelog010Item1" }
    ]
  }
];

function renderChangelog() {
  const pageTitle = document.getElementById("page-title");
  const container = document.getElementById("changelogList");
  if (!pageTitle || !container) {
    return;
  }

  pageTitle.textContent = t("changelogHeroTitle");
  document.title = t("changelogPageTitle");
  container.innerHTML = "";

  for (const item of CHANGELOG) {
    const section = document.createElement("section");
    section.className = "version-section";

    const header = document.createElement("div");
    header.className = "version-header";

    const heading = document.createElement("h2");
    heading.className = "version-heading";
    heading.textContent = `v${item.version}`;

    const date = document.createElement("span");
    date.className = "version-date";
    date.textContent = item.date;

    header.append(heading, date);

    const list = document.createElement("ul");
    list.className = "changelog-items";

    for (const entry of item.entries) {
      const li = document.createElement("li");
      li.textContent = t(entry.key);
      list.appendChild(li);
    }

    section.append(header, list);
    container.appendChild(section);
  }
}

renderChangelog();
