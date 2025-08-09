async function sortTabsInWindow(windowId) {
  try {
    const tabs = await browser.tabs.query({ windowId });
    const pinned = tabs.filter(t => t.pinned);
    const unpinned = tabs.filter(t => !t.pinned);

    // 1. Идентифицируем и закрываем дубликаты
    const seenUrls = new Set();
    const tabsToKeep = [];
    const tabsToCloseIds = [];

    for (const tab of unpinned) {
      if (tab.url && seenUrls.has(tab.url)) {
        tabsToCloseIds.push(tab.id);
      } else {
        seenUrls.add(tab.url);
        tabsToKeep.push(tab);
      }
    }

    if (tabsToCloseIds.length > 0) {
      console.log(`Closing ${tabsToCloseIds.length} duplicate tabs.`);
      await browser.tabs.remove(tabsToCloseIds);
    }
    
    // 2. Сортируем оставшиеся уникальные вкладки
    function getHost(tab) {
      try {
        return new URL(tab.url).hostname;
      } catch (e) {
        return tab.url || '';
      }
    }

    function tabCompare(a, b) {
      const hostA = getHost(a);
      const hostB = getHost(b);

      const hostCompare = hostA.localeCompare(hostB, undefined, { sensitivity: 'base' });
      if (hostCompare !== 0) return hostCompare;

      return (a.title || '').localeCompare((b.title || ''), undefined, { sensitivity: 'base' });
    }

    const sortedUnpinned = [...tabsToKeep].sort(tabCompare);
    const currentOrderIds = tabsToKeep.map(t => t.id);
    const sortedOrderIds = sortedUnpinned.map(t => t.id);
    const alreadySorted = currentOrderIds.length === sortedOrderIds.length && currentOrderIds.every((id, i) => id === sortedOrderIds[i]);

    if (alreadySorted) {
      console.log('Tabs already sorted — no action taken.');
      return { status: 'already_sorted' };
    }

    // 3. Перемещаем вкладки в отсортированном порядке
    let targetIndex = pinned.length;
    for (const tab of sortedUnpinned) {
      try {
        await browser.tabs.move(tab.id, { index: targetIndex });
        targetIndex++;
      } catch (err) {
        console.error('Failed moving tab', tab.id, err);
      }
    }

    console.log('Tabs sorted.');
    return { status: 'sorted' };
  } catch (err) {
    console.error('Error while sorting tabs:', err);
    return { status: 'error', error: String(err) };
  }
}

browser.commands.onCommand.addListener(async (command) => {
  if (command === 'sort-tabs') {
    try {
      const w = await browser.windows.getCurrent();
      const result = await sortTabsInWindow(w.id);
      console.log('sort-tabs result:', result);
    } catch (err) {
      console.error('Command handler error:', err);
    }
  }
});