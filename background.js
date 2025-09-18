let groupState = {};

function getEffectiveHostname(hostname) {
  const lower = (hostname || '').toLowerCase();
  if (!lower) return '';

  // IP addresses or localhost
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(lower) || lower === 'localhost') {
    return lower;
  }

  let host = lower.startsWith('www.') ? lower.slice(4) : lower;

  // Handle common multi-part public suffixes (approximation without PSL dependency)
  const multiPartSuffixes = [
    'co.uk', 'org.uk', 'gov.uk', 'ac.uk',
    'com.au', 'net.au', 'org.au',
    'co.jp'
  ];

  for (const suffix of multiPartSuffixes) {
    if (host.endsWith('.' + suffix)) {
      const parts = host.split('.');
      return parts.slice(-3).join('.');
    }
  }

  const parts = host.split('.');
  if (parts.length >= 2) {
    return parts.slice(-2).join('.');
  }
  return host;
}

function getHost(tab) {
  try {
    const hostname = new URL(tab.url).hostname;
    return getEffectiveHostname(hostname);
  } catch (e) {
    return (tab.url || '').toLowerCase();
  }
}

function normalizeUrlForDeduplication(rawUrl) {
  try {
    const u = new URL(rawUrl);
    u.hash = '';
    return u.href;
  } catch (_) {
    return rawUrl || '';
  }
}

async function removeDuplicateTabs(windowId) {
  try {
    const tabs = await browser.tabs.query({ windowId });
    const urlToTabs = new Map();

    for (const tab of tabs) {
      if (!tab.url) continue;
      const key = normalizeUrlForDeduplication(tab.url);
      if (!urlToTabs.has(key)) urlToTabs.set(key, []);
      urlToTabs.get(key).push(tab);
    }

    const toClose = [];

    for (const [, sameUrlTabs] of urlToTabs) {
      if (sameUrlTabs.length <= 1) continue;

      const pinnedTabs = sameUrlTabs.filter(t => t.pinned);
      const unpinnedTabs = sameUrlTabs.filter(t => !t.pinned);

      if (pinnedTabs.length > 0) {
        // Never touch pinned. Remove all unpinned duplicates of the same URL.
        for (const t of unpinnedTabs) {
          toClose.push(t.id);
        }
        continue;
      }

      // No pinned: keep one unpinned by priority active > lowest index
      let keep = unpinnedTabs.find(t => t.active);
      if (!keep) keep = unpinnedTabs.slice().sort((a, b) => a.index - b.index)[0];
      for (const t of unpinnedTabs) {
        if (t.id !== keep.id) toClose.push(t.id);
      }
    }

    if (toClose.length > 0) {
      try {
        await browser.tabs.remove(toClose);
      } catch (err) { }
    }
  } catch (err) { }
}

async function updateGroupState(windowId) {
  try {
    const groups = await browser.tabGroups.query({ windowId });
    groupState[windowId] = groupState[windowId] || {};
    for (const group of groups) {
      const groupTabs = await browser.tabs.query({ groupId: group.id });
      groupState[windowId][group.id] = {
        title: group.title,
        tabIds: groupTabs.map(tab => tab.id),
        minIndex: groupTabs.length > 0 ? Math.min(...groupTabs.map(t => t.index)) : null,
      };
    }
  } catch (err) { }
}

async function autoSortNewTab(tab) {
  try {
    if (!tab.url || tab.pinned) return;

    const windowId = tab.windowId;
    const newTabHost = getHost(tab);
    const supportsTabGroups = typeof browser.tabGroups !== 'undefined';
    const tabs = await browser.tabs.query({
      windowId,
      pinned: false,
      ...(supportsTabGroups ? { groupId: browser.tabGroups.TAB_GROUP_ID_NONE } : {}),
    });

    const sameDomainTabs = tabs.filter(t => t.id !== tab.id && getHost(t) === newTabHost);
    let targetIndex = sameDomainTabs.length > 0 ? Math.min(...sameDomainTabs.map(t => t.index)) : -1;

    try {
      await browser.tabs.move(tab.id, { index: targetIndex });
    } catch (err) { }
  } catch (err) { }
}

