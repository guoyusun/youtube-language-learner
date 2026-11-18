/**
 * LinguaTube - Frontend Interactive Subtitle & Single-Sentence Loop Controller
 */

const state = {
  videoId: "_hgYfOs9rbs",
  isShorts: true,
  title: "",
  author: "",
  selectedLanguage: "",
  translateLanguage: "zh-Hans",
  segMode: "sentence",
  availableTracks: [],
  segments: [],
  activeIndex: -1,

  // Single-sentence loop & shadowing state
  isLooping: false,
  loopTargetIndex: -1,
  maxLoopCount: 0, // 0 = infinite, >0 = N times then advance
  currentLoopIteration: 1,
  shadowPauseSetting: "0", // "0", "1.5", "3", "auto"
  isInShadowPause: false,
  shadowPauseTimer: null,

  // UI toggles
  autoScroll: true,
  showOriginal: true,
  showTranslation: true,
  searchQuery: "",

  // Saved vocabulary & sentences (persisted in localStorage)
  savedWords: JSON.parse(localStorage.getItem("linguatube_words") || "[]"),
  savedSentences: JSON.parse(localStorage.getItem("linguatube_sentences") || "[]"),
};

let ytPlayer = null;
let isPlayerReady = false;
let syncTimer = null;

// DOM Elements
const els = {
  urlForm: document.getElementById("url-form"),
  urlInput: document.getElementById("youtube-url-input"),
  clearUrlBtn: document.getElementById("clear-url-btn"),
  loadBtn: document.getElementById("load-btn"),
  aspectToggleBtn: document.getElementById("aspect-toggle-btn"),
  vocabDrawerBtn: document.getElementById("vocab-drawer-btn"),
  savedCount: document.getElementById("saved-count"),
  statusBanner: document.getElementById("status-banner"),
  workspace: document.getElementById("workspace"),
  playerContainer: document.getElementById("player-container"),
  videoTypeBadge: document.getElementById("video-type-badge"),
  videoTitle: document.getElementById("video-title"),
  videoAuthor: document.getElementById("video-author"),

  activeIndexBadge: document.getElementById("active-index-badge"),
  activeTimeBadge: document.getElementById("active-time-badge"),
  loopStatusPill: document.getElementById("loop-status-pill"),
  spotToggleOrigBtn: document.getElementById("spot-toggle-orig-btn"),
  spotToggleTransBtn: document.getElementById("spot-toggle-trans-btn"),
  saveCurrentSentenceBtn: document.getElementById("save-current-sentence-btn"),
  activePrimaryText: document.getElementById("active-primary-text"),
  activeTranslatedText: document.getElementById("active-translated-text"),

  prevSubBtn: document.getElementById("prev-sub-btn"),
  replaySubBtn: document.getElementById("replay-sub-btn"),
  playPauseBtn: document.getElementById("play-pause-btn"),
  nextSubBtn: document.getElementById("next-sub-btn"),
  loopToggleBtn: document.getElementById("loop-toggle-btn"),
  loopCountSelect: document.getElementById("loop-count-select"),
  shadowPauseSelect: document.getElementById("shadow-pause-select"),
  speedSelect: document.getElementById("speed-select"),

  trackSelect: document.getElementById("track-select"),
  translateSelect: document.getElementById("translate-select"),
  segModeSelect: document.getElementById("seg-mode-select"),
  toggleOrigBtn: document.getElementById("toggle-orig-btn"),
  toggleTransBtn: document.getElementById("toggle-trans-btn"),
  autoscrollCheckbox: document.getElementById("autoscroll-checkbox"),
  exportMenuBtn: document.getElementById("export-menu-btn"),
  exportDropdown: document.getElementById("export-dropdown"),
  searchInput: document.getElementById("subtitle-search-input"),
  subtitleStats: document.getElementById("subtitle-stats"),
  subtitleList: document.getElementById("subtitle-list"),

  wordPopover: document.getElementById("word-popover"),
  popoverWord: document.getElementById("popover-word"),
  popoverContext: document.getElementById("popover-context"),
  speakWordBtn: document.getElementById("speak-word-btn"),
  saveWordBtn: document.getElementById("save-word-btn"),
  closePopoverBtn: document.getElementById("close-popover-btn"),
  dictYoudao: document.getElementById("dict-youdao"),
  dictCambridge: document.getElementById("dict-cambridge"),
  dictGoogle: document.getElementById("dict-google"),

  vocabDrawer: document.getElementById("vocab-drawer"),
  closeDrawerBtn: document.getElementById("close-drawer-btn"),
  exportNotesBtn: document.getElementById("export-notes-btn"),
  savedWordsList: document.getElementById("saved-words-list"),
  savedSentencesList: document.getElementById("saved-sentences-list"),
};

