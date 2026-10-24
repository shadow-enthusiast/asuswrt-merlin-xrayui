// Stand-in for the router's httpd, backed by the `router` container.
// - GET  /user1.asp            -> the mounted XRAYUI page with the ASP tags httpd would fill in
// - GET  /ext/xrayui/<file>    -> /www/user/xrayui/<file> inside the container
// - POST /start_apply.htm      -> stores amng_custom in custom_settings.txt and fires the
//                                 service-event hook exactly like install.sh wires it up
import http from 'node:http';
import { execFile } from 'node:child_process';

const CONTAINER = process.env.ROUTER_CONTAINER ?? 'router';
const PORT = Number(process.env.PORT ?? 8080);

const docker = (args, input) =>
  new Promise((resolve) => {
    const child = execFile('docker', args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr: stderr.toString() })
    );
    if (input !== undefined) child.stdin.end(input);
  });
const sh = (script, input) => docker(['exec', '-i', CONTAINER, 'sh', '-c', script], input);

const readSettings = async () => {
  const r = await sh('cat /jffs/addons/custom_settings.txt 2>/dev/null');
  const out = {};
  for (const line of r.stdout.toString().split('\n')) {
    const i = line.indexOf(' ');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
};

const writeSettings = async (settings) => {
  const body = Object.entries(settings)
    .filter(([, v]) => v !== '' && v !== null && v !== undefined)
    .map(([k, v]) => `${k} ${v}\n`)
    .join('');
  await sh('cat >/jffs/addons/custom_settings.txt', body);
};

const jsonc = (value) => JSON.stringify(value).replaceAll('/', '\\/');

const renderAsp = async (html) => {
  const settings = await readSettings();
  const pid = (await sh('pidof xray | cut -d" " -f1')).stdout.toString().trim();
  const values = {
    get_custom_settings: jsonc(settings),
    cpu_core_num: '2',
    get_clientlist: '{}',
    get_clientlist_from_json_database: '{}',
    'nvram_get("productid")': 'RT-AX58U_V2',
    'nvram_get("firmver")': '3004.388.10',
    'nvram_get("preferred_lang")': 'EN',
    'nvram_get("lan_ipaddr")': '192.168.50.1',
    'nvram_get("territory_code")': 'EU/01',
    'nvram_get("wan_ipaddr")': '203.0.113.7',
    'nvram_get("link_internet")': '2',
    'nvram_get("rc_support")': 'am_addons mssid 2.4G 5G',
    'nvram_get("extendno")': '0',
    'sysinfo("pid.xray")': pid || '-1',
    'sysinfo("pid.b4sni")': '-1'
  };
  return html.replace(/<%\s*(.*?);?\s*%>/g, (_tag, call) => values[call.replace(/\(\)$/, '')] ?? '');
};

// The firmware's own page scripts; XRAYUI only needs the loading overlay and a few no-ops.
const MERLIN_JS = `
window.showLoading = function () { document.body.dataset.loading = '1'; };
window.updateLoadingProgress = function () {};
window.hideLoading = function () { delete document.body.dataset.loading; };
window.LoadingTime = function () {};
window.showtext = function (el, text) { if (el) el.textContent = text; };
window.overlib = function () {};
window.show_menu = function () {};
window.hint = function () {};
`;

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
  });

const TYPES = { js: 'application/javascript', json: 'application/json', cab: 'application/json', asp: 'text/html', css: 'text/css' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://router');
  const path = decodeURIComponent(url.pathname);
  const ext = path.split('.').pop();
  try {
    if (req.method === 'POST' && path === '/start_apply.htm') {
      const form = new URLSearchParams(await readBody(req));
      if (form.has('amng_custom')) {
        await writeSettings({ ...(await readSettings()), ...JSON.parse(form.get('amng_custom')) });
      }
      const script = form.get('action_script') ?? '';
      console.log(`[httpd] action_script=${script}`);
      if (script.startsWith('xrayui')) {
        const args = script.split('_').slice(1);
        // service-event: /jffs/scripts/xrayui service_event $(echo "$2" | cut -d'_' -f2- | tr '_' ' ') &
        await docker(['exec', '-d', CONTAINER, 'sh', '-c', `/jffs/scripts/xrayui service_event ${args.join(' ')} >>/tmp/service_event.log 2>&1`]);
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<html><body>ok</body></html>');
    }

    if (path === '/' || /^\/user\d+\.asp$/.test(path)) {
      const page = path === '/' ? (await sh('ls /www/user/user*.asp | head -n 1')).stdout.toString().trim() : `/www/user${path}`;
      const r = await sh(`cat '${page}'`);
      if (r.code !== 0) throw Object.assign(new Error('page not mounted'), { status: 404 });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(await renderAsp(r.stdout.toString()));
    }

    if (path.startsWith('/ext/xrayui/')) {
      const name = path.slice('/ext/xrayui/'.length);
      if (!/^[A-Za-z0-9._-]+$/.test(name)) throw Object.assign(new Error('bad name'), { status: 400 });
      const r = await sh(`cat '/www/user/xrayui/${name}'`);
      if (r.code !== 0) throw Object.assign(new Error('not found'), { status: 404 });
      res.writeHead(200, { 'Content-Type': TYPES[ext] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
      return res.end(r.stdout);
    }

    if (ext === 'js') {
      res.writeHead(200, { 'Content-Type': TYPES.js });
      return res.end(MERLIN_JS);
    }
    if (ext === 'css') {
      // index_style.css hides the loading overlay until showLoading() opens it
      res.writeHead(200, { 'Content-Type': TYPES.css });
      return res.end('.popup_bg { display: none; }');
    }
    if (ext === 'png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end('');
    }
    throw Object.assign(new Error('not found'), { status: 404 });
  } catch (e) {
    res.writeHead(e.status ?? 500, { 'Content-Type': 'text/plain' });
    res.end(String(e.message ?? e));
  }
});

server.listen(PORT, () => console.log(`[httpd] listening on http://127.0.0.1:${PORT}`));
