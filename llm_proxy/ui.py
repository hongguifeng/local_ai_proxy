from __future__ import annotations

import json
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

from .manager import ProxyManager, SUGGESTED_STRIP_REQUEST_FIELDS_TEXT
from .payloads import body_json_value


INDEX_HTML = r"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>LLM Proxy</title>
  <style>
    :root { color-scheme: light; --bg: #f6f7f9; --panel: #ffffff; --ink: #17202a; --muted: #657080; --line: #d9dee7; --accent: #1f7a5a; --accent-soft: #dff3eb; --danger: #b42318; }
    * { box-sizing: border-box; }
    html, body { height: 100%; overflow: hidden; }
    body { margin: 0; font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--ink); }
    button, input, textarea, select { font: inherit; }
    button { border: 1px solid var(--line); background: var(--panel); color: var(--ink); border-radius: 6px; padding: 7px 10px; cursor: pointer; }
    button.primary { background: var(--accent); color: white; border-color: var(--accent); }
    button.icon { width: 34px; height: 34px; padding: 0; display: inline-grid; place-items: center; }
    input, textarea { width: 100%; min-width: 0; border: 1px solid var(--line); border-radius: 6px; padding: 7px 8px; background: white; color: var(--ink); }
    textarea { min-height: 64px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; }
    .app { height: 100vh; display: grid; grid-template-rows: 52px 1fr; }
    header { display: flex; align-items: center; justify-content: space-between; padding: 0 18px; border-bottom: 1px solid var(--line); background: var(--panel); }
    h1 { margin: 0; font-size: 18px; letter-spacing: 0; }
    .header-actions { display: flex; align-items: center; gap: 10px; }
    .tabs { display: inline-flex; gap: 4px; padding: 3px; border: 1px solid var(--line); border-radius: 8px; background: #eef1f5; }
    .tab { border: 0; background: transparent; padding: 6px 12px; }
    .tab.active { background: white; box-shadow: 0 1px 2px rgba(0,0,0,.08); }
    .language-toggle { width: auto; min-width: 112px; border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; background: white; color: var(--ink); }
    main { min-height: 0; overflow: hidden; }
    .view { height: 100%; display: none; }
    .view.active { display: block; }
    .logs-view.active { display: grid; }
    .proxy-view { padding: 18px; overflow: auto; }
    .toolbar { display: flex; gap: 8px; align-items: center; justify-content: space-between; margin-bottom: 12px; }
    .proxy-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 360px), 1fr)); gap: 12px; }
    .proxy-card { min-width: 0; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px; display: grid; gap: 10px; }
    .proxy-head { display: flex; align-items: center; gap: 8px; justify-content: space-between; }
    .proxy-title { display: flex; align-items: center; gap: 8px; font-weight: 650; min-width: 0; }
    .proxy-title input { min-width: 0; }
    .status { width: 10px; height: 10px; border-radius: 50%; background: #a5adba; flex: 0 0 auto; }
    .status.running { background: var(--accent); }
    .switch { position: relative; width: 42px; height: 24px; flex: 0 0 auto; }
    .switch input { opacity: 0; width: 0; height: 0; }
    .slider { position: absolute; inset: 0; border-radius: 999px; background: #b8c0cc; transition: .15s; }
    .slider:before { content: ""; position: absolute; width: 18px; height: 18px; left: 3px; top: 3px; border-radius: 50%; background: white; transition: .15s; box-shadow: 0 1px 2px rgba(0,0,0,.25); }
    .switch input:checked + .slider { background: var(--accent); }
    .switch input:checked + .slider:before { transform: translateX(18px); }
    .fields { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) 100px; gap: 8px; }
    .fields.three { grid-template-columns: minmax(0, 1fr) 90px 90px; }
    .fields label { min-width: 0; }
    label { min-width: 0; display: grid; gap: 4px; color: var(--muted); font-size: 12px; }
    label span { min-width: 0; white-space: normal; overflow-wrap: anywhere; line-height: 1.35; }
    .row-actions { display: flex; gap: 8px; justify-content: flex-end; }
    .logs-view { height: 100%; grid-template-columns: var(--sidebar-w, 330px) 6px 1fr; min-height: 0; }
    .log-list { border-right: 0; background: var(--panel); min-height: 0; display: grid; grid-template-rows: auto 1fr; }
    .log-list-head { padding: 12px; border-bottom: 1px solid var(--line); display: grid; gap: 8px; }
    .log-actions { display: flex; align-items: center; gap: 8px; }
    .log-actions button { flex: 0 0 auto; }
    .auto-refresh { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; }
    .auto-refresh input { width: auto; }
    .log-items { overflow: auto; }
    .log-group { border-bottom: 1px solid var(--line); }
    .log-group-head { width: 100%; border: 0; border-radius: 0; padding: 9px 12px; background: #e8edf3; display: grid; grid-template-columns: 16px minmax(0, 1fr); gap: 3px 6px; text-align: left; }
    .log-group-caret { grid-row: 1 / span 2; color: var(--muted); }
    .log-group-title { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .log-item { width: 100%; text-align: left; border: 0; border-bottom: 1px solid var(--line); border-radius: 0; padding: 10px 12px; background: white; display: grid; gap: 3px; }
    .log-group .log-item { padding-left: 24px; }
    .log-item.active { background: var(--accent-soft); }
    .log-meta { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .log-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 400; }
    .detail { min-width: 0; min-height: 0; display: grid; grid-template-rows: var(--request-fr, 1fr) 8px var(--response-fr, 1fr); }
    .json-pane { min-height: 0; display: grid; grid-template-rows: 40px 1fr; background: #fbfcfd; }
    .pane-head { border-bottom: 1px solid var(--line); padding: 0 12px; display: flex; align-items: center; justify-content: space-between; background: var(--panel); }
    .pane-actions { display: inline-flex; gap: 6px; }
    .json-string.format-mode { white-space: pre-wrap; word-break: break-all; overflow-wrap: anywhere; background: #f0faf6; padding: 4px 8px; border-radius: 4px; margin: 2px 0; display: block; width: calc(100% - 16px); }
    .json-view { margin: 0; padding: 12px; overflow: auto; min-height: 0; font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; }
    .json-view.wrap { white-space: pre-wrap; overflow-wrap: anywhere; }
    .json-view.nowrap { white-space: pre; }
    .json-view .json-children { margin-left: 16px; }
    .json-view summary { cursor: pointer; list-style-position: outside; }
    .json-row { min-height: 18px; }
    .json-key { color: #7a3e00; }
    .json-string { color: #0b6b4f; }
    .json-number, .json-boolean { color: #1c5fb8; }
    .json-null { color: #7a6678; }
    .json-muted { color: var(--muted); }
    .json-str-detail > summary { cursor: pointer; list-style: none; user-select: none; padding: 2px 4px; border-radius: 4px; }
    .json-str-detail > summary:hover { background: #f3f6f8; }
    .json-str-detail > summary::-webkit-details-marker { display: none; }
    .json-str-detail[open] > summary { margin-bottom: 4px; }
    .json-str-full { display: grid; gap: 4px; align-items: start; }
    .json-str-copy { width: 26px; height: 26px; padding: 0; display: inline-grid; place-items: center; justify-self: start; background: var(--panel); font-size: 12px; }
    .json-str-body { margin: 0; padding: 6px 10px; background: #f8faf9; border: 1px solid var(--line); border-radius: 6px; font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; word-break: break-all; overflow-wrap: anywhere; max-height: 400px; overflow-y: auto; }
    .splitter { background: var(--line); cursor: row-resize; }
    .log-splitter { background: var(--line); cursor: col-resize; flex-shrink: 0; }
    .empty { height: 100%; display: grid; place-items: center; color: var(--muted); }
    .toast { position: fixed; right: 14px; bottom: 14px; background: #18212d; color: white; padding: 9px 12px; border-radius: 8px; opacity: 0; pointer-events: none; transition: .15s; max-width: min(420px, calc(100vw - 28px)); }
    .toast.show { opacity: 1; }
    @media (max-width: 760px) {
      .app { grid-template-rows: auto 1fr; }
      header { gap: 10px; align-items: stretch; flex-direction: column; padding: 10px 12px; }
      .header-actions { justify-content: space-between; }
      .logs-view { grid-template-columns: 1fr; grid-template-rows: 260px 1fr; }
      .log-list { border-right: 0; border-bottom: 1px solid var(--line); }
      .proxy-grid, .fields, .fields.three { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="app">
    <header>
      <h1>LLM Proxy</h1>
      <div class="header-actions">
        <div class="tabs" role="tablist">
          <button class="tab active" data-tab="proxies" data-i18n="tabProxies">监听转发</button>
          <button class="tab" data-tab="logs" data-i18n="tabLogs">历史日志</button>
        </div>
        <select id="languageSelect" class="language-toggle" data-i18n-title="language">
          <option value="zh">🇨🇳 中文</option>
          <option value="en">🇺🇸 English</option>
        </select>
      </div>
    </header>
    <main>
      <section id="proxies" class="view proxy-view active">
        <div class="toolbar">
          <strong data-i18n="proxyPairs">地址对</strong>
          <div>
            <button id="addProxy" data-i18n-title="add" title="添加">+</button>
            <button id="saveProxies" class="primary" data-i18n="saveConfig">保存配置</button>
          </div>
        </div>
        <div id="proxyGrid" class="proxy-grid"></div>
      </section>
      <section id="logs" class="view logs-view">
        <aside class="log-list">
          <div class="log-list-head">
            <input id="logSearch" data-i18n-placeholder="filterPlaceholder" placeholder="筛选 path / id / target">
            <div class="log-actions">
              <button id="refreshLogs" data-i18n="refresh">刷新</button>
              <label class="auto-refresh"><input id="autoRefreshLogs" type="checkbox" checked> <span data-i18n="autoRefresh">自动刷新</span></label>
            </div>
          </div>
          <div id="logItems" class="log-items"></div>
        </aside>
        <div id="logSplitter" class="log-splitter"></div>
        <section id="detail" class="detail">
          <div class="json-pane">
            <div class="pane-head"><strong data-i18n="request">Request</strong><span class="pane-actions"><button class="icon" data-wrap="request" data-i18n-title="toggleWrap" title="切换自动换行">↵</button><button class="icon" data-expand="request" title="展开 JSON">{}</button><button class="icon" data-format="request" data-i18n-title="formatStringContent" title="格式化字符串内容">📝</button><button class="icon" data-copy="request" data-i18n-title="copyJson" title="复制 JSON">📋</button></span></div>
            <div id="requestJson" class="json-view nowrap"></div>
          </div>
          <div id="splitter" class="splitter"></div>
          <div class="json-pane">
            <div class="pane-head"><strong data-i18n="response">Response</strong><span class="pane-actions"><button class="icon" data-wrap="response" data-i18n-title="toggleWrap" title="切换自动换行">↵</button><button class="icon" data-expand="response" title="展开 JSON">{}</button><button class="icon" data-format="response" data-i18n-title="formatStringContent" title="格式化字符串内容">📝</button><button class="icon" data-copy="response" data-i18n-title="copyJson" title="复制 JSON">📋</button></span></div>
            <div id="responseJson" class="json-view nowrap"></div>
          </div>
        </section>
      </section>
    </main>
  </div>
  <div id="toast" class="toast"></div>
  <script>
    const translations = {
      zh: {
        language: "语言",
        tabProxies: "监听转发",
        tabLogs: "历史日志",
        request: "请求",
        response: "响应",
        proxyPairs: "地址对",
        add: "添加",
        saveConfig: "保存配置",
        filterPlaceholder: "筛选 path / id / target",
        refresh: "刷新",
        autoRefresh: "自动刷新",
        toggleWrap: "切换自动换行",
        expandJson: "展开 JSON",
        collapseJson: "折叠 JSON",
        formatStringContent: "格式化字符串内容",
        copyJson: "复制 JSON",
        copiedJson: "已复制 JSON",
        copiedText: "已复制格式化文本",
        copyFailed: "复制失败",
        savedConfig: "配置已保存",
        newProxy: "新代理",
        switch: "开关",
        listenHost: "监听地址",
        port: "端口",
        targetUrl: "转发地址",
        timeoutSeconds: "超时秒数",
        readableLogDir: "可读日志目录",
        upstreamHeaders: "上游 Headers，每行一个 Name: value",
        stripFields: "转发前移除的 request 字段，逗号分隔；留空关闭",
        injectFields: "转发前注入的 request 字段，JSON object；留空关闭",
        delete: "删除",
        history: "历史记录",
        task: "任务",
        pending: "等待中",
        noLogs: "暂无日志",
        ungrouped: "未归组",
        requests: "个请求",
        items: "项",
        lines: "行",
        copyFormattedText: "复制格式化文本"
      },
      en: {
        language: "Language",
        tabProxies: "Proxy",
        tabLogs: "History",
        request: "Request",
        response: "Response",
        proxyPairs: "Proxy pairs",
        add: "Add",
        saveConfig: "Save config",
        filterPlaceholder: "Filter path / id / target",
        refresh: "Refresh",
        autoRefresh: "Auto refresh",
        toggleWrap: "Toggle line wrap",
        expandJson: "Expand JSON",
        collapseJson: "Collapse JSON",
        formatStringContent: "Format string content",
        copyJson: "Copy JSON",
        copiedJson: "Copied JSON",
        copiedText: "Copied formatted text",
        copyFailed: "Copy failed",
        savedConfig: "Config saved",
        newProxy: "New proxy",
        switch: "Enable or disable",
        listenHost: "Listen host",
        port: "Port",
        targetUrl: "Target URL",
        timeoutSeconds: "Timeout seconds",
        readableLogDir: "Readable log directory",
        upstreamHeaders: "Upstream headers, one Name: value per line",
        stripFields: "Request fields to remove before forwarding, comma-separated; leave blank to disable",
        injectFields: "Request fields to inject before forwarding, JSON object; leave blank to disable",
        delete: "Delete",
        history: "History",
        task: "Task",
        pending: "pending",
        noLogs: "No logs",
        ungrouped: "Ungrouped",
        requests: "requests",
        items: "items",
        lines: "lines",
        copyFormattedText: "Copy formatted text"
      }
    };
    const savedLanguage = localStorage.getItem("llmProxyLanguage");
    const initialLanguage = savedLanguage || ((navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en");
    const state = { language: translations[initialLanguage] ? initialLanguage : "en", pairs: [], logGroups: [], logs: [], selected: null, raw: { request: null, response: null }, wrap: { request: false, response: false }, formatStrings: { request: false, response: false }, tree: { request: true, response: true }, collapsedGroups: {}, logsLoading: false, logsLoadedAt: 0, searchTimer: null, refreshTimer: null };
    const $ = (id) => document.getElementById(id);
    const t = (key) => (translations[state.language] && translations[state.language][key]) || translations.en[key] || key;
    const toast = (text) => { const el = $("toast"); el.textContent = text; el.classList.add("show"); setTimeout(() => el.classList.remove("show"), 2400); };
    const api = async (url, options = {}) => {
      const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...options });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText);
      return data;
    };
    function applyLanguage() {
      document.documentElement.lang = state.language === "zh" ? "zh-CN" : "en";
      $("languageSelect").value = state.language;
      document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
      document.querySelectorAll("[data-i18n-title]").forEach((el) => { el.title = t(el.dataset.i18nTitle); });
      document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
      updateExpandButton("request");
      updateExpandButton("response");
    }
    function setLanguage(language) {
      if (!translations[language]) return;
      if (document.querySelector(".proxy-card")) collectPairs();
      state.language = language;
      localStorage.setItem("llmProxyLanguage", language);
      applyLanguage();
      renderPairs();
      renderLogs();
      renderJsonPane("request");
      renderJsonPane("response");
    }
    function formatLogMeta(meta) {
      const text = String(meta || "");
      return text.replace(/(\d+)\s+requests/g, (_, count) => `${count} ${t("requests")}`);
    }
    function formatStatus(status) {
      return status === undefined || status === null || status === "pending" ? t("pending") : String(status);
    }
    const suggestedStripRequestFields = __SUGGESTED_STRIP_REQUEST_FIELDS__;
    const newPair = () => ({ id: `proxy-${Date.now()}`, name: t("newProxy"), enabled: false, running: false, listen_host: "127.0.0.1", listen_port: 1234, target_url: "http://127.0.0.1:1235", target_headers: [], strip_request_fields: "", inject_request_fields: "", timeout: 600, access_log: false });
    function renderPairs() {
      $("proxyGrid").innerHTML = state.pairs.map((p, i) => `
        <article class="proxy-card" data-index="${i}">
          <div class="proxy-head">
            <div class="proxy-title"><span class="status ${p.running ? "running" : ""}"></span><input data-field="name" value="${escapeHtml(p.name || "")}"></div>
            <label class="switch" title="${escapeHtml(t("switch"))}"><input type="checkbox" data-toggle ${p.enabled ? "checked" : ""}><span class="slider"></span></label>
          </div>
          <div class="fields">
            <label><span>${escapeHtml(t("listenHost"))}</span><input data-field="listen_host" value="${escapeHtml(p.listen_host || "")}"></label>
            <label><span>${escapeHtml(t("port"))}</span><input type="number" data-field="listen_port" value="${p.listen_port || 0}"></label>
          </div>
          <label><span>${escapeHtml(t("targetUrl"))}</span><input data-field="target_url" value="${escapeHtml(p.target_url || "")}" placeholder="https://api.example.com/v1"></label>
          <div class="fields">
            <label><span>${escapeHtml(t("timeoutSeconds"))}</span><input type="number" data-field="timeout" value="${p.timeout || 600}"></label>
            <label><span>${escapeHtml(t("readableLogDir"))}</span><input data-field="readable_log_dir" value="${escapeHtml(p.readable_log_dir || "")}"></label>
          </div>
          <label><span>${escapeHtml(t("upstreamHeaders"))}</span><textarea data-field="target_headers">${escapeHtml((p.target_headers || []).join("\n"))}</textarea></label>
          <label><span>${escapeHtml(t("stripFields"))}</span><textarea data-field="strip_request_fields" placeholder="${escapeHtml(suggestedStripRequestFields)}">${escapeHtml(p.strip_request_fields ?? "")}</textarea></label>
          <label><span>${escapeHtml(t("injectFields"))}</span><textarea data-field="inject_request_fields" placeholder='{"metadata":{"source":"proxy"}}'>${escapeHtml(p.inject_request_fields ?? "")}</textarea></label>
          <div class="row-actions"><button data-remove>${escapeHtml(t("delete"))}</button></div>
        </article>`).join("");
    }
    function escapeHtml(text) { return String(text).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])); }
    function collectPairs() {
      document.querySelectorAll(".proxy-card").forEach((card) => {
        const pair = state.pairs[Number(card.dataset.index)];
        card.querySelectorAll("[data-field]").forEach((input) => {
          const field = input.dataset.field;
          let value = input.value;
          if (field === "listen_port") value = Number(value);
          if (field === "timeout") value = Number(value);
          if (field === "target_headers") value = value.split(/\n/).map((line) => line.trim()).filter(Boolean);
          if (field === "strip_request_fields" && value === "") value = "";
          if (field === "inject_request_fields" && value === "") value = "";
          pair[field] = value;
        });
      });
    }
    async function loadPairs() {
      const data = await api("/api/pairs");
      state.pairs = data.pairs;
      renderPairs();
    }
    async function savePairs() {
      collectPairs();
      const data = await api("/api/pairs", { method: "PUT", body: JSON.stringify({ pairs: state.pairs }) });
      state.pairs = data.pairs;
      renderPairs();
      toast(t("savedConfig"));
    }
    function scheduleLogRefresh(delay = 3000) {
      clearTimeout(state.refreshTimer);
      if (!$("autoRefreshLogs").checked) return;
      state.refreshTimer = setTimeout(() => {
        if (document.hidden || !$("logs").classList.contains("active")) {
          scheduleLogRefresh(delay);
          return;
        }
        loadLogs({ quiet: true }).catch((e) => toast(e.message));
      }, delay);
    }
    function logGroupsSignature(groups) {
      return (groups || []).map((group) => [
        group.id,
        group.meta,
        ...(group.logs || []).map((item) => `${item.id}:${item.timestamp}:${item.status}`)
      ].join("|")).join("\n");
    }
    function sameLogGroups(nextGroups) {
      return logGroupsSignature(state.logGroups) === logGroupsSignature(nextGroups);
    }
    async function loadLogs(options = {}) {
      if (state.logsLoading) return;
      state.logsLoading = true;
      const q = encodeURIComponent($("logSearch").value.trim());
      try {
        const data = await api(`/api/logs?q=${q}`);
        const nextGroups = data.groups || [{ id: "logs", title: t("history"), logs: data.logs || [] }];
        if (!sameLogGroups(nextGroups)) {
          state.logGroups = nextGroups;
          state.logs = state.logGroups.flatMap((group) => group.logs || []);
          renderLogs();
        }
        state.logsLoadedAt = Date.now();
      } finally {
        state.logsLoading = false;
        scheduleLogRefresh();
      }
    }
    function renderLogs() {
      $("logItems").innerHTML = state.logGroups.map((group) => `
        <section class="log-group">
          <button class="log-group-head" data-group-id="${escapeHtml(group.id || "")}">
            <span class="log-group-caret">${!state.collapsedGroups[group.id] ? "▸" : "▾"}</span>
            <span class="log-group-title">${escapeHtml(group.title === "未归组" ? t("ungrouped") : (group.title || group.id || t("task")))}</span>
            <span class="log-meta">${escapeHtml(formatLogMeta(group.meta || ""))}</span>
          </button>
          ${!state.collapsedGroups[group.id] ? "" : (group.logs || []).map((item) => `
            <button class="log-item ${state.selected === item.id ? "active" : ""}" data-log-id="${escapeHtml(item.id)}">
              <span class="log-title">${item.sequence ? `${escapeHtml("[" + item.sequence + "]")} ` : ""}${escapeHtml(item.method)} ${escapeHtml(item.path)}</span>
              <span class="log-meta">${escapeHtml(item.timestamp || "")} | ${escapeHtml(formatStatus(item.status))} | ${escapeHtml(item.target || "")}</span>
            </button>`).join("")}
        </section>`).join("") || `<div class="empty">${escapeHtml(t("noLogs"))}</div>`;
    }
    function jsonType(value) {
      if (value === null) return "null";
      if (Array.isArray(value)) return "array";
      return typeof value;
    }
    function renderJsonValue(value, key = "", root = false, formatMode = false) {
      const type = jsonType(value);
      const keyHtml = key === "" ? "" : `<span class="json-key">${escapeHtml(JSON.stringify(key))}</span>: `;
      if (type === "array" || type === "object") {
        const entries = type === "array" ? value.map((item, index) => [index, item]) : Object.entries(value);
        const start = type === "array" ? "[" : "{";
        const end = type === "array" ? "]" : "}";
        const summary = `${keyHtml}${start}<span class="json-muted">${entries.length ? ` ${entries.length} ${t("items")} ` : ""}</span>${end}`;
        const childrenHtml = `<div class="json-children">${entries.map(([childKey, childValue]) => `<div class="json-row">${renderJsonValue(childValue, String(childKey), false, formatMode)}</div>`).join("")}</div>`;
        return `<details open${root ? ' class="root"' : ''}><summary>${summary}</summary>${childrenHtml}<div class="json-muted">${end}</div></details>`;
      }
      if (type === "string") {
        if (!formatMode) return `${keyHtml}<span class="json-string">${escapeHtml(JSON.stringify(value))}</span>`;
        const shouldFormat = typeof value === 'string' && (value.indexOf(String.fromCharCode(10)) !== -1 || value.indexOf("\\") !== -1 || value.length > 200);
        if (!shouldFormat) return `${keyHtml}<span class="json-string">${escapeHtml(JSON.stringify(value))}</span>`;
        const displayValue = formatString(value);
        if (displayValue.indexOf(String.fromCharCode(10)) !== -1 || displayValue.length > 200) {
          const summary = escapeHtml(displayValue.substring(0, 150) + (displayValue.length > 150 ? "…" : ""));
          const fullLines = displayValue.split(String.fromCharCode(10)).length;
          return `${keyHtml}<details class="json-str-detail"><summary>${summary} <span class="json-muted">(${fullLines} ${t("lines")})</span></summary><div class="json-str-full"><button class="json-str-copy" data-copy-string title="${escapeHtml(t("copyFormattedText"))}">📋</button><pre class="json-str-body">${escapeHtml(displayValue)}</pre></div></details>`;
        }
        return `${keyHtml}<span class="json-string format-mode">${escapeHtml(displayValue)}</span>`;
      }
      if (type === "number") return `${keyHtml}<span class="json-number">${escapeHtml(String(value))}</span>`;
      if (type === "boolean") return `${keyHtml}<span class="json-boolean">${escapeHtml(String(value))}</span>`;
      if (type === "undefined") return `${keyHtml}<span class="json-null">undefined</span>`;
      return `${keyHtml}<span class="json-null">null</span>`;
    }
    function formatString(value) {
      if (typeof value !== "string") return value;
      return value.replace(/\\n/g, String.fromCharCode(10))
                  .replace(/\\r/g, String.fromCharCode(13))
                  .replace(/\\t/g, '    ')
                  .replace(/\\b/g, '\b')
                  .replace(/\\f/g, '\f')
                  .replace(/\\"/g, '"')
                  .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    }
    function jsonText(value) {
      const text = JSON.stringify(value, null, 2);
      return text === undefined ? "undefined" : text;
    }
    function renderJsonPane(key) {
      const el = $(key + "Json");
      el.classList.toggle("wrap", state.wrap[key]);
      el.classList.toggle("nowrap", !state.wrap[key]);
      if (state.tree[key]) {
        el.innerHTML = renderJsonValue(state.raw[key], "", true, state.formatStrings[key]);
      } else {
        el.textContent = jsonText(state.raw[key]);
      }
      updateExpandButton(key);
    }
    function updateExpandButton(key) {
      const button = document.querySelector(`[data-expand="${key}"]`);
      if (!button) return;
      const details = Array.from($(key + "Json").querySelectorAll("details"));
      const allOpen = details.length > 0 && details.every((detail) => detail.open);
      button.title = allOpen ? t("collapseJson") : t("expandJson");
    }
    async function selectLog(id) {
      state.selected = id;
      renderLogs();
      const data = await api(`/api/logs/${encodeURIComponent(id)}`);
      state.raw.request = data.request;
      state.raw.response = data.response;
      state.tree.request = true;
      state.tree.response = true;
      renderJsonPane("request");
      renderJsonPane("response");
    }
    document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => {
      document.querySelectorAll(".tab, .view").forEach((el) => el.classList.remove("active"));
      tab.classList.add("active"); $(tab.dataset.tab).classList.add("active");
      if (tab.dataset.tab === "logs") loadLogs().catch((e) => toast(e.message));
    }));
    $("languageSelect").addEventListener("change", (event) => setLanguage(event.target.value));
    $("addProxy").addEventListener("click", () => { state.pairs.push(newPair()); renderPairs(); });
    $("saveProxies").addEventListener("click", () => savePairs().catch((e) => toast(e.message)));
    $("proxyGrid").addEventListener("click", (event) => {
      const card = event.target.closest(".proxy-card");
      if (!card) return;
      if (event.target.matches("[data-remove]")) { state.pairs.splice(Number(card.dataset.index), 1); renderPairs(); }
    });
    $("proxyGrid").addEventListener("change", async (event) => {
      if (!event.target.matches("[data-toggle]")) return;
      collectPairs();
      await savePairs();
      const pair = state.pairs[Number(event.target.closest(".proxy-card").dataset.index)];
      const data = await api(`/api/pairs/${encodeURIComponent(pair.id)}/enabled`, { method: "POST", body: JSON.stringify({ enabled: event.target.checked }) });
      Object.assign(pair, data.pair);
      renderPairs();
    });
    $("refreshLogs").addEventListener("click", () => loadLogs().catch((e) => toast(e.message)));
    $("autoRefreshLogs").addEventListener("change", () => scheduleLogRefresh(250));
    $("logSearch").addEventListener("input", () => {
      clearTimeout(state.searchTimer);
      state.searchTimer = setTimeout(() => loadLogs().catch((e) => toast(e.message)), 180);
    });
    $("logItems").addEventListener("click", (event) => {
      const group = event.target.closest("[data-group-id]");
      if (group) {
        const groupId = group.dataset.groupId;
        state.collapsedGroups[groupId] = !state.collapsedGroups[groupId];
        renderLogs();
        return;
      }
      const item = event.target.closest("[data-log-id]");
      if (item) selectLog(item.dataset.logId).catch((e) => toast(e.message));
    });
    document.querySelectorAll("[data-wrap]").forEach((button) => button.addEventListener("click", () => {
      const key = button.dataset.wrap;
      state.wrap[key] = !state.wrap[key];
      renderJsonPane(key);
    }));
    document.querySelectorAll("[data-expand]").forEach((button) => button.addEventListener("click", () => {
      const key = button.dataset.expand;
      state.tree[key] = true;
      if ($(key + "Json").querySelectorAll("details").length === 0) renderJsonPane(key);
      const details = Array.from($(key + "Json").querySelectorAll("details"));
      const shouldOpen = !details.length || details.some((detail) => !detail.open);
      details.forEach((detail) => {
        const parentDetail = detail.parentElement ? detail.parentElement.closest("details") : null;
        detail.open = shouldOpen || detail.classList.contains("root") || parentDetail?.classList.contains("root");
      });
      updateExpandButton(key);
    }));
    ["request", "response"].forEach((key) => {
      $(key + "Json").addEventListener("toggle", () => updateExpandButton(key), true);
      $(key + "Json").addEventListener("click", (event) => {
        const button = event.target.closest("[data-copy-string]");
        if (!button) return;
        const body = button.closest(".json-str-full")?.querySelector(".json-str-body");
        if (!body) return;
        navigator.clipboard.writeText(body.textContent || "").then(
          () => toast(t("copiedText")),
          () => toast(t("copyFailed"))
        );
      });
    });
    document.querySelectorAll("[data-format]").forEach((button) => button.addEventListener("click", () => {
      const key = button.dataset.format;
      state.formatStrings[key] = !state.formatStrings[key];
      renderJsonPane(key);
    }));
    document.querySelectorAll("[data-copy]").forEach((button) => button.addEventListener("click", () => {
      const key = button.dataset.copy;
      if (key && state.raw[key] !== null) {
        navigator.clipboard.writeText(JSON.stringify(state.raw[key], null, 2)).then(
          () => toast(t("copiedJson")),
          () => toast(t("copyFailed"))
        );
      }
    }));
    (() => {
      const detail = $("detail"), splitter = $("splitter");
      let dragging = false;
      splitter.addEventListener("pointerdown", (e) => { dragging = true; splitter.setPointerCapture(e.pointerId); });
      splitter.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const rect = detail.getBoundingClientRect();
        const top = Math.max(120, Math.min(rect.height - 120, e.clientY - rect.top));
        detail.style.setProperty("--request-fr", `${top}px`);
        detail.style.setProperty("--response-fr", `${rect.height - top - 8}px`);
      });
      splitter.addEventListener("pointerup", () => { dragging = false; });
    })();
    (() => {
      const logsView = $("logs"), logSplitter = $("logSplitter");
      let dragging = false;
      logSplitter.addEventListener("pointerdown", (e) => { dragging = true; logSplitter.setPointerCapture(e.pointerId); });
      logSplitter.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const rect = logsView.getBoundingClientRect();
        const minW = 200, maxW = rect.width * 0.8;
        const w = Math.max(minW, Math.min(maxW, e.clientX - rect.left));
        logsView.style.setProperty("--sidebar-w", `${w}px`);
      });
      logSplitter.addEventListener("pointerup", () => { dragging = false; });
    })();
    applyLanguage();
    loadPairs().catch((e) => toast(e.message));
  </script>
</body>
</html>""".replace(
    "__SUGGESTED_STRIP_REQUEST_FIELDS__",
    json.dumps(SUGGESTED_STRIP_REQUEST_FIELDS_TEXT),
)


class AdminHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    @property
    def manager(self) -> ProxyManager:
        return self.server.manager  # type: ignore[attr-defined]

    def do_GET(self) -> None:
        parsed = urlsplit(self.path)
        if parsed.path == "/":
            self._send_html(INDEX_HTML)
            return
        if parsed.path == "/api/pairs":
            self._send_json({"pairs": self.manager.list_pairs()})
            return
        if parsed.path == "/api/logs":
            query = parse_qs(parsed.query).get("q", [""])[0]
            self._send_json({"groups": self._list_log_groups(query), "logs": self._list_logs(query)})
            return
        if parsed.path.startswith("/api/logs/"):
            record_id = parsed.path.rsplit("/", 1)[-1]
            record = self._find_log(record_id)
            if not record:
                self._send_json({"error": "Log record not found."}, HTTPStatus.NOT_FOUND)
                return
            self._send_json(self._record_detail(record))
            return
        self._send_json({"error": "Not found."}, HTTPStatus.NOT_FOUND)

    def do_PUT(self) -> None:
        if urlsplit(self.path).path != "/api/pairs":
            self._send_json({"error": "Not found."}, HTTPStatus.NOT_FOUND)
            return
        payload = self._read_json()
        pairs = payload.get("pairs")
        if not isinstance(pairs, list):
            self._send_json({"error": "Expected pairs list."}, HTTPStatus.BAD_REQUEST)
            return
        try:
            updated = self.manager.replace_pairs([pair for pair in pairs if isinstance(pair, dict)])
        except Exception as exc:  # noqa: BLE001
            self._send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
            return
        self._send_json({"pairs": updated})

    def do_POST(self) -> None:
        parsed = urlsplit(self.path)
        if parsed.path.startswith("/api/pairs/") and parsed.path.endswith("/enabled"):
            pair_id = parsed.path.split("/")[-2]
            payload = self._read_json()
            try:
                pair = self.manager.set_enabled(pair_id, bool(payload.get("enabled")))
            except Exception as exc:  # noqa: BLE001
                self._send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
                return
            self._send_json({"pair": pair})
            return
        self._send_json({"error": "Not found."}, HTTPStatus.NOT_FOUND)

    def log_message(self, fmt: str, *args: object) -> None:
        return

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            return {}
        try:
            loaded = json.loads(self.rfile.read(length).decode("utf-8"))
        except json.JSONDecodeError:
            return {}
        return loaded if isinstance(loaded, dict) else {}

    def _send_html(self, html: str) -> None:
        data = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)
        self.close_connection = True

    def _send_json(self, payload: object, status: HTTPStatus = HTTPStatus.OK) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(int(status))
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)
        self.close_connection = True

    def _readable_roots(self) -> list[Path]:
        paths = []
        if self.manager.readable_log_dir:
            paths.append(self.manager.readable_log_dir)
        for pair in self.manager.list_pairs():
            raw_path = pair.get("readable_log_dir")
            if raw_path:
                paths.append(Path(str(raw_path)))
        return list(dict.fromkeys(paths))

    def _iter_finished_records(self) -> list[dict[str, Any]]:
        records = []
        for root in self._readable_roots():
            if not root.exists():
                continue
            for path in root.iterdir():
                if not path.is_dir() or path.name == "tasks" or path.name.startswith("."):
                    continue
                record = self._read_readable_record(path)
                if record:
                    records.append(record)
        return records

    def _logs_signature(self) -> tuple[tuple[str, int, int], ...]:
        signature: list[tuple[str, int, int]] = []
        for root in self._readable_roots():
            if not root.exists():
                signature.append((str(root), 0, 0))
                continue
            candidates = [root, root.parent / "tasks"]
            try:
                candidates.extend(path for path in root.iterdir() if path.is_dir() and not path.name.startswith("."))
            except OSError:
                pass
            tasks_root = root.parent / "tasks"
            if tasks_root.exists():
                try:
                    for task_path in tasks_root.iterdir():
                        if not task_path.is_dir() or task_path.name.startswith("."):
                            continue
                        candidates.append(task_path)
                        candidates.extend(path for path in task_path.iterdir() if path.is_dir() and not path.name.startswith("."))
                except OSError:
                    pass
            for path in candidates:
                try:
                    stat = path.stat()
                except OSError:
                    continue
                signature.append((str(path), stat.st_mtime_ns, stat.st_size))
                if path.is_dir():
                    try:
                        newest_markdown = max(path.glob("*.md"), key=lambda item: item.stat().st_mtime_ns, default=None)
                    except OSError:
                        newest_markdown = None
                    if newest_markdown is not None:
                        try:
                            md_stat = newest_markdown.stat()
                        except OSError:
                            continue
                        signature.append((str(newest_markdown), md_stat.st_mtime_ns, md_stat.st_size))
        return tuple(sorted(signature))

    def _log_snapshot(self) -> dict[str, Any]:
        signature = self._logs_signature()
        with self.server.log_cache_lock:  # type: ignore[attr-defined]
            if signature == self.server.log_cache_signature:  # type: ignore[attr-defined]
                return self.server.log_cache  # type: ignore[attr-defined]
            snapshot = self._build_log_snapshot()
            self.server.log_cache_signature = signature  # type: ignore[attr-defined]
            self.server.log_cache = snapshot  # type: ignore[attr-defined]
            return snapshot

    def _load_task_meta_map(self, root: Path) -> dict[str, dict[str, Any]]:
        """Load task model/kind from .task-index.json for a readable root.

        Falls back to parsing the directory name when index entry is missing
        or does not match actual disk dirs (e.g. after dir renames).
        New format: ``{date}__{start_time}__{end_time}__{model}__{kind}__fp-hash``.
        """
        import json
        result: dict[str, dict[str, Any]] = {}

        # 1) Try reading from .task-index.json first (most accurate).
        index_path = root.parent / ".task-index.json"
        if index_path.exists():
            try:
                data = json.loads(index_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                pass
            else:
                tasks = data.get("tasks", {}) or {}
                for task_id, task in tasks.items():
                    if not isinstance(task, dict):
                        continue
                    dir_name = str(task.get("dir_name") or "")
                    # Index may still hold an old dir_name; record anyway.
                    result[dir_name] = {
                        "model": task.get("model"),
                        "kind": task.get("kind"),
                    }

        # 2) Also scan actual dirs on disk and parse model from name if possible.
        tasks_root = root.parent / "tasks"
        if tasks_root.exists():
            for task_path in self._iter_dirs(tasks_root):
                parts = task_path.name.split("__")
                # New format: date, start_time, end_time, model, kind, fp-hash (6 parts)
                if len(parts) >= 6 and not result.get(task_path.name):
                    model_candidate = parts[3]
                    if model_candidate and "/" not in model_candidate and chr(92) not in model_candidate:
                        # Looks like a model name, not another time segment.
                        result[task_path.name] = {"model": model_candidate, "kind": parts[4]}

        return result

    def _task_group_title(self, dir_name: str) -> str:
        parts = dir_name.split("__")
        if len(parts) < 3:
            return dir_name
        date_part, start_time, end_time = parts[:3]
        if not self._looks_like_log_date(date_part) or not self._looks_like_log_time(start_time) or not self._looks_like_log_time(end_time):
            return dir_name
        return f"{date_part} {self._display_log_time(start_time)} - {self._display_log_time(end_time)}"

    def _looks_like_log_date(self, value: str) -> bool:
        parts = value.split("-")
        return len(parts) in {2, 3} and all(part.isdigit() and len(part) in {2, 4} for part in parts)

    def _looks_like_log_time(self, value: str) -> bool:
        time_part, dot, milliseconds = value.partition(".")
        parts = time_part.split("-")
        return len(parts) == 3 and all(part.isdigit() and len(part) == 2 for part in parts) and (not dot or milliseconds.isdigit())

    def _display_log_time(self, value: str) -> str:
        return value.replace("-", ":")

    def _build_log_snapshot(self) -> dict[str, Any]:
        groups = []
        ungrouped_records = []
        task_record_ids: set[str] = set()
        by_id: dict[str, dict[str, Any]] = {}

        for root in self._readable_roots():
            if not root.exists():
                continue
            tasks_root = root.parent / "tasks"
            if tasks_root.exists():
                for task_path in self._iter_dirs(tasks_root):
                    logs = []
                    for request_path in self._iter_dirs(task_path):
                        record = self._read_readable_record(request_path, include_body=False)
                        if not record:
                            continue
                        record["_task_dir"] = task_path.name
                        item = self._log_item(record)
                        logs.append(item)
                        record_id = str(item.get("id"))
                        task_record_ids.add(record_id)
                        by_id[record_id] = {"path": request_path, "task_dir": task_path.name}
                    if not logs:
                        continue
                    logs.sort(key=lambda item: str(item.get("_sort_key") or item.get("timestamp") or ""), reverse=True)
                    groups.append(
                        {
                            "id": task_path.name,
                            "title": self._task_group_title(task_path.name),
                            "meta": f"{len(logs)} requests",
                            "logs": logs,
                        }
                    )
            for path in self._iter_dirs(root):
                if path.name == "tasks":
                    continue
                record = self._read_readable_record(path, include_body=False)
                if not record:
                    continue
                record_id = str(record.get("id"))
                by_id.setdefault(record_id, {"path": path, "task_dir": None})
                if record_id not in task_record_ids:
                    ungrouped_records.append(record)

        groups.sort(
            key=lambda group: max((str(item.get("_sort_key") or item.get("timestamp") or "") for item in group["logs"]), default=""),
            reverse=True,
        )
        ungrouped = [self._log_item(record) for record in ungrouped_records]
        ungrouped.sort(key=lambda item: str(item.get("_sort_key") or item.get("timestamp") or ""), reverse=True)
        return {"groups": groups, "ungrouped": ungrouped, "by_id": by_id}

    def _iter_dirs(self, root: Path) -> list[Path]:
        try:
            return [path for path in root.iterdir() if path.is_dir() and not path.name.startswith(".")]
        except OSError:
            return []

    def _iter_task_groups(self) -> list[dict[str, Any]]:
        groups = []
        for root in self._readable_roots():
            # Load model/kind metadata from .task-index.json once per readable root.
            task_meta_map_itg: dict[str, dict[str, Any]] = {}
            tasks_root_check = root.parent / "tasks"
            if tasks_root_check.exists():
                task_meta_map_itg = self._load_task_meta_map(root)
            tasks_root = root.parent / "tasks"
            if not tasks_root.exists():
                continue
            for task_path in tasks_root.iterdir():
                if not task_path.is_dir() or task_path.name.startswith("."):
                    continue
                logs = []
                for request_path in task_path.iterdir():
                    if not request_path.is_dir() or request_path.name.startswith("."):
                        continue
                    record = self._read_readable_record(request_path)
                    if record:
                        record["_task_dir"] = task_path.name
                        logs.append(self._log_item(record))
                if not logs:
                    continue
                logs.sort(key=lambda item: str(item.get("_sort_key") or item.get("timestamp") or ""), reverse=True)
                meta_parts_itg = [f"{len(logs)} requests"]
                task_meta_itg = task_meta_map_itg.get(task_path.name) or {}
                model_name_itg = task_meta_itg.get("model")
                if isinstance(model_name_itg, str) and model_name_itg.strip():
                    display_model_itg = model_name_itg.rsplit("/", 1)[-1].rsplit(chr(92), 1)[-1]
                    meta_parts_itg.insert(0, display_model_itg)
                groups.append(
                    {
                        "id": task_path.name,
                        "title": self._task_group_title(task_path.name),
                        "meta": " | ".join(meta_parts_itg),
                        "_record_ids": [str(item.get("id")) for item in logs],
                        "logs": logs,
                    }
                )
        groups.sort(
            key=lambda group: max((str(item.get("_sort_key") or item.get("timestamp") or "") for item in group["logs"]), default=""),
            reverse=True,
        )
        return groups

    def _read_readable_record(self, path: Path, include_body: bool = True) -> dict[str, Any] | None:
        markdown_files = sorted(path.glob("*.md"), key=lambda item: item.stat().st_mtime, reverse=True)
        if not markdown_files:
            return None
        metadata = self._markdown_metadata(markdown_files[0])
        request_text = str(metadata.get("Request") or "")
        request_method, _, request_path = request_text.partition(" ")
        response_status = self._parse_status(metadata.get("Response"))
        dir_timestamp, dir_sort_key = self._timestamp_from_record_dir(path)
        record: dict[str, Any] = {
            "id": metadata.get("id") or path.name,
            "timestamp": dir_timestamp or metadata.get("Time"),
            "event": metadata.get("Event"),
            "request": {
                "method": request_method,
                "path": request_path,
            },
            "response": {
                "status": response_status,
            },
            "_target_text": metadata.get("Target") or "",
            "_readable_path": str(path),
            "_dir_sequence": self._record_dir_sequence(path),
            "_sort_key": dir_sort_key or dir_timestamp or metadata.get("Time") or "",
        }
        if include_body:
            record["request"]["body_json"] = self._read_json_file(path / "request.json")
            record["response"]["body_json"] = self._read_json_file(path / "response.json")
        return record

    def _record_dir_sequence(self, path: Path) -> str:
        if path.parent.parent.name != "tasks":
            return ""
        sequence, _, _ = path.name.partition("__")
        return sequence if sequence.isdigit() else ""

    def _timestamp_from_record_dir(self, path: Path) -> tuple[str | None, str | None]:
        parts = path.name.split("__")
        date_part: str | None = None
        time_part: str | None = None
        if path.parent.parent.name == "tasks":
            task_parts = path.parent.name.split("__")
            if task_parts:
                date_part = task_parts[0]
            if len(parts) >= 2:
                time_part = parts[1]
        elif len(parts) >= 2:
            date_part = parts[0]
            time_part = parts[1]
        if not date_part or not time_part:
            return None, None
        display_time = time_part.replace("-", ":")
        return f"{date_part} {display_time}", f"{date_part}__{time_part}"

    def _markdown_metadata(self, path: Path) -> dict[str, object]:
        metadata: dict[str, object] = {}
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError:
            return metadata
        for line in lines:
            if line.startswith("# LLM Interaction "):
                metadata["id"] = line.removeprefix("# LLM Interaction ").strip()
            if not line.startswith("- "):
                continue
            key, separator, value = line[2:].partition(": ")
            if separator:
                metadata[key] = value
        return metadata

    def _read_json_file(self, path: Path) -> object:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None

    def _parse_status(self, value: object) -> object:
        if value in {None, "", "None"}:
            return None
        try:
            return int(str(value))
        except ValueError:
            return value

    def _record_matches_terms(self, record: dict[str, Any], terms: list[str]) -> bool:
        if not terms:
            return True
        request = record.get("request") if isinstance(record.get("request"), dict) else {}
        response = record.get("response") if isinstance(record.get("response"), dict) else {}
        target = record.get("target") if isinstance(record.get("target"), dict) else {}
        target_text = str(record.get("_target_text") or f"{target.get('scheme')}://{target.get('host')}:{target.get('port')}{target.get('path')}")
        haystack = " ".join(
            str(value).lower()
            for value in [
                record.get("id"),
                record.get("_task_dir"),
                request.get("method"),
                request.get("path"),
                response.get("status"),
                target_text,
            ]
        )
        return all(term in haystack for term in terms)

    def _log_item(self, record: dict[str, Any]) -> dict[str, Any]:
        request = record.get("request") if isinstance(record.get("request"), dict) else {}
        response = record.get("response") if isinstance(record.get("response"), dict) else {}
        target = record.get("target") if isinstance(record.get("target"), dict) else {}
        target_text = str(record.get("_target_text") or f"{target.get('scheme')}://{target.get('host')}:{target.get('port')}{target.get('path')}")
        return {
            "id": record.get("id"),
            "timestamp": record.get("timestamp"),
            "_sort_key": record.get("_sort_key"),
            "sequence": record.get("_dir_sequence", ""),
            "method": request.get("method", ""),
            "path": request.get("path", ""),
            "status": response.get("status"),
            "target": target_text,
        }

    def _list_logs(self, query: str) -> list[dict[str, Any]]:
        terms = query.lower().split()
        snapshot = self._log_snapshot()
        items = [
            item
            for item in snapshot.get("ungrouped", [])
            if self._log_item_matches_terms(item, {"id": "ungrouped", "title": "未归组"}, terms)
        ]
        items.sort(key=lambda item: str(item.get("_sort_key") or item.get("timestamp") or ""), reverse=True)
        return items[:500]

    def _list_log_groups(self, query: str) -> list[dict[str, Any]]:
        terms = query.lower().split()
        snapshot = self._log_snapshot()
        # Build model lookup from .task-index.json once for all groups.
        task_meta_map_list: dict[str, dict[str, Any]] = {}
        for root in self._readable_roots():
            if not root.exists():
                continue
            loaded = self._load_task_meta_map(root)
            task_meta_map_list.update(loaded)
        groups = []
        for group in snapshot.get("groups", []):
            filtered_logs = []
            for item in group["logs"]:
                if self._log_item_matches_terms(item, group, terms):
                    filtered_logs.append(item)
            if filtered_logs:
                visible_group = {key: value for key, value in group.items() if not key.startswith("_")}
                visible_group["logs"] = filtered_logs[:200]
                filter_parts = [f"{len(filtered_logs)} requests"]
                vis_task_meta = task_meta_map_list.get(group.get("id", "")) or {}
                vis_model = vis_task_meta.get("model")
                if isinstance(vis_model, str) and vis_model.strip():
                    display_v = vis_model.rsplit("/", 1)[-1].rsplit(chr(92), 1)[-1]
                    filter_parts.insert(0, display_v)
                visible_group["meta"] = " | ".join(filter_parts)
                groups.append(visible_group)

        ungrouped = [
            item
            for item in snapshot.get("ungrouped", [])
            if self._log_item_matches_terms(item, {"id": "ungrouped", "title": "未归组"}, terms)
        ]
        ungrouped.sort(key=lambda item: str(item.get("_sort_key") or item.get("timestamp") or ""), reverse=True)
        if ungrouped:
            groups.append({"id": "ungrouped", "title": "未归组", "meta": f"{len(ungrouped)} requests", "logs": ungrouped[:200]})
        return groups[:100]

    def _log_item_matches_terms(self, item: dict[str, Any], group: dict[str, Any], terms: list[str]) -> bool:
        if not terms:
            return True
        haystack = " ".join(
            str(value).lower()
            for value in [
                group.get("id"),
                group.get("title"),
                item.get("id"),
                item.get("method"),
                item.get("path"),
                item.get("status"),
                item.get("target"),
            ]
        )
        return all(term in haystack for term in terms)

    def _find_log(self, record_id: str) -> dict[str, Any] | None:
        snapshot = self._log_snapshot()
        found = snapshot.get("by_id", {}).get(record_id)
        if isinstance(found, dict) and isinstance(found.get("path"), Path):
            record = self._read_readable_record(found["path"], include_body=True)
            if record and found.get("task_dir"):
                record["_task_dir"] = found["task_dir"]
            if record:
                return record
        for root in self._readable_roots():
            tasks_root = root.parent / "tasks"
            if not tasks_root.exists():
                continue
            for task_path in tasks_root.iterdir():
                if not task_path.is_dir() or task_path.name.startswith("."):
                    continue
                for request_path in task_path.iterdir():
                    if not request_path.is_dir() or request_path.name.startswith("."):
                        continue
                    record = self._read_readable_record(request_path)
                    if record and str(record.get("id")) == record_id:
                        record["_task_dir"] = task_path.name
                        return record
        for record in self._iter_finished_records():
            if str(record.get("id")) == record_id:
                return record
        return None

    def _record_detail(self, record: dict[str, Any]) -> dict[str, Any]:
        request = dict(record.get("request") or {})
        response = dict(record.get("response") or {})
        if "body_json" not in request and isinstance(request.get("body"), dict):
            request["body_json"] = body_json_value(request["body"])
        if "body_json" not in response and isinstance(response.get("body"), dict):
            response["body_json"] = body_json_value(response["body"])
        return {"id": record.get("id"), "request": request, "response": response, "record": record}


class AdminServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, listen: tuple[str, int], manager: ProxyManager) -> None:
        super().__init__(listen, AdminHandler)
        self.manager = manager
        self.log_cache_lock = threading.Lock()
        self.log_cache_signature: tuple[tuple[str, int, int], ...] | None = None
        self.log_cache: dict[str, Any] = {"groups": [], "ungrouped": [], "by_id": {}}


def serve_admin(host: str, port: int, manager: ProxyManager) -> None:
    manager.start_enabled()
    server = AdminServer((host, port), manager)
    try:
        server.serve_forever()
    finally:
        manager.stop_all()
        server.server_close()
