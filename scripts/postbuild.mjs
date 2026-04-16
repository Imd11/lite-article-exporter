import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

async function moveBuiltHtmlPages() {
  const root = process.cwd();
  const distDir = resolve(root, "dist");
  const pages = [
    { source: resolve(distDir, "src/popup/index.html"), destination: resolve(distDir, "popup/index.html") },
    { source: resolve(distDir, "src/changelog/index.html"), destination: resolve(distDir, "changelog/index.html") }
  ];
  let movedAny = false;

  for (const page of pages) {
    try {
      await stat(page.source);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }

    await mkdir(dirname(page.destination), { recursive: true });
    await rename(page.source, page.destination);
    movedAny = true;
  }

  if (!movedAny) {
    return;
  }

  const leftoverDir = resolve(distDir, "src");
  await rm(leftoverDir, { recursive: true, force: true });
}

await moveBuiltHtmlPages();
