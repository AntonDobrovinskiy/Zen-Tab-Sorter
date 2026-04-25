// Default settings
const defaults = {
  removeDuplicates: true,
  sortOnShortcut: true,
  groupByDomain: true,
  sortWithinGroups: true,
  sortGroupsAlphabetically: true,
};

// Current settings
let settings = { ...defaults };

// Load settings from storage
async function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(null, (stored) => {
      settings = { ...defaults, ...stored };
      applySettingsToUI();
      resolve();
    });
  });
}

// Apply settings to UI controls
function applySettingsToUI() {
  for (const key of Object.keys(defaults)) {
    const el = document.getElementById(key);
    if (el) el.checked = settings[key];
  }
}

// Save settings to storage
async function saveSettings() {
  // Update settings from UI
  for (const key of Object.keys(defaults)) {
    const el = document.getElementById(key);
    if (el) settings[key] = el.checked;
  }

  chrome.storage.local.set(settings, () => {
    showStatus("Settings saved", "success");
  });
}

// Show status message
function showStatus(message, type) {
  const el = document.getElementById("status");
  el.textContent = message;
  el.className = `status ${type}`;
  setTimeout(() => { el.className = "status"; }, 2000);
}

// Initialize
document.addEventListener("DOMContentLoaded", loadSettings);

// Save on any change
document.querySelectorAll("input[type='checkbox']").forEach(el => {
  el.addEventListener("change", saveSettings);
});