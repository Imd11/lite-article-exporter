export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 64) || "article";
}

export function buildDocumentBaseName(slug: string, createdAt = new Date()): string {
  const stamp = `${createdAt.getFullYear()}${pad(createdAt.getMonth() + 1)}${pad(createdAt.getDate())}`;
  return `${stamp}-${slug}`;
}

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}
