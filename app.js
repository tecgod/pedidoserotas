/* ROTAS DA GOMA – tudo é lido/gravado na planilha (via Apps Script). Nada fica no navegador. */
const CFG = {
  API_URL: 'https://script.google.com/macros/s/AKfycbzsfCab1yV9sro0zHPW0sOmHVU95mVV0fjUeaTBuAiu8323WsGrWJkeQm5rQwKqOrkX/exec',
  KEY: 'troque-esta-chave',                   // a mesma do Code.gs
  CIDADE: 'Fortaleza, CE',                    // ajuda a achar o endereço
  PRECO_FARDO: 0,                             // 0 = digitar o valor na mão
  FREQ_PADRAO: 7                              // dias entre visitas
};
let D = { Clientes: [], Pedidos: [], Visitas: [] }, tab = 'hoje', rmode = 'entrega';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const brl = n => (+n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const C = id => D.Clientes.find(c => c.id == id);
const pend = () => D.Pedidos.filter(p => p.status === 'Pendente');
const toast = m => { const t = $('#toast'); t.textContent = m; t.className = 'show'; setTimeout(() => t.className = '', 2600); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- dados ---------- */
async function load() {
  try {
    const j = await (await fetch(CFG.API_URL + '?key=' + encodeURIComponent(CFG.KEY))).json();
    if (j.error) throw j.error;
    D = j;
  } catch (e) { toast('Erro ao carregar: ' + e); }
  render();
}
async function send(sheet, op, row) {
  try {
    const j = await (await fetch(CFG.API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ key: CFG.KEY, sheet, op, row }) })).json();
    if (j.error) throw j.error;
  } catch (e) { toast('Erro ao salvar: ' + e); }
}
async function put(sheet, row) {
  const i = D[sheet].findIndex(r => r.id == row.id);
  i >= 0 ? D[sheet][i] = row : D[sheet].push(row);
  render(); await send(sheet, 'upsert', row);
}
async function del(sheet, row) {
  D[sheet] = D[sheet].filter(r => r.id != row.id);
  render(); await send(sheet, 'delete', row);
}

/* ---------- regras ---------- */
const last = id => D.Visitas.filter(v => v.clienteId == id).map(v => +new Date(v.data)).sort((a, b) => b - a)[0];
const days = id => { const l = last(id); return l ? Math.floor((Date.now() - l) / 864e5) : null; };
const needs = c => { const d = days(c.id); return d === null || d >= (+c.freq || CFG.FREQ_PADRAO); };
const lastTxt = id => { const d = days(id); return d === null ? 'nunca visitado' : d === 0 ? 'visitado hoje' : 'última visita há ' + d + ' d'; };
const hasGeo = c => c.lat !== '' && c.lng !== '' && !isNaN(+c.lat) && !isNaN(+c.lng);
const pt = c => ({ ...c, lat: +c.lat, lng: +c.lng });
const wa = t => 'https://wa.me/55' + String(t).replace(/\D/g, '').replace(/^55/, '');

async function visit(cid, obs = '') { await put('Visitas', { id: uid(), clienteId: cid, data: new Date().toISOString(), obs }); }
async function deliver(pid) {
  const p = D.Pedidos.find(x => x.id == pid);
  await put('Pedidos', { ...p, status: 'Entregue', entregue: new Date().toISOString() });
  await visit(p.clienteId, 'entrega'); toast('Entrega registrada');
}
async function deliverClient(cid) { for (const p of pend().filter(p => p.clienteId == cid)) await deliver(p.id); }
async function cancelPed(pid) {
  if (!confirm('Cancelar este pedido?')) return;
  await del('Pedidos', D.Pedidos.find(x => x.id == pid));
}