// Format seconds to MM:SS.d
function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "00:00.0";
  const mins = Math.floor(sec / 60);
  const secs = Math.floor(sec % 60);
  const tenths = Math.floor((sec % 1) * 10);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${tenths}`;
}

// Format seconds to SRT timestamp (HH:MM:SS,mmm)
function formatSrtTime(sec) {
  const hrs = Math.floor(sec / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const secs = Math.floor(sec % 60);
  const ms = Math.round((sec % 1) * 1000);
  return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function showBanner(msg, isError = false, autoHideMs = 4000) {
  els.statusBanner.textContent = msg;
  els.statusBanner.classList.remove("hidden", "error");
  if (isError) {
    els.statusBanner.classList.add("error");
  }
  if (autoHideMs > 0) {
    setTimeout(() => {
      els.statusBanner.classList.add("hidden");
    }, autoHideMs);
  }
}

// Tokenize sentence into clickable word spans
function renderClickableWords(text, sentenceContext = "") {
  if (!text) return "";
  // Split preserving whitespace and punctuation tokens
  const tokens = text.split(/(\s+)/);
  return tokens
    .map((tok) => {
      if (/^\s+$/.test(tok)) return tok;
      const cleanWord = tok.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
      if (!cleanWord) return escapeHtml(tok);
      return `<span class="clickable-word" data-word="${escapeHtml(cleanWord)}" data-context="${escapeHtml(sentenceContext || text)}">${escapeHtml(tok)}</span>`;
    })
    .join("");
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// YouTube IFrame API Global Callback
window.onYouTubeIframeAPIReady = function () {
  ytPlayer = new YT.Player("yt-player", {
    height: "100%",
    width: "100%",
    videoId: state.videoId,
    playerVars: {
      playsinline: 1,
      rel: 0,
      modestbranding: 1,
      cc_load_policy: 0, // We render our own interactive subtitles
    },
    events: {
      onReady: () => {
        isPlayerReady = true;
        startPlaybackSyncLoop();
      },
      onStateChange: (event) => {
        // Keep sync loop running when playing
        if (event.data === YT.PlayerState.PLAYING) {
          startPlaybackSyncLoop();
        }
      },
    },
  });
};

function clearShadowPause() {
  if (state.shadowPauseTimer) {
    clearTimeout(state.shadowPauseTimer);
    state.shadowPauseTimer = null;
  }
  state.isInShadowPause = false;
}

// High-frequency (50ms) playback monitor for millisecond-accurate sentence tracking & looping
function startPlaybackSyncLoop() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = setInterval(() => {
    if (!isPlayerReady || !ytPlayer || typeof ytPlayer.getCurrentTime !== "function") return;
    if (state.isInShadowPause) return;

    const playerState = ytPlayer.getPlayerState ? ytPlayer.getPlayerState() : -1;
    if (playerState !== 1) return; // Only sync actively when playing

    const currentTime = ytPlayer.getCurrentTime();
    if (!Number.isFinite(currentTime) || state.segments.length === 0) return;

    // 1. Handle Single-Sentence Loop boundary check first
    if (state.isLooping && state.loopTargetIndex >= 0 && state.loopTargetIndex < state.segments.length) {
      const targetSeg = state.segments[state.loopTargetIndex];
      // Add a tiny 0.04s buffer before end so we catch it cleanly before bleeding into next line
      const loopEndBoundary = Math.max(targetSeg.start + 0.25, targetSeg.end - 0.03);

      if (currentTime >= loopEndBoundary || currentTime < targetSeg.start - 0.35) {
        handleSentenceLoopBoundary(targetSeg);
        return;
      }
    }

    // 2. Otherwise find the currently active subtitle segment
    const foundIdx = findSegmentIndexAtTime(currentTime);
    if (foundIdx !== -1 && foundIdx !== state.activeIndex) {
      setActiveSegment(foundIdx, { scrollIntoView: state.autoScroll });
      // If looping is enabled but loopTargetIndex wasn't locked or user let it advance
      if (state.isLooping && state.loopTargetIndex === -1) {
        state.loopTargetIndex = foundIdx;
        state.currentLoopIteration = 1;
        updateLoopUI();
      }
    }
  }, 50);
}

function handleSentenceLoopBoundary(targetSeg) {
  const pauseDurationSec = computeShadowPauseSeconds(targetSeg);

  const executeNextIterationOrAdvance = () => {
    state.isInShadowPause = false;
    if (state.maxLoopCount > 0 && state.currentLoopIteration >= state.maxLoopCount) {
      // Completed N loops -> advance to next sentence and loop that one!
      const nextIdx = state.loopTargetIndex + 1;
      if (nextIdx < state.segments.length) {
        state.loopTargetIndex = nextIdx;
        state.currentLoopIteration = 1;
        setActiveSegment(nextIdx, { scrollIntoView: state.autoScroll });
        updateLoopUI();
        seekAndPlay(state.segments[nextIdx].start);
      } else {
        // Reached end of video transcript
        state.currentLoopIteration = 1;
        updateLoopUI();
        seekAndPlay(targetSeg.start);
      }
    } else {
      // Repeat the same sentence again
      state.currentLoopIteration += 1;
      updateLoopUI();
      seekAndPlay(targetSeg.start);
    }
  };

  if (pauseDurationSec > 0 && ytPlayer && typeof ytPlayer.pauseVideo === "function") {
    state.isInShadowPause = true;
    ytPlayer.pauseVideo();
    els.loopStatusPill.textContent = `🗣️ 跟读留白暂停 (${pauseDurationSec.toFixed(1)}s)...`;
    els.loopStatusPill.classList.remove("hidden");
    state.shadowPauseTimer = setTimeout(() => {
      executeNextIterationOrAdvance();
    }, pauseDurationSec * 1000);
  } else {
    executeNextIterationOrAdvance();
  }
}

function computeShadowPauseSeconds(seg) {
  if (state.shadowPauseSetting === "0") return 0;
  if (state.shadowPauseSetting === "auto") {
    return Math.min(Math.max(seg.duration, 1.2), 8.0);
  }
  const parsed = parseFloat(state.shadowPauseSetting);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function findSegmentIndexAtTime(timeSec) {
  const segs = state.segments;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const nextStart = i + 1 < segs.length ? segs[i + 1].start : s.end + 0.5;
    const effectiveEnd = Math.max(s.end, Math.min(nextStart, s.start + 0.25));
    if (timeSec >= s.start - 0.08 && timeSec < effectiveEnd) {
      return i;
    }
  }
  return -1;
}

function seekAndPlay(timeSec) {
  clearShadowPause();
  if (!isPlayerReady || !ytPlayer) return;
  ytPlayer.seekTo(Math.max(0, timeSec), true);
  ytPlayer.playVideo();
}

// Jump to a specific subtitle line
function jumpToSegment(index, { enableLoop = null } = {}) {
  if (index < 0 || index >= state.segments.length) return;
  clearShadowPause();

  if (enableLoop !== null) {
    state.isLooping = enableLoop;
  }
  if (state.isLooping) {
    state.loopTargetIndex = index;
    state.currentLoopIteration = 1;
  }

  setActiveSegment(index, { scrollIntoView: true });
  updateLoopUI();
  seekAndPlay(state.segments[index].start);
}

function setActiveSegment(index, { scrollIntoView = true } = {}) {
  state.activeIndex = index;
  const seg = state.segments[index];

  // Update active spotlight card
  if (seg) {
    els.activeIndexBadge.textContent = `# ${index + 1} / ${state.segments.length}`;
    els.activeTimeBadge.textContent = `${formatTime(seg.start)} - ${formatTime(seg.end)}`;
    els.activePrimaryText.innerHTML = renderClickableWords(seg.text, seg.text);

    if (seg.translation) {
      els.activeTranslatedText.textContent = seg.translation;
      els.activeTranslatedText.classList.remove("hidden");
    } else {
      els.activeTranslatedText.textContent = "";
      els.activeTranslatedText.classList.add("hidden");
    }
  }

  // Update list highlight
  const items = els.subtitleList.querySelectorAll(".sub-item");
  items.forEach((item) => {
    const itemIdx = parseInt(item.dataset.index, 10);
    const isActive = itemIdx === index;
    const isLoopTarget = state.isLooping && itemIdx === state.loopTargetIndex;
    item.classList.toggle("active", isActive);
    item.classList.toggle("looping", isLoopTarget);

    const loopBtn = item.querySelector(".loop-this-btn");
    if (loopBtn) {
      loopBtn.classList.toggle("active", isLoopTarget);
      loopBtn.textContent = isLoopTarget ? "🔁 循环中" : "🔁 复读此句";
    }
  });

  if (scrollIntoView) {
    const activeEl = els.subtitleList.querySelector(`.sub-item[data-index="${index}"]`);
    if (activeEl) {
      activeEl.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }
}

