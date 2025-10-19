// This script manages tab sorting, duplicate removal, and group handling.

// A global state object, not actively used in the current sorting logic
// but potentially useful for future stateful features.
let groupState = {};

/**
 * Extracts a more meaningful "effective" hostname from a full hostname.
 * This helps group subdomains (e.g., "mail.google.com" and "docs.google.com")
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

  // A simplified list of common multi-part top-level domains (TLDs).
  // This avoids a heavy dependency on a full Public Suffix List.
  const multiPartSuffixes = [
    "co.uk", "org.uk", "gov.uk", "ac.uk",
    "com.au", "net.au", "org.au",
    "co.jp",
  ];

  for (const suffix of multiPartSuffixes) {
    if (host.endsWith("." + suffix)) {
      const parts = host.split(".");
      return parts.slice(-3).join("."); // e.g., "bbc.co.uk"
    }
  }

  // For standard TLDs, return the last two parts.
  const parts = host.split(".");
  if (parts.length >= 2) {
    return parts.slice(-2).join("."); // e.g., "google.com"
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
    // Fallback for URLs that can't be parsed (e.g., "about:blank").
    return (tab.url || "").toLowerCase();
  }
}

/**
 * Normalizes a URL for robust duplicate detection.
 * It removes the hash part of the URL (e.g., "#section1").
 * @param {string} rawUrl - The original URL.
 * @returns {string} The normalized URL.
 */
function normalizeUrlForDeduplication(rawUrl) {
  try {
    const u = new URL(rawUrl);
    u.hash = "";
    return u.href;
  } catch (_) {
    return rawUrl || "";
  }
}

/**
 * Finds and removes duplicate tabs within a given window.
 * Pinned tabs are never removed. If duplicates of a pinned tab exist,
 * the unpinned ones are removed. For unpinned duplicates, the active tab
 * or the one with the lowest index is kept.
 * @param {number} windowId - The ID of the window to clean.
 */
async function removeDuplicateTabs(windowId) {
  try {
    const tabs = await browser.tabs.query({ windowId });
    const urlToTabs = new Map();

    // Group tabs by their normalized URL.
    for (const tab of tabs) {
      if (!tab.url) continue;
      const key = normalizeUrlForDeduplication(tab.url);
      if (!urlToTabs.has(key)) urlToTabs.set(key, []);
      urlToTabs.get(key).push(tab);
    }

    const toClose = [];

    for (const [, sameUrlTabs] of urlToTabs) {
      if (sameUrlTabs.length <= 1) continue;

      const pinnedTabs = sameUrlTabs.filter((t) => t.pinned);
      const unpinnedTabs = sameUrlTabs.filter((t) => !t.pinned);

      if (pinnedTabs.length > 0) {
        // If a pinned version exists, close all unpinned duplicates.
        toClose.push(...unpinnedTabs.map(t => t.id));
        continue;
      }

      // If no pinned tabs, keep the best unpinned one.
      // Priority: active tab > lowest index tab.
      let keep = unpinnedTabs.find((t) => t.active);
      if (!keep) {
        keep = unpinnedTabs.sort((a, b) => a.index - b.index)[0];
      }
      for (const t of unpinnedTabs) {
        if (t.id !== keep.id) toClose.push(t.id);
      }
    }

    if (toClose.length > 0) {
      try {
        await browser.tabs.remove(toClose);
      } catch (err) { /* Ignore errors if tabs were already closed. */ }
    }
  } catch (err) { /* Ignore errors on query failure. */ }
}

/**
 * Updates the global groupState object.
 * This function is not critical for the current sorting logic but is
 * attached to listeners for potential future use.
 * @param {number} windowId - The window ID to update state for.
 */
async function updateGroupState(windowId) {
  try {
    const [groups, allTabs] = await Promise.all([
      browser.tabGroups.query({ windowId }),
      browser.tabs.query({ windowId }),
    ]);
    groupState[windowId] = {};
    for (const group of groups) {
      const groupTabs = allTabs.filter((tab) => tab.groupId === group.id);
      groupState[windowId][group.id] = {
        title: group.title,
        tabIds: groupTabs.map((tab) => tab.id),
        minIndex:
          groupTabs.length > 0
            ? Math.min(...groupTabs.map((t) => t.index))
            : null,
      };
    }
  } catch (err) {
    // console.log("Ошибка updateGroupState", err);
  }
}

