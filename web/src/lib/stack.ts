export { splitStackBlock, type ParsedStack } from "../../../src/stack-api";

/** Tall stacks show only the ends and a window around the current PR until expanded. */
export const FULL_STACK_LIMIT = 11;
const WINDOW_RADIUS = 3;

export type ChipSlot<Member> = { kind: "member"; member: Member } | { kind: "gap"; hidden: number };

export function chipSlots<Member>(members: Member[], currentPosition: number, expanded: boolean): ChipSlot<Member>[] {
  if (expanded || members.length <= FULL_STACK_LIMIT) return members.map((member) => ({ kind: "member", member }));
  const slots: ChipSlot<Member>[] = [];
  let hidden = 0;
  members.forEach((member, index) => {
    const visible = index === 0 || index === members.length - 1 || Math.abs(index - currentPosition) <= WINDOW_RADIUS;
    if (!visible) { hidden += 1; return; }
    if (hidden > 0) slots.push({ kind: "gap", hidden });
    hidden = 0;
    slots.push({ kind: "member", member });
  });
  return slots;
}