function toggleSingleSentenceLoop(forceIndex = null) {
  clearShadowPause();

  if (forceIndex !== null) {
    // Clicking the per-sentence "🔁 复读此句" button
    if (state.isLooping && state.loopTargetIndex === forceIndex) {
      state.isLooping = false;
      state.loopTargetIndex = -1;
    } else {
      state.isLooping = true;
      state.loopTargetIndex = forceIndex;
      state.currentLoopIteration = 1;
      jumpToSegment(forceIndex, { enableLoop: true });
      return;
    }
  } else {
    state.isLooping = !state.isLooping;
    if (state.isLooping) {
      const target = state.activeIndex >= 0 ? state.activeIndex : 0;
      state.loopTargetIndex = target;
      state.currentLoopIteration = 1;
      if (state.segments[target]) {
        jumpToSegment(target, { enableLoop: true });
        return;
      }
    } else {
      state.loopTargetIndex = -1;
    }
  }

  updateLoopUI();
  if (state.activeIndex >= 0) {
    setActiveSegment(state.activeIndex, { scrollIntoView: false });
  }
}

function updateLoopUI() {
  els.loopToggleBtn.classList.toggle("active", state.isLooping);
  if (state.isLooping) {
    const countLabel =
      state.maxLoopCount > 0
        ? `${state.currentLoopIteration}/${state.maxLoopCount}遍`
        : `第${state.currentLoopIteration}遍 (∞)`;
    els.loopToggleBtn.textContent = `🔁 单句循环: 开 (${countLabel})`;
    els.loopStatusPill.textContent = `🔁 单句复读 #${state.loopTargetIndex + 1} · ${countLabel}`;
    els.loopStatusPill.classList.remove("hidden");
  } else {
    els.loopToggleBtn.textContent = "🔁 单句循环: 关";
    els.loopStatusPill.classList.add("hidden");
  }
}

