import { Button as PrimerButton } from "@primer/react";
import clsx from "clsx";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonVariant = "default" | "muted" | "icon";

export function Button({ variant = "default", className, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; children: ReactNode }) {
  return <PrimerButton variant={variant === "default" ? "default" : "invisible"} size={variant === "default" ? "medium" : "small"} className={clsx("ui-button", `ui-button-${variant}`, className)} {...props}>{children}</PrimerButton>;
}
