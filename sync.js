import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const LEETCODE_URL = "https://leetcode.com/graphql";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// Run this from the solutions repository; its root receives topics/, README.md, and .sync-state.json.
const OUTPUT_DIR = path.resolve(process.env.LEETCODE_OUTPUT_DIR || ".");
const TOPICS_DIR = path.join(OUTPUT_DIR, "topics");
const STATE_FILE = path.join(OUTPUT_DIR, ".sync-state.json");
const REQUEST_DELAY_MS = 500;
const PAGE_SIZE = 20;
const TOPIC_LAYOUT = process.env.LEETCODE_TOPIC_LAYOUT || "primary"; // primary, duplicate, or symlink
const SYNC_GIT = process.env.SYNC_GIT !== "false";

export const EXTENSIONS = {
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

class LeetCodeAuthError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(message) {
  console.log(`[leetcode-sync] ${message}`);
}

function normalizeLanguage(language = "") {
  return language.toLowerCase().replaceAll(" ", "");
}

export function extensionFor(language) {
  return EXTENSIONS[normalizeLanguage(language)] || "txt";
}

function requireCredentials() {
  const session = process.env.LEETCODE_SESSION;
  const csrf = process.env.LEETCODE_CSRF_TOKEN;
  if (!session || !csrf) {
    throw new LeetCodeAuthError("LEETCODE_SESSION and LEETCODE_CSRF_TOKEN are required.");
  }
  return { session, csrf };
}

function isAuthFailure(status, message) {
  return status === 401 || status === 403 || /auth|sign.?in|unauthori[sz]ed|permission/i.test(message);
}

async function graphql(operationName, query, variables) {
  const { session, csrf } = requireCredentials();
  let lastError;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await sleep(REQUEST_DELAY_MS);
      const response = await fetch(LEETCODE_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://leetcode.com",
          referer: "https://leetcode.com/",
          cookie: `LEETCODE_SESSION=${session}; csrftoken=${csrf}`,
          "x-csrftoken": csrf,
          "user-agent": "leetcode-github-sync/1.0",
        },
        body: JSON.stringify({ operationName, query, variables }),
      });
      const text = await response.text();
      if (!response.ok) {
        if (isAuthFailure(response.status, text)) throw new LeetCodeAuthError(`LeetCode authentication failed (${response.status}).`);
        if (response.status === 429 || response.status >= 500) throw new Error(`LeetCode HTTP ${response.status}`);
        throw new Error(`LeetCode HTTP ${response.status}: ${text.slice(0, 300)}`);
      }

      let body;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error("LeetCode returned non-JSON content.");
      }
      if (body.errors?.length) {
        const message = body.errors.map((error) => error.message).join("; ");
        if (isAuthFailure(response.status, message)) throw new LeetCodeAuthError(`LeetCode authentication failed: ${message}`);
        throw new Error(`LeetCode GraphQL error: ${message}`);
      }
      return body.data;
    } catch (error) {
      if (error instanceof LeetCodeAuthError) throw error;
      lastError = error;
      if (attempt === 3) break;
      const delay = REQUEST_DELAY_MS * 2 ** attempt;
      log(`${operationName} failed (${error.message}); retrying in ${delay}ms.`);
      await sleep(delay);
    }
  }
  throw lastError;
}

function readState() {
  if (!existsSync(STATE_FILE)) return { lastSyncedTimestamp: 0, lastSyncedSubmissionIds: [] };
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return {
      lastSyncedTimestamp: Number(state.lastSyncedTimestamp) || 0,
      lastSyncedSubmissionIds: Array.isArray(state.lastSyncedSubmissionIds) ? state.lastSyncedSubmissionIds.map(String) : [],
    };
  } catch (error) {
    throw new Error(`Cannot read ${STATE_FILE}: ${error.message}`);
  }
}

