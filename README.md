# LeetCode → GitHub sync

`zk19604/leetcode-script` is the automation repository. It syncs accepted submissions into a separate solutions repository's `topics/<topic>/<number>-<slug>/` directories, commits there, and pushes. GitHub Actions runs every 30 minutes and can repair an expired LeetCode session once.

## Setup

1. Create or clone the separate GitHub repository that will hold your solutions, then clone `zk19604/leetcode-script` separately. Install Node 22+ in the script repository, run `npm install`, then copy `.env.example` to `.env`.
2. In a logged-in LeetCode browser tab, open DevTools → Application → Cookies → `https://leetcode.com`; copy `LEETCODE_SESSION` and `csrftoken` into `.env` as `LEETCODE_SESSION` and `LEETCODE_CSRF_TOKEN`.
3. Run locally from the solutions repository: `node --env-file=/path/to/leetcode-script/.env /path/to/leetcode-script/sync.js`. Use `SYNC_GIT=false` to write files without committing.
4. In `zk19604/leetcode-script`, add the Actions secrets `LEETCODE_SESSION`, `LEETCODE_CSRF_TOKEN`, `LEETCODE_USERNAME`, `LEETCODE_PASSWORD`, `GH_SECRETS_TOKEN`, and `SOLUTIONS_REPO_TOKEN`. Add the non-secret Actions variable `SOLUTIONS_REPO` with the target's `owner/repo` value.

`GH_SECRETS_TOKEN` is a fine-grained PAT with **Actions secrets: write** access for `zk19604/leetcode-script`; it lets the recovery job update LeetCode cookies. `SOLUTIONS_REPO_TOKEN` is a PAT with **Contents: read and write** access to the solutions repository; it lets the workflow push solution commits. `GITHUB_TOKEN` is supplied by GitHub Actions. A local `refresh-session.mjs` run also needs `GITHUB_REPOSITORY=zk19604/leetcode-script`.

## Topic layout

`sync.js` reads `LEETCODE_TOPIC_LAYOUT` (default `primary`):

- `primary`: save under the first LeetCode topic tag only.
- `duplicate`: write the solution under every topic tag.
- `symlink`: write once under the first tag and directory-link it from the others (Git-compatible Unix runners).

Language names are mapped in `EXTENSIONS` at the top of `sync.js`; unrecognised languages become `solution.txt` rather than losing source code. A later Accepted submission overwrites the existing problem folder and creates another commit.

## How the sync works

The sync uses the authenticated `submissionList` query for your recent submissions, filters `statusDisplay: Accepted`, then requests `submissionDetails(submissionId)` for source code and `question(titleSlug)` for `questionFrontendId`, `difficulty`, `content`, and `topicTags`. It stores the timestamp plus submission IDs at that timestamp in the solutions repository's `.sync-state.json`, so re-runs are no-ops and same-second submissions are not skipped.

The query shapes were verified from [LeetCode Query](https://github.com/JacobLinCool/LeetCode-Query) (including its authenticated source-code query) and [alfa-leetcode-api](https://github.com/alfaarghya/alfa-leetcode-api) (recent submissions and question metadata).

## Session refresh and CAPTCHA failures

The workflow uses reactive re-login, not a pretend cookie refresh: only an authentication failure starts Playwright, logs in with `LEETCODE_USERNAME` and `LEETCODE_PASSWORD`, encrypts fresh cookies with Libsodium, updates the two Actions secrets through GitHub’s REST API, and retries once. GitHub requires a repository public key and Libsodium-encrypted value for secret updates; this is implemented in `refresh-session.mjs` per its [Actions secrets API](https://docs.github.com/en/rest/actions/secrets).

If LeetCode asks for a CAPTCHA, login credentials are rejected, or the secret update is unauthorized, the workflow fails loudly. Log in normally, update the cookies/secrets if needed, and re-run the workflow; it deliberately does not loop.

## Responsible use

This is unofficial, personal-session automation. Keep the included 30-minute schedule and request backoff; review [LeetCode’s terms](https://leetcode.com/terms/) before using it, and stop using the workflow if automated access is not permitted for your account.

Run `npm test` for the lightweight state and language-mapping check.