/* ---------- geocodificação e rota (100% gratuito: OpenStreetMap + Google Maps link) ---------- */
async function geo1(q) {
  try {
    const r = await (await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=br&q=' + encodeURIComponent(q + ', ' + CFG.CIDADE))).json();
    return r[0] ? { lat: (+r[0].lat).toFixed(6), lng: (+r[0].lon).toFixed(6) } : null;
  } catch { return null; }
}
async function geo(addr, bairro = '') { // tenta várias formas do endereço
  const rua = addr.replace(/\s*(,|-|n[º°o.]*)?\s*\d+.*$/i, '').trim(); // tira número e complemento
  for (const q of [addr + ' ' + bairro, addr, rua + ' ' + bairro, rua].filter(s => s.trim())) {
    const g = await geo1(q.trim()); if (g) return g;
    await sleep(1100);
  }
  return null;
}
async function useGPS() {
  toast('Pegando sua localização…');
  const p = await here();
  if (!p) return toast('Não consegui o GPS: libere a localização no navegador');
  $('#dlg [name=coord]').value = p.lat.toFixed(6) + ', ' + p.lng.toFixed(6);
  toast('Localização preenchida');
}
const hav = (a, b) => {
  const r = x => x * Math.PI / 180, dl = r(b.lat - a.lat), dn = r(b.lng - a.lng);
  const h = Math.sin(dl / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dn / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};
function optimize(pts, start) { // vizinho mais próximo + 2-opt
  let rem = [...pts], cur = start, path = [];
  while (rem.length) {
    let bi = 0, bd = 1e9;
    rem.forEach((p, i) => { const d = hav(cur, p); if (d < bd) { bd = d; bi = i; } });
    cur = rem.splice(bi, 1)[0]; path.push(cur);
  }
  const len = a => a.reduce((s, p, i) => s + hav(i ? a[i - 1] : start, p), 0);
  let imp = true, n = 0;
  while (imp && n++ < 40) {
    imp = false;
    for (let i = 0; i < path.length - 1; i++) for (let j = i + 1; j < path.length; j++) {
      const np = [...path.slice(0, i), ...path.slice(i, j + 1).reverse(), ...path.slice(j + 1)];
      if (len(np) < len(path) - 1e-6) { path = np; imp = true; }
    }
  }
  return path;
}
const here = () => new Promise(r => navigator.geolocation
  ? navigator.geolocation.getCurrentPosition(p => r({ lat: p.coords.latitude, lng: p.coords.longitude }), () => r(null), { timeout: 6000 })
  : r(null));
function mapLinks(path) { // Google Maps aceita até 10 paradas por link
  const co = p => p.lat + ',' + p.lng, out = [];
  for (let i = 0; i < path.length; i += 10) {
    const leg = path.slice(i, i + 10), dest = leg[leg.length - 1], wp = leg.slice(0, -1).map(co).join('|');
    out.push('https://www.google.com/maps/dir/?api=1' + (i ? '&origin=' + co(path[i - 1]) : '') + '&destination=' + co(dest) + '&travelmode=driving' + (wp ? '&waypoints=' + encodeURIComponent(wp) : ''));
  }
  return out;
}
async function fillGeo() {
  const miss = D.Clientes.filter(c => !hasGeo(c) && c.endereco);
  for (let i = 0; i < miss.length; i++) {
    toast(`Localizando ${i + 1}/${miss.length}…`);
    const g = await geo(miss[i].endereco, miss[i].bairro);
    if (g) await put('Clientes', { ...miss[i], ...g });
    await sleep(1100); // limite do serviço gratuito: 1 consulta/segundo
  }
  toast('Pronto'); render();
}

/* ---------- telas ---------- */
const go = t => { tab = t; render(); window.scrollTo(0, 0); };
function render() {
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.t === tab));
  ({ hoje: vHoje, pedidos: vPedidos, rota: vRota, clientes: vClientes })[tab]();
}
const addr = c => esc([c.endereco, c.bairro].filter(Boolean).join(' – ')) || '<span class="bad">sem endereço</span>';
const cliCard = c => `<div class="card"><div class="t">${esc(c.nome)}</div>
<div class="m">${addr(c)}</div><div class="m ${needs(c) ? 'w' : ''}">${lastTxt(c.id)}</div>
<div class="row"><button class="p" onclick="fPedido('${c.id}')">Fazer pedido</button><button onclick="visit('${c.id}').then(()=>toast('Visita registrada'))">Visitei</button>${c.telefone ? `<a class="btn" href="${wa(c.telefone)}" target="_blank" rel="noopener">WhatsApp</a>` : ''}</div></div>`;

function vHoje() {
  const p = pend(), fd = p.reduce((s, x) => s + +x.fardos, 0), vl = p.reduce((s, x) => s + +x.valor, 0), nv = D.Clientes.filter(needs);
  $('#v').innerHTML = `<div class="stats"><div><b>${p.length}</b>pedidos pendentes</div><div><b>${fd}</b>fardos a separar</div><div><b>${brl(vl)}</b>a receber</div></div>
<h2>Precisam de visita (${nv.length})</h2>${nv.map(cliCard).join('') || '<p class="m">Nenhum cliente atrasado.</p>'}`;
}

