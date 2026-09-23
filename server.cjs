'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Store } = require('./lib/store.cjs');
const { ACTIVE, id, now, assert, atomic, read, validateMachine, validateTree, orderedTasks, configFor, nextTask, blankTree, blankNode, parsePlan } = require('./lib/core.cjs');
const { probe, runtimeProfile, assertRuntimeProfile } = require('./lib/executor.cjs');
const { launchRemote, remoteAccess } = require('./lib/remote.cjs');
const { BIND_ADDRESS, localUrl, localRequestError } = require('./lib/local-http.cjs');
const { upload, hydrate, metadata } = require('./lib/attachments.cjs');
const { DEFAULTS, cliArgs } = require('./lib/cli-options.cjs');
const { Notion } = require('./lib/notion.cjs');
const { readEvents } = require('./lib/events.cjs');
const { selectExecution } = require('./lib/task-selection.cjs');
const { nextExecution, executionProgress, taskDefinitions, taskMatches } = require('./public/next-execution.js');
const { Proposals } = require('./lib/proposals.cjs');
const { HerdrBindings } = require('./lib/herdr-bindings.cjs');
const { isWSL, localPath, executionTree } = require('./lib/local-path.cjs');
const orca = require('./lib/orca.cjs');
const { launchInput } = require('./lib/orca-execution.cjs');

