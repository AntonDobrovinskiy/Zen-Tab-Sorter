// Функция для получения хоста из URL вкладки.
// Возвращает hostname или пустую строку при ошибке.
function getHost(tab) {
  try {
    return new URL(tab.url).hostname;
  } catch (e) {
    return tab.url || '';
  }
}

// Функция для автоматической сортировки новой вкладки по домену.
// Новая вкладка перемещается к незакрепленным вкладкам того же домена,
// избегая попадания в группы. Если подходящих вкладок нет, помещается в конец.
async function autoSortNewTab(tab) {
  try {
    // Игнорируем вкладки без URL или закрепленные.
    if (!tab.url || tab.pinned) {
      console.log(`Вкладка ${tab.id} пропущена (нет URL или закреплена).`);
      return;
    }

    const windowId = tab.windowId;
    const newTabHost = getHost(tab);

    // Проверяем поддержку групп вкладок.
    const supportsTabGroups = typeof browser.tabGroups !== 'undefined';

    // Получаем все незакрепленные вкладки, не входящие в группы.
    const tabs = await browser.tabs.query({
      windowId,
      pinned: false,
      ...(supportsTabGroups ? { groupId: browser.tabGroups.TAB_GROUP_ID_NONE } : {}),
    });

    // Ищем незакрепленные вкладки с тем же доменом, исключая новую вкладку.
    const sameDomainTabs = tabs.filter(t => t.id !== tab.id && getHost(t) === newTabHost);

    let targetIndex;
    if (sameDomainTabs.length > 0) {
      // Находим минимальный индекс среди незакрепленных вкладок с тем же доменом.
      targetIndex = Math.min(...sameDomainTabs.map(t => t.index));
    } else {
      // Если нет вкладок с тем же доменом, перемещаем в конец окна.
      console.log(`Для вкладки ${tab.id} (${newTabHost}) нет незакрепленных вкладок с таким доменом — перемещаем в конец.`);
      targetIndex = -1;
    }

    // Перемещаем вкладку.
    try {
      await browser.tabs.move(tab.id, { index: targetIndex });
      console.log(`Вкладка ${tab.id} (${newTabHost}) перемещена на индекс ${targetIndex} (без группы).`);
    } catch (err) {
      console.error(`Ошибка перемещения вкладки ${tab.id}:`, err);
    }
  } catch (err) {
    console.error(`Ошибка при автоматической сортировке вкладки ${tab.id}:`, err);
  }
}

