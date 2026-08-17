import assert from "node:assert/strict";
import { advanceState, extensionFor, isNewSubmission } from "./sync.js";

assert.equal(extensionFor("Python3"), "py");
assert.equal(extensionFor("C++23"), "cpp");
assert.equal(extensionFor("MS SQL Server"), "sql");

let state = { lastSyncedTimestamp: 100, lastSyncedSubmissionIds: ["1"] };
assert.equal(isNewSubmission({ id: "1", timestamp: 100 }, state), false);
assert.equal(isNewSubmission({ id: "2", timestamp: 100 }, state), true);
state = advanceState(state, { id: "2", timestamp: 100 });
assert.deepEqual(state.lastSyncedSubmissionIds, ["1", "2"]);
state = advanceState(state, { id: "3", timestamp: 101 });
assert.deepEqual(state, { lastSyncedTimestamp: 101, lastSyncedSubmissionIds: ["3"] });

console.log("sync helpers: ok");
