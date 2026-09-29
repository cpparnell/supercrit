const input = document.getElementById("username");
const statusLine = document.getElementById("status");
const syncButton = document.getElementById("sync");
const toggles = document.querySelectorAll("#features [data-setting]");

function render() {
  const status = cachePeek(USER_STATUS_KEY)?.v;
  const username = cachePeek(USERNAME_KEY)?.v;
  // A status left over from a previous username says nothing about this one.
  const current = status?.username === username ? status : null;
  statusLine.textContent = username ? describeSync(current) : "";
  statusLine.dataset.state = current?.state || "";
  syncButton.hidden = !username || current?.state === "syncing";
}

const sync = (force) => chrome.runtime.sendMessage({ type: "syncUser", force });

// The username applies as soon as typing pauses, or on Enter or leaving the field; no Save button.
// An unchanged name does nothing, so a pause after a stray keystroke doesn't re-sync.
const TYPING_PAUSE_MS = 600;
let typingTimer = null;

async function saveUsername() {
  clearTimeout(typingTimer);
  const raw = input.value.trim();
  const username = normalizeUsername(raw);
  if (raw && !username) {
    statusLine.textContent = "That doesn't look like a Letterboxd username.";
    statusLine.dataset.state = "error";
    return;
  }
  if ((username || null) === (cachePeek(USERNAME_KEY)?.v || null)) return render();
  if (username) await cacheSet(USERNAME_KEY, username, 3650 * DAY_MS);
  else await chrome.storage.local.remove(USERNAME_KEY);
  render();
  sync(true);
}

input.addEventListener("input", () => {
  clearTimeout(typingTimer);
  typingTimer = setTimeout(saveUsername, TYPING_PAUSE_MS);
});
input.addEventListener("change", saveUsername); // Enter, or leaving the field
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveUsername();
});

syncButton.addEventListener("click", () => sync(true));

// Open Criterion tabs pick the change up from storage and redraw in place; no reload needed.
function renderSettings() {
  const settings = normalizeSettings(cachePeek(SETTINGS_KEY)?.v);
  for (const toggle of toggles) toggle.checked = settings[toggle.dataset.setting];
}

for (const toggle of toggles) {
  toggle.addEventListener("change", () => {
    const settings = normalizeSettings(cachePeek(SETTINGS_KEY)?.v);
    cacheSet(SETTINGS_KEY, { ...settings, [toggle.dataset.setting]: toggle.checked }, 3650 * DAY_MS);
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (USER_STATUS_KEY in changes || USERNAME_KEY in changes) render();
  if (SETTINGS_KEY in changes) renderSettings();
});

cacheReady.then(() => {
  input.value = cachePeek(USERNAME_KEY)?.v || "";
  render();
  renderSettings();
});
