// Zen Tab Sorter — Main background script

/**
 * Extracts a meaningful "effective" hostname from a full hostname.
 * Groups subdomains (e.g., "mail.google.com" and "docs.google.com")
 * under a single parent domain ("google.com").
 * @param {string} hostname - The full hostname from a URL.
 * @returns {string} The effective hostname for sorting.
 */
function getEffectiveHostname(hostname) {
  const lower = (hostname || "").toLowerCase();
  if (!lower) return "";

  // Return IP addresses or localhost as is.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(lower) || lower === "localhost") {
    return lower;
  }

  // Strip "www." prefix for consistency.
  let host = lower.startsWith("www.") ? lower.slice(4) : lower;

  // Common multi-part top-level domains (TLDs).
  const multiPartSuffixes = [
    "co.uk", "org.uk", "gov.uk", "ac.uk",
    "com.au", "net.au", "org.au",
    "co.jp",
  ];

  for (const suffix of multiPartSuffixes) {
    if (host.endsWith("." + suffix)) {
      const parts = host.split(".");
      return parts.slice(-3).join(".");
    }
  }

  // Standard TLDs: return last two parts.
  const parts = host.split(".");
  if (parts.length >= 2) {
    return parts.slice(-2).join(".");
  }
  return host;
}

/**
 * Safely extracts the effective hostname from a browser tab object.
 * @param {object} tab - The browser tab object.
 * @returns {string} The effective hostname or a fallback string.
 */
function getHost(tab) {
  try {
    const hostname = new URL(tab.url).hostname;
    return getEffectiveHostname(hostname);
  } catch (e) {
    return (tab.url || "").toLowerCase();
  }
}

/**
 * Normalizes a URL for robust duplicate detection.
 * Removes the hash part of the URL.
 * @param {string} rawUrl - The original URL.
 * @returns {string} The normalized URL.
 */
function normalizeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    u.hash = "";
    return u.href;
  } catch (_) {
    return rawUrl || "";
  }
}

/**
 * Reusable tab sorter: sorts by host, then by title.
 * @param {object} a - First tab.
 * @param {object} b - Second tab.
 * @returns {number} Comparison result.
 */
function compareTabs(a, b) {
  const hostA = getHost(a);
  const hostB = getHost(b);
  const hostCompare = hostA.localeCompare(hostB, undefined, { sensitivity: "base" });
  if (hostCompare !== 0) return hostCompare;
  return (a.title || "").localeCompare(b.title || "", undefined, { sensitivity: "base" });
}

/**
 * Loads settings from storage with defaults.
 * @returns {Promise<object>} Settings object.
 */
async function getSettings() {
  const defaults = {
    removeDuplicates: true,
    sortOnShortcut: true,
    groupByDomain: true,
    sortWithinGroups: true,
    sortGroupsAlphabetically: true,
  };
  try {
    const stored = await browser.storage.local.get(null);
    return { ...defaults, ...stored };
  } catch (e) {
    return defaults;
  }
}

/**
 * Finds and removes duplicate tabs within a given window.
 * @param {number} windowId - The ID of the window to clean.
 */
async function removeDuplicateTabs(windowId) {
  try {
    const tabs = await browser.tabs.query({ windowId });
    const urlToTabs = new Map();

    for (const tab of tabs) {
      if (!tab.url) continue;
      const key = normalizeUrl(tab.url);
      if (!urlToTabs.has(key)) urlToTabs.set(key, []);
      urlToTabs.get(key).push(tab);
    }

    const toClose = [];

    for (const [, sameUrlTabs] of urlToTabs) {
      if (sameUrlTabs.length <= 1) continue;

      const pinnedTabs = sameUrlTabs.filter((t) => t.pinned);
      const unpinnedTabs = sameUrlTabs.filter((t) => !t.pinned);

      if (pinnedTabs.length > 0) {
        toClose.push(...unpinnedTabs.map(t => t.id));
        continue;
      }

      // Keep active tab, or the one with lowest index.
      let keep = unpinnedTabs.find((t) => t.active);
      if (!keep) {
        keep = unpinnedTabs.reduce((min, t) => t.index < min.index ? t : min);
      }
      for (const t of unpinnedTabs) {
        if (t.id !== keep.id) toClose.push(t.id);
      }
    }

    if (toClose.length > 0) {
      try {
        await browser.tabs.remove(toClose);
      } catch (err) { /* Tab already closed. */ }
    }
  } catch (err) { /* Ignore query errors. */ }
}