// Функция для полной сортировки вкладок и групп по команде Alt+S.
// Сортирует:
// 1. Вкладки внутри групп по алфавиту заголовков.
// 2. Группы по алфавиту названий.
// 3. Незакрепленные вкладки без группы сортируются по домену, затем по заголовку, и перемещаются в конец окна по порядку.
async function sortTabsInWindow(windowId) {
  try {
    // Получаем все вкладки в окне.
    const tabs = await browser.tabs.query({ windowId });
    const pinned = tabs.filter(t => t.pinned);
    const unpinned = tabs.filter(t => !t.pinned);

    // 1. Закрываем дубликаты URL среди незакрепленных вкладок.
    const seenUrls = new Set();
    const tabsToKeep = [];
    const tabsToCloseIds = [];

    for (const tab of unpinned) {
      if (tab.url && seenUrls.has(tab.url)) {
        tabsToCloseIds.push(tab.id);
      } else if (tab.url) {
        seenUrls.add(tab.url);
        tabsToKeep.push(tab);
      } else {
        tabsToKeep.push(tab);
      }
    }

    if (tabsToCloseIds.length > 0) {
      console.log(`Закрываем ${tabsToCloseIds.length} дубликатов вкладок.`);
      await browser.tabs.remove(tabsToCloseIds);
    }

    // Проверяем поддержку групп вкладок.
    const supportsTabGroups = typeof browser.tabGroups !== 'undefined';

    if (!supportsTabGroups) {
      console.log('API tabGroups не поддерживается, сортируем только вкладки.');
      return await sortUngroupedTabs(tabs.filter(t => !t.pinned), pinned.length);
    }

    // 2. Получаем все группы вкладок.
    const groups = await browser.tabGroups.query({ windowId });

    if (groups.length === 0) {
      console.log('Группы отсутствуют, сортируем вкладки.');
      return await sortUngroupedTabs(await browser.tabs.query({ windowId, pinned: false }), pinned.length);
    }

    // 3. Сортируем вкладки внутри каждой группы по алфавиту заголовков.
    for (const group of groups) {
      const groupTabs = await browser.tabs.query({ groupId: group.id });
      if (groupTabs.length === 0) {
        console.log(`Группа ${group.id} (${group.title}) пуста — пропускаем.`);
        continue;
      }

      // Компаратор для вкладок: только по заголовку (алфавиту).
      function tabCompare(a, b) {
        return (a.title || '').localeCompare((b.title || ''), undefined, { sensitivity: 'base' });
      }

      const sortedGroupTabs = [...groupTabs].sort(tabCompare);
      const currentOrderIds = groupTabs.map(t => t.id);
      const sortedOrderIds = sortedGroupTabs.map(t => t.id);
      const alreadySorted = currentOrderIds.every((id, i) => id === sortedOrderIds[i]);

      if (alreadySorted) {
        console.log(`Вкладки в группе ${group.id} (${group.title}) уже отсортированы.`);
        continue;
      }

      let targetIndex = Math.min(...groupTabs.map(t => t.index));
      for (const tab of sortedGroupTabs) {
        try {
          await browser.tabs.move(tab.id, { index: targetIndex });
          console.log(`Вкладка ${tab.id} (${tab.url}) в группе ${group.id} перемещена на индекс ${targetIndex}.`);
          targetIndex++;
        } catch (err) {
          console.error(`Ошибка перемещения вкладки ${tab.id} в группе ${group.id}:`, err);
        }
      }
      console.log(`Вкладки в группе ${group.id} (${group.title}) отсортированы по алфавиту.`);
    }

    // 4. Собираем группы с количеством вкладок.
    const groupWithTabCount = [];
    for (const group of groups) {
      const groupTabs = await browser.tabs.query({ groupId: group.id });
      if (groupTabs.length === 0) {
        console.log(`Группа ${group.id} (${group.title}) пуста после сортировки — пропускаем.`);
        continue;
      }
      groupWithTabCount.push({ ...group, tabCount: groupTabs.length });
    }

    // Компаратор для групп: по названию (алфавиту).
    function groupCompare(a, b) {
      return (a.title || '').localeCompare((b.title || ''), undefined, { sensitivity: 'base' });
    }

    const sortedGroups = [...groupWithTabCount].sort(groupCompare);

    // 5. Перемещаем группы после закрепленных вкладок.
    let targetIndex = pinned.length;
    for (const group of sortedGroups) {
      try {
        await browser.tabGroups.move(group.id, { index: targetIndex });
        console.log(`Группа ${group.id} (${group.title}) перемещена на индекс ${targetIndex}.`);
        targetIndex += group.tabCount;
      } catch (err) {
        console.error(`Ошибка перемещения группы ${group.id}:`, err);
      }
    }
    console.log('Группы отсортированы по алфавиту названий и перемещены.');

    // 6. Сортируем незакрепленные вкладки без группы по домену, затем по заголовку, и перемещаем в конец по порядку.
    const ungroupedTabs = await browser.tabs.query({ windowId, groupId: browser.tabGroups.TAB_GROUP_ID_NONE, pinned: false });
    if (ungroupedTabs.length > 0) {
      const sortedUngrouped = [...ungroupedTabs].sort((a, b) => {
        const hostA = getHost(a);
        const hostB = getHost(b);
        const hostCompare = hostA.localeCompare(hostB, undefined, { sensitivity: 'base' });
        if (hostCompare !== 0) return hostCompare;
        return (a.title || '').localeCompare((b.title || ''), undefined, { sensitivity: 'base' });
      });

      // Перемещаем отсортированные вкладки в конец окна по порядку.
      for (const tab of sortedUngrouped) {
        try {
          await browser.tabs.move(tab.id, { index: -1 });
          console.log(`Вкладка ${tab.id} (${tab.url}) отсортирована и перемещена в конец (без группы).`);
        } catch (err) {
          console.error(`Ошибка перемещения незакрепленной вкладки ${tab.id}:`, err);
        }
      }
      console.log('Незакрепленные вкладки без группы отсортированы по домену и заголовку и перемещены в конец.');
    }

    return { status: 'sorted' };
  } catch (err) {
    console.error('Ошибка при сортировке вкладок и групп:', err);
    return { status: 'error', error: String(err) };
  }
}

// Вспомогательная функция для сортировки вкладок, если группы не поддерживаются.
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
    console.log('Вкладки уже отсортированы — ничего не делаем.');
    return { status: 'already_sorted' };
  }

  let targetIndex = pinnedCount;
  for (const tab of sortedUnpinned) {
    try {
      await browser.tabs.move(tab.id, { index: targetIndex });
      targetIndex++;
    } catch (err) {
      console.error(`Ошибка перемещения вкладки ${tab.id}:`, err);
    }
  }
  console.log('Вкладки отсортированы.');
  return { status: 'sorted' };
}

// Слушатель для новых вкладок (автоматическая сортировка).
browser.tabs.onCreated.addListener(async (tab) => {
  await autoSortNewTab(tab);
});

// Слушатель команды Alt+S для полной сортировки.
browser.commands.onCommand.addListener(async (command) => {
  if (command === 'sort-tabs') {
    try {
      const w = await browser.windows.getCurrent();
      const result = await sortTabsInWindow(w.id);
      console.log('Результат сортировки:', result);
    } catch (err) {
      console.error('Ошибка обработки команды:', err);
    }
  }
});