/**
 * Automatically moves a newly created tab next to existing tabs
 * from the same domain.
 * @param {object} tab - The newly created tab object.
 */
async function autoSortNewTab(tab) {
  try {
    if (!tab.url || tab.pinned) return;

    const windowId = tab.windowId;
    const newTabHost = getHost(tab);
    const supportsTabGroups = typeof browser.tabGroups !== "undefined";
    
    // Query only ungrouped tabs to find a sorting position.
    const tabs = await browser.tabs.query({
      windowId,
      pinned: false,
      ...(supportsTabGroups
        ? { groupId: browser.tabGroups.TAB_GROUP_ID_NONE }
        : {}),
    });

    const sameDomainTabs = tabs.filter(
      (t) => t.id !== tab.id && getHost(t) === newTabHost,
    );
    
    // Move to the position of the first tab of the same domain.
    if (sameDomainTabs.length > 0) {
      const targetIndex = Math.min(...sameDomainTabs.map((t) => t.index));
      try {
        await browser.tabs.move(tab.id, { index: targetIndex });
      } catch (err) { /* Ignore move errors. */ }
    }
  } catch (err) { /* Ignore query errors. */ }
}

/**
 * Main function to sort all tabs in a window when the user executes the command.
 * This function implements a "brute-force" regrouping strategy to handle
 * browser-specific quirks where moving grouped tabs is unreliable.
 * @param {number} windowId - The ID of the window to sort.
 */
async function sortTabsInWindow(windowId) {
  try {
    // First, clean up any duplicate tabs.
    await removeDuplicateTabs(windowId);

    const allTabs = await browser.tabs.query({ windowId });
    const pinned = allTabs.filter((t) => t.pinned);

    const supportsTabGroups = typeof browser.tabGroups !== "undefined";
    if (!supportsTabGroups) {
      // If tab groups are not supported, use the simpler sorting logic.
      const unpinned = allTabs.filter((t) => !t.pinned);
      return await sortUngroupedTabs(unpinned, pinned.length);
    }

    // --- 1. Data Collection ---
    // Collect all groups and create a map to store their tabs.
    const groups = await browser.tabGroups.query({ windowId });
    const groupData = new Map();
    groups.forEach(g => groupData.set(g.id, { group: g, tabs: [] }));

    // Distribute all unpinned tabs into their respective groups or the ungrouped list.
    const ungroupedTabs = [];
    allTabs.forEach(tab => {
      if (tab.pinned) return;
      if (tab.groupId && tab.groupId !== browser.tabGroups.TAB_GROUP_ID_NONE && groupData.has(tab.groupId)) {
        groupData.get(tab.groupId).tabs.push(tab);
      } else {
        ungroupedTabs.push(tab);
      }
    });

    // --- 2. Sorting (The "Plan") ---
    // Define a reusable sorter function for tabs (by host, then by title).
    const tabSorter = (a, b) => {
      const hostA = getHost(a);
      const hostB = getHost(b);
      const hostCompare = hostA.localeCompare(hostB, { sensitivity: "base" });
      return hostCompare !== 0
        ? hostCompare
        : (a.title || "").localeCompare(b.title || "", { sensitivity: "base" });
    };

    // Sort tabs within each group's list in memory.
    groupData.forEach(data => data.tabs.sort(tabSorter));

    // Sort the groups themselves alphabetically by title.
    const sortedGroupData = [...groupData.values()].sort((a, b) =>
      (a.group.title || "").localeCompare(b.group.title || "", { sensitivity: "base" })
    );

    // Sort the remaining ungrouped tabs.
    ungroupedTabs.sort(tabSorter);

    // --- 3. Execution (Brute-force Regrouping) ---
    // This strategy moves tabs one-by-one into their final sorted positions,
    // then re-applies the grouping. This is more reliable than moving grouped tabs directly.
    let currentIndex = pinned.length;

    // Process sorted groups first.
    for (const data of sortedGroupData) {
      if (data.tabs.length === 0) continue;

      const tabIds = data.tabs.map(t => t.id);
      
      // Move all tabs for the current group into a contiguous block.
      // This action temporarily breaks them out of their group in the browser.
      for (const tabId of tabIds) {
          try {
              await browser.tabs.move(tabId, { index: currentIndex });
              currentIndex++;
          } catch (e) { /* Tab might have been closed during the process. */ }
      }
      
      // Now, re-apply the group to the tabs that were just moved into position.
      try {
          await browser.tabs.group({
              tabIds: tabIds,
              groupId: data.group.id
          });
      } catch (e) {
          // If regrouping fails (e.g., group was deleted), try to create a new group.
          try {
             const newGroupId = await browser.tabs.group({ tabIds: tabIds });
             await browser.tabGroups.update(newGroupId, { title: data.group.title });
          } catch (e2) { /* If creating a new group also fails, do nothing. */ }
      }
    }

    // Finally, move the sorted ungrouped tabs to the end.
    for (const tab of ungroupedTabs) {
        try {
            await browser.tabs.move(tab.id, { index: currentIndex });
            currentIndex++;
        } catch (e) { /* Tab might have been closed. */ }
    }

    return { status: "sorted" };
  } catch (err) {
    return { status: "error", error: String(err) };
  }
}

