const status = document.getElementById("status");

async function load() {
  const { config } = await chrome.storage.sync.get("config");
  if (!config) return;
  document.getElementById("token").value = config.token || "";
  document.getElementById("owner").value = config.owner || "";
  document.getElementById("repo").value = config.repo || "";
  document.getElementById("branch").value = config.branch || "main";
}

document.getElementById("save").addEventListener("click", async () => {
  const config = {
    token: document.getElementById("token").value.trim(),
    owner: document.getElementById("owner").value.trim(),
    repo: document.getElementById("repo").value.trim(),
    branch: document.getElementById("branch").value.trim() || "main",
  };
  await chrome.storage.sync.set({ config });
  status.textContent = "Saved.";
});

document.getElementById("syncNow").addEventListener("click", () => {
  status.textContent = "Syncing...";
  chrome.runtime.sendMessage("sync-now", (response) => {
    status.textContent = response.ok ? "Synced." : `Error: ${response.error}`;
  });
});

load();
