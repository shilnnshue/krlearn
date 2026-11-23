/* CDP 截图 + 页面内求值：node tools/shot.js <url> <out.png> [w] [h] [jsFile] [waitMs] */
const fs = require('fs');
const http = require('http');

const [, , url, out, wArg, hArg, jsFile, waitArg] = process.argv;
const W = +(wArg || 1440), H = +(hArg || 1200);
const WAIT = +(waitArg || 900);
const PORT = +(process.env.CDP_PORT || 9333);

function req(path, method = 'GET') {
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path, method }, resp => {
      let d = ''; resp.on('data', c => d += c); resp.on('end', () => res(d));
    });
    r.on('error', rej); r.end();
  });
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && c.pending.has(m.id)) {
        const { res, rej } = c.pending.get(m.id); c.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      } else if (m.method) { c.events.push(m); }
    };
    return c;
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

(async () => {
  const target = JSON.parse(await req('/json/new?' + encodeURIComponent(url), 'PUT'));
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: W, height: H, deviceScaleFactor: 2, mobile: W < 600
    });
    await cdp.send('Page.navigate', { url });
    await new Promise(r => setTimeout(r, 1200));

    if (jsFile) {
      const code = fs.existsSync(jsFile) ? fs.readFileSync(jsFile, 'utf8') : jsFile;
      const r = await cdp.send('Runtime.evaluate', {
        expression: code, awaitPromise: true, returnByValue: true
      });
      if (r.exceptionDetails) console.error('JS ERROR:', JSON.stringify(r.exceptionDetails.exception));
      else console.log('EVAL:', JSON.stringify(r.result.value));
      await new Promise(x => setTimeout(x, WAIT));
    } else {
      await new Promise(x => setTimeout(x, WAIT));
    }

    const errs = await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify(window.__errs || [])', returnByValue: true
    });
    console.log('PAGE_ERRS:', errs.result.value);

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log('SAVED', out, fs.statSync(out).size);
  } catch (e) {
    console.error('FAIL', e.message);
    process.exitCode = 1;
  } finally { cdp.close(); }
})();
