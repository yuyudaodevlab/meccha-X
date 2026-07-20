(() => {
  "use strict";

  if (window.__xPostHistoryLoaded) return;
  window.__xPostHistoryLoaded = true;

  const KEY = "xPostHistoryItems";
  const SETTINGS_KEY = "xPostHistorySettings";
  const MAX_ITEMS = 3000;
  const HISTORY_PATH = "/i/post_history";
  const visibleSince = new Map();
  const observed = new WeakSet();
  let isHistoryOpen = false;
  let previousUrl = location.href;
  let settings = { tracking: true };
  let writeQueue = Promise.resolve();

  const icon = (name, size = 24) => {
    const paths = {
      history: '<path d="M13.5 3a9 9 0 1 0 8.65 11.5h-2.1A7 7 0 1 1 18.6 7.4L16 10h7V3l-2.95 2.95A8.96 8.96 0 0 0 13.5 3Zm-1 5v6l5 3 .9-1.55-3.9-2.35V8h-2Z"/>',
      search: '<path d="m21.53 20.47-4.7-4.7a7.5 7.5 0 1 0-1.06 1.06l4.7 4.7 1.06-1.06ZM5.5 11.25a5.75 5.75 0 1 1 11.5 0 5.75 5.75 0 0 1-11.5 0Z"/>',
      calendar: '<path d="M7 2h2v2h6V2h2v2h2.5A2.5 2.5 0 0 1 22 6.5v13a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 2 19.5v-13A2.5 2.5 0 0 1 4.5 4H7V2Zm13 8H4v9.5c0 .28.22.5.5.5h15a.5.5 0 0 0 .5-.5V10ZM4.5 6a.5.5 0 0 0-.5.5V8h16V6.5a.5.5 0 0 0-.5-.5h-15Z"/>',
      trash: '<path d="M9 3h6l1 2h5v2H3V5h5l1-2Zm-3 6h12l-1 12H7L6 9Zm3 2 .5 8h2L11 11H9Zm4 0-.5 8h2l.5-8h-2Z"/>',
      star: '<path d="m12 2.7 2.86 5.8 6.4.93-4.63 4.51 1.1 6.38L12 17.31l-5.73 3.01 1.1-6.38-4.63-4.51 6.4-.93L12 2.7Z"/>',
      close: '<path d="m6.4 5 12.6 12.6-1.4 1.4L5 6.4 6.4 5Zm11.2 0L5 17.6 6.4 19 19 6.4 17.6 5Z"/>',
      more: '<circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>',
      external: '<path d="M14 3h7v7h-2V6.4l-8.3 8.3-1.4-1.4L17.6 5H14V3ZM5 5h6v2H5v12h12v-6h2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/>',
      pause: '<path d="M6 4h4v16H6V4Zm8 0h4v16h-4V4Z"/>',
      play: '<path d="m7 4 13 8-13 8V4Z"/>',
      download: '<path d="M11 3h2v10.2l3.6-3.6L18 11l-6 6-6-6 1.4-1.4 3.6 3.6V3ZM4 19h16v2H4v-2Z"/>'
    };
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">${paths[name]}</svg>`;
  };

  const storageGet = (keys) => new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  const storageSet = (value) => new Promise((resolve) => chrome.storage.local.set(value, resolve));

  async function loadSettings() {
    const data = await storageGet(SETTINGS_KEY);
    settings = { tracking: true, ...(data[SETTINGS_KEY] || {}) };
  }

  function parsePost(article) {
    const statusLinks = [...article.querySelectorAll('a[href*="/status/"]')];
    const statusLink = statusLinks.find((a) => /\/status\/\d+/.test(a.getAttribute("href") || ""));
    if (!statusLink) return null;
    const match = statusLink.getAttribute("href").match(/^\/([^/]+)\/status\/(\d+)/);
    if (!match) return null;

    const [, handle, id] = match;
    const textNode = article.querySelector('[data-testid="tweetText"]');
    const userNode = article.querySelector('[data-testid="User-Name"]');
    const name = userNode?.querySelector("span")?.textContent?.trim() || handle;
    const image = [...article.querySelectorAll('img[src]')].find((img) =>
      /pbs\.twimg\.com\/media/.test(img.src)
    );
    const videoPoster = article.querySelector("video[poster]");
    const time = article.querySelector("time")?.getAttribute("datetime") || null;

    return {
      id,
      url: `${location.origin}/${handle}/status/${id}`,
      handle: `@${handle}`,
      author: name,
      text: textNode?.innerText?.trim() || "（本文のないポスト）",
      postedAt: time,
      thumbnail: image?.src || videoPoster?.poster || null
    };
  }

  function recordPost(article) {
    if (!settings.tracking || isHistoryOpen || !document.contains(article)) return;
    const post = parsePost(article);
    if (!post) return;

    // Several posts may finish their dwell timer together. Serializing writes keeps
    // one storage update from accidentally overwriting another.
    writeQueue = writeQueue.then(async () => {
      const data = await storageGet(KEY);
      const items = Array.isArray(data[KEY]) ? data[KEY] : [];
      const now = new Date().toISOString();
      const index = items.findIndex((item) => item.id === post.id);
      if (index >= 0) {
        const old = items.splice(index, 1)[0];
        items.unshift({ ...old, ...post, firstViewedAt: old.firstViewedAt || now, lastViewedAt: now, viewCount: (old.viewCount || 1) + 1, visibleMs: old.visibleMs || 0 });
      } else {
        items.unshift({ ...post, firstViewedAt: now, lastViewedAt: now, viewCount: 1, favorite: false, visibleMs: 0 });
      }
      await storageSet({ [KEY]: items.slice(0, MAX_ITEMS) });
    }).catch((error) => console.warn("[X Post History] 履歴の保存に失敗しました", error));
  }

  function addVisibleTime(article, elapsedMs) {
    const post = parsePost(article);
    if (!post || elapsedMs <= 0) return;
    writeQueue = writeQueue.then(async () => {
      const data = await storageGet(KEY);
      const items = Array.isArray(data[KEY]) ? data[KEY] : [];
      const item = items.find((entry) => entry.id === post.id);
      if (!item) return;
      item.visibleMs = (item.visibleMs || 0) + Math.round(elapsedMs);
      await storageSet({ [KEY]: items });
    }).catch((error) => console.warn("[X Post History] 表示時間の保存に失敗しました", error));
  }

  function stopVisibleTimer(article) {
    const startedAt = visibleSince.get(article);
    if (startedAt === undefined) return;
    visibleSince.delete(article);
    addVisibleTime(article, performance.now() - startedAt);
  }

  function flushVisibleTimers() {
    const now = performance.now();
    for (const [article, startedAt] of visibleSince) {
      addVisibleTime(article, now - startedAt);
      visibleSince.set(article, now);
    }
  }

  function startTimersForVisiblePosts() {
    if (!settings.tracking || document.hidden) return;
    const now = performance.now();
    document.querySelectorAll('article[data-testid="tweet"]').forEach((article) => {
      const rect = article.getBoundingClientRect();
      if (rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth) {
        if (!visibleSince.has(article)) visibleSince.set(article, now);
      }
    });
  }

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (settings.tracking && !document.hidden && entry.isIntersecting && entry.intersectionRatio > 0) {
        if (!visibleSince.has(entry.target)) visibleSince.set(entry.target, performance.now());
      } else {
        stopVisibleTimer(entry.target);
      }
    }
  }, { threshold: [0, 0.01] });

  function observePosts() {
    document.querySelectorAll('article[data-testid="tweet"]').forEach((article) => {
      if (!observed.has(article)) {
        observed.add(article);
        // Record every post X renders, even when the user scrolls past instantly.
        recordPost(article);
        observer.observe(article);
      }
    });
  }

  function createNavItem() {
    if (document.getElementById("xph-nav")) return;
    const nav = document.querySelector('header nav[role="navigation"], nav[aria-label="Primary"], nav[aria-label="メインメニュー"]');
    if (!nav) return;
    const item = document.createElement("a");
    item.id = "xph-nav";
    item.href = HISTORY_PATH;
    item.setAttribute("role", "link");
    item.innerHTML = `<div class="xph-nav-inner">${icon("history", 26)}<span>ポストの履歴</span></div>`;
    item.addEventListener("click", (event) => {
      event.preventDefault();
      openHistory(true);
    });
    nav.appendChild(item);
  }

  function formatDate(value) {
    if (!value) return "";
    const date = new Date(value);
    const now = new Date();
    if (date.toDateString() === now.toDateString()) return `今日 ${date.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}`;
    const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return `昨日 ${date.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}`;
    return date.toLocaleString("ja-JP", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function dayKey(value) {
    return new Date(value).toLocaleDateString("sv-SE");
  }

  function escapeHtml(value = "") {
    return value.replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
  }

  function historyShell() {
    const root = document.createElement("section");
    root.id = "xph-root";
    root.innerHTML = `
      <header class="xph-header">
        <button class="xph-icon-button" id="xph-back" aria-label="戻る">${icon("close", 20)}</button>
        <div><h1>ポストの履歴</h1><p id="xph-count">読み込み中...</p></div>
        <button class="xph-icon-button" id="xph-menu" aria-label="その他">${icon("more", 22)}</button>
      </header>
      <div class="xph-toolbar">
        <label class="xph-search">${icon("search", 19)}<input id="xph-query" type="search" placeholder="履歴を検索" autocomplete="off"></label>
        <button class="xph-filter-button" id="xph-date-toggle">${icon("calendar", 18)}<span>絞り込み</span></button>
      </div>
      <div class="xph-date-panel" id="xph-date-panel" hidden>
        <label>開始日<input type="date" id="xph-from"></label>
        <label>終了日<input type="date" id="xph-to"></label>
        <label>最小表示秒数<input type="number" id="xph-min-seconds" min="0" step="0.1" placeholder="0"></label>
        <label>最大表示秒数<input type="number" id="xph-max-seconds" min="0" step="0.1" placeholder="指定なし"></label>
        <button id="xph-date-clear">クリア</button>
      </div>
      <div class="xph-chips">
        <button class="active" data-filter="all">すべて</button>
        <button data-filter="today">今日</button>
        <button data-filter="yesterday">昨日</button>
        <button data-filter="long">10秒以上</button>
        <button data-filter="favorite">お気に入り</button>
      </div>
      <div class="xph-menu-panel" id="xph-menu-panel" hidden>
        <button id="xph-tracking">${icon(settings.tracking ? "pause" : "play", 19)}<span>${settings.tracking ? "履歴の記録を一時停止" : "履歴の記録を再開"}</span></button>
        <button id="xph-export">${icon("download", 19)}<span>履歴をJSONで書き出す</span></button>
        <button id="xph-clear-all" class="danger">${icon("trash", 19)}<span>すべての履歴を削除</span></button>
      </div>
      <div id="xph-list" class="xph-list"></div>
      <div id="xph-toast" class="xph-toast" role="status"></div>`;
    return root;
  }

  async function openHistory(pushState = false) {
    if (isHistoryOpen) return;
    const primary = document.querySelector('[data-testid="primaryColumn"]');
    if (!primary) return;
    flushVisibleTimers();
    isHistoryOpen = true;
    previousUrl = location.href;
    if (pushState) history.pushState({ xph: true }, "", HISTORY_PATH);
    [...primary.children].forEach((child) => child.classList.add("xph-native-hidden"));
    const root = historyShell();
    const bodyColor = getComputedStyle(document.body).backgroundColor.match(/\d+/g)?.map(Number) || [0, 0, 0];
    const luminance = bodyColor[0] * .299 + bodyColor[1] * .587 + bodyColor[2] * .114;
    root.dataset.theme = luminance > 150 ? "light" : "dark";
    primary.prepend(root);
    document.getElementById("xph-nav")?.classList.add("xph-selected");
    bindHistoryEvents(root);
    await writeQueue;
    await renderHistory();
  }

  function closeHistory(goBack = false) {
    const root = document.getElementById("xph-root");
    if (!root) return;
    const primary = root.parentElement;
    root.remove();
    [...primary.children].forEach((child) => child.classList.remove("xph-native-hidden"));
    document.getElementById("xph-nav")?.classList.remove("xph-selected");
    isHistoryOpen = false;
    if (goBack) history.back();
  }

  function toast(message) {
    const el = document.getElementById("xph-toast");
    if (!el) return;
    el.textContent = message;
    el.classList.add("show");
    setTimeout(() => el.classList.remove("show"), 2200);
  }

  function bindHistoryEvents(root) {
    let filter = "all";
    const rerender = () => renderHistory(filter);
    root.querySelector("#xph-back").onclick = () => closeHistory(true);
    root.querySelector("#xph-query").oninput = rerender;
    root.querySelector("#xph-from").onchange = rerender;
    root.querySelector("#xph-to").onchange = rerender;
    root.querySelector("#xph-min-seconds").oninput = rerender;
    root.querySelector("#xph-max-seconds").oninput = rerender;
    root.querySelector("#xph-date-toggle").onclick = () => {
      const panel = root.querySelector("#xph-date-panel");
      panel.hidden = !panel.hidden;
    };
    root.querySelector("#xph-date-clear").onclick = () => {
      root.querySelector("#xph-from").value = "";
      root.querySelector("#xph-to").value = "";
      root.querySelector("#xph-min-seconds").value = "";
      root.querySelector("#xph-max-seconds").value = "";
      rerender();
    };
    root.querySelectorAll(".xph-chips button").forEach((button) => button.onclick = () => {
      root.querySelectorAll(".xph-chips button").forEach((b) => b.classList.remove("active"));
      button.classList.add("active");
      filter = button.dataset.filter;
      rerender();
    });
    root.querySelector("#xph-menu").onclick = () => {
      const menu = root.querySelector("#xph-menu-panel");
      menu.hidden = !menu.hidden;
    };
    root.querySelector("#xph-tracking").onclick = async () => {
      if (settings.tracking) {
        flushVisibleTimers();
        visibleSince.clear();
      }
      settings.tracking = !settings.tracking;
      await storageSet({ [SETTINGS_KEY]: settings });
      if (settings.tracking) startTimersForVisiblePosts();
      const button = root.querySelector("#xph-tracking");
      button.innerHTML = `${icon(settings.tracking ? "pause" : "play", 19)}<span>${settings.tracking ? "履歴の記録を一時停止" : "履歴の記録を再開"}</span>`;
      toast(settings.tracking ? "履歴の記録を再開しました" : "履歴の記録を一時停止しました");
    };
    root.querySelector("#xph-export").onclick = exportHistory;
    root.querySelector("#xph-clear-all").onclick = async () => {
      if (!confirm("すべての閲覧履歴を削除しますか？ この操作は元に戻せません。")) return;
      await storageSet({ [KEY]: [] });
      root.querySelector("#xph-menu-panel").hidden = true;
      await rerender();
      toast("すべての履歴を削除しました");
    };
    root.querySelector("#xph-list").addEventListener("click", handleListClick);
  }

  async function renderHistory(filter = document.querySelector(".xph-chips .active")?.dataset.filter || "all") {
    const root = document.getElementById("xph-root");
    if (!root) return;
    const data = await storageGet(KEY);
    const allItems = Array.isArray(data[KEY]) ? data[KEY] : [];
    const query = root.querySelector("#xph-query").value.trim().toLocaleLowerCase("ja");
    const from = root.querySelector("#xph-from").value;
    const to = root.querySelector("#xph-to").value;
    const minSecondsValue = root.querySelector("#xph-min-seconds").value;
    const maxSecondsValue = root.querySelector("#xph-max-seconds").value;
    const minSeconds = minSecondsValue === "" ? null : Number(minSecondsValue);
    const maxSeconds = maxSecondsValue === "" ? null : Number(maxSecondsValue);
    const today = dayKey(new Date());
    const yesterdayDate = new Date(); yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterday = dayKey(yesterdayDate);

    const items = allItems.filter((item) => {
      const viewedDay = dayKey(item.lastViewedAt);
      const haystack = `${item.author} ${item.handle} ${item.text}`.toLocaleLowerCase("ja");
      if (query && !haystack.includes(query)) return false;
      if (from && viewedDay < from) return false;
      if (to && viewedDay > to) return false;
      const visibleSeconds = (item.visibleMs || 0) / 1000;
      if (minSeconds !== null && visibleSeconds < minSeconds) return false;
      if (maxSeconds !== null && visibleSeconds > maxSeconds) return false;
      if (filter === "today" && viewedDay !== today) return false;
      if (filter === "yesterday" && viewedDay !== yesterday) return false;
      if (filter === "long" && visibleSeconds < 10) return false;
      if (filter === "favorite" && !item.favorite) return false;
      return true;
    });

    root.querySelector("#xph-count").textContent = `${items.length.toLocaleString()}件${items.length !== allItems.length ? ` / 全${allItems.length.toLocaleString()}件` : ""}`;
    const list = root.querySelector("#xph-list");
    if (!items.length) {
      list.innerHTML = `<div class="xph-empty">${icon("history", 46)}<h2>履歴が見つかりません</h2><p>${allItems.length ? "検索条件を変えてみてください。" : "Xのタイムラインでポストを閲覧すると、ここに自動で保存されます。"}</p></div>`;
      return;
    }

    let lastGroup = "";
    list.innerHTML = items.map((item) => {
      const group = dayKey(item.lastViewedAt) === today ? "今日" : dayKey(item.lastViewedAt) === yesterday ? "昨日" : new Date(item.lastViewedAt).toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric" });
      const heading = group !== lastGroup ? `<div class="xph-day-heading">${escapeHtml(group)}</div>` : "";
      lastGroup = group;
      return `${heading}<article class="xph-card" data-id="${item.id}">
        <div class="xph-card-main">
          <div class="xph-card-meta"><strong>${escapeHtml(item.author)}</strong><span>${escapeHtml(item.handle)}</span><span>·</span><time>${escapeHtml(formatDate(item.lastViewedAt))}</time></div>
          <p>${escapeHtml(item.text)}</p>
          ${item.thumbnail ? `<img class="xph-thumbnail" src="${escapeHtml(item.thumbnail)}" alt="ポストの画像" loading="lazy">` : ""}
          <div class="xph-card-footer"><span class="xph-duration">表示 ${formatDuration(item.visibleMs || 0)}</span><span>${item.viewCount > 1 ? `${item.viewCount}回表示` : "1回表示"}</span><span>最初: ${escapeHtml(formatDate(item.firstViewedAt))}</span></div>
        </div>
        <div class="xph-card-actions">
          <button data-action="favorite" aria-label="お気に入り" class="${item.favorite ? "is-favorite" : ""}">${icon("star", 19)}</button>
          <a href="${escapeHtml(item.url)}" data-action="open" aria-label="ポストを開く">${icon("external", 19)}</a>
          <button data-action="delete" aria-label="履歴から削除">${icon("trash", 19)}</button>
        </div>
      </article>`;
    }).join("");
  }

  async function handleListClick(event) {
    const action = event.target.closest("[data-action]");
    if (!action) return;
    const card = action.closest(".xph-card");
    const id = card?.dataset.id;
    if (!id) return;
    if (action.dataset.action === "open") {
      closeHistory(false);
      return;
    }
    const data = await storageGet(KEY);
    let items = Array.isArray(data[KEY]) ? data[KEY] : [];
    if (action.dataset.action === "delete") {
      items = items.filter((item) => item.id !== id);
      await storageSet({ [KEY]: items });
      card.remove();
      await renderHistory();
      toast("履歴から削除しました");
    } else if (action.dataset.action === "favorite") {
      const item = items.find((entry) => entry.id === id);
      if (!item) return;
      item.favorite = !item.favorite;
      await storageSet({ [KEY]: items });
      action.classList.toggle("is-favorite", item.favorite);
      toast(item.favorite ? "お気に入りに追加しました" : "お気に入りを解除しました");
    }
  }

  async function exportHistory() {
    const data = await storageGet(KEY);
    const blob = new Blob([JSON.stringify(data[KEY] || [], null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `x-post-history-${dayKey(new Date())}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast("履歴を書き出しました");
  }

  function formatDuration(milliseconds) {
    const seconds = milliseconds / 1000;
    if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}秒`;
    const minutes = Math.floor(seconds / 60);
    const remaining = Math.round(seconds % 60);
    return `${minutes}分${remaining ? `${remaining}秒` : ""}`;
  }

  const domObserver = new MutationObserver(() => {
    createNavItem();
    observePosts();
    if (location.pathname === HISTORY_PATH && !isHistoryOpen) openHistory(false);
    else if (location.pathname !== HISTORY_PATH && isHistoryOpen) closeHistory(false);
  });

  window.addEventListener("popstate", () => {
    if (location.pathname === HISTORY_PATH) openHistory(false);
    else if (isHistoryOpen) closeHistory(false);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      flushVisibleTimers();
      visibleSince.clear();
    } else startTimersForVisiblePosts();
  });
  window.addEventListener("pagehide", flushVisibleTimers);

  setInterval(() => {
    if (!document.hidden && settings.tracking) flushVisibleTimers();
  }, 5000);

  loadSettings().then(() => {
    createNavItem();
    observePosts();
    domObserver.observe(document.body, { childList: true, subtree: true });
    if (location.pathname === HISTORY_PATH) openHistory(false);
  });
})();
