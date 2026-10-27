window.__ModuleLoader__.load({
  id: "dsh-session-auto-archive",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require("react");
    const h = React.createElement;
    const useState = React.useState;
    const useEffect = React.useEffect;
    const useCallback = React.useCallback;

    // ---- 常量：与 lib/index.js 的 patch 行 id、路由保持一致 ----
    const PKG = "dsh-session-auto-archive";
    const ROW_ID = "session-auto-archive"; // cordis.patch.yml 里 insert 的 id
    const API = "/api/dsh-auto-archive";

    const DEFAULTS = {
      enabled: true,
      idleDays: 14,
      dryRun: true,
      keepPinned: true,
      includeSubagents: false,
      intervalHours: 12,
      startupDelayMs: 60000,
      excludeCwdSubstrings: [],
    };

    const I18N = {
      zh: {
        title: "会话自动归档",
        desc: "按闲置时长周期性归档 DSH 会话（原生 archivedSessionIds，可从回收/归档区取消归档）。",
        enabled: "启用自动归档",
        dryRun: "演练模式（只记录不归档）",
        keepPinned: "跳过置顶会话",
        includeSubagents: "包含子代理会话",
        idleDays: "闲置天数阈值",
        intervalHours: "扫描间隔（小时）",
        excludeCwd: "跳过的工作区（cwd 子串，逗号分隔）",
        excludePlaceholder: "例如 D:\\敏感项目, 收件箱",
        save: "保存",
        saved: "已保存",
        saving: "保存中…",
        runNow: "立即扫描一次",
        running: "扫描中…",
        revert: "撤销上次归档",
        reverting: "撤销中…",
        lastRun: "上次运行",
        never: "尚未运行",
        trigger: "触发",
        scanned: "扫描",
        archived: "已归档",
        planned: "待归档",
        skipped: "跳过",
        errors: "错误",
        conflict: "配置已被别处改动，已刷新最新值，请重试。",
        fail: "操作失败：",
        archiveHint: "真正归档前请先关闭演练模式；带定时任务的会话会被活动检查自动跳过（不会被删除任务）。",
        hintEnabled: "总开关，关闭后不再自动归档",
        hintDryRun: "只扫描并记录计划，不真正归档",
        hintKeepPinned: "置顶的会话跳过归档",
        hintSubagents: "子代理会话也参与扫描",
        hintIdleDays: "超过该天数无活动的会话将被归档",
        hintInterval: "定时器每隔多久扫描一次",
        hintExclude: "工作区路径包含任一子串则跳过",
        collapse: "收起",
        expand: "展开",
        history: "归档历史",
        historyEmpty: "暂无归档记录",
        historyLoading: "读取中…",
        historyFail: "读取历史失败：",
        hArchived: "已归档",
        hPlanned: "演练计划",
        hUnarchived: "已撤销",
        hFailed: "失败",
        undo: "撤销",
        undoing: "撤销中…",
        undone: "已撤销",
        noTitle: "（无标题）",
        disabled: "已停用",
        historyNeedRestart: "读取历史失败：接口尚未注册，重启 DSH 后生效。",
      },
      en: {
        title: "Session Auto Archive",
        desc: "Periodically archives DSH sessions by idle age (native archivedSessionIds; reversible).",
        enabled: "Enable auto-archive",
        dryRun: "Dry run (log only, no archive)",
        keepPinned: "Skip pinned sessions",
        includeSubagents: "Include subagent sessions",
        idleDays: "Idle threshold (days)",
        intervalHours: "Scan interval (hours)",
        excludeCwd: "Excluded workspaces (cwd substrings, comma-separated)",
        excludePlaceholder: "e.g. D:\\secret, inbox",
        save: "Save",
        saved: "Saved",
        saving: "Saving…",
        runNow: "Scan now",
        running: "Scanning…",
        revert: "Undo last archive",
        reverting: "Undoing…",
        lastRun: "Last run",
        never: "Not run yet",
        trigger: "Trigger",
        scanned: "scanned",
        archived: "archived",
        planned: "planned",
        skipped: "skipped",
        errors: "errors",
        conflict: "Config changed elsewhere; refreshed to latest, please retry.",
        fail: "Operation failed: ",
        archiveHint: "Turn off dry run before real archiving; sessions with armed schedules are skipped by the activity check (their tasks are never deleted).",
        hintEnabled: "Master switch; when off nothing is auto-archived",
        hintDryRun: "Scan and log a plan only, no real archiving",
        hintKeepPinned: "Skip pinned sessions",
        hintSubagents: "Include subagent sessions in scans",
        hintIdleDays: "Sessions idle longer than this get archived",
        hintInterval: "How often the timer scans",
        hintExclude: "Skip workspaces whose path contains any substring",
        collapse: "Collapse",
        expand: "Expand",
        history: "Archive history",
        historyEmpty: "No archive records yet",
        historyLoading: "Loading…",
        historyFail: "Failed to load history: ",
        hArchived: "Archived",
        hPlanned: "Dry-run plan",
        hUnarchived: "Unarchived",
        hFailed: "Failed",
        undo: "Undo",
        undoing: "Undoing…",
        undone: "Undone",
        noTitle: "(untitled)",
        disabled: "Disabled",
        historyNeedRestart: "Failed to load history: the endpoint is not registered yet — restart DSH for it to take effect.",
      },
    };

    function pickLang() {
      const primary = typeof navigator === "undefined" ? "zh" : String((navigator.languages && navigator.languages[0]) || navigator.language || "zh").toLowerCase();
      return primary.startsWith("en") ? I18N.en : I18N.zh;
    }

    // ---- 最近一次运行结果的模块级缓存（summary 视图不触发网络请求）----
    let lastStatusCache = null;

    async function reqJson(path, opts) {
      const response = await fetch(API + path, Object.assign({ headers: { "content-type": "application/json" } }, opts));
      let data = {};
      try { data = await response.json(); } catch { data = {}; }
      return { httpStatus: response.status, ok: response.ok && data.ok !== false, data };
    }

    const loadSettings = () => reqJson("/settings", { method: "GET" });
    const saveSettings = (patch, expectedRevision) => reqJson("/settings", { method: "POST", body: JSON.stringify({ patch, expectedRevision }) });
    const loadStatus = () => reqJson("/status", { method: "GET" });
    const loadHistory = (limit) => reqJson("/history?limit=" + (limit || 50), { method: "GET" });
    const runScan = (dryRun) => reqJson("/run", { method: "POST", body: JSON.stringify(dryRun === undefined ? {} : { dryRun }) });
    const revertLast = (sessionId) => reqJson("/revert", { method: "POST", body: JSON.stringify(sessionId ? { sessionId } : {}) });

    function normalizeConfig(raw) {
      const src = raw && typeof raw === "object" ? raw : {};
      const out = Object.assign({}, DEFAULTS);
      for (const k of ["enabled", "dryRun", "keepPinned", "includeSubagents"]) if (typeof src[k] === "boolean") out[k] = src[k];
      for (const k of ["idleDays", "intervalHours", "startupDelayMs"]) if (Number.isFinite(Number(src[k]))) out[k] = Number(src[k]);
      if (Array.isArray(src.excludeCwdSubstrings)) out.excludeCwdSubstrings = src.excludeCwdSubstrings.map(String);
      return out;
    }

    function summaryText() {
      const t = pickLang();
      const s = lastStatusCache;
      const bits = [];
      bits.push(t.title);
      if (s && s.lastResult) {
        const r = s.lastResult;
        bits.push(`${t.lastRun}: ${r.dryRun ? t.planned : t.archived} ${r.dryRun ? (r.planned ?? 0) : (r.archived ?? 0)}`);
      } else {
        bits.push(t.never);
      }
      return bits.join(" · ");
    }

    // ---- 与 dsh-qoder-connect 卡片同一套行/开关/按钮版式（设置外壳的行规则）----

    /** 一行设置：左侧标题+说明，右侧控件（开关或输入框）。 */
    function SettingRow(props) {
      return h("div", { className: "dsha-row" },
        h("div", { className: "dsha-rowtext" },
          h("span", { className: "dsha-label", children: props.label }),
          props.hint ? h("span", { className: "dsha-hint", children: props.hint }) : null),
        props.children);
    }

    function Toggle(props) {
      return h("button", {
        type: "button",
        role: "switch",
        "aria-checked": props.checked ? "true" : "false",
        "aria-label": props.label,
        className: "dsha-toggle" + (props.checked ? " dsha-on" : ""),
        onClick: () => props.onChange(!props.checked),
        children: h("span", { className: "dsha-knob" }),
      });
    }

    /** 与设置面板自带卡片同一个 IconChevronDownOutline14 路径（qoder 注释同源）。 */
    function ChevronDownIcon() {
      return h("svg", {
        width: 14, height: 14, viewBox: "0 0 14 14", fill: "none",
        xmlns: "http://www.w3.org/2000/svg", "aria-hidden": "true",
      }, h("path", {
        d: "M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z",
        fill: "currentColor",
      }));
    }

    // 展开状态跨挂载保留（设置页/插件行两处共享一个开合偏好）
    let openPref = false;

    function AutoArchiveCard() {
      const t = pickLang();
      const [cfg, setCfg] = useState(null);
      const [revision, setRevision] = useState(undefined);
      const [status, setStatus] = useState(null);
      const [busy, setBusy] = useState("");
      const [msg, setMsg] = useState("");
      const [excludeText, setExcludeText] = useState("");
      const [open, setOpen] = useState(openPref);
      const [history, setHistory] = useState(null); // null=未加载, []=空, entries[]
      const [histError, setHistError] = useState(false);
      const [histBusyId, setHistBusyId] = useState("");

      const refresh = useCallback(async () => {
        const [s, st] = await Promise.all([loadSettings(), loadStatus()]);
        if (s.ok) {
          setCfg(normalizeConfig(s.data.value));
          setRevision(s.data.revision);
          setExcludeText((normalizeConfig(s.data.value).excludeCwdSubstrings || []).join(", "));
        } else {
          setCfg(normalizeConfig({}));
        }
        if (st.ok) { lastStatusCache = st.data; setStatus(st.data); }
      }, []);

      useEffect(() => { void refresh(); }, [refresh]);

      // 展开时才拉历史（折叠态零请求）；每次展开刷新一次。
      useEffect(() => {
        if (!open) return;
        let cancelled = false;
        void (async () => {
          const r = await loadHistory(50);
          if (cancelled) return;
          if (r.ok && Array.isArray(r.data.entries)) { setHistError(false); setHistory(r.data.entries); }
          else { setHistError(true); setHistory([]); }
        })();
        return () => { cancelled = true; };
      }, [open]);

      const toggleOpen = () => setOpen((v) => { openPref = !v; return !v; });

      const setField = (key, value) => setCfg((c) => (c ? Object.assign({}, c, { [key]: value }) : c));

      const onSave = async () => {
        if (!cfg) return;
        setBusy("save"); setMsg("");
        const list = excludeText.split(",").map((x) => x.trim()).filter(Boolean);
        const patch = {
          enabled: cfg.enabled, dryRun: cfg.dryRun, keepPinned: cfg.keepPinned,
          includeSubagents: cfg.includeSubagents, idleDays: Number(cfg.idleDays),
          intervalHours: Number(cfg.intervalHours), excludeCwdSubstrings: list,
        };
        const r = await saveSettings(patch, revision);
        if (r.ok) {
          setMsg(t.saved);
          setRevision(r.data.revision);
          if (r.data && r.data.value) setCfg(normalizeConfig(r.data.value));
        } else if (r.httpStatus === 409) {
          setMsg(t.conflict);
          const fresh = await loadSettings();
          if (fresh.ok) { setCfg(normalizeConfig(fresh.data.value)); setRevision(fresh.data.revision); }
        } else {
          setMsg(t.fail + (r.data.error || r.httpStatus));
        }
        setBusy("");
      };

      const reloadHistory = useCallback(async () => {
        const hr = await loadHistory(50);
        if (hr.ok && Array.isArray(hr.data.entries)) { setHistError(false); setHistory(hr.data.entries); }
        else setHistError(true);
      }, []);

      const onRun = async () => {
        setBusy("run"); setMsg("");
        const r = await runScan(undefined);
        if (r.ok && r.data.result) {
          lastStatusCache = { lastResult: r.data.result };
          setStatus((prev) => Object.assign({}, prev, { lastResult: r.data.result }));
          const res = r.data.result;
          setMsg(`${r.data.result.dryRun ? t.planned : t.archived}: ${r.data.result.dryRun ? (res.planned ?? 0) : (res.archived ?? 0)} · ${res.scanned ?? 0} ${t.scanned}`);
          if (open) await reloadHistory();
        } else {
          setMsg(t.fail + (r.data.error || r.httpStatus));
        }
        setBusy("");
      };

      const onRevert = async () => {
        setBusy("revert"); setMsg("");
        const r = await revertLast(undefined);
        if (r.ok) {
          const n = (r.data && r.data.revertedCount) || (r.data && r.data.reverted ? r.data.reverted.length : 0);
          setMsg(`${t.revert}: ${n}`);
          const st = await loadStatus(); if (st.ok) { lastStatusCache = st.data; setStatus(st.data); }
          if (open) await reloadHistory();
        } else {
          setMsg(t.fail + (r.data.error || r.httpStatus));
        }
        setBusy("");
      };

      const onUndoOne = async (sessionId) => {
        setHistBusyId(sessionId); setMsg("");
        const r = await revertLast(sessionId);
        if (r.ok) {
          setMsg(`${t.undone}: ${sessionId.replace(/^session-/, "").slice(0, 8)}`);
          await reloadHistory();
        } else {
          setMsg(t.fail + (r.data.error || r.httpStatus));
        }
        setHistBusyId("");
      };

      if (!cfg) return h("li", { className: "dsha-acc" }, h("style", { dangerouslySetInnerHTML: { __html: CSS } }), h("div", { className: "dsha-loading", children: "…" }));

      const r = status && status.lastResult;
      const skips = r && r.skippedByReason ? Object.entries(r.skippedByReason).map((kv) => `${kv[0]}:${kv[1]}`).join(" ") : "";
      const histCount = Array.isArray(history) ? history.length : 0;

      const ACTION_LABEL = { archived: t.hArchived, planned: t.hPlanned, unarchived: t.hUnarchived, failed: t.hFailed };
      const fmtTime = (iso) => { try { return new Date(iso).toLocaleString(); } catch { return iso || "?"; } };

      // qoder 同款卡片：li 根 + 0.5px border-l4 radius16 + header（标题15/600 + 描述13 tertiary）
      // + 真 chevron SVG（open 时 rotate 180），body 一行一项、行底 .5px 分隔线。
      return h("li", { className: "dsha-acc" + (open ? " dsha-opened" : "") },
        h("style", { dangerouslySetInnerHTML: { __html: CSS } }),
        h("button", {
          type: "button", className: "dsha-acc-head", "aria-expanded": open ? "true" : "false",
          "aria-label": (open ? t.collapse : t.expand) + ": " + t.title, onClick: toggleOpen,
        },
          h("span", { className: "dsha-headtext" },
            h("span", { className: "dsha-acc-title", children: t.title }),
            h("span", { className: "dsha-acc-summary", children: t.desc })),
          h("span", { className: "dsha-acc-chev" + (open ? " dsha-chev-open" : ""), "aria-hidden": "true" }, h(ChevronDownIcon, {}))),

        open ? h("div", { className: "dsha-acc-body" },
          h(SettingRow, { label: t.enabled, hint: t.hintEnabled }, h(Toggle, { checked: cfg.enabled, label: t.enabled, onChange: (v) => setField("enabled", v) })),
          h(SettingRow, { label: t.dryRun, hint: t.hintDryRun }, h(Toggle, { checked: cfg.dryRun, label: t.dryRun, onChange: (v) => setField("dryRun", v) })),
          h(SettingRow, { label: t.keepPinned, hint: t.hintKeepPinned }, h(Toggle, { checked: cfg.keepPinned, label: t.keepPinned, onChange: (v) => setField("keepPinned", v) })),
          h(SettingRow, { label: t.includeSubagents, hint: t.hintSubagents }, h(Toggle, { checked: cfg.includeSubagents, label: t.includeSubagents, onChange: (v) => setField("includeSubagents", v) })),
          h(SettingRow, { label: t.idleDays, hint: t.hintIdleDays }, h("input", { className: "dsha-input", type: "number", step: "0.5", min: "0.5", value: cfg.idleDays, onChange: (e) => setField("idleDays", e.target.value) })),
          h(SettingRow, { label: t.intervalHours, hint: t.hintInterval }, h("input", { className: "dsha-input", type: "number", step: "0.25", min: "0.25", value: cfg.intervalHours, onChange: (e) => setField("intervalHours", e.target.value) })),
          h(SettingRow, { label: t.excludeCwd, hint: t.hintExclude }, h("input", { className: "dsha-input dsha-wide", type: "text", placeholder: t.excludePlaceholder, value: excludeText, onChange: (e) => setExcludeText(e.target.value) })),

          h("div", { className: "dsha-actions" },
            h("button", { className: "dsha-btn dsha-primary", type: "button", disabled: busy === "save", onClick: onSave, children: busy === "save" ? t.saving : t.save }),
            h("button", { className: "dsha-btn", type: "button", disabled: busy === "run", onClick: onRun, children: busy === "run" ? t.running : t.runNow }),
            h("button", { className: "dsha-btn", type: "button", disabled: busy === "revert", onClick: onRevert, children: busy === "revert" ? t.reverting : t.revert }),
            msg ? h("span", { className: "dsha-msg", children: msg }) : null),

          h("div", { className: "dsha-status" },
            h("span", { className: "dsha-label", children: t.lastRun }),
            r ? h("span", { className: "dsha-hint", children: `${r.trigger || "?"} · ${fmtTime(r.at)} · ${t.scanned} ${r.scanned ?? 0} · ${r.dryRun ? t.planned : t.archived} ${r.dryRun ? (r.planned ?? 0) : (r.archived ?? 0)}${r.errors && r.errors.length ? " · " + t.errors + " " + r.errors.length : ""}${skips ? " · (" + skips + ")" : ""}` })
              : h("span", { className: "dsha-hint", children: t.never })),

          h("div", { className: "dsha-hint dsha-note", children: t.archiveHint }),

          h("div", { className: "dsha-hist" },
            h("div", { className: "dsha-hist-title" },
              h("span", { children: t.history }),
              histCount ? h("span", { className: "dsha-hist-count", children: "· " + histCount }) : null),
            history === null ? h("div", { className: "dsha-loading", children: t.historyLoading })
              : histError ? h("div", { className: "dsha-loading", children: t.historyNeedRestart })
              : history.length === 0 ? h("div", { className: "dsha-loading", children: t.historyEmpty })
                : h("ul", { className: "dsha-hist-list" }, history.map((e, i) => h("li", { key: (e.at || "") + (e.sessionId || "") + i, className: "dsha-hist-row" },
                  h("span", { className: "dsha-hist-badge dsha-hist-" + (e.action || "failed"), children: ACTION_LABEL[e.action] || e.action || "?" }),
                  h("span", { className: "dsha-hist-main" },
                    h("span", { className: "dsha-hist-name", title: e.sessionId || "", children: e.title || t.noTitle }),
                    h("span", { className: "dsha-hist-meta", children: [
                      fmtTime(e.at),
                      e.cwd ? e.cwd : null,
                      (e.idleDays !== undefined && e.idleDays !== null) ? `${e.idleDays}d` : null,
                      e.error ? String(e.error) : null,
                    ].filter(Boolean).join(" · ") })),
                  e.action === "archived" ? h("button", {
                    className: "dsha-btn dsha-hist-undo", type: "button",
                    disabled: histBusyId !== "", onClick: () => onUndoOne(e.sessionId),
                    children: histBusyId === e.sessionId ? t.undoing : t.undo,
                  }) : null)))))
        : null);
    }

    const inject = ["slots"];

    // ---- 设置页共享《插件设置》区块：与 dsh-qoder-connect / dsh-connect-* 同一套会合协议 ----
    // settings.section 是 list slot（多块并存），但子 slot 名只能声明一次、list 条目 id 只能注册一次：
    // 先到者注册容器并声明 plugin-settings.item，后到者检测到已有条目就只挂自己的 item。
    const SHARED_SECTION_SLOT = "settings.section";
    const SHARED_SECTION_ID = "plugin-settings";
    const SHARED_SECTION_ORDER = 900;
    const SHARED_ITEM_SLOT = "plugin-settings.item";
    const SHARED_SECTION_LABEL = "插件设置";

    function PluginSettingsSection(props) {
      return h("ul", {
        style: { display: "flex", flexDirection: "column", gap: 6, padding: 0, listStyle: "none" },
        children: props.renderSlot(SHARED_ITEM_SLOT, {}),
      });
    }

    function joinSharedSettingsBlock(ctx) {
      ctx.slots.inject(SHARED_SECTION_SLOT, () => {
        let disposeContainer;
        const already = (ctx.slots.entries(SHARED_SECTION_SLOT) || []).some((entry) => entry.options && entry.options.id === SHARED_SECTION_ID);
        if (!already) {
          try {
            disposeContainer = ctx.slots.register(
              {
                name: SHARED_SECTION_SLOT,
                id: SHARED_SECTION_ID,
                order: SHARED_SECTION_ORDER,
                label: () => SHARED_SECTION_LABEL,
                children: { [SHARED_ITEM_SLOT]: { kind: "list", scope: "root" } },
              },
              PluginSettingsSection
            );
          } catch (error) {
            console.error("[dsh-session-auto-archive] 共享插件设置区块注册竞争失败，改为挂载到赢家:", error);
          }
        }
        let disposeItem;
        try {
          disposeItem = ctx.slots.inject(SHARED_ITEM_SLOT, () =>
            ctx.slots.register(
              { name: SHARED_ITEM_SLOT, id: PKG, order: 40, inject: () => ({}) },
              // 卡片根本身就是 li（qoder 同款），共享区块的 ul 直接容纳它。
              () => h(AutoArchiveCard, { page: true })
            )
          );
        } catch (error) {
          console.error("[dsh-session-auto-archive] plugin-settings.item 注册失败:", error);
        }
        return () => {
          try { disposeItem && disposeItem(); } catch {}
          try { disposeContainer && disposeContainer(); } catch {}
        };
      });
    }

    function apply(ctx) {
      // 每个挂载面各有一道边界：slot API 破坏性变更只降级为 console.error，
      // 不能抛进 DSH loader 触发红色 “Failed to load plugins” 横幅。
      try {
        ctx.slots.inject("plugins.row.config", () => {
          try {
            return ctx.slots.register(
              { name: "plugins.row.config", key: PKG + "#" + ROW_ID },
              (slotProps) => (slotProps && slotProps.view === "summary" ? summaryText() : h(AutoArchiveCard, { page: true }))
            );
          } catch (error) {
            console.error("[dsh-session-auto-archive] plugins.row.config 注册失败:", error);
          }
        });
      } catch (error) {
        console.error("[dsh-session-auto-archive] plugins.row.config inject 失败:", error);
      }
      try {
        joinSharedSettingsBlock(ctx);
      } catch (error) {
        console.error("[dsh-session-auto-archive] 设置页区块挂载失败:", error);
      }
    }

    // 版式与 dsh-qoder-connect 卡片逐项对齐（0.5px border-l4 / radius16 / bg layer-3、
    // 开合态换 layer-2+label-dimmed、header 14px 16px、行底 .5px 分隔、36x20 开关、
    // 8px radius 输入与按钮）；颜色全部走主题令牌，逗号后为缺令牌时的兜底。
    const CSS = [
      ".dsha-acc{list-style:none;font-family:var(--dsh-font-family-text,inherit);color:var(--dsw-alias-label-primary,#1d1d1f);box-sizing:border-box;border-width:.5px;border-style:solid;border-color:var(--dsw-alias-border-l4,rgba(0,0,0,.14));border-radius:16px;background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.6));transition:border-color .16s, background .16s}",
      ".dsha-acc:hover{border-color:var(--dsw-alias-label-dimmed,#8a8a8e)}",
      ".dsha-opened{background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03));border-color:var(--dsw-alias-label-dimmed,#8a8a8e)}",
      ".dsha-acc-head{box-sizing:border-box;width:100%;display:flex;align-items:center;gap:12px;border:0;border-radius:12px;padding:14px 16px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;appearance:none}",
      ".dsha-acc-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#0071e3);outline-offset:-2px}",
      ".dsha-headtext{display:flex;flex:1;min-width:0;flex-direction:column;gap:4px}",
      ".dsha-acc-title{font-size:15px;line-height:1.4;font-weight:600;color:var(--dsw-alias-label-primary,#1d1d1f)}",
      ".dsha-acc-summary{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#8a8a8e)}",
      ".dsha-acc-chev{flex:none;display:flex;color:var(--dsw-alias-label-tertiary,#8a8a8e);transition:transform .16s}",
      ".dsha-chev-open{transform:rotate(180deg)}",
      ".dsha-acc-body{border-top:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));margin:0 16px;padding:12px 0 8px;display:flex;flex-direction:column;gap:12px}",
      ".dsha-row{display:flex;align-items:center;gap:12px;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));padding-bottom:10px}",
      ".dsha-rowtext{display:flex;flex:1;min-width:0;flex-direction:column;gap:2px}",
      ".dsha-label{font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary,#1d1d1f)}",
      ".dsha-hint{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#8a8a8e)}",
      ".dsha-toggle{flex:none;display:flex;width:36px;height:20px;border-radius:10px;border-width:1px;border-style:solid;border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.12));padding:1px;cursor:pointer;align-items:center;justify-content:flex-start;transition:background .16s;appearance:none;background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.2))}",
      ".dsha-on{background:var(--dsw-alias-brand-primary,#0071e3);justify-content:flex-end}",
      ".dsha-knob{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 1px 2px rgba(0,0,0,.2)}",
      ".dsha-input{box-sizing:border-box;flex:none;width:64px;padding:5px 8px;border-width:1px;border-style:solid;border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03));color:var(--dsw-alias-label-primary,#1d1d1f);font:inherit;font-size:13px;text-align:center}",
      ".dsha-wide{width:auto;flex:1;min-width:0;text-align:left}",
      ".dsha-input:focus{outline:2px solid var(--dsw-alias-brand-primary,#0071e3);outline-offset:-1px}",
      ".dsha-actions{display:flex;flex-wrap:wrap;align-items:center;gap:10px}",
      ".dsha-btn{box-sizing:border-box;padding:5px 14px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#6e6e73);font:inherit;font-size:13px;line-height:1.5;cursor:pointer;transition:background .16s, border-color .16s}",
      ".dsha-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}",
      ".dsha-primary{border-color:var(--dsw-alias-button-primary-fill,#0071e3);background:var(--dsw-alias-button-primary-fill,#0071e3);color:var(--dsw-alias-label-primary-foreground,#fff)}",
      ".dsha-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#0071e3);border-color:var(--dsw-alias-button-primary-hover,#0071e3)}",
      ".dsha-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#0071e3);outline-offset:1px}",
      ".dsha-btn:disabled{opacity:.45;cursor:not-allowed}",
      ".dsha-msg{font-size:13px;color:var(--dsw-alias-state-success-primary,#248a3d)}",
      ".dsha-status{display:flex;flex-direction:column;gap:2px;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));padding-bottom:10px}",
      ".dsha-hist{display:flex;flex-direction:column;gap:6px}",
      ".dsha-hist-title{font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary,#1d1d1f)}",
      ".dsha-hist-count{font-weight:400;color:var(--dsw-alias-label-tertiary,#8a8a8e);margin-left:4px}",
      ".dsha-hist-list{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none;max-height:280px;overflow:auto}",
      ".dsha-hist-row{display:flex;align-items:center;gap:10px;padding:6px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03))}",
      ".dsha-hist-badge{flex:none;font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;background:rgba(52,199,89,.15);color:var(--dsw-alias-state-success-primary,#248a3d)}",
      ".dsha-hist-planned{background:rgba(255,159,10,.16);color:var(--dsw-alias-state-warn-primary,#b25000)}",
      ".dsha-hist-unarchived{background:rgba(120,120,128,.15);color:var(--dsw-alias-label-secondary,#6e6e73)}",
      ".dsha-hist-failed{background:rgba(255,69,58,.14);color:var(--dsw-alias-state-error-primary,#c0392b)}",
      ".dsha-hist-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}",
      ".dsha-hist-name{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsha-hist-meta{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a8e);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsha-hist-undo{flex:none;padding:5px 10px;font-size:12px}",
      ".dsha-loading{padding:12px;color:var(--dsw-alias-label-tertiary,#8a8a8e)}",
    ].join("");

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});


