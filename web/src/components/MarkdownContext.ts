import React from "react";

export type FileLinkContext = { prUrl: string; headSha?: string; snippets?: boolean };

export const InlineSnippetsContext = React.createContext<{ headSha: string; snippets: boolean } | null>(null);
export const InlineSnippetsProvider = InlineSnippetsContext.Provider;