// Fetch video transcript from backend API
async function loadVideoAndTranscript({
  url,
  lang = "",
  translate = state.translateLanguage,
  mode = state.segMode,
  preservePlayerPosition = false,
} = {}) {
  const targetUrl = (url || els.urlInput.value || "").trim();
  if (!targetUrl) {
    showBanner("请输入有效的 YouTube 视频或 Shorts 链接", true);
    return;
  }

  clearShadowPause();
  els.loadBtn.disabled = true;
  els.loadBtn.textContent = "提取字幕中...";
  els.subtitleList.innerHTML = `
    <div class="empty-state">
      <div class="spinner"></div>
      <p>正在从 YouTube 提取字幕轨道与时间戳，请稍候...</p>
    </div>
  `;

  try {
    const params = new URLSearchParams({ url: targetUrl, mode });
    if (lang) params.set("lang", lang);
    if (translate) params.set("translate", translate);

    const resp = await fetch(`/api/transcript?${params.toString()}`);
    const payload = await resp.json();

    if (!resp.ok || !payload.ok) {
      throw new Error(payload.error || "获取字幕失败");
    }

    const data = payload.data;
    const videoChanged = data.video_id !== state.videoId;

    state.videoId = data.video_id;
    state.isShorts = Boolean(data.is_shorts);
    state.title = data.title || `YouTube Video (${data.video_id})`;
    state.author = data.author || "";
    state.selectedLanguage = data.selected_language || "";
    state.availableTracks = data.available_tracks || [];
    state.segments = data.segments || [];

    // Update Aspect Ratio UI automatically based on Shorts vs standard video
    applyAspectMode(state.isShorts);

    // Update Video Meta Header
    els.videoTitle.textContent = state.title;
    els.videoAuthor.textContent = state.author ? `@${state.author}` : "";
    els.videoTypeBadge.textContent = state.isShorts ? "Shorts 竖屏" : "YouTube 视频";

    // Populate Track Select Dropdown
    renderTrackSelector();

    // Render Subtitle List
    renderSubtitleList();

    // Load video into YouTube IFrame Player if changed
    if (isPlayerReady && ytPlayer && videoChanged && !preservePlayerPosition) {
      ytPlayer.cueVideoById(state.videoId);
    }

    if (state.segments.length > 0) {
      setActiveSegment(0, { scrollIntoView: false });
      showBanner(
        `成功提取 ${state.segments.length} 句字幕（${data.selected_language_name || data.selected_language}${
          data.is_generated ? " · 自动识别字幕" : ""
        }）`,
        false,
        3500
      );
    }
  } catch (err) {
    els.subtitleList.innerHTML = `
      <div class="empty-state">
        <p style="color: #fca5a5; font-weight: 600;">⚠️ ${escapeHtml(err.message)}</p>
        <p style="font-size: 12px;">请检查视频是否公开且包含字幕/自动字幕，或尝试更换其他 YouTube 链接。</p>
      </div>
    `;
    showBanner(err.message, true, 6000);
  } finally {
    els.loadBtn.disabled = false;
    els.loadBtn.textContent = "提取字幕并加载";
  }
}

function applyAspectMode(isShorts) {
  state.isShorts = isShorts;
  els.playerContainer.classList.toggle("shorts-aspect", isShorts);
  els.playerContainer.classList.toggle("landscape-aspect", !isShorts);
  els.workspace.classList.toggle("wide-mode", !isShorts);
  els.aspectToggleBtn.textContent = isShorts ? "📱 竖屏 Shorts 视图" : "🖥️ 16:9 宽屏视图";
}

function renderTrackSelector() {
  els.trackSelect.innerHTML = "";
  state.availableTracks.forEach((tr) => {
    const opt = document.createElement("option");
    opt.value = tr.language_code;
    opt.textContent = `${tr.language}${tr.is_generated ? " (自动生成)" : ""}`;
    if (tr.language_code === state.selectedLanguage) {
      opt.selected = true;
    }
    els.trackSelect.appendChild(opt);
  });
}

function renderSubtitleList() {
  const query = state.searchQuery.trim().toLowerCase();
  const filtered = state.segments.filter((seg) => {
    if (!query) return true;
    return (
      seg.text.toLowerCase().includes(query) ||
      (seg.translation && seg.translation.toLowerCase().includes(query))
    );
  });

  els.subtitleStats.textContent = query
    ? `匹配 ${filtered.length} / ${state.segments.length} 句`
    : `共 ${state.segments.length} 句`;

  if (filtered.length === 0) {
    els.subtitleList.innerHTML = `
      <div class="empty-state">
        <p>没有找到匹配的字幕内容</p>
      </div>
    `;
    return;
  }

  els.subtitleList.innerHTML = filtered
    .map((seg) => {
      const idx = seg.index;
      const isActive = idx === state.activeIndex;
      const isLoopTarget = state.isLooping && idx === state.loopTargetIndex;

      return `
        <div class="sub-item ${isActive ? "active" : ""} ${isLoopTarget ? "looping" : ""}" data-index="${idx}">
          <div class="sub-meta">
            <span class="sub-idx">#${idx + 1}</span>
            <span class="sub-time" title="点击跳转到 ${formatTime(seg.start)}">${formatTime(seg.start)}</span>
          </div>
          <div class="sub-content">
            <div class="sub-text-primary">${renderClickableWords(seg.text, seg.text)}</div>
            ${
              seg.translation
                ? `<div class="sub-text-trans">${escapeHtml(seg.translation)}</div>`
                : ""
            }
          </div>
          <div class="sub-actions">
            <button type="button" class="sub-action-btn play-this-btn" data-index="${idx}" title="从本句开始播放">
              ▶ 播放
            </button>
            <button type="button" class="sub-action-btn loop-this-btn ${isLoopTarget ? "active" : ""}" data-index="${idx}" title="单句循环复读本句">
              ${isLoopTarget ? "🔁 循环中" : "🔁 复读此句"}
            </button>
          </div>
        </div>
      `;
    })
    .join("");
}

// Word Pronunciation & Popover Dictionary
function openWordPopover(word, contextSentence, anchorRect) {
  els.popoverWord.textContent = word;
  els.popoverContext.textContent = contextSentence;

  const encoded = encodeURIComponent(word);
  els.dictYoudao.href = `https://dict.youdao.com/result?word=${encoded}&lang=en`;
  els.dictCambridge.href = `https://dictionary.cambridge.org/dictionary/english-chinese-simplified/${encoded}`;
  els.dictGoogle.href = `https://translate.google.com/?sl=auto&tl=zh-CN&text=${encoded}&op=translate`;

  els.wordPopover.classList.remove("hidden");

  // Position near clicked word
  const top = Math.min(window.innerHeight - 170, Math.max(12, anchorRect.bottom + 8));
  const left = Math.min(window.innerWidth - 320, Math.max(12, anchorRect.left));
  els.wordPopover.style.top = `${top}px`;
  els.wordPopover.style.left = `${left}px`;

  // Speak word using Web Speech API
  speakText(word, state.selectedLanguage || "en-US");
}

function speakText(text, langCode = "en-US") {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = langCode;
  utter.rate = 0.92;
  window.speechSynthesis.speak(utter);
}

// Vocabulary & Saved Sentences Management
function updateSavedNotesUI() {
  const total = state.savedWords.length + state.savedSentences.length;
  els.savedCount.textContent = String(total);

  localStorage.setItem("linguatube_words", JSON.stringify(state.savedWords));
  localStorage.setItem("linguatube_sentences", JSON.stringify(state.savedSentences));

  // Render words
  if (state.savedWords.length === 0) {
    els.savedWordsList.innerHTML = `<p style="font-size:12px;color:var(--text-muted);">点击字幕中的任意单词即可添加生词</p>`;
  } else {
    els.savedWordsList.innerHTML = state.savedWords
      .map(
        (item, i) => `
        <div class="saved-card">
          <div class="saved-card-top">
            <span style="color:#a5b4fc;font-size:15px;">${escapeHtml(item.word)}</span>
            <div>
              <button type="button" class="icon-btn speak-saved-word" data-word="${escapeHtml(item.word)}">🔊</button>
              <button type="button" class="icon-btn delete-saved-word" data-idx="${i}">🗑️</button>
            </div>
          </div>
          <div style="font-size:12px;color:var(--text-secondary);">${escapeHtml(item.context || "")}</div>
        </div>
      `
      )
      .join("");
  }

  // Render sentences
  if (state.savedSentences.length === 0) {
    els.savedSentencesList.innerHTML = `<p style="font-size:12px;color:var(--text-muted);">点击“⭐ 收藏本句”保存重点跟读句</p>`;
  } else {
    els.savedSentencesList.innerHTML = state.savedSentences
      .map(
        (item, i) => `
        <div class="saved-card">
          <div class="saved-card-top">
            <span style="font-size:11px;color:#818cf8;">${escapeHtml(item.timeLabel || "")}</span>
            <div>
              <button type="button" class="mini-tool-btn jump-saved-sentence" data-start="${item.start}">▶ 跳转播放</button>
              <button type="button" class="icon-btn delete-saved-sentence" data-idx="${i}">🗑️</button>
            </div>
          </div>
          <div style="font-weight:500;">${escapeHtml(item.text)}</div>
          ${item.translation ? `<div style="font-size:12px;color:#93c5fd;">${escapeHtml(item.translation)}</div>` : ""}
        </div>
      `
      )
      .join("");
  }
}