/**
 * A simpler sorting function for environments without tab group support.
 * @param {Array<object>} unpinnedTabs - An array of unpinned tab objects.
 * @param {number} pinnedCount - The number of pinned tabs.
 */
async function sortUngroupedTabs(unpinnedTabs, pinnedCount) {
  const tabCompare = (a, b) => {
    const hostA = getHost(a);
    const hostB = getHost(b);
    const hostCompare = hostA.localeCompare(hostB, undefined, {
      sensitivity: "base",
    });
    if (hostCompare !== 0) return hostCompare;
    return (a.title || "").localeCompare(b.title || "", undefined, {
      sensitivity: "base",
    });
  };

  const sortedUnpinned = [...unpinnedTabs].sort(tabCompare);
  
  // Avoid unnecessary moves if tabs are already sorted.
  const currentOrderIds = unpinnedTabs.map((t) => t.id);
  const sortedOrderIds = sortedUnpinned.map((t) => t.id);
  if (currentOrderIds.every((id, i) => id === sortedOrderIds[i])) {
    return { status: "already_sorted" };
  }

  let targetIndex = pinnedCount;
  for (const tab of sortedUnpinned) {
    try {
      await browser.tabs.move(tab.id, { index: targetIndex });
      targetIndex++;
    } catch (err) { /* Ignore move errors. */ }
  }
  return { status: "sorted" };
}

// --- Event Listeners ---
// These listeners are for maintaining groupState, which could be used in the future.
browser.tabGroups.onCreated.addListener(async (group) => {
  await updateGroupState(group.windowId);
});

browser.tabGroups.onUpdated.addListener(async (group) => {
  await updateGroupState(group.windowId);
});

browser.tabGroups.onRemoved.addListener(async (group) => {
  await updateGroupState(group.windowId);
});

browser.tabs.onAttached.addListener(async (tabId, attachInfo) => {
  await updateGroupState(attachInfo.newWindowId);
});

browser.tabs.onDetached.addListener(async (tabId, detachInfo) => {
  await updateGroupState(detachInfo.oldWindowId);
});

// Automatically sort a new tab when it's created.
browser.tabs.onCreated.addListener(async (tab) => {
  await autoSortNewTab(tab);
});

// Listen for the command shortcut (e.g., Alt+S) to trigger the main sorting function.
browser.commands.onCommand.addListener(async (command) => {
  if (command === "sort-tabs") {
    try {
      const w = await browser.windows.getCurrent();
      await sortTabsInWindow(w.id);
    } catch (err) { /* Ignore errors if window cannot be found. */ }
  }
});