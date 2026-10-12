import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

export function toPosix(path) {
  return String(path).split("\\").join("/");
}

/** Walk a directory deterministically and return matching files. */
export function findFiles(root, predicate = () => true) {
  if (!root || !existsSync(root)) return [];
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== ".git") walk(full);
      } else if (entry.isFile() && predicate(entry, full)) {
        found.push(full);
      }
    }
  };
  walk(root);
  return found.sort();
}

export function relativeFileMap(root, predicate = () => true) {
  return new Map(findFiles(root, predicate).map((file) => [toPosix(relative(root, file)), file]));
}