// Export Handlers
function handleExport(action) {
  if (state.segments.length === 0) {
    showBanner("当前没有可导出的字幕", true);
    return;
  }

  if (action === "copy-plain") {
    const content = state.segments.map((s) => s.text).join("\n");
    navigator.clipboard.writeText(content);
    showBanner("已复制全部纯文本字幕到剪贴板！");
  } else if (action === "copy-timestamp") {
    const content = state.segments
      .map((s) => `[${formatTime(s.start)}] ${s.text}`)
      .join("\n");
    navigator.clipboard.writeText(content);
    showBanner("已复制带时间戳字幕到剪贴板！");
  } else if (action === "copy-bilingual") {
    const content = state.segments
      .map((s) => `[${formatTime(s.start)}] ${s.text}${s.translation ? "\n" + s.translation : ""}`)
      .join("\n\n");
    navigator.clipboard.writeText(content);
    showBanner("已复制双语对照字幕到剪贴板！");
  } else if (action === "download-srt") {
    const srt = state.segments
      .map(
        (s, i) =>
          `${i + 1}\n${formatSrtTime(s.start)} --> ${formatSrtTime(s.end)}\n${s.text}${
            s.translation ? "\n" + s.translation : ""
          }\n`
      )
      .join("\n");
    downloadTextFile(`${state.videoId}.srt`, srt);
    showBanner("已下载 .SRT 字幕文件！");
  } else if (action === "download-md") {
    const md = [
      `# ${state.title}`,
      `- 视频链接: https://www.youtube.com/watch?v=${state.videoId}`,
      `- 字幕语言: ${state.selectedLanguage}`,
      "",
      "## 字幕全文对照",
      ...state.segments.map(
        (s, i) =>
          `${i + 1}. **[${formatTime(s.start)}]** ${s.text}${
            s.translation ? `  \n   > ${s.translation}` : ""
          }`
      ),
    ].join("\n");
    downloadTextFile(`${state.videoId}-study-notes.md`, md);
    showBanner("已下载 Markdown 学习笔记！");
  }
}