function writeState(state) {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

export function isNewSubmission(submission, state) {
  const timestamp = Number(submission.timestamp);
  return timestamp > state.lastSyncedTimestamp || (
    timestamp === state.lastSyncedTimestamp && !state.lastSyncedSubmissionIds.includes(String(submission.id))
  );
}

export function advanceState(state, submission) {
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

async function listNewAcceptedSubmissions(state) {
  const found = [];
  let offset = 0;
  while (true) {
    const data = await graphql("submissionList", SUBMISSIONS_QUERY, { offset, limit: PAGE_SIZE });
    const page = data.submissionList;
    if (!page?.submissions) throw new LeetCodeAuthError("LeetCode returned no submission list; session may be invalid.");
    const accepted = page.submissions.filter((submission) => submission.statusDisplay === "Accepted");
    found.push(...accepted.filter((submission) => isNewSubmission(submission, state)));
    const oldest = Math.min(...page.submissions.map((submission) => Number(submission.timestamp)));
    if (!page.hasNext || (state.lastSyncedTimestamp && oldest < state.lastSyncedTimestamp)) break;
    offset += PAGE_SIZE;
    await sleep(REQUEST_DELAY_MS);
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
- **Topics:** ${tags.map((tag) => tag.name).join(", ") || "Uncategorized"}
- **Primary topic:** ${primaryTopic(question)}

<details>
<summary>Problem statement</summary>

${question.content || "Problem statement unavailable."}

</details>
`;
}

function primaryTopic(question) {
  return question.topicTags?.[0]?.slug || "uncategorized";
}

function problemDirectory(topic, question) {
  return path.join(TOPICS_DIR, topic, `${question.questionFrontendId}-${question.titleSlug}`);
}

function ensureSymlink(linkPath, targetPath) {
  if (existsSync(linkPath)) {
    if (lstatSync(linkPath).isSymbolicLink()) return;
    throw new Error(`${linkPath} exists and is not a symlink; move it before using symlink topic layout.`);
  }
  mkdirSync(path.dirname(linkPath), { recursive: true });
  const relativeTarget = path.relative(path.dirname(linkPath), targetPath);
  // ponytail: directory links need a manual cleanup if topic mode changes.
  symlinkSync(relativeTarget, linkPath, "dir");
}

function writeSolution(directory, code, extension) {
  for (const name of readdir(directory)) {
    if (name.startsWith("solution.") && name !== `solution.${extension}`) unlinkSync(path.join(directory, name));
  }
  writeFileSync(path.join(directory, `solution.${extension}`), code);
}

function writeProblem(question, submission, code, language) {
  if (!question?.questionFrontendId || !question.titleSlug) throw new Error(`Missing metadata for ${submission.titleSlug}.`);
  const primary = problemDirectory(primaryTopic(question), question);
  const tags = [...new Set((question.topicTags || []).map((tag) => tag.slug).filter(Boolean))];
  const directories = TOPIC_LAYOUT === "primary" ? [primary] : tags.map((tag) => problemDirectory(tag, question));
  if (!directories.length) directories.push(primary);
  if (!["primary", "duplicate", "symlink"].includes(TOPIC_LAYOUT)) throw new Error("LEETCODE_TOPIC_LAYOUT must be primary, duplicate, or symlink.");

  mkdirSync(primary, { recursive: true });
  const readme = problemReadme(question, submission);
  const extension = extensionFor(language);
  writeSolution(primary, code, extension);
  writeFileSync(path.join(primary, "README.md"), readme);

  for (const directory of directories) {
    if (directory === primary) continue;
    if (TOPIC_LAYOUT === "symlink") {
      ensureSymlink(directory, primary);
      continue;
    }
    mkdirSync(directory, { recursive: true });
    writeSolution(directory, code, extension);
    writeFileSync(path.join(directory, "README.md"), readme);
  }
  return primary;
}

function collectSolutions() {
  if (!existsSync(TOPICS_DIR)) return [];
  const solutions = new Map();
  for (const topic of readdir(TOPICS_DIR)) {
    const topicDir = path.join(TOPICS_DIR, topic);
    for (const problem of readdir(topicDir)) {
      const readme = path.join(topicDir, problem, "README.md");
      if (!existsSync(readme)) continue;
      const content = readFileSync(readme, "utf8");
      const difficulty = content.match(/\*\*Difficulty:\*\* (.+)/)?.[1] || "Unknown";
      const primary = content.match(/\*\*Primary topic:\*\* (.+)/)?.[1] || topic;
      solutions.set(problem, { difficulty, topic: primary });
    }
  }
  return [...solutions.values()];
}

function readdir(directory) {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

function regenerateStats() {
  const solutions = collectSolutions();
  const byDifficulty = Object.groupBy(solutions, ({ difficulty }) => difficulty);
  const byTopic = Object.groupBy(solutions, ({ topic }) => topic);
  const table = (items) => Object.entries(items).sort(([a], [b]) => a.localeCompare(b))
    .map(([name, entries]) => `| ${name} | ${entries.length} |`).join("\n") || "| — | 0 |";
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(path.join(OUTPUT_DIR, "README.md"), `# LeetCode Solutions

Automatically synced from accepted LeetCode submissions.

**Unique problems solved:** ${solutions.length}

## By difficulty

| Difficulty | Solved |
| --- | ---: |
${table(byDifficulty)}

## By primary topic

| Topic | Solved |
| --- | ---: |
${table(byTopic)}
`);
}

function git(args, stdio = "inherit") {
  return execFileSync("git", args, { cwd: process.cwd(), stdio });
}

function commitIfChanged(message) {
  const relativeOutput = path.relative(process.cwd(), OUTPUT_DIR) || ".";
  git(["add", "--", relativeOutput]);
  try {
    git(["diff", "--cached", "--quiet"], "ignore");
    return false;
  } catch {
    git(["commit", "-m", message]);
    return true;
  }
}

function setWorkflowStatus(status) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `status=${status}\n`);
}

export async function sync() {
  if (path.resolve(process.cwd()) === SCRIPT_DIR) {
    throw new Error("Run sync.js from the separate solutions repository, not the script repository.");
  }
  const state = readState();
  const submissions = await listNewAcceptedSubmissions(state);
  let changed = false;
  log(`Found ${submissions.length} new accepted submission${submissions.length === 1 ? "" : "s"}.`);

  for (const submission of submissions) {
    const details = await graphql("submissionDetails", SUBMISSION_DETAILS_QUERY, { id: Number(submission.id) });
    const metadata = await graphql("questionData", QUESTION_QUERY, { titleSlug: submission.titleSlug });
    const source = details.submissionDetails;
    if (typeof source?.code !== "string") throw new LeetCodeAuthError(`No source code returned for submission ${submission.id}.`);
    const question = metadata.question;
    const language = source.lang?.name || source.lang?.verboseName || submission.lang;
    writeProblem(question, submission, source.code, language);
    const nextState = advanceState(state, submission);
    state.lastSyncedTimestamp = nextState.lastSyncedTimestamp;
    state.lastSyncedSubmissionIds = nextState.lastSyncedSubmissionIds;
    writeState(state);
    regenerateStats();
    log(`Synced ${question.questionFrontendId}. ${question.title} (${primaryTopic(question)}, ${question.difficulty}).`);

    if (SYNC_GIT && commitIfChanged(`Solved: ${question.questionFrontendId}. ${question.title} (${primaryTopic(question)}, ${question.difficulty})`)) {
      changed = true;
    }
  }

  if (!submissions.length) {
    regenerateStats();
    if (SYNC_GIT && commitIfChanged("Update LeetCode solution stats")) changed = true;
  }
  if (SYNC_GIT && changed) git(["push"]);
  log(changed ? "Committed and pushed sync changes." : "Nothing to commit.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  sync().then(() => setWorkflowStatus("ok")).catch((error) => {
    const auth = error instanceof LeetCodeAuthError;
    setWorkflowStatus(auth ? "auth" : "error");
    console.error(`[leetcode-sync] ${error.message}`);
    process.exitCode = auth ? 2 : 1;
  });
}
