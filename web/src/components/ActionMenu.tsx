import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { ReactElement, ReactNode } from "react";

export function ActionMenu({ trigger, children, align = "end" }: { trigger: ReactElement; children: ReactNode; align?: "start" | "center" | "end" }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="action-menu-popover" align={align} sideOffset={4}>
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function ActionMenuItem({ children, onSelect, title }: { children: ReactNode; onSelect: () => void; title?: string }) {
  return <DropdownMenu.Item asChild onSelect={onSelect}><button type="button" title={title}>{children}</button></DropdownMenu.Item>;
}
