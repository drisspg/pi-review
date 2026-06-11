import * as Dialog from "@radix-ui/react-dialog";
import { XIcon } from "@primer/octicons-react";
import type { ReactNode } from "react";

import { Button } from "./Button";

export function ModalShell({ open, onOpenChange, label, children, className }: { open: boolean; onOpenChange: (open: boolean) => void; label: string; children: ReactNode; className?: string }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="review-modal" />
        <Dialog.Content className={`review-modal-card${className != null ? ` ${className}` : ""}`} aria-label={label}>
          <Dialog.Title asChild><span className="visually-hidden">{label}</span></Dialog.Title>
          <Dialog.Close asChild><Button variant="icon" className="modal-close-button" aria-label={`Close ${label}`}><XIcon size={16} /></Button></Dialog.Close>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export const ModalTitle = Dialog.Title;
export const ModalClose = Dialog.Close;
