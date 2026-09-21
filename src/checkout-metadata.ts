import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

type MetadataEntry = { kind: "directory" } | { kind: "file"; bytes: number; sha256: string };

/** Only bounded, ordinary Sapling metadata is copied automatically; never follow symlinks. */
async function metadataManifest(root: string): Promise<Record<string, MetadataEntry>> {
  const entries: Record<string, MetadataEntry> = Object.create(null);
  let bytes = 0;
  let count = 0;
  async function visit(path: string): Promise<void> {
    if (++count > 10_000) throw new Error("Sapling metadata has too many entries to preserve automatically");
    const stat = await lstat(path);
    const name = relative(root, path);
    if (stat.isDirectory()) {
      entries[name] = { kind: "directory" };
      for (const child of (await readdir(path)).sort()) await visit(resolve(path, child));
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (bytes > 64 * 1024 * 1024) throw new Error("Sapling metadata exceeds the 64 MiB automatic preservation limit");
      const hash = createHash("sha256");
      let readBytes = 0;
      for await (const chunk of createReadStream(path)) {
        readBytes += chunk.length;
        if (readBytes > stat.size) throw new Error("Sapling metadata changed while being read; retry checkout deletion");
        hash.update(chunk);
      }
      if (readBytes !== stat.size) throw new Error("Sapling metadata changed while being read; retry checkout deletion");
      entries[name] = { kind: "file", bytes: stat.size, sha256: hash.digest("hex") };
    } else {
      throw new Error("Sapling metadata contains a symlink or special file; preserve it manually before deletion");
    }
  }
  await visit(root);
  return entries;
}

const copyMetadata = (source: string, destination: string) => cp(source, destination, { recursive: true, dereference: false, errorOnExist: true, force: false, preserveTimestamps: true });

async function prospectiveRealpath(path: string): Promise<string> {
  try { return await realpath(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw error;
    return resolve(await prospectiveRealpath(dirname(path)), basename(path));
  }
}

/** Validate even nonexistent recovery paths before creating directories. */
export async function resolveMetadataRecoveryPath(destination: string, protectedRoots: string[]): Promise<string> {
  const path = await prospectiveRealpath(resolve(destination));
  for (const root of protectedRoots) {
    const rel = relative(await prospectiveRealpath(resolve(root)), path);
    if (!rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))) throw new Error("Metadata recovery storage must be outside the checkout and Git metadata being deleted");
  }
  return path;
}

/** Verify both the copy and the unchanged source before publishing a durable recovery directory. */
export async function preserveSaplingMetadata(source: string, destinationParent: string, copy = copyMetadata): Promise<string> {
  const before = await metadataManifest(source);
  const parent = await resolveMetadataRecoveryPath(destinationParent, [source]);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if (await realpath(parent) !== parent) throw new Error("Metadata recovery storage changed during preservation");
  const id = randomUUID();
  const pending = resolve(parent, `.pending-${id}`);
  const destination = resolve(parent, id);
  await mkdir(pending, { mode: 0o700 });
  try {
    await copy(source, resolve(pending, "sl"));
    if (!isDeepStrictEqual(before, await metadataManifest(resolve(pending, "sl"))) || !isDeepStrictEqual(before, await metadataManifest(source))) {
      throw new Error("Sapling metadata changed while being preserved; retry checkout deletion");
    }
    await writeFile(resolve(pending, "manifest.json"), JSON.stringify({ source, createdAt: new Date().toISOString(), entries: before }, null, 2), { flag: "wx", mode: 0o600 });
    await rename(pending, destination);
    return destination;
  } catch (error) {
    // Remove only our unpublished staging copy, never the source metadata.
    await rm(pending, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