function vPedidos() {
  const p = pend(), by = {};
  p.forEach(x => by[x.clienteId] = (by[x.clienteId] || 0) + +x.fardos);
  const fd = p.reduce((s, x) => s + +x.fardos, 0);
  $('#v').innerHTML = `<div class="row" style="margin:0"><button class="p" onclick="fPedido()">Novo pedido</button></div>
<h2>Separar em casa (${fd} fardos)</h2>
${Object.keys(by).map(id => `<div class="card"><b>${by[id]}</b> fardo(s) — ${esc(C(id)?.nome || '?')}</div>`).join('') || '<p class="m">Nada pendente.</p>'}
<h2>Pedidos pendentes (${p.length})</h2>
${p.map(x => { const c = C(x.clienteId) || {}; return `<div class="card"><div class="t">${esc(c.nome)}</div><div class="m">${addr(c)}</div>
<div>${x.fardos} fardo(s) · ${brl(x.valor)}</div>${x.obs ? `<div class="m">${esc(x.obs)}</div>` : ''}
<div class="row"><button class="p" onclick="deliver('${x.id}')">Entregue</button><button class="d" onclick="cancelPed('${x.id}')">Cancelar</button></div></div>`; }).join('')}`;
}

async function vRota() {
  const ent = rmode === 'entrega';
  const base = ent ? [...new Set(pend().map(p => p.clienteId))].map(C).filter(Boolean) : D.Clientes.filter(needs);
  const ok = base.filter(hasGeo).map(pt), sem = base.filter(c => !hasGeo(c));
  const seg = `<div class="seg"><button class="${ent ? 'on' : ''}" onclick="rmode='entrega';render()">Entregas</button><button class="${ent ? '' : 'on'}" onclick="rmode='visita';render()">Visitas</button></div>`;
  $('#v').innerHTML = seg + '<p class="m">Calculando a melhor rota…</p>';
  const gps = await here(), start = gps || ok[0];
  const path = ok.length ? optimize(ok, start) : [];
  let km = 0; path.forEach((p, i) => km += hav(i ? path[i - 1] : start, p));
  const links = mapLinks(path), miss = D.Clientes.filter(c => !hasGeo(c) && c.endereco).length;
  if (tab !== 'rota') return;
  $('#v').innerHTML = seg + (path.length ? `<div class="card"><b>${path.length} parada(s)</b> · cerca de ${(km * 1.3).toFixed(1)} km${gps ? '' : ' (a partir da 1ª parada: ative o GPS para partir de onde você está)'}
<div class="row">${links.map((u, i) => `<a class="btn p" href="${u}" target="_blank" rel="noopener">Abrir no Maps${links.length > 1 ? ' – trecho ' + (i + 1) : ''}</a>`).join('')}</div></div>` : '<p class="m">Nenhuma parada com localização.</p>') +
    path.map((c, i) => { const f = pend().filter(p => p.clienteId == c.id).reduce((s, x) => s + +x.fardos, 0); return `<div class="card stop"><div class="n">${i + 1}</div><div style="flex:1"><div class="t">${esc(c.nome)}</div><div class="m">${addr(c)}</div>
<div class="m">${ent ? f + ' fardo(s) · ' + brl(pend().filter(p => p.clienteId == c.id).reduce((s, x) => s + +x.valor, 0)) : lastTxt(c.id)}</div>
<div class="row">${ent ? `<button class="p" onclick="deliverClient('${c.id}')">Entregue</button>` : `<button class="p" onclick="fPedido('${c.id}')">Fazer pedido</button><button onclick="visit('${c.id}')">Visitei</button>`}</div></div></div>`; }).join('') +
    (sem.length ? `<h2>Sem localização (${sem.length})</h2>${sem.map(c => `<div class="card">${esc(c.nome)} <span class="m">– edite o endereço em Clientes</span></div>`).join('')}` : '') +
    (miss ? `<div class="row"><button onclick="fillGeo()">Localizar ${miss} endereço(s) automaticamente</button></div>` : '');
}

