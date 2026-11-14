import assert from "node:assert/strict";
import test from "node:test";

import { chipSlots } from "../../web/src/lib/stack.js";

const shape = (slots: ReturnType<typeof chipSlots<number>>) => slots.map((slot) => slot.kind === "gap" ? `+${slot.hidden}` : slot.member);
const range = (count: number) => Array.from({ length: count }, (_, index) => index);

test("short stacks and expanded stacks show every member", () => {
  assert.deepEqual(shape(chipSlots(range(11), 5, false)), range(11));
  assert.deepEqual(shape(chipSlots(range(26), 9, true)), range(26));
});

test("long stacks keep both ends and a window around the current PR", () => {
  assert.deepEqual(shape(chipSlots(range(26), 9, false)), [0, "+5", 6, 7, 8, 9, 10, 11, 12, "+12", 25]);
  assert.deepEqual(shape(chipSlots(range(26), 0, false)), [0, 1, 2, 3, "+21", 25], "window clipped at the bottom");
  assert.deepEqual(shape(chipSlots(range(26), 24, false)), [0, "+20", 21, 22, 23, 24, 25], "window touching the top end has no gap");
});
