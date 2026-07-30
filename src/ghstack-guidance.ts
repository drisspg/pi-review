/** Shared prompt guidance for inspecting sibling pull requests in ghstack workspaces. */

export function ghstackWorkspaceInstructions(prKey: string): string {
  return `Ghstack workspace guidance for ${prKey}: if the current commit messages contain ghstack-source-id or Pull-Request trailers, or the PR description contains a "Stack from ghstack" list, treat sibling PRs in that stack as relevant review context. Use git log --format=full to map local commits to their Pull-Request URLs. Use gh pr view <number-or-url> --repo <owner/repo> --json title,body,url,state,baseRefName,headRefName,files,commits and gh pr diff <number-or-url> --repo <owner/repo> to inspect PRs listed in the stack description. Keep track of which commit and PR owns each change. Do not check out, rebase, push, or modify ghstack's synthetic branches merely to inspect sibling PRs.`;
}
