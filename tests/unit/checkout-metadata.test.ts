import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test, { type TestContext } from "node:test";

import { preserveSaplingMetadata } from "../../src/checkout-metadata.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(resolve(tmpdir(), "pi-review-metadata-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = resolve(root, "sl");
  const recovery = resolve(root, "durable");
  await mkdir(resolve(source, "store"), { recursive: true });
  await writeFile(resolve(source, "config-git-user"), "local configuration\n");
  await writeFile(resolve(source, "store", "dirstate"), "workspace state\n");
  return { source, recovery };
}

test("Sapling metadata is copied and verified in a private durable directory", async (t) => {
  const { source, recovery } = await fixture(t);
  const destination = await preserveSaplingMetadata(source, recovery);
  assert.equal(await readFile(resolve(destination, "sl/config-git-user"), "utf8"), "local configuration\n");
  assert.equal(await readFile(resolve(destination, "sl/store/dirstate"), "utf8"), "workspace state\n");
  assert.equal(await readFile(resolve(source, "store/dirstate"), "utf8"), "workspace state\n");
  const manifest = JSON.parse(await readFile(resolve(destination, "manifest.json"), "utf8"));
  assert.equal(manifest.entries["store/dirstate"].bytes, 16);
  assert.match(manifest.entries["store/dirstate"].sha256, /^[0-9a-f]{64}$/);
  assert.equal((await stat(destination)).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(recovery), [destination.split("/").at(-1)]);
});

for (const failure of ["copy", "corrupt copy", "source changed"] as const) {
  test(`metadata ${failure} failure never publishes a recovery copy or removes the source`, async (t) => {
    const { source, recovery } = await fixture(t);
    await assert.rejects(preserveSaplingMetadata(source, recovery, async (from, to) => {
      if (failure === "copy") throw new Error("copy failed");
      await cp(from, to, { recursive: true });
      await writeFile(resolve(failure === "source changed" ? from : to, "config-git-user"), "changed");
    }), failure === "copy" ? /copy failed/ : /changed while being preserved/);
    assert.equal(await readFile(resolve(source, "store/dirstate"), "utf8"), "workspace state\n");
    assert.deepEqual(await readdir(recovery), []);
  });
}

test("automatic metadata preservation refuses symlinks and oversized content", async (t) => {
  const { source, recovery } = await fixture(t);
  const link = resolve(source, "external");
  await symlink(resolve(source, "config-git-user"), link);
  await assert.rejects(preserveSaplingMetadata(source, recovery), /symlink or special file/);
  await rm(link);
  const large = resolve(source, "large");
  await writeFile(large, "");
  await truncate(large, 65 * 1024 * 1024);
  await assert.rejects(preserveSaplingMetadata(source, recovery), /64 MiB/);
  assert.equal(await readFile(resolve(source, "config-git-user"), "utf8"), "local configuration\n");
});

test("metadata recovery cannot be placed inside its source", async (t) => {
  const { source } = await fixture(t);
  await assert.rejects(preserveSaplingMetadata(source, resolve(source, "recovery")), /outside the checkout and Git metadata/);
  assert.deepEqual((await readdir(source)).sort(), ["config-git-user", "store"]);
});
