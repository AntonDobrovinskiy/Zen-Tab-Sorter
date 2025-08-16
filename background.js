let groupState = {};

function getHost(tab) {
  try {
    return new URL(tab.url).hostname;
  } catch (e) {
    return tab.url || '';
  }
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
