# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`
- **Read an issue**: `gh issue view <number> --comments`
- **List issues**: use `gh issue list` with suitable state, label, and JSON filters.
- **Comment**: `gh issue comment <number> --body "..."`
- **Apply or remove labels**: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repository from `git remote -v`; `gh` does this automatically inside the clone.

## Pull requests as a triage surface

**PRs as a request surface: yes.**

External PRs run through the same labels and states as issues:

- Read with `gh pr view <number> --comments` and `gh pr diff <number>`.
- List open PRs and retain authors whose association is `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE`.
- Exclude `OWNER`, `MEMBER`, and `COLLABORATOR` PRs.
- Comment, label, and close with the corresponding `gh pr` commands.

GitHub shares one number space across issues and PRs. Resolve an ambiguous number with `gh pr view <number>`, falling back to `gh issue view <number>`.

## Skill operations

- “Publish to the issue tracker” means create a GitHub issue.
- “Fetch the relevant ticket” means run `gh issue view <number> --comments`.
