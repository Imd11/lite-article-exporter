import { mkdir, rename, rm, stat, rmdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

async function movePopupHtml() {
  const root = process.cwd();
  const distDir = resolve(root, "dist");
  const source = resolve(distDir, "src/popup/index.html");
  const destination = resolve(distDir, "popup/index.html");

  try {
    await stat(source);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  await mkdir(dirname(destination), { recursive: true });
  await rename(source, destination);

  const leftoverDir = resolve(distDir, "src");
  await rm(leftoverDir, { recursive: true, force: true });
}

await movePopupHtml();
