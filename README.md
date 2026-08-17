# LeetCode → GitHub sync

Chrome extension in `extension/`. Reads your live `LEETCODE_SESSION`/`csrftoken` cookies from the browser, polls every minute for new Accepted submissions, and pushes each as a commit to `topics/<topic>/<number>-<slug>/` in a separate solutions repository.

## Setup

1. `chrome://extensions` → enable Developer mode → Load unpacked → select `extension/`.
2. Click the extension icon. Enter a GitHub token with **Contents: read and write** on the solutions repo, the repo owner, repo name, and branch. Save.
3. Stay logged in to leetcode.com in that browser. New Accepted submissions sync automatically; "Sync now" runs immediately.

## How it works

Background service worker queries `submissionList`, filters `statusDisplay: Accepted`, fetches `submissionDetails` for source code and `question` for `questionFrontendId`/`difficulty`/`content`/`topicTags`. State (last synced timestamp + submission IDs) lives in `chrome.storage.local`, seeded to install-time so pre-existing history is never backfilled. Each new submission is pushed as one atomic commit via GitHub's Git Data API (blobs → tree → commit → ref update).

## Responsible use

Unofficial, personal-session automation. Review [LeetCode's terms](https://leetcode.com/terms/) before using it.
