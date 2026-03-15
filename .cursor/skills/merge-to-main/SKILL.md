---
name: merge-to-main
description: Automates the full release workflow when the user says "merge to main". Updates README, bumps the semantic version, validates the build, creates a PR, merges it, and tags the release. Use when the user asks to merge to main, create a release, ship to main, or finalize a branch.
---

# Merge to Main

End-to-end release workflow that takes the current feature branch through to a tagged merge on `main`.

## Trigger phrases

- "merge to main"
- "ship to main"
- "create a release from this branch"
- "finalize this branch"

## Workflow

Execute these steps in order. Stop and report to the user if any step fails.

### Step 1: Pre-flight checks

1. Run `git status` to confirm a clean working tree (no uncommitted changes beyond what you're about to make). If there are unstaged changes, stage and commit them first with a descriptive message.
2. Run `git branch --show-current` to confirm you are **not** on `main`. Abort if you are.
3. Run `git log --oneline main..HEAD` to collect the full list of commits on this branch since it diverged from `main`. You will need these to write the PR body and README changelog entry.

### Step 2: Update the README

1. Read `README.md`.
2. Review every commit on the branch (from step 1.3) plus any uncommitted changes. Summarise what changed in this branch at a high level.
3. Update the README to accurately reflect the current state of the project (new features, changed setup steps, new prerequisites, etc.). Do **not** add a raw changelog dump -- integrate the information naturally into the existing sections.
4. Do **not** remove or rewrite content unrelated to this branch's changes.

### Step 3: Bump the version

1. Read `package.json` and note the current `version` field.
2. Determine the appropriate semver bump by analysing the branch's commits:
   - **major** -- breaking changes to APIs, CRDs, config formats, or CLI flags
   - **minor** -- new features, new agent types, new endpoints, new scripts
   - **patch** -- bug fixes, documentation-only changes, refactors with no API change
3. Compute the new version string.
4. Update the `version` field in the root `package.json`.

### Step 4: Commit the release prep

```
git add -A
git commit -m "<type>(<scope>): <summary>

<body explaining the key changes in this release>

Bumps version from <old> to <new>."
```

Use conventional commit format. The type should reflect the dominant change category (feat, fix, chore, docs). The body should be a concise but complete summary of the branch's changes -- this will be the main commit reviewers see.

### Step 5: Push and validate the build

1. Push the branch to origin: `git push -u origin HEAD`
2. Run the project build to validate:
   ```
   npm run build
   ```
3. If the build fails, fix the errors, commit the fix, push again, and re-run the build. Do not proceed until the build passes.
4. For the Go operator, also validate:
   ```
   cd operator && go build ./... && cd ..
   ```

### Step 6: Create the Pull Request

Create a PR using `gh pr create` with:

- **Title**: Same as the commit summary from step 4 (e.g. `feat(github): add GitHub account integration`)
- **Body** using this template:

```markdown
## Summary
<High-level description of what this branch does -- 2-4 sentences.>

## Changes
<Bulleted list of specific changes, grouped by area. Reference files where helpful.>

## Version
`<old version>` → `<new version>` (<bump type>)

## Test plan
- [ ] `npm run build` passes
- [ ] `cd operator && go build ./...` passes
- [ ] Key changes reviewed: <list the most important files>
```

### Step 7: Merge the PR

1. Merge using: `gh pr merge --squash --delete-branch`
   - Use `--squash` to keep main's history clean.
   - Use `--delete-branch` to clean up the feature branch.
2. If merge fails due to conflicts, report to the user and stop.

### Step 8: Tag the release

1. Switch to main and pull: `git checkout main && git pull origin main`
2. Create an annotated tag:
   ```
   git tag -a v<new version> -m "v<new version>: <one-line summary of release>"
   ```
3. Push the tag: `git push origin v<new version>`

### Step 9: Report

Tell the user:
- The PR URL
- The new version number
- The tag name
- A brief summary of what was released

## Conventional commit types reference

| Type | When |
|------|------|
| `feat` | New feature or capability |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `chore` | Build process, CI, or auxiliary tool changes |
| `test` | Adding or updating tests |

## Important notes

- Never force-push to `main`.
- If the build fails, fix it before creating the PR.
- If the merge fails, stop and ask the user for guidance.
- The version bump must match the semver rules above -- do not over-bump or under-bump.
- Keep the PR body informative -- reviewers should understand the full scope without reading every commit.
