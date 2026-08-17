const LEETCODE_URL = "https://leetcode.com/graphql";
const GITHUB_API = "https://api.github.com";
const POLL_MINUTES = 1;

const EXTENSIONS = {
  bash: "sh", c: "c", "c#": "cs", csharp: "cs", "c++": "cpp", "c++11": "cpp",
  "c++14": "cpp", "c++17": "cpp", "c++20": "cpp", "c++23": "cpp", dart: "dart",
  elixir: "ex", erlang: "erl", go: "go", golang: "go", java: "java", javascript: "js",
  kotlin: "kt", mssql: "sql", mssqlserver: "sql", mysql: "sql", oracle: "sql",
  oraclesql: "sql", pandas: "py", php: "php", postgresql: "sql", python: "py",
  python3: "py", racket: "rkt", ruby: "rb", rust: "rs", scala: "scala", shell: "sh",
  swift: "swift", typescript: "ts",
};

const SUBMISSIONS_QUERY = `
  query submissionList($offset: Int!, $limit: Int!) {
    submissionList(offset: $offset, limit: $limit) {
      hasNext
      submissions { id title titleSlug timestamp lang statusDisplay }
    }
  }
`;

const SUBMISSION_DETAILS_QUERY = `
  query submissionDetails($id: Int!) {
    submissionDetails(submissionId: $id) { id code lang { name verboseName } }
  }
`;

const QUESTION_QUERY = `
  query questionData($titleSlug: String!) {
    question(titleSlug: $titleSlug) {
      questionFrontendId title titleSlug difficulty content
      topicTags { name slug }
    }
  }
`;

const PAGE_SIZE = 20;

function extensionFor(language) {
  const key = (language || "").toLowerCase().replaceAll(" ", "");
  return EXTENSIONS[key] || "txt";
}

function primaryTopic(question) {
  return question.topicTags?.[0]?.slug || "uncategorized";
}

function log(message) {
  console.log(`[leetcode-sync] ${message}`);
}

async function getCookie(name) {
  return chrome.cookies.get({ url: "https://leetcode.com", name });
}

async function getConfig() {
  const { config } = await chrome.storage.sync.get("config");
  return config || {};
}

async function getState() {
  const { syncState } = await chrome.storage.local.get("syncState");
  return syncState || { lastSyncedTimestamp: 0, lastSyncedSubmissionIds: [] };
}

async function setState(state) {
  await chrome.storage.local.set({ syncState: state });
}

function isNewSubmission(submission, state) {
  const timestamp = Number(submission.timestamp);
  return timestamp > state.lastSyncedTimestamp || (
    timestamp === state.lastSyncedTimestamp && !state.lastSyncedSubmissionIds.includes(String(submission.id))
  );
}

function advanceState(state, submission) {
  const timestamp = Number(submission.timestamp);
  const id = String(submission.id);
  if (timestamp > state.lastSyncedTimestamp) {
    return { lastSyncedTimestamp: timestamp, lastSyncedSubmissionIds: [id] };
  }
  if (timestamp === state.lastSyncedTimestamp && !state.lastSyncedSubmissionIds.includes(id)) {
    return { ...state, lastSyncedSubmissionIds: [...state.lastSyncedSubmissionIds, id] };
  }
  return state;
}

async function graphql(operationName, query, variables, csrf) {
  const response = await fetch(LEETCODE_URL, {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/json",
      "x-csrftoken": csrf,
      referer: "https://leetcode.com/",
    },
    body: JSON.stringify({ operationName, query, variables }),
  });
  const body = await response.json();
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join("; "));
  return body.data;
}

async function listNewAccepted(state, csrf) {
  const found = [];
  let offset = 0;
  while (true) {
    const data = await graphql("submissionList", SUBMISSIONS_QUERY, { offset, limit: PAGE_SIZE }, csrf);
    const page = data.submissionList;
    if (!page?.submissions) throw new Error("LeetCode returned no submission list; not logged in?");
    const accepted = page.submissions.filter((s) => s.statusDisplay === "Accepted");
    found.push(...accepted.filter((s) => isNewSubmission(s, state)));
    const oldest = Math.min(...page.submissions.map((s) => Number(s.timestamp)));
    if (!page.hasNext || (state.lastSyncedTimestamp && oldest < state.lastSyncedTimestamp)) break;
    offset += PAGE_SIZE;
  }
  return found.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
}