async function ensureUngroupedTabs(windowId, ungroupedTabIds) {
  const supportsTabGroups = typeof browser.tabGroups !== 'undefined';
  if (!supportsTabGroups) return;

  const allTabs = await browser.tabs.query({ windowId, pinned: false });
  for (const tab of allTabs) {
    if (ungroupedTabIds.has(tab.id) && tab.groupId !== browser.tabGroups.TAB_GROUP_ID_NONE) {
      try {
        await browser.tabs.move(tab.id, { index: -1 });
      } catch (err) { }
    }
  }
}

async function sortTabsInWindow(windowId) {
  try {
    await removeDuplicateTabs(windowId);
    const tabs = await browser.tabs.query({ windowId });
    const pinned = tabs.filter(t => t.pinned);
    const unpinned = tabs.filter(t => !t.pinned);

    const supportsTabGroups = typeof browser.tabGroups !== 'undefined';
    if (!supportsTabGroups) {
      return await sortUngroupedTabs(unpinned, pinned.length);
    }

    const groups = await browser.tabGroups.query({ windowId });
    const groupInfo = new Map();
    
    for (const group of groups) {
      const groupTabs = await browser.tabs.query({ windowId, groupId: group.id });
      groupInfo.set(group.id, {
        title: group.title,
        color: group.color,
        collapsed: group.collapsed,
        tabs: groupTabs
      });
    }

    const sortedGroups = [...groups].sort((a, b) => 
      (a.title || '').localeCompare((b.title || ''), undefined, { sensitivity: 'base' })
    );

    let currentPosition = pinned.length;

    for (const group of sortedGroups) {
      const info = groupInfo.get(group.id);
      if (!info || info.tabs.length === 0) continue;

      const sortedTabs = [...info.tabs].sort((a, b) => 
        (a.title || '').localeCompare((b.title || ''), undefined, { sensitivity: 'base' })
      );

      for (const tab of sortedTabs) {
        try {
          await browser.tabs.move(tab.id, { index: currentPosition });
          await browser.tabs.group({
            tabIds: tab.id,
            groupId: group.id
          });
          currentPosition++;
        } catch (err) { }
      }

      try {
        await browser.tabGroups.update(group.id, {
          collapsed: info.collapsed,
          color: info.color,
          title: info.title
        });
      } catch (err) { }
    }

    const ungroupedTabs = unpinned.filter(
      tab => tab.groupId === browser.tabGroups.TAB_GROUP_ID_NONE
    );

    if (ungroupedTabs.length > 0) {
      const sortedUngrouped = [...ungroupedTabs].sort((a, b) => {
        const hostA = getHost(a);
        const hostB = getHost(b);
        const hostCompare = hostA.localeCompare(hostB, undefined, { sensitivity: 'base' });
        return hostCompare !== 0 ? hostCompare : 
          (a.title || '').localeCompare((b.title || ''), undefined, { sensitivity: 'base' });
      });

      for (const tab of sortedUngrouped) {
        try {
          await browser.tabs.move(tab.id, { index: -1 });
          await browser.tabs.ungroup(tab.id);
        } catch (err) { }
      }
    }

    return { status: 'sorted' };
  } catch (err) {
    return { status: 'error', error: String(err) };
  }
}

async function sortUngroupedTabs(unpinnedTabs, pinnedCount) {
  function tabCompare(a, b) {
    const hostA = getHost(a);
    const hostB = getHost(b);
    const hostCompare = hostA.localeCompare(hostB, undefined, { sensitivity: 'base' });
    if (hostCompare !== 0) return hostCompare;
    return (a.title || '').localeCompare((b.title || ''), undefined, { sensitivity: 'base' });
  }

    const sortedUnpinned = [...unpinnedTabs].sort(tabCompare);
  const currentOrderIds = unpinnedTabs.map(t => t.id);
  const sortedOrderIds = sortedUnpinned.map(t => t.id);
  const alreadySorted = currentOrderIds.every((id, i) => id === sortedOrderIds[i]);

  if (alreadySorted) {
    return { status: 'already_sorted' };
  }

  let targetIndex = pinnedCount;
  for (const tab of sortedUnpinned) {
    try {
      await browser.tabs.move(tab.id, { index: targetIndex });
      targetIndex++;
    } catch (err) { }
  }
  return { status: 'sorted' };
}

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

browser.tabs.onCreated.addListener(async (tab) => {
  await autoSortNewTab(tab);
});

browser.commands.onCommand.addListener(async (command) => {
  if (command === 'sort-tabs') {
    try {
      const w = await browser.windows.getCurrent();
      await sortTabsInWindow(w.id);
    } catch (err) { }
  }
});
