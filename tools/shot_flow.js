/* 在同一页面实例内执行多步操作并逐步截图
 * node tools/shot_flow.js <url> <outDir> <prefix> <stepsJson>
 * stepsJson: [{"n":"a","js":"...","wait":700}, ...]
 */
const fs = require('fs');
const http = require('http');
const PORT = +(process.env.CDP_PORT || 9333);

function req(path, method = 'GET') {
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path, method }, resp => {
      let d = ''; resp.on('data', c => d += c); resp.on('end', () => res(d));
    });
    r.on('error', rej); r.end();
  });
}

(async () => {
  const [, , url, outDir, prefix, stepsJson, wArg, hArg] = process.argv;
  const W = +(wArg || 430), H = +(hArg || 950);
  const steps = stepsJson.startsWith('@') ? JSON.parse(fs.readFileSync(stepsJson.slice(1), 'utf8')) : JSON.parse(stepsJson);

  const target = JSON.parse(await req('/json/new?about:blank', 'PUT'));
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id); pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  };
  const send = (method, params) => new Promise((res, rej) => {
    const i = ++id; pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url });
  await new Promise(r => setTimeout(r, 1500));

  for (const st of steps) {
    const r = await send('Runtime.evaluate', { expression: st.js, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) console.log('  JSERR[' + st.n + ']', (r.exceptionDetails.exception || {}).description);
    else if (r.result && r.result.value !== undefined) console.log('  RES[' + st.n + ']', r.result.value);
    await new Promise(x => setTimeout(x, st.wait || 800));
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const p = outDir + '/' + prefix + st.n + '.png';
    fs.writeFileSync(p, Buffer.from(shot.data, 'base64'));
    console.log('  SAVED', p, fs.statSync(p).size);
  }
  ws.close();
})().catch(e => { console.error('FAIL', e.message); process.exitCode = 1; });
