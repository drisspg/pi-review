import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { ReactElement, ReactNode } from "react";

export function ActionMenu({ trigger, children }: { trigger: ReactElement; children: ReactNode }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="action-menu-popover" align="end" sideOffset={4}>
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function ActionMenuItem({ children, onSelect, title }: { children: ReactNode; onSelect: () => void; title?: string }) {
  return <DropdownMenu.Item asChild onSelect={onSelect}><button type="button" title={title}>{children}</button></DropdownMenu.Item>;
}

/** A labelled group of mutually exclusive choices (checked state is exposed to assistive tech). */
export function ActionMenuRadioGroup({ label, value, onValueChange, children }: { label: string; value: string; onValueChange: (value: string) => void; children: ReactNode }) {
  return <>
    <DropdownMenu.Label className="action-menu-label">{label}</DropdownMenu.Label>
    <DropdownMenu.RadioGroup value={value} onValueChange={onValueChange}>{children}</DropdownMenu.RadioGroup>
  </>;
}

export function ActionMenuRadioItem({ value, children }: { value: string; children: ReactNode }) {
  return <DropdownMenu.RadioItem asChild value={value}><button type="button" className="action-menu-radio"><span className="action-menu-check" aria-hidden="true"><DropdownMenu.ItemIndicator>✓</DropdownMenu.ItemIndicator></span>{children}</button></DropdownMenu.RadioItem>;
}
