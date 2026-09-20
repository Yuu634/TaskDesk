'use strict';
const path = require('node:path');
const { atomic, read, id, assert, orderedTasks } = require('./core.cjs');
const { call, targetFor, label, verifyPane, shellReady } = require('./herdr-execution.cjs');
const { shellQuote } = require('./executor.cjs');

class HerdrBindings {
  constructor(dir, invoke = call) {
    this.file = path.join(dir, 'herdr-bindings.json'); this.call = invoke;
    this.data = read(this.file, { version: 1, owner: id(), targets: {} });
    this.queue = Promise.resolve(); this.errors = {}; this.syncing = new Set(); this.pendingSync = new Map();
  }
  save() { atomic(this.file, this.data); }
  exclusive(fn) { const next = this.queue.then(fn); this.queue = next.catch(() => {}); return next; }
  target(tree) { return targetFor(tree.herdrSession || 'default'); }
  entry(tree) {
    const session = this.target(tree).session;
    const target = this.data.targets[session] ||= { trees: {} };
    return target.trees[tree.id] ||= { bindingId: id(), nodes: {} };
  }
  async workspace(tree, trees) {
    const target = this.target(tree), entry = this.entry(tree);
    const listing = await this.call(target, ['workspace', 'list']);
    const spaces = listing.workspaces || [];
    let space = entry.workspaceId && spaces.find(w => w.workspace_id === entry.workspaceId);
    if (space) assert(space.tokens?.wt_owner === this.data.owner && space.tokens?.wt_binding === entry.bindingId, 'herdr Space の所有関係が変わりました');
    if (!space && entry.creating) {
      space = spaces.find(w => w.tokens?.wt_binding === entry.bindingId && w.tokens?.wt_owner === this.data.owner);
      assert(space, 'Space 作成結果が不明です。herdr 側を確認してください（自動再作成しません）');
    }
    if (!space) {
      entry.creating = true; this.save();
      const made = await this.call(target, ['workspace', 'create', '--cwd', path.resolve(__dirname, '..'), '--label', label(tree.name, tree.id, trees), '--no-focus']);
      entry.workspaceId = made.workspace.workspace_id;
      entry.managementPaneId = made.root_pane.pane_id;
      entry.managementTerminalId = made.root_pane.terminal_id;
      entry.managementTabId = made.tab.tab_id; entry.managementOpened = false; entry.nodes = {}; this.save();
      await this.call(target, ['workspace', 'report-metadata', entry.workspaceId, '--source', 'work-tree:binding', '--token', 'wt_owner=' + this.data.owner, '--token', 'wt_binding=' + entry.bindingId]);
      await this.call(target, ['pane', 'report-metadata', entry.managementPaneId, '--source', 'work-tree:binding', '--token', 'wt_owner=' + this.data.owner, '--token', 'wt_binding=' + entry.bindingId]);
    } else entry.workspaceId = space.workspace_id;
    entry.creating = false; this.save();
    await this.call(target, ['workspace', 'rename', entry.workspaceId, label(tree.name, tree.id, trees)]);
    return { target, entry };
  }
  async node(tree, node, target, entry, forExecution = false) {
    let binding = entry.nodes[node.id];
    const panes = (await this.call(target, ['pane', 'list', '--workspace', entry.workspaceId])).panes || [];
    if (binding?.paneId && panes.some(p => p.pane_id === binding.paneId)) {
      await verifyPane(target, binding, this.call);
      if (forExecution) {
        const info = (await this.call(target, ['pane', 'process-info', '--pane', binding.paneId])).process_info;
        // Completed native sessions stay open for follow-up. A fresh run gets a
        // fresh pane so its launch settings cannot inherit an earlier session.
        if (info?.foreground_process_group_id !== info?.shell_pid) binding = null;
      }
    } else { assert(!binding?.creating, 'ノードペインの作成結果が不明です。herdr を確認してください'); binding = null; }
    if (!binding) {
      binding = entry.nodes[node.id] = { bindingId: id(), owner: this.data.owner, workspaceId: entry.workspaceId, creating: true };
      binding.agentAlias = 'wt-' + binding.bindingId.replace(/-/g, '').slice(0, 28); this.save();
      const made = await this.call(target, ['tab', 'create', '--workspace', entry.workspaceId, '--cwd', path.resolve(__dirname, '..'), '--label', label(node.title, node.id, tree.nodes), '--no-focus']);
      Object.assign(binding, { paneId: made.root_pane.pane_id, terminalId: made.root_pane.terminal_id, tabId: made.tab.tab_id }); this.save();
      await this.call(target, ['pane', 'report-metadata', binding.paneId, '--source', 'work-tree:binding', '--token', 'wt_owner=' + this.data.owner, '--token', 'wt_binding=' + binding.bindingId]);
      binding.creating = false; this.save();
    }
    const title = label(node.title, node.id, tree.nodes);
    await this.call(target, ['tab', 'rename', binding.tabId, title]);
    await this.call(target, ['pane', 'rename', binding.paneId, title]);
    await this.call(target, ['pane', 'report-metadata', binding.paneId, '--source', 'work-tree:display', '--display-agent', title]);
    binding.agentKind = node.tool || tree.tool; binding.lastSyncedRevision = tree.revision; this.save();
    return binding;
  }
  async prepare(tree, snapshot, trees) {
    return this.exclusive(async () => {
      const { target, entry } = await this.workspace(tree, trees), nodes = {};
      for (const selected of orderedTasks(snapshot)) nodes[selected.id] = structuredClone(await this.node(tree, tree.nodes.find(n => n.id === selected.id), target, entry, true));
      delete this.errors[tree.id]; return { target, nodes };
    });
  }
  async sync(tree, trees) {
    const entry = this.data.targets[tree.herdrSession || 'default']?.trees[tree.id];
    if (!entry?.workspaceId) return;
    this.pendingSync.set(tree.id, { tree, trees });
    if (this.syncing.has(tree.id)) return;
    this.syncing.add(tree.id);
    return this.exclusive(async () => {
      try {
        while (this.pendingSync.has(tree.id)) {
          const current = this.pendingSync.get(tree.id); this.pendingSync.delete(tree.id);
          const { target, entry: currentEntry } = await this.workspace(current.tree, current.trees);
          for (const node of current.tree.nodes.filter(n => currentEntry.nodes[n.id])) await this.node(current.tree, node, target, currentEntry);
          delete this.errors[tree.id];
        }
      } catch (e) { this.errors[tree.id] = e.message; }
      finally { this.syncing.delete(tree.id); }
    });
  }
  async open(tree, trees, url) {
    return this.exclusive(async () => {
      const { target, entry } = await this.workspace(tree, trees);
      const pane = (await this.call(target, ['pane', 'get', entry.managementPaneId])).pane;
      assert(pane?.terminal_id === entry.managementTerminalId && pane.tokens?.wt_owner === this.data.owner && pane.tokens?.wt_binding === entry.bindingId, '管理ペインの所有関係が変わりました');
      if (entry.managementOpened) {
        const info = (await this.call(target, ['pane', 'process-info', '--pane', entry.managementPaneId])).process_info;
        if (info?.shell_pid && info.foreground_process_group_id === info.shell_pid) entry.managementOpened = false;
      }
      if (!entry.managementOpened) {
        await shellReady(target, entry.managementPaneId, this.call);
        entry.managementOpened = true; this.save();
        await this.call(target, ['tab', 'rename', entry.managementTabId, 'タスクツリー']);
        const argv = [process.execPath, path.join(__dirname, '../scripts/task-tree.cjs'), '--url', url, '--tree', tree.id, '--no-report'];
        await this.call(target, ['pane', 'run', entry.managementPaneId, argv.map(shellQuote).join(' ')]);
      }
      return { workspaceId: entry.workspaceId, paneId: entry.managementPaneId };
    });
  }
}
module.exports = { HerdrBindings };