/**
 * Main function to sort all tabs in a window.
 * @param {number} windowId - The ID of the window to sort.
 */
async function sortTabsInWindow(windowId) {
  try {
    const settings = await getSettings();

    if (settings.removeDuplicates) {
      await removeDuplicateTabs(windowId);
    }

    const allTabs = await browser.tabs.query({ windowId });
    const pinned = allTabs.filter((t) => t.pinned);
    const unpinned = allTabs.filter((t) => !t.pinned);

    const supportsTabGroups = typeof browser.tabGroups !== "undefined";

    if (!supportsTabGroups || !settings.groupByDomain) {
      return await sortUngroupedTabs(unpinned, pinned.length);
    }

    // --- Tab Groups Mode ---

    // Collect all groups and distribute tabs.
    const groups = await browser.tabGroups.query({ windowId });
    const groupData = new Map();
    groups.forEach(g => groupData.set(g.id, { group: g, tabs: [] }));

    const ungroupedTabs = [];

    for (const tab of unpinned) {
      if (tab.groupId && tab.groupId !== browser.tabGroups.TAB_GROUP_ID_NONE && groupData.has(tab.groupId)) {
        groupData.get(tab.groupId).tabs.push(tab);
      } else {
        ungroupedTabs.push(tab);
      }
    }

    // Sort tabs within groups.
    if (settings.sortWithinGroups) {
      for (const data of groupData.values()) {
        data.tabs.sort(compareTabs);
      }
    }

    // Sort groups alphabetically.
    let sortedGroups = [...groupData.values()];
    if (settings.sortGroupsAlphabetically) {
      sortedGroups.sort((a, b) =>
        (a.group.title || "").localeCompare(b.group.title || "", undefined, { sensitivity: "base" })
      );
    }

    // Sort ungrouped tabs.
    ungroupedTabs.sort(compareTabs);

    // Execute moves.
    let currentIndex = pinned.length;

    // Move grouped tabs.
    for (const data of sortedGroups) {
      if (data.tabs.length === 0) continue;

      const tabIds = data.tabs.map(t => t.id);

      for (const tabId of tabIds) {
        try {
          await browser.tabs.move(tabId, { index: currentIndex });
          currentIndex++;
        } catch (e) { /* Tab closed during process. */ }
      }

      try {
        await browser.tabs.group({ tabIds, groupId: data.group.id });
      } catch (e) {
        try {
          const newGroupId = await browser.tabs.group({ tabIds });
          await browser.tabGroups.update(newGroupId, { title: data.group.title });
        } catch (e2) { /* Grouping failed. */ }
      }
    }

    // Move ungrouped tabs.
    for (const tab of ungroupedTabs) {
      try {
        await browser.tabs.move(tab.id, { index: currentIndex });
        currentIndex++;
      } catch (e) { /* Tab closed. */ }
    }

    return { status: "sorted" };
  } catch (err) {
    return { status: "error", error: String(err) };
  }
}

/**
 * Sorts ungrouped tabs (no tab groups support or disabled).
 * @param {Array<object>} tabs - Array of unpinned tab objects.
 * @param {number} pinnedCount - Number of pinned tabs.
 */
async function sortUngroupedTabs(tabs, pinnedCount) {
  const sorted = [...tabs].sort(compareTabs);

  const currentOrderIds = tabs.map((t) => t.id);
  const sortedOrderIds = sorted.map((t) => t.id);

  if (currentOrderIds.every((id, i) => id === sortedOrderIds[i])) {
    return { status: "already_sorted" };
  }

  let targetIndex = pinnedCount;
  for (const tab of sorted) {
    try {
      await browser.tabs.move(tab.id, { index: targetIndex });
      targetIndex++;
    } catch (err) { /* Ignore move errors. */ }
  }
  return { status: "sorted" };
}

// --- Event Listeners ---

// Listen for the Alt+S shortcut.
browser.commands.onCommand.addListener(async (command) => {
  if (command !== "sort-tabs") return;

  const settings = await getSettings();
  if (!settings.sortOnShortcut) return;

  try {
    const w = await browser.windows.getCurrent();
    await sortTabsInWindow(w.id);
  } catch (err) { /* Ignore errors. */ }
});

// Listen for clicks on the extension icon.
browser.browserAction.onClicked.addListener(async () => {
  try {
    const w = await browser.windows.getCurrent();
    await sortTabsInWindow(w.id);
  } catch (err) { /* Ignore errors. */ }
});
