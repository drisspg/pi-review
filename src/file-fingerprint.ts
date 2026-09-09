import { createHash } from "node:crypto";

import type { PullFile } from "./types.js";

/** Identify the actual displayed change so viewed flags expire when its patch changes. */
export function fileFingerprint(file: PullFile): string {
  return createHash("sha1").update(`${file.status}\n${file.previous_filename ?? ""}\n${file.patch ?? ""}`).digest("hex");
}