function createApp({ dataDir = process.env.WORK_TREE_DATA || path.join(__dirname, '.work-tree'), port = Number(process.env.PORT || 4317), notionOptions } = {}) {
  dataDir = path.resolve(dataDir);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const lockFile = path.join(dataDir, 'server.lock'), lockOwner = id();
  const oldLock = read(lockFile);
  if (oldLock?.pid) {
    let alive = true; try { process.kill(oldLock.pid, 0); } catch (e) { alive = e.code === 'EPERM'; }
    if (alive) throw new Error('同じデータディレクトリのサーバーが起動中です');
    fs.unlinkSync(lockFile);
  }
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, owner: lockOwner, platform: process.platform }), { flag: 'wx', mode: 0o600 });
  function releaseLock() { if (read(lockFile)?.owner === lockOwner) fs.unlinkSync(lockFile); }
  const store = new Store(path.resolve(dataDir));
  const notion = new Notion(dataDir, notionOptions);
  const herdr = new HerdrBindings(dataDir);
  const orcaObservation = new (require('./lib/orca-observation.cjs').OrcaObservation)(store);
  const proposals = new Proposals(store, startRun, localState, assertEditable, tree => { void herdr.sync(tree, store.data.trees); });
  const token = crypto.randomBytes(32).toString('hex');
  let refreshing = false, closing = false;
  const locked = new Set();
  function fail(message, code = 400) { const e = new Error(message); e.statusCode = code; throw e; }
  function treeById(tid) { const tree = store.data.trees.find(t => t.id === tid); if (!tree) fail('ツリーが見つかりません', 404); return tree; }
  function runById(rid) { const run = store.data.runs.find(r => r.id === rid); if (!run) fail('実行が見つかりません', 404); return run; }
  function activeFor(tid) { return store.data.runs.find(r => r.treeId === tid && ACTIVE.has(store.state(r).status)); }
  function machineById(mid) { const m = store.data.machines.find(m => m.id === mid); if (!m) fail('マシンが見つかりません', 404); return m; }
  function assertEditable(tid) { if (activeFor(tid) || locked.has(tid)) fail('実行中のツリーは編集できません。停止後に編集してください', 409); }
  async function refreshRemote() {
    if (refreshing || closing) return; refreshing = true;
    try {
      await Promise.allSettled(store.data.runs.filter(r => r.runner.type === 'ssh' && ACTIVE.has(store.state(r).status)).map(async run => {
        try {
          const result = await remoteAccess(run.runner, run.id);
          if (closing) return;
          if (result.state) {
            if (result.alive === false && ACTIVE.has(result.state.status)) { result.state.status = 'interrupted'; result.state.error = 'SSH 実行プロセスが終了しています。成果物を確認してから再実行してください'; }
            atomic(path.join(store.runDir(run.id), 'state.json'), result.state);
          } else if (Date.now() - Date.parse(run.createdAt) > 30000) {
            atomic(path.join(store.runDir(run.id), 'state.json'), { ...store.state(run), status: 'failed', error: 'SSH 接続先で実行が開始されていません。Node.js のパスと worker.log を確認してください' });
          }
          run.connectionError = null; run.syncedAt = now();
        } catch (e) { if (!closing) run.connectionError = e.message; }
      }));
      if (!closing) store.save();
    } finally { refreshing = false; }
  }
  function localState(run) {
    const state = store.state(run);
    if (run.runner.type === 'local' && ACTIVE.has(state.status) && !state.offlineReview) {
      const pid = state.pid || run.pid;
      let alive = true;
      if (pid) { try { process.kill(pid, 0); } catch (e) { alive = e.code === 'EPERM'; } }
      if (!alive || (!pid && Date.now() - Date.parse(run.createdAt) > 15000)) {
        state.status = 'interrupted'; state.error = '実行プロセスが終了しています。変更内容を確認してから再実行してください';
        atomic(path.join(store.runDir(run.id), 'state.json'), state);
      }
    }
    return state;
  }
  function stateResponse() {
    const runs = store.data.runs.map(r => ({ ...runWithDefinitions(r), state: orcaObservation.decorate(r, localState(r)) }));
    return { proposals: proposals.public(), trees: store.data.trees, machines: store.data.machines, runs, herdr: { syncErrors: herdr.errors }, version: '0.7.18', server: { capabilities: ['node-execution', 'herdr-execution', 'orca-execution', 'next-execution', 'orca-auto-results'], dataDir, pid: process.pid, platform: process.platform, wsl: isWSL, cwd: process.cwd(), hostname: require('node:os').hostname(), runtime: runtimeProfile() } };
  }
  const definitionCache = new Map();
  function runWithDefinitions(run) {
    if (run.taskDefinitions) return run;
    if (!definitionCache.has(run.id)) {
      const snapshot = read(path.join(store.runDir(run.id), 'input.json'))?.tree;
      if (snapshot) definitionCache.set(run.id, taskDefinitions(snapshot));
    }
    return { ...run, ...(definitionCache.has(run.id) ? { taskDefinitions: definitionCache.get(run.id) } : {}) };
  }
  let startQueue = Promise.resolve();
  function startRun(...args) {
    const pending = startQueue.then(() => startRunImpl(...args));
    startQueue = pending.catch(() => {});
    return pending;
  }
  async function startRunImpl(tree, kind, resume = false, nodeId = null, progress = null, reassessment = null, reassessmentDefinitions = null) {
    validateTree(tree, store.data.machines);
    assert(orderedTasks(tree).length > 0, '実行するタスクを追加してください');
    const runner = machineById(tree.runnerId);
    const definitions = reassessmentDefinitions || taskDefinitions(tree);
    const useOrca = tree.executionBackend === 'orca';
    tree = useOrca ? structuredClone(tree) : executionTree(tree, runner);
    let orcaContext;
    if (useOrca) {
      assert(runner.type === 'local', 'Orca 実行の管理マシンは「このマシン」にしてください');
      orcaContext = await orca.prepareTree(tree);
      if (reassessment) orcaContext.reassessment = reassessment;
      for (const n of orderedTasks(tree)) n.orca = orcaContext.nodes[n.id];
    }
    const useHerdr = tree.executionBackend === 'herdr' && kind !== 'plan';
    if (useHerdr) {
      assert(process.platform !== 'win32', 'herdr 実行は TaskDesk と herdr を同じ WSL / Linux / macOS 環境で起動してください');
      assert(runner.type === 'local', 'herdr 実行の管理マシンは「このマシン」にしてください');
    }
    for (const node of orderedTasks(tree)) {
      const c = configFor(tree, node);
      cliArgs(c, { interactive: useHerdr || useOrca });
      if (useOrca) launchInput(c, c.orca, c.prompt);
      if (c.options.mode === 'goal') assert(c.criteria.trim(), 'ゴールモードには完了条件が必要です: ' + node.title);
      assert(c.prompt.trim(), 'プロンプトが空です: ' + node.title);
      if (!useOrca) assert(c.cwd.trim(), '作業ディレクトリを指定してください: ' + node.title);
      if (useHerdr) {
        assert(c.machineId === 'local', 'herdr 実行は同じ環境のローカルノードに対応しています。SSH ノードは通常実行を選択してください');
        assert(path.isAbsolute(c.cwd) && fs.existsSync(c.cwd) && fs.statSync(c.cwd).isDirectory(), 'herdr と同じ環境の作業ディレクトリを指定してください: ' + c.cwd);
      }
      if (runner.type === 'ssh') assert(c.machineId !== 'local', 'SSH 常駐実行では「このマシン」を実行先にできません。ノードのマシン設定を SSH マシンへ変更してください');
    }
    if (['tree', 'chat', 'node'].includes(kind)) {
      const normalize = (t, n) => {
        const c = configFor(t, n), o = t.executionBackend === 'orca' ? c.orca : null;
        const host = o ? o.hostId : c.machineId, cwd = o ? o.path : c.cwd;
        return host + ':' + (host === 'local' ? (process.platform === 'win32' ? path.resolve(cwd).toLowerCase() : path.resolve(localPath(cwd))) : cwd.replace(/\/$/, ''));
      };
      const targets = new Set(orderedTasks(tree).map(n => normalize(tree, n)));
      for (const running of store.data.runs.filter(r => ['tree', 'chat', 'node'].includes(r.kind) && ACTIVE.has(localState(r).status))) {
        const snapshot = read(path.join(store.runDir(running.id), 'input.json'))?.tree;
        if (snapshot) assert(!orderedTasks(snapshot).some(n => targets.has(normalize(snapshot, n))), '同じマシン・作業ディレクトリで別のツリーが実行中です。完了を待つか別の作業ディレクトリを指定してください');
      }
    }
    const run = { id: id(), treeId: tree.id, treeRevision: tree.revision, kind, createdAt: now(), runner: structuredClone(runner), treeName: tree.name };
    run.executionBackend = useOrca ? 'orca' : useHerdr ? 'herdr' : 'direct';
    run.taskDefinitions = definitions;
    if (['tree','node'].includes(kind) && !useOrca) run.resultSuggestions = true;
    if (nodeId) run.nodeId = nodeId;
    if (notion.links[tree.id]) run.notionSource = notion.links[tree.id].sourceId;
    const previous = store.data.runs.find(r => r.treeId === tree.id && r.kind === 'tree');
    const previousState = previous ? store.state(previous) : null;
    if (resume) assert(previous && previous.treeRevision === tree.revision && !ACTIVE.has(previousState.status), '編集後のツリーは最初から実行してください');
    const completed = progress ? Object.keys(progress).filter(key => progress[key].status === 'succeeded' && tree.nodes.some(n => n.id === key)) : resume ? Object.keys(previousState.nodes).filter(key => previousState.nodes[key].status === 'succeeded') : [];
    const input = { id: run.id, kind, tree: hydrate(dataDir, structuredClone(tree)), machines: structuredClone(store.data.machines), runnerId: runner.id, completed, previousResults: resume ? Object.fromEntries(Object.entries(previousState.nodes).map(([k, v]) => [k, v.response || ''])) : {} };
    if (progress) input.previousResults = Object.fromEntries(Object.entries(progress).filter(([, v]) => v.status === 'succeeded').map(([key, value]) => [key, value.response || '']));
    const previousNodes = progress || (resume ? previousState?.nodes : {}) || {};
    input.previousReports = Object.fromEntries(tree.nodes.filter(n=>n.kind==='task' && completed.includes(n.id)).map(n=>[n.id,require('./lib/task-reports.cjs').previousReport(tree,n,previousNodes[n.id])]));
    if (useOrca) input.orca = orcaContext;
    const dir = store.runDir(run.id); atomic(path.join(dir, 'input.json'), input);
    if (useHerdr) run.pid = process.pid;
    store.data.runs.unshift(run); store.save();
    try {
      if (useHerdr) {
        input.herdr = await herdr.prepare(treeById(tree.id), tree, store.data.trees);
        atomic(path.join(dir, 'input.json'), input);
      }
      if (runner.type === 'ssh') { const r = await launchRemote(runner, input); run.pid = r.pid; }
      else {
        const fd = fs.openSync(path.join(dir, 'worker.log'), 'a', 0o600);
        const workerEnv = { ...process.env }; delete workerEnv.NOTION_TOKEN;
        // Detached AI processes do not own the terminal that launched the server.
        for (const key of Object.keys(workerEnv)) if (key.startsWith('HERDR_')) delete workerEnv[key];
        const child = spawn(process.execPath, [path.join(__dirname, 'lib', 'worker.cjs'), dir], { detached: true, windowsHide: true, env: workerEnv, stdio: ['ignore', fd, fd] });
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        child.unref(); fs.closeSync(fd); run.pid = child.pid;
      }
    } catch (e) {
      if (runner.type === 'ssh') { run.connectionError = '開始結果を確認中: ' + e.message; }
      else atomic(path.join(dir, 'state.json'), { id: run.id, status: 'failed', nodes: {}, error: e.message });
    }
    store.save(); return run;
  }
  function send(res, code, value) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value));
  }
  async function body(req) {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 8 * 1024 * 1024) fail('リクエストが大きすぎます', 413); chunks.push(chunk); }
    const text = Buffer.concat(chunks).toString('utf8');
    try { return text ? JSON.parse(text) : {}; } catch { fail('JSON が不正です'); }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const host = req.headers.host || '';
      const accessError = localRequestError(req);
      if (accessError) fail(accessError, 403);
      const url = new URL(req.url, 'http://' + host), parts = url.pathname.split('/').filter(Boolean);
      if (url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.headers['x-work-tree-token'] !== token) fail('ページを再読み込みしてください', 403);
        if (req.method === 'GET' && url.pathname === '/api/session') return send(res, 200, { token });
        if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, stateResponse());
        if (req.method === 'GET' && url.pathname === '/api/orca/targets') {
          const { target, ...catalog } = await orca.discover();
          return send(res, 200, { ...catalog, runtimeId: target.runtimeId });
        }
        if (req.method === 'POST' && url.pathname === '/api/orca/focus') {
          const data = await body(req), run = runById(data.runId);
          assert(run.executionBackend === 'orca', 'Orca 実行を指定してください');
          const dir = store.runDir(run.id), input = read(path.join(dir, 'input.json'));
          assert(input.tree.nodes.some(n => n.id === data.nodeId), 'タスクが見つかりません');
          const binding = read(path.join(dir, 'orca', data.nodeId, 'dispatch.json'))?.binding;
          assert(binding, 'Orca 端末はまだ作成されていません');
          await orca.verifyTerminal(input.orca.target, binding);
          await orca.call(input.orca.target, ['terminal', 'switch', '--terminal', binding.handle]);
          return send(res, 200, { ok: true });
        }
        if (req.method === 'POST' && url.pathname === '/api/herdr/open') {
          const data = await body(req), tree = treeById(data.treeId); assertEditable(tree.id); locked.add(tree.id);
          try {
            const next = { ...tree, executionBackend: 'herdr', herdrSession: data.session || tree.herdrSession || 'default' };
            validateTree(next, store.data.machines);
            const opened = await herdr.open(next, store.data.trees, 'http://' + host);
            if (tree.executionBackend !== next.executionBackend || tree.herdrSession !== next.herdrSession) {
              next.revision++; next.updatedAt = now(); store.data.trees[store.data.trees.indexOf(tree)] = next; store.save();
            }
            return send(res, 200, opened);
          } finally { locked.delete(tree.id); }
        }
        if (parts[1] === 'notion') {
          if (req.method === 'GET' && parts.length === 2) return send(res, 200, notion.status());
          if (req.method === 'PUT' && parts.length === 2) return send(res, 200, notion.configure(await body(req)));
          if (req.method === 'POST' && parts[2] === 'create') return send(res, 201, await notion.exclusive(() => notion.createDatabase()));
          if (req.method === 'POST' && parts[2] === 'verify') return send(res, 200, await notion.exclusive(async () => { await notion.verify(); return { ok: true }; }));
        }
        if (req.method === 'GET' && url.pathname === '/api/cli-defaults') {
          let models = [];
          try {
            const cache = read(path.join(process.env.CODEX_HOME || path.join(require('node:os').homedir(), '.codex'), 'models_cache.json'));
            models = (cache?.models || []).filter(m => typeof m.slug === 'string').map(m => ({ id: m.slug, name: m.display_name || m.slug }));
          } catch {}
          return send(res, 200, { defaults: DEFAULTS, models: { codex: models, claude: ['sonnet', 'opus', 'haiku'].map(id => ({ id, name: id })) } });
        }
        if (req.method === 'POST' && url.pathname === '/api/attachments') return send(res, 201, upload(dataDir, await body(req)));
        if (req.method === 'POST' && url.pathname === '/api/trees') {
          const data = await body(req);
          const tree = blankTree({ ...data, id: id(), revision: 1, createdAt: now(), updatedAt: now() }); validateTree(tree, store.data.machines);
          store.data.trees.unshift(tree); store.save(); return send(res, 201, tree);
        }
        if (req.method === 'POST' && parts[1] === 'proposals' && parts.length === 4) {
          await body(req); return send(res, 200, proposals.decide(parts[2], parts[3]));
        }
        if (parts[1] === 'trees' && parts[2]) {
          const tree = treeById(parts[2]);
          if (req.method === 'POST' && parts[3] === 'proposals') {
            const data = await body(req);
            return send(res, 201, await proposals.create(treeById(parts[2]), data));
          }
          if (req.method === 'POST' && ['notion-push', 'notion-pull'].includes(parts[3])) {
            const data = await body(req); assertEditable(tree.id); locked.add(tree.id);
            try {
              const result = await notion.exclusive(async () => {
                if (parts[3] === 'notion-push') return notion.push(tree);
                const next = await notion.pull(tree, store.data.machines, data.discardLocal === true);
                store.data.trees[store.data.trees.indexOf(tree)] = next; store.save(); return next;
              });
              return send(res, 200, result);
            } finally { locked.delete(tree.id); }
          }
          if (req.method === 'POST' && parts[3] === 'chat') {
            const data = await body(req); assertEditable(tree.id); locked.add(tree.id);
            try {
              assert(typeof data.message === 'string' && data.message.trim() && data.message.length <= 20000, '追加依頼を 20000 文字以内で入力してください');
              let source = tree;
              if (notion.links[tree.id]) { source = await notion.exclusive(() => notion.pull(tree, store.data.machines)); store.data.trees[store.data.trees.indexOf(tree)] = source; store.save(); }
              const node = source.nodes.find(n => n.id === data.nodeId && n.kind === 'task'); assert(node, '実行するタスクを選択してください');
              const history = store.data.runs.filter(r => r.treeId === tree.id && r.kind !== 'plan').slice(0, 10).reverse().flatMap(r => {
                const s = store.state(r).nodes?.[node.id], old = read(path.join(store.runDir(r.id), 'input.json'))?.tree.nodes.find(n => n.id === node.id);
                return s?.response ? [{ request: (old?.chatMessage || old?.prompt || '').slice(-10000), response: s.response.slice(-12000) }] : [];
              });
              const prompt = '元のタスク:\n' + node.prompt.slice(0, 20000) + '\n\nこれまでの会話（参考・長い履歴は省略）:\n' + JSON.stringify(history).slice(-18000) + '\n\n追加依頼:\n' + data.message;
              const snapshot = { ...source, nodes: [{ ...node, parentId: null, dependsOn: [], prompt, chatMessage: data.message }] };
              return send(res, 201, await startRun(snapshot, 'chat'));
            } finally { locked.delete(tree.id); }
          }
          if (req.method === 'PUT' && parts.length === 3) {
            const data = await body(req); assertEditable(tree.id);
            if (data.revision !== tree.revision) fail('別の画面で更新されました。再読み込みしてから編集してください', 409);
            const next = { ...data, id: tree.id, revision: tree.revision + 1, createdAt: tree.createdAt, updatedAt: now() }; validateTree(next, store.data.machines);
            store.data.trees[store.data.trees.indexOf(tree)] = next; store.save();
            for (const item of store.data.trees) void herdr.sync(item, store.data.trees);
            return send(res, 200, next);
          }
          if (req.method === 'DELETE' && parts.length === 3) { assertEditable(tree.id); store.data.trees = store.data.trees.filter(t => t.id !== tree.id); store.save(); return send(res, 200, { ok: true }); }
          if (req.method === 'POST' && parts[3] === 'run') {
            const data = await body(req); assertEditable(tree.id); locked.add(tree.id);
            try {
              if (data.revision !== undefined) assert(data.revision === tree.revision, 'ツリーが更新されました。再読み込みしてから実行してください');
              const next = notion.links[tree.id] ? await notion.exclusive(() => notion.pull(tree, store.data.machines)) : tree;
              if (next !== tree) { store.data.trees[store.data.trees.indexOf(tree)] = next; store.save(); }
              if (data.next !== undefined) {
                assert(['task', 'wp'].includes(data.next) && !data.resume && data.nodeId === undefined, '次の実行範囲が不正です');
                const progress = executionProgress(next, store.data.runs.map(r => ({ ...runWithDefinitions(r), state: localState(r) })));
                const selection = nextExecution(next, progress), target = data.next === 'wp' ? selection.wp : selection.task;
                assert(target, selection.complete ? 'すべての TASK が完了しています' : '実行可能な次の ' + data.next.toUpperCase() + ' がありません');
                return send(res, 201, await startRun(selectExecution(next, target.id), 'node', false, target.id, progress));
              }
              if (data.nodeId !== undefined) {
                assert(typeof data.nodeId === 'string' && !data.resume, 'ノード実行では nodeId を指定し、resume は指定しないでください');
                validateTree(next, store.data.machines);
                return send(res, 201, await startRun(selectExecution(next, data.nodeId), 'node', false, data.nodeId));
              }
              return send(res, 201, await startRun(next, 'tree', Boolean(data.resume)));
            } finally { locked.delete(tree.id); }
          }
        }
        if (parts[1] === 'runs' && parts[2]) {
          const run = runById(parts[2]);
          if (req.method === 'POST' && parts[3] === 'label') {
            const data = await body(req), tree = treeById(run.treeId);
            let state = localState(run), node = state.nodes?.[data.nodeId];
            assert(['node','tree'].includes(run.kind) && node && node.status !== 'pending' && !node.reused, 'ラベルを付ける実行結果がありません');
            const latest = require('./public/next-execution.js').taskRun(tree, store.data.runs.map(r=>({...runWithDefinitions(r),state:localState(r)})), data.nodeId);
            assert(latest?.id === run.id, '最新のTASK設定・実行結果に対してラベルを付けてください');
            assert(!store.data.runs.some(r=>r.id!==run.id && r.treeId===tree.id && ACTIVE.has(localState(r).status)), '同じツリーの実行が終了してから変更してください');
            assert(!ACTIVE.has(state.status) || state.status === 'review' && state.currentNodeId === data.nodeId, 'TASKの実行・判定が終了してからラベルを付けてください');
            const control = {id:id(),action:'label',nodeId:data.nodeId,outcome:data.outcome,note:data.note || ''};
            require('./lib/manual-label.cjs').labelResult(structuredClone(node), control.outcome, control.note);
            const pending = read(path.join(store.runDir(run.id),'control.json'));
            assert(!(pending?.action === 'reassess' && pending.id !== node.reassessmentRequestId && ACTIVE.has(state.status)), '完了判定の開始を待っています');
            let legacyReview = false;
            if (ACTIVE.has(state.status) && !state.offlineReview && state.manualLabelVersion !== 2) {
              assert(run.runner.type === 'local', '更新前のSSH常駐実行は停止してから結果を確認してください');
              // An old worker does not understand label controls. It is idle in
              // review: stop its wait loop before writing, never race its saves.
              const savedNode = structuredClone(node);
              atomic(path.join(store.runDir(run.id),'before-manual-label.json'),state);
              atomic(path.join(store.runDir(run.id),'control.json'),{id:id(),action:'stop'});
              const deadline = Date.now()+10000;
              do { await new Promise(resolve=>setTimeout(resolve,100)); state=localState(run); } while(ACTIVE.has(state.status) && Date.now()<deadline);
              assert(!ACTIVE.has(state.status), '旧実行の確認待ちを終了しています。少し待って再度保存してください');
              state.nodes[data.nodeId] = savedNode; node = savedNode; legacyReview = true;
            }
            if (ACTIVE.has(state.status) && !state.offlineReview) {
              if (run.runner.type === 'ssh') await remoteAccess(run.runner,run.id,{control});
              else atomic(path.join(store.runDir(run.id),'control.json'),control);
            } else {
              assert(run.runner.type === 'local', 'SSH常駐実行の終了後ラベル変更には対応していません');
              require('./lib/manual-label.cjs').labelResult(node,control.outcome,control.note);
              state.error = null; state.updatedAt = now();
              state.offlineReview = control.outcome === 'needs_review';
              state.currentNodeId = state.offlineReview ? data.nodeId : null;
              state.status = state.offlineReview ? 'review' : control.outcome !== 'completed' ? 'failed' : Object.values(state.nodes).every(n=>n.status==='succeeded') ? 'succeeded' : 'interrupted';
              atomic(path.join(store.runDir(run.id),'state.json'),state);
            }
            return send(res,200,{ok:true, ...(legacyReview ? {message:'ラベルを保存しました。更新前の実行の残りは「次TASKを実行」から続けられます。'} : {})});
          }
          if (req.method === 'POST' && parts[3] === 'reassess') {
            const data = await body(req), state = localState(run);
            assert(run.executionBackend === 'orca' && (state.nodes[data.nodeId]?.canReassess || state.nodes[data.nodeId]?.interactive?.binding || state.nodes[data.nodeId]?.interactive?.handle), 'この TASK の再判定情報がありません');
            assert(!ACTIVE.has(state.status) || state.status === 'review' && state.currentNodeId === data.nodeId, '作業または判定の終了を待ってください');
            const pendingControl = read(path.join(store.runDir(run.id), 'control.json'));
            assert(!(pendingControl?.action === 'reassess' && pendingControl.id !== state.nodes[data.nodeId]?.reassessmentRequestId && !state.offlineReview && ACTIVE.has(state.status)), '再判定の開始を待っています');
            const current = structuredClone(treeById(run.treeId)), currentNode = current.nodes.find(n => n.id === data.nodeId);
            assert(currentNode, 'TASK が見つかりません');
            const previous = read(path.join(store.runDir(run.id), 'input.json'));
            const comparable = structuredClone(current);
            comparable.nodes.find(n => n.id === data.nodeId).criteria = previous.tree.nodes.find(n => n.id === data.nodeId)?.criteria || '';
            assert(taskMatches(comparable, runWithDefinitions(run), data.nodeId), '指示・実行先などの変更後は TASK を再実行してください');
            if (data.criteria !== undefined) {
              assert(typeof data.criteria === 'string' && data.criteria.length <= 60000, '完了条件は60000文字以内で入力してください');
              if (data.criteria !== currentNode.criteria) { currentNode.criteria = data.criteria; current.revision++; current.updatedAt = now(); }
            }
            const criteria = currentNode.criteria;
            if (state.status === 'review' && state.currentNodeId === data.nodeId && !state.offlineReview) {
              store.data.trees[store.data.trees.findIndex(t => t.id === current.id)] = current;
              run.taskDefinitions = { ...runWithDefinitions(run).taskDefinitions, [data.nodeId]:taskDefinitions(current)[data.nodeId] }; store.save();
              previous.tree.nodes.find(n => n.id === data.nodeId).criteria = criteria;
              atomic(path.join(store.runDir(run.id), 'input.json'), previous);
              atomic(path.join(store.runDir(run.id), 'control.json'), { id: id(), action: 'reassess', nodeId: data.nodeId, refreshReport:true, criteria });
              return send(res, 200, { ok: true });
            }
            assert(!ACTIVE.has(state.status) || state.offlineReview, '実行中の TASK が終了してから再判定してください');
            const result = read(path.join(store.runDir(run.id), 'orca', data.nodeId, 'result.json'));
            const work = result?.reassessment || (state.nodes[data.nodeId]?.interactive?.notificationMode === 'manual' ? { binding:state.nodes[data.nodeId].interactive, baselineResponse:state.nodes[data.nodeId].workResponse } : null);
            assert(work, '作業ペインの情報がありません');
            if (state.offlineReview) {
              state.offlineReview = false; state.status = 'interrupted'; state.currentNodeId = null;
              state.nodes[data.nodeId].resultStale = true;
              state.nodes[data.nodeId].canReassess = true;
              atomic(path.join(store.runDir(run.id), 'state.json'), state);
            }
            const tree = structuredClone(previous.tree);
            tree.revision = current.revision;
            tree.nodes = tree.nodes.filter(n => n.id === data.nodeId).map(n => ({ ...n, criteria, parentId: null, dependsOn: [] }));
            store.data.trees[store.data.trees.findIndex(t => t.id === current.id)] = current;
            store.save();
            return send(res, 201, await startRun(tree, 'node', false, data.nodeId, null, { ...work, report:state.nodes[data.nodeId]?.report, refreshReport:true }, taskDefinitions(current)));
          }
          if (req.method === 'GET' && parts[3] === 'events') {
            const after = Number(url.searchParams.get('after') || 0); assert(Number.isSafeInteger(after) && after >= 0, '読み取り位置が不正です');
            const feed = run.runner.type === 'ssh' ? (await remoteAccess(run.runner, run.id, { events: true, after })).feed : readEvents(store.runDir(run.id), after);
            const snapshot = read(path.join(store.runDir(run.id), 'input.json'))?.tree;
            return send(res, 200, { ...(feed || { events: [], cursor: 0, more: false }), nodes: (snapshot?.nodes || []).map(n => ({ id: n.id, title: n.title, prompt: n.chatMessage || n.prompt })) });
          }
          if (req.method === 'POST' && parts[3] === 'control') {
            const data = await body(req); assert(['pause', 'resume', 'stop', 'approve', 'complete', 'revise'].includes(data.action), '操作が不正です');
            const state = localState(run); assert(ACTIVE.has(state.status), '実行は終了しています');
            if (data.action === 'approve') assert(state.status === 'review' && data.nodeId === state.currentNodeId, '確認待ちのノードが一致しません');
            if (data.action === 'approve') assert(!state.nodes[data.nodeId]?.resultStale, '修正後の結果を再判定してから完了を承認してください');
            if (data.action === 'approve') {
              const pending = read(path.join(store.runDir(run.id), 'control.json'));
              assert(!(pending?.nodeId === data.nodeId && (pending.action === 'revise' || pending.action === 'reassess' && pending.id !== state.nodes[data.nodeId]?.reassessmentRequestId)), '修正・再判定の処理が完了するまで承認できません');
            }
            if (data.action === 'revise') assert(state.status === 'review' && data.nodeId === state.currentNodeId, '確認待ちの TASK を指定してください');
            if (state.offlineReview) {
              if (data.action === 'revise') {
                state.nodes[data.nodeId].resultStale = true; state.updatedAt = now();
                atomic(path.join(store.runDir(run.id), 'state.json'), state);
                return send(res, 200, { ok:true });
              }
              assert(['approve', 'stop'].includes(data.action), '復元した確認待ちは、実行結果タブで完了を承認するか停止してください');
              const node = state.nodes[state.currentNodeId];
              if (data.action === 'approve') Object.assign(node, { status: 'succeeded', outcome: 'completed', confirmedByUser: true, confirmedAt: now() });
              else node.status = 'cancelled';
              state.status = data.action === 'stop' ? 'cancelled' : Object.values(state.nodes).every(n => n.status === 'succeeded') ? 'succeeded' : 'interrupted';
              state.currentNodeId = null; state.offlineReview = false; state.finishedAt = now(); state.updatedAt = now();
              atomic(path.join(store.runDir(run.id), 'state.json'), state);
              return send(res, 200, { ok: true });
            }
            const control = { id: id(), action: data.action, nodeId: data.nodeId };
            if (data.action === 'complete') {
              const interactive = state.nodes[data.nodeId]?.interactive;
              assert(['herdr', 'orca'].includes(run.executionBackend) && data.nodeId === state.currentNodeId && (['ready', 'confirmation'].includes(interactive?.phase) || interactive?.phase === 'start-unconfirmed' && interactive.canComplete === true), '対話 Agent が入力待ちになってから完了を確定してください');
              assert(typeof data.response === 'string' && data.response.trim() && data.response.length <= 60000, '結果の要約を 60000 文字以内で入力してください');
              control.response = data.response;
              assert(data.outcome === undefined || ['completed','error','unexpected'].includes(data.outcome), '結果ラベルが不正です');
              control.outcome = data.outcome || 'completed';
            }
            if (run.runner.type === 'ssh') await remoteAccess(run.runner, run.id, { control });
            else atomic(path.join(store.runDir(run.id), 'control.json'), control);
            return send(res, 200, { ok: true });
          }
          if (req.method === 'GET' && parts[3] === 'log') {
            let log = '';
            if (run.runner.type === 'ssh') { const result = await remoteAccess(run.runner, run.id, { log: true }); log = result.log; }
            else { try { const f = fs.openSync(path.join(store.runDir(run.id), 'events.log'), 'r'), size = fs.fstatSync(f).size, buf = Buffer.alloc(Math.min(size, 65536)); fs.readSync(f, buf, 0, buf.length, Math.max(0, size - buf.length)); fs.closeSync(f); log = buf.toString('utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
            return send(res, 200, { log });
          }
          if (req.method === 'POST' && parts[3] === 'import') {
            assert(run.kind === 'plan', '計画生成の実行ではありません');
            if (run.importedTreeId) return send(res, 200, treeById(run.importedTreeId));
            const state = localState(run); assert(state.status === 'succeeded', '計画生成は完了していません');
            const parsed = parsePlan(Object.values(state.nodes)[0].response);
            const original = metadata(read(path.join(store.runDir(run.id), 'input.json')).tree);
            const settings = original.creationSettings || { executionBackend: original.executionBackend, herdrSession: original.herdrSession, cli: original.cli, attachments: original.attachments, tool: original.tool, machineId: original.machineId, runnerId: original.runnerId, cwd: original.cwd };
            const tree = blankTree({ ...parsed, ...settings, name: settings.name || parsed.name, brief: original.brief, nodes: parsed.nodes });
            validateTree(tree, store.data.machines); store.data.trees.unshift(tree); run.importedTreeId = tree.id; store.save(); return send(res, 201, tree);
          }
        }
        if (req.method === 'POST' && url.pathname === '/api/generate') {
          const data = await body(req); assert(typeof data.prompt === 'string' && data.prompt.trim() && data.prompt.length <= 20000, '要件を 20000 文字以内で入力してください');
          const machine = machineById(data.machineId || 'local');
          const instruction = 'あなたは作業計画の設計者です。以下の要件を実行可能なタスクツリーに分解してください。ファイルを変更せず、計画だけ作成してください。最終回答は説明やコードフェンスを含めず、次の形の JSON のみを返してください。\n' +
            JSON.stringify({ name: 'プロジェクト名', nodes: [{ id: 'group1', title: '親タスク', kind: 'group', parentId: null, prompt: '共通の背景', criteria: '', dependsOn: [] }, { id: 'task1', title: '具体的な作業', kind: 'task', parentId: 'group1', prompt: 'AI が実行する具体的な指示', criteria: '検証可能な完了条件', dependsOn: [] }] }) +
            '\n各 ID は一意。グループのみが子を持ち、実行タスクは末端。依存先は実行タスク ID のみ。循環禁止。5〜20 ノードを目安とし、必要以上に細分化しないでください。\n要件:\n' + data.prompt;
          const tool = data.tool || 'codex';
          const settings = { completionMode: data.completionMode || 'ai', name: data.name || '', description: data.description || '', executionBackend: data.executionBackend || 'direct', herdrSession: data.herdrSession, orca: data.orca, tool, machineId: machine.id, runnerId: data.executionBackend === 'orca' ? 'local' : data.runnerId || machine.id, cwd: data.cwd || '', timeoutMinutes: data.timeoutMinutes || 60, cli: data.cli, attachments: data.attachments };
          validateTree(blankTree({ ...settings, name: settings.name || '新しいタスクプラン' }), store.data.machines);
          const tree = blankTree({ ...settings, name: 'AI による計画生成', brief: data.brief, creationSettings: settings, timeoutMinutes: 15, nodes: [blankNode({ title: 'タスクツリーを設計する', prompt: instruction, sandbox: 'read-only', claudePermission: 'plan', cli: { [tool]: { mode: 'plan' } } })] });
          if (settings.executionBackend === 'orca') {
            // Planning is non-interactive; imported tasks retain the original target.
            tree.executionBackend = 'direct'; tree.machineId = 'local'; tree.runnerId = 'local'; tree.cwd = process.cwd();
            delete tree.orca;
            tree.attachments = (settings.attachments || []).filter(a => a.id);
            tree.nodes[0].prompt += '\n\n作成後の TASK の実行先（計画生成中にこの接続先の操作やファイル変更は行わない）:\n' + JSON.stringify({ orca:settings.orca, references:(settings.attachments || []).filter(a=>!a.id) });
          }
          return send(res, 201, await startRun(tree, 'plan'));
        }
        if (req.method === 'POST' && url.pathname === '/api/machines') {
          const data = await body(req); const machine = { ...data, id: id(), type: 'ssh' }; validateMachine(machine); store.data.machines.push(machine); store.save(); return send(res, 201, machine);
        }
        if (parts[1] === 'machines' && parts[2]) {
          const machine = machineById(parts[2]);
          if (req.method === 'POST' && parts[3] === 'probe') return send(res, 200, await probe(machine));
          if (req.method === 'PUT' && parts.length === 3) {
            const data = await body(req);
            assert(!store.data.runs.some(r => ACTIVE.has(store.state(r).status)), '実行中はマシン設定を変更できません');
            const next = { ...data, id: machine.id, type: machine.type }; validateMachine(next); store.data.machines[store.data.machines.indexOf(machine)] = next; store.save(); return send(res, 200, next);
          }
          if (req.method === 'DELETE' && parts.length === 3) {
            assert(machine.id !== 'local', 'ローカルマシンは削除できません');
            assert(!store.data.trees.some(t => t.runnerId === machine.id || t.machineId === machine.id || t.nodes.some(n => n.machineId === machine.id)), 'ツリーで使用しているマシンは削除できません');
            assert(!store.data.runs.some(r => ACTIVE.has(store.state(r).status)), '実行中はマシンを削除できません');
            store.data.machines = store.data.machines.filter(m => m.id !== machine.id); store.save(); return send(res, 200, { ok: true });
          }
        }
        fail('API が見つかりません', 404);
      }
      const publicFiles = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/tree-edit.js': ['tree-edit.js', 'text/javascript'], '/workspace-ui.js': ['workspace-ui.js', 'text/javascript'], '/workspace.css': ['workspace.css', 'text/css'], '/chat-format.js': ['chat-format.js', 'text/javascript'], '/cli-ui.js': ['cli-ui.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
      publicFiles['/orca-ui.js'] = ['orca-ui.js', 'text/javascript'];
      publicFiles['/next-execution.js'] = ['next-execution.js', 'text/javascript'];
      publicFiles['/mobile-input.js'] = ['mobile-input.js', 'text/javascript'];
      const file = publicFiles[url.pathname]; if (!file || req.method !== 'GET') fail('ページが見つかりません', 404);
      res.writeHead(200, { 'Content-Type': file[1] + '; charset=utf-8', 'Cache-Control': 'no-cache' }); res.end(fs.readFileSync(path.join(__dirname, 'public', file[0])));
    } catch (e) { if (!res.headersSent) send(res, e.statusCode || 400, { error: e.message }); else res.end(); }
  });
  const proposalPoll = setInterval(() => { if (!closing) proposals.tick().catch(() => {}); }, 1000); proposalPoll.unref();
  const poll = setInterval(refreshRemote, 4000); poll.unref();
  const observationPoll = setInterval(() => { if (!closing) void orcaObservation.refresh(); }, 4000); observationPoll.unref();
  const sync = setInterval(() => {
    if (!closing) {
      notion.syncResults(store).catch(() => {});
      for (const tid of Object.keys(herdr.errors)) { const tree = store.data.trees.find(t => t.id === tid); if (tree) void herdr.sync(tree, store.data.trees); }
    }
  }, 5000); sync.unref();
  return { server, store, notion, listen: () => new Promise((resolve, reject) => { server.once('error', e => { releaseLock(); reject(e); }); server.listen(port, BIND_ADDRESS, () => { refreshRemote(); void orcaObservation.refresh(); for (const tree of store.data.trees) void herdr.sync(tree, store.data.trees); resolve(server.address()); }); }), close: () => { closing = true; clearInterval(poll); clearInterval(sync); clearInterval(proposalPoll); clearInterval(observationPoll); return new Promise(resolve => server.close(async () => { await proposals.drain(); releaseLock(); resolve(); })); } };
}
if (require.main === module) {
  try {
    const profile = assertRuntimeProfile();
    const app = createApp();
    app.listen().then(address => { console.log('TaskDesk: ' + localUrl(address.port) + ' (localhost only)'); console.log('User: ' + profile.username); console.log('Data: ' + app.store.dir); }).catch(e => { console.error(e.message); process.exitCode = 1; });
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => app.close().then(() => process.exit(0)));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
module.exports = { createApp };