function problemReadme(question, submission) {
  const tags = question.topicTags || [];
  const solvedDate = new Date(Number(submission.timestamp) * 1000).toISOString().slice(0, 10);
  return `# ${question.questionFrontendId}. ${question.title}

- **Link:** https://leetcode.com/problems/${question.titleSlug}/
- **Difficulty:** ${question.difficulty}
- **Solved:** ${solvedDate}
- **Topics:** ${tags.map((t) => t.name).join(", ") || "Uncategorized"}
- **Primary topic:** ${primaryTopic(question)}

<details>
<summary>Problem statement</summary>

${question.content || "Problem statement unavailable."}

</details>
`;
}

function buildFiles(question, submission, code, language) {
  const dir = `topics/${primaryTopic(question)}/${question.questionFrontendId}-${question.titleSlug}`;
  const ext = extensionFor(language);
  return [
    { path: `${dir}/solution.${ext}`, content: code },
    { path: `${dir}/README.md`, content: problemReadme(question, submission) },
  ];
}

async function ghRequest(path, token, options = {}) {
  const response = await fetch(`${GITHUB_API}${path}`, {
    ...options,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });
  if (!response.ok) throw new Error(`GitHub ${path} failed (${response.status}): ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function pushCommit(files, message, config) {
  const { owner, repo, branch = "main", token } = config;
  const repoPath = `/repos/${owner}/${repo}`;

  const ref = await ghRequest(`${repoPath}/git/ref/heads/${branch}`, token);
  const parentSha = ref.object.sha;
  const parentCommit = await ghRequest(`${repoPath}/git/commits/${parentSha}`, token);
  const baseTreeSha = parentCommit.tree.sha;

  const blobs = await Promise.all(
    files.map(async (file) => {
      const blob = await ghRequest(`${repoPath}/git/blobs`, token, {
        method: "POST",
        body: JSON.stringify({ content: toBase64(file.content), encoding: "base64" }),
      });
      return { path: file.path, mode: "100644", type: "blob", sha: blob.sha };
    }),
  );

  const tree = await ghRequest(`${repoPath}/git/trees`, token, {
    method: "POST",
    body: JSON.stringify({ base_tree: baseTreeSha, tree: blobs }),
  });

  const commit = await ghRequest(`${repoPath}/git/commits`, token, {
    method: "POST",
    body: JSON.stringify({ message, tree: tree.sha, parents: [parentSha] }),
  });

  await ghRequest(`${repoPath}/git/refs/heads/${branch}`, token, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha }),
  });
}

async function syncOnce() {
  const config = await getConfig();
  if (!config.token || !config.owner || !config.repo) {
    log("not configured; open the extension options.");
    return;
  }

  const session = await getCookie("LEETCODE_SESSION");
  const csrf = await getCookie("csrftoken");
  if (!session || !csrf) {
    log("not logged in to leetcode.com.");
    return;
  }

  const state = await getState();
  const submissions = await listNewAccepted(state, csrf.value);
  log(`found ${submissions.length} new accepted submission(s).`);

  for (const submission of submissions) {
    const details = await graphql("submissionDetails", SUBMISSION_DETAILS_QUERY, { id: Number(submission.id) }, csrf.value);
    const metadata = await graphql("questionData", QUESTION_QUERY, { titleSlug: submission.titleSlug }, csrf.value);
    const source = details.submissionDetails;
    const question = metadata.question;
    const language = source.lang?.name || source.lang?.verboseName || submission.lang;
    const files = buildFiles(question, submission, source.code, language);
    const message = `Solved: ${question.questionFrontendId}. ${question.title} (${primaryTopic(question)}, ${question.difficulty})`;

    await pushCommit(files, message, config);
    const next = advanceState(state, submission);
    state.lastSyncedTimestamp = next.lastSyncedTimestamp;
    state.lastSyncedSubmissionIds = next.lastSyncedSubmissionIds;
    await setState(state);
    log(`synced ${question.questionFrontendId}. ${question.title}`);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const state = await getState();
  if (state.lastSyncedTimestamp === 0) {
    await setState({ lastSyncedTimestamp: Math.floor(Date.now() / 1000), lastSyncedSubmissionIds: [] });
  }
  chrome.alarms.create("sync", { periodInMinutes: POLL_MINUTES });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("sync", { periodInMinutes: POLL_MINUTES });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "sync") syncOnce().catch((e) => log(`sync failed: ${e.message}`));
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message === "sync-now") {
    syncOnce()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});
