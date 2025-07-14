export function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*]+/g, "").trim();
}
