import { Tabs as PrimerTabs, useTab, useTabList, useTabPanel } from "@primer/react/experimental";
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

export const Tabs = PrimerTabs;

export function TabList({ children, ...props }: HTMLAttributes<HTMLDivElement> & ({ "aria-label": string } | { "aria-labelledby": string }) & { children: ReactNode }) {
  const { tabListProps } = useTabList<HTMLDivElement>(props);
  return <div {...props} {...tabListProps}>{children}</div>;
}

export function Tab({ value, disabled, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { value: string; children: ReactNode }) {
  const { tabProps } = useTab<HTMLButtonElement>({ value, disabled });
  return <button type="button" disabled={disabled} {...props} {...tabProps}>{children}</button>;
}

export function TabPanel({ value, children, ...props }: HTMLAttributes<HTMLDivElement> & { value: string; children: ReactNode }) {
  const { tabPanelProps } = useTabPanel<HTMLDivElement>({ value });
  return <div {...props} {...tabPanelProps}>{children}</div>;
}
