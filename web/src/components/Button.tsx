import type { ButtonHTMLAttributes, ReactNode } from "react";
import clsx from "clsx";

type ButtonVariant = "default" | "muted" | "icon";

export function Button({ variant = "default", className, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; children: ReactNode }) {
  return <button className={clsx("ui-button", `ui-button-${variant}`, className)} {...props}>{children}</button>;
}