function vClientes() {
  $('#v').innerHTML = `<div class="row" style="margin:0"><button class="p" onclick="fCliente()">Novo cliente</button></div>
<input id="q" placeholder="Buscar por nome ou bairro" oninput="lc()" style="margin-top:12px"><div id="lc"></div>`;
  lc();
}
function lc() {
  const q = ($('#q')?.value || '').toLowerCase();
  $('#lc').innerHTML = D.Clientes.filter(c => (c.nome + ' ' + c.bairro).toLowerCase().includes(q)).sort((a, b) => a.nome.localeCompare(b.nome)).map(c =>
    `<div class="card"><div class="t">${esc(c.nome)}</div><div class="m">${addr(c)}</div><div class="m">${lastTxt(c.id)} · visitar a cada ${+c.freq || CFG.FREQ_PADRAO} d${hasGeo(c) ? '' : ' · <span class="bad">sem localização</span>'}</div>
<div class="row"><button onclick="fCliente('${c.id}')">Editar</button><button class="p" onclick="fPedido('${c.id}')">Pedido</button>${hasGeo(c) ? `<a class="btn" href="https://www.google.com/maps?q=${c.lat},${c.lng}" target="_blank" rel="noopener">Ver no mapa</a>` : ''}</div></div>`).join('') || '<p class="m">Nenhum cliente.</p>';
}

/* ---------- formulários ---------- */
const dlg = h => { $('#dlg').innerHTML = h; $('#dlg').showModal(); };
const close = () => $('#dlg').close();

function fCliente(id) {
  const c = C(id) || { freq: CFG.FREQ_PADRAO };
  dlg(`<form onsubmit="sCliente(event,'${id || ''}')"><h2 style="margin-top:0">${id ? 'Editar' : 'Novo'} cliente</h2>
<label>Nome</label><input name="nome" required value="${esc(c.nome)}">
<label>Telefone (WhatsApp)</label><input name="telefone" type="tel" value="${esc(c.telefone)}">
<label>Endereço (rua e número)</label><input name="endereco" required value="${esc(c.endereco)}">
<label>Bairro</label><input name="bairro" value="${esc(c.bairro)}">
<label>Visitar a cada (dias)</label><input name="freq" type="number" min="1" value="${esc(c.freq)}">
<label>Coordenadas (preenchidas sozinhas pelo endereço)</label><input name="coord" value="${hasGeo(c) ? c.lat + ', ' + c.lng : ''}">
<button type="button" onclick="useGPS()" style="margin-bottom:10px">Estou no cliente: usar minha localização</button>
<label>Observações</label><textarea name="obs" rows="2">${esc(c.obs)}</textarea>
<div class="row"><button class="p">Salvar</button><button type="button" onclick="close()">Fechar</button>${id ? `<button type="button" class="d" onclick="xCliente('${id}')">Excluir</button>` : ''}</div></form>`);
}
async function sCliente(e, id) {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target)), old = C(id) || {};
  let coord = f.coord.trim(), changed = (old.endereco || '') !== f.endereco || (old.bairro || '') !== f.bairro;
  const oldCoord = hasGeo(old) ? old.lat + ', ' + old.lng : '';
  let lat = '', lng = '';
  if (coord && (coord !== oldCoord || !changed)) [lat, lng] = coord.split(/[,;\s]+/);
  else { toast('Localizando endereço…'); const g = await geo(f.endereco, f.bairro); if (g) ({ lat, lng } = g); else toast('Endereço não localizado: cole as coordenadas depois'); }
  const { coord: _, ...rest } = f;
  close();
  await put('Clientes', { id: id || uid(), criado: old.criado || new Date().toISOString(), ...rest, lat, lng });
}
async function xCliente(id) {
  if (!confirm('Excluir este cliente?')) return;
  close(); await del('Clientes', C(id));
}

function fPedido(cid) {
  if (!D.Clientes.length) return toast('Cadastre um cliente primeiro');
  const opts = [...D.Clientes].sort((a, b) => a.nome.localeCompare(b.nome)).map(c => `<option value="${c.id}" ${c.id == cid ? 'selected' : ''}>${esc(c.nome)}</option>`).join('');
  dlg(`<form onsubmit="sPedido(event)"><h2 style="margin-top:0">Novo pedido</h2>
<label>Cliente</label><select name="clienteId">${opts}</select>
<label>Quantidade de fardos</label><input name="fardos" type="number" min="1" required oninput="if(${CFG.PRECO_FARDO})this.form.valor.value=(this.value*${CFG.PRECO_FARDO}).toFixed(2)">
<label>Valor total (R$)</label><input name="valor" type="number" step="0.01" min="0" required>
<label>Observações</label><input name="obs">
<div class="row"><button class="p">Salvar pedido</button><button type="button" onclick="close()">Fechar</button></div></form>`);
}
async function sPedido(e) {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  close(); await put('Pedidos', { id: uid(), ...f, status: 'Pendente', criado: new Date().toISOString(), entregue: '' });
  toast('Pedido salvo');
}

load();