function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Event Listeners Setup
function bindEvents() {
  els.urlForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (state.segMode === "raw") {
      state.segMode = "sentence";
      els.segModeSelect.value = "sentence";
    }
    loadVideoAndTranscript({ url: els.urlInput.value, mode: state.segMode });
  });

  els.clearUrlBtn.addEventListener("click", () => {
    els.urlInput.value = "";
    els.urlInput.focus();
  });

  els.aspectToggleBtn.addEventListener("click", () => {
    applyAspectMode(!state.isShorts);
  });

  // Track & Translation Change
  els.trackSelect.addEventListener("change", () => {
    loadVideoAndTranscript({
      url: state.videoId,
      lang: els.trackSelect.value,
      translate: els.translateSelect.value,
      mode: state.segMode,
      preservePlayerPosition: true,
    });
  });

  els.translateSelect.addEventListener("change", () => {
    state.translateLanguage = els.translateSelect.value;
    loadVideoAndTranscript({
      url: state.videoId,
      lang: state.selectedLanguage,
      translate: state.translateLanguage,
      mode: state.segMode,
      preservePlayerPosition: true,
    });
  });

  els.segModeSelect.addEventListener("change", () => {
    state.segMode = els.segModeSelect.value;
    loadVideoAndTranscript({
      url: state.videoId,
      lang: state.selectedLanguage,
      translate: state.translateLanguage,
      mode: state.segMode,
      preservePlayerPosition: true,
    });
  });

  // Subtitle List Click -> Seek / Loop / Word Lookup
  els.subtitleList.addEventListener("click", (e) => {
    const wordEl = e.target.closest(".clickable-word");
    if (wordEl) {
      e.stopPropagation();
      openWordPopover(
        wordEl.dataset.word,
        wordEl.dataset.context,
        wordEl.getBoundingClientRect()
      );
      return;
    }

    const loopBtn = e.target.closest(".loop-this-btn");
    if (loopBtn) {
      e.stopPropagation();
      const idx = parseInt(loopBtn.dataset.index, 10);
      toggleSingleSentenceLoop(idx);
      return;
    }

    const subItem = e.target.closest(".sub-item");
    if (subItem) {
      const idx = parseInt(subItem.dataset.index, 10);
      // If already in loop mode, clicking another sentence switches loop target to that sentence
      jumpToSegment(idx, { enableLoop: state.isLooping ? true : null });
    }
  });

  // Active Caption Box Word Click
  els.activePrimaryText.addEventListener("click", (e) => {
    const wordEl = e.target.closest(".clickable-word");
    if (wordEl) {
      openWordPopover(
        wordEl.dataset.word,
        wordEl.dataset.context,
        wordEl.getBoundingClientRect()
      );
    }
  });

  // Transport & Shadowing Controls
  els.prevSubBtn.addEventListener("click", () => {
    const target = Math.max(0, (state.activeIndex >= 0 ? state.activeIndex : 0) - 1);
    jumpToSegment(target);
  });

  els.nextSubBtn.addEventListener("click", () => {
    const target = Math.min(
      state.segments.length - 1,
      (state.activeIndex >= 0 ? state.activeIndex : 0) + 1
    );
    jumpToSegment(target);
  });

  els.replaySubBtn.addEventListener("click", () => {
    const target = state.activeIndex >= 0 ? state.activeIndex : 0;
    jumpToSegment(target);
  });

  els.playPauseBtn.addEventListener("click", () => {
    clearShadowPause();
    if (!isPlayerReady || !ytPlayer) return;
    const st = ytPlayer.getPlayerState();
    if (st === 1) {
      ytPlayer.pauseVideo();
    } else {
      ytPlayer.playVideo();
    }
  });

  els.loopToggleBtn.addEventListener("click", () => {
    toggleSingleSentenceLoop();
  });

  els.loopCountSelect.addEventListener("change", () => {
    state.maxLoopCount = parseInt(els.loopCountSelect.value, 10) || 0;
    state.currentLoopIteration = 1;
    updateLoopUI();
  });

  els.shadowPauseSelect.addEventListener("change", () => {
    state.shadowPauseSetting = els.shadowPauseSelect.value;
    clearShadowPause();
  });

  els.speedSelect.addEventListener("change", () => {
    const rate = parseFloat(els.speedSelect.value) || 1.0;
    if (isPlayerReady && ytPlayer && typeof ytPlayer.setPlaybackRate === "function") {
      ytPlayer.setPlaybackRate(rate);
    }
  });

  // Independent Original & Translation Visibility Toggles
  function updateTextVisibilityUI() {
    document.body.classList.toggle("hide-primary", !state.showOriginal);
    document.body.classList.toggle("hide-translation", !state.showTranslation);

    if (els.toggleOrigBtn) {
      els.toggleOrigBtn.classList.toggle("active", state.showOriginal);
      els.toggleOrigBtn.textContent = state.showOriginal ? "👁️ 显示原文" : "🙈 隐藏原文";
    }
    if (els.spotToggleOrigBtn) {
      els.spotToggleOrigBtn.classList.toggle("active-toggle", state.showOriginal);
      els.spotToggleOrigBtn.textContent = state.showOriginal ? "👁️ 原文: 显" : "🙈 原文: 隐";
    }

    if (els.toggleTransBtn) {
      els.toggleTransBtn.classList.toggle("active", state.showTranslation);
      els.toggleTransBtn.textContent = state.showTranslation ? "👁️ 显示译文" : "🙈 隐藏译文";
    }
    if (els.spotToggleTransBtn) {
      els.spotToggleTransBtn.classList.toggle("active-toggle", state.showTranslation);
      els.spotToggleTransBtn.textContent = state.showTranslation ? "👁️ 译文: 显" : "🙈 译文: 隐";
    }
  }

  function handleToggleOriginal() {
    state.showOriginal = !state.showOriginal;
    updateTextVisibilityUI();
  }

  function handleToggleTranslation() {
    state.showTranslation = !state.showTranslation;
    updateTextVisibilityUI();
  }

  if (els.toggleOrigBtn) els.toggleOrigBtn.addEventListener("click", handleToggleOriginal);
  if (els.spotToggleOrigBtn) els.spotToggleOrigBtn.addEventListener("click", handleToggleOriginal);
  if (els.toggleTransBtn) els.toggleTransBtn.addEventListener("click", handleToggleTranslation);
  if (els.spotToggleTransBtn) els.spotToggleTransBtn.addEventListener("click", handleToggleTranslation);

  // Save Current Sentence
  els.saveCurrentSentenceBtn.addEventListener("click", () => {
    const seg = state.segments[state.activeIndex];
    if (!seg) return;
    state.savedSentences.unshift({
      videoId: state.videoId,
      start: seg.start,
      timeLabel: formatTime(seg.start),
      text: seg.text,
      translation: seg.translation || "",
    });
    updateSavedNotesUI();
    showBanner("已收藏当前句到学习笔记！");
  });

  // Auto-scroll & Search
  els.autoscrollCheckbox.addEventListener("change", () => {
    state.autoScroll = els.autoscrollCheckbox.checked;
  });

  els.searchInput.addEventListener("input", () => {
    state.searchQuery = els.searchInput.value;
    renderSubtitleList();
  });

  // Export Menu
  els.exportMenuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    els.exportDropdown.classList.toggle("hidden");
  });

  els.exportDropdown.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-export]");
    if (btn) {
      handleExport(btn.dataset.export);
      els.exportDropdown.classList.add("hidden");
    }
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".dropdown")) {
      els.exportDropdown.classList.add("hidden");
    }
    if (!e.target.closest("#word-popover") && !e.target.closest(".clickable-word")) {
      els.wordPopover.classList.add("hidden");
    }
  });

  // Popover buttons
  els.closePopoverBtn.addEventListener("click", () => {
    els.wordPopover.classList.add("hidden");
  });

  els.speakWordBtn.addEventListener("click", () => {
    speakText(els.popoverWord.textContent, state.selectedLanguage || "en-US");
  });

  els.saveWordBtn.addEventListener("click", () => {
    const word = els.popoverWord.textContent;
    const context = els.popoverContext.textContent;
    if (!state.savedWords.some((w) => w.word.toLowerCase() === word.toLowerCase())) {
      state.savedWords.unshift({ word, context });
      updateSavedNotesUI();
    }
    showBanner(`已将 "${word}" 加入生词本！`);
  });

  // Drawer events
  els.vocabDrawerBtn.addEventListener("click", () => {
    els.vocabDrawer.classList.toggle("hidden");
  });

  els.closeDrawerBtn.addEventListener("click", () => {
    els.vocabDrawer.classList.add("hidden");
  });

  els.savedWordsList.addEventListener("click", (e) => {
    const speakBtn = e.target.closest(".speak-saved-word");
    if (speakBtn) {
      speakText(speakBtn.dataset.word, state.selectedLanguage || "en-US");
    }
    const delBtn = e.target.closest(".delete-saved-word");
    if (delBtn) {
      state.savedWords.splice(parseInt(delBtn.dataset.idx, 10), 1);
      updateSavedNotesUI();
    }
  });

  els.savedSentencesList.addEventListener("click", (e) => {
    const jumpBtn = e.target.closest(".jump-saved-sentence");
    if (jumpBtn) {
      seekAndPlay(parseFloat(jumpBtn.dataset.start));
    }
    const delBtn = e.target.closest(".delete-saved-sentence");
    if (delBtn) {
      state.savedSentences.splice(parseInt(delBtn.dataset.idx, 10), 1);
      updateSavedNotesUI();
    }
  });

  els.exportNotesBtn.addEventListener("click", () => {
    const lines = [
      "# 我的 LinguaTube 外语学习生词与重点句",
      "",
      "## 生词本",
      ...state.savedWords.map((w, i) => `${i + 1}. **${w.word}** — _${w.context}_`),
      "",
      "## 重点跟读句",
      ...state.savedSentences.map(
        (s, i) => `${i + 1}. [${s.timeLabel}] ${s.text}${s.translation ? ` (${s.translation})` : ""}`
      ),
    ];
    downloadTextFile("linguatube-vocabulary-notes.md", lines.join("\n"));
  });

  // Global Keyboard Shortcuts for Fast Shadowing
  document.addEventListener("keydown", (e) => {
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

    if (e.code === "Space") {
      e.preventDefault();
      els.playPauseBtn.click();
    } else if (e.code === "ArrowLeft" || e.code === "KeyA") {
      e.preventDefault();
      els.prevSubBtn.click();
    } else if (e.code === "ArrowRight" || e.code === "KeyD") {
      e.preventDefault();
      els.nextSubBtn.click();
    } else if (e.code === "KeyS") {
      e.preventDefault();
      els.replaySubBtn.click();
    } else if (e.code === "KeyL" || e.code === "KeyR") {
      e.preventDefault();
      toggleSingleSentenceLoop();
    } else if (e.code === "KeyO") {
      e.preventDefault();
      handleToggleOriginal();
    } else if (e.code === "KeyT") {
      e.preventDefault();
      handleToggleTranslation();
    } else if (e.code === "KeyB") {
      e.preventDefault();
      const hideBoth = state.showOriginal || state.showTranslation;
      state.showOriginal = !hideBoth;
      state.showTranslation = !hideBoth;
      updateTextVisibilityUI();
    }
  });
}

// Initialize App
document.addEventListener("DOMContentLoaded", () => {
  bindEvents();
  updateSavedNotesUI();
  // Automatically extract subtitles for the default pre-filled video on startup
  loadVideoAndTranscript({ url: els.urlInput.value });
});
