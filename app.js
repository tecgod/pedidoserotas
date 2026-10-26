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
/* Fila de alterações: tudo que você faz fica "em pausa" e só vai para a planilha ao tocar em Enviar.
   Só a fila (o que ainda não foi enviado) fica guardada no navegador, para não perder se fechar a página. */
let Q = []; try { Q = JSON.parse(localStorage.getItem('rg_fila') || '[]'); } catch { Q = []; }
const saveQ = () => { try { localStorage.setItem('rg_fila', JSON.stringify(Q)); } catch { } };
function applyOp(o) {
  const a = D[o.sheet];
  if (o.op === 'delete') D[o.sheet] = a.filter(r => r.id != o.row.id);
  else { const i = a.findIndex(r => r.id == o.row.id); i >= 0 ? a[i] = o.row : a.push(o.row); }
}
function queue(sheet, op, row) {
  const o = { sheet, op, row };
  applyOp(o);
  Q = Q.filter(x => !(x.sheet === sheet && x.row.id == row.id)); Q.push(o); saveQ(); render(); autoSend();
}
const put = async (sheet, row) => queue(sheet, 'upsert', row);
const del = async (sheet, row) => queue(sheet, 'delete', row);
async function load() {
  try {
    const j = await (await fetch(CFG.API_URL + '?key=' + encodeURIComponent(CFG.KEY))).json();
    if (j.error) throw j.error;
    D = j; Q.forEach(applyOp); // mantém o que ainda não foi enviado
  } catch (e) { toast('Erro ao carregar: ' + e); }
  render();
}
let timer = null, sending = false, fails = 0;
function autoSend(ms = 8000) { clearTimeout(timer); if (Q.length) timer = setTimeout(() => sendAll(true), ms); } // envia sozinho após alguns segundos parado
async function sendAll(auto) {
  if (sending) return;
  if (!Q.length) return auto || toast('Nada para enviar');
  if (!navigator.onLine) return toast('Sem internet: fica guardado e envia quando voltar');
  sending = true; const b = $('#send'); b.disabled = true;
  const snap = [...Q]; // o que foi feito durante o envio fica na fila para a próxima
  try {
    for (const o of snap) if (o.sheet === 'Clientes' && o.op === 'upsert' && !hasGeo(o.row) && o.row.endereco) {
      toast('Localizando ' + o.row.nome + '…');
      const g = await geo(o.row.endereco, o.row.bairro);
      if (g) { Object.assign(o.row, g); applyOp(o); }
    }
    toast('Enviando ' + snap.length + ' alteração(ões)…');
    const j = await (await fetch(CFG.API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ key: CFG.KEY, op: 'batch', ops: snap }) })).json();
    if (j.error) throw j.error;
    Q = Q.filter(x => !snap.includes(x)); saveQ(); fails = 0; toast('Enviado!');
    await load();
  } catch (e) { toast('Erro ao enviar: ' + e + ' (nada foi perdido)'); if (++fails < 5) autoSend(30000); }
  sending = false; b.disabled = false; render();
}
window.addEventListener('online', () => autoSend(2000));
window.addEventListener('beforeunload', e => { if (Q.length) { e.preventDefault(); e.returnValue = ''; } });

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
  toast('Pegando sua localização…'); GT = 0;
  const p = await here();
  if (!p) return toast('Não consegui o GPS: libere a localização no navegador');
  const f = $('#dlg form');
  f.coord.value = p.lat.toFixed(6) + ', ' + p.lng.toFixed(6);
  try {
    const r = await (await fetch('https://nominatim.openstreetmap.org/reverse?format=json&addressdetails=1&lat=' + p.lat + '&lon=' + p.lng)).json(), ad = r.address || {};
    if (!f.endereco.value && ad.road) f.endereco.value = ad.road + (ad.house_number ? ', ' + ad.house_number : '');
    if (!f.bairro.value) f.bairro.value = ad.suburb || ad.neighbourhood || '';
  } catch { }
  toast('Localização preenchida: confira o número');
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
let GP = null, GT = 0;
const here = () => GP && Date.now() - GT < 6e4 ? Promise.resolve(GP) : new Promise(r => navigator.geolocation
  ? navigator.geolocation.getCurrentPosition(p => { GP = { lat: p.coords.latitude, lng: p.coords.longitude }; GT = Date.now(); r(GP); }, () => r(null), { timeout: 6000, maximumAge: 30000 })
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
  toast('Pronto: toque em Enviar para gravar na planilha'); render();
}

/* ---------- telas ---------- */
const go = t => { tab = t; render(); window.scrollTo(0, 0); };
function render() {
  const sb = $('#send'); sb.textContent = 'Enviar' + (Q.length ? ' (' + Q.length + ')' : ''); sb.className = Q.length ? 'p' : '';
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.t === tab));
  ({ hoje: vHoje, pedidos: vPedidos, rota: vRota, clientes: vClientes })[tab]();
}
const addr = c => esc([c.endereco, c.bairro].filter(Boolean).join(' – ')) || '<span class="bad">sem endereço</span>';
const chip = id => { const d = days(id); return `<span class="chip ${d === null || d > 14 ? 'r' : d >= 7 ? 'y' : 'g'}">${d === null ? 'novo' : d === 0 ? 'hoje' : d + ' d'}</span>`; };
const cliCard = c => `<div class="card"><div class="t">${esc(c.nome)} ${chip(c.id)}</div>
<div class="m">${addr(c)}</div>
<div class="row"><button class="p" onclick="fPedido('${c.id}')">Pedido</button><button onclick="visit('${c.id}').then(()=>toast('Visita registrada'))">Visitei</button>${c.telefone ? `<a class="btn" href="${wa(c.telefone)}" target="_blank" rel="noopener">WhatsApp</a><a class="btn" href="tel:${esc(c.telefone)}">Ligar</a>` : ''}</div></div>`;

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
<div>${x.fardos} fardo(s) · ${vtxt(x)}</div>${x.obs ? `<div class="m">${esc(x.obs)}</div>` : ''}
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
<div class="m">${ent ? f + ' fardo(s) · ' + vc(c.id) : lastTxt(c.id)}</div>
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
<button type="button" class="p big" onclick="useGPS()">Estou no cliente: preencher pela localização</button>
<label>Nome</label><input name="nome" required autocomplete="off" value="${esc(c.nome)}">
<label>Endereço</label><input name="endereco" required autocomplete="off" value="${esc(c.endereco)}">
<label>Telefone</label><input name="telefone" type="tel" inputmode="tel" value="${esc(c.telefone)}">
<details><summary>Mais opções</summary>
<label>Bairro</label><input name="bairro" value="${esc(c.bairro)}">
<label>Visitar a cada (dias)</label><input name="freq" type="number" inputmode="numeric" min="1" value="${esc(c.freq)}">
<label>Coordenadas</label><input name="coord" value="${hasGeo(c) ? c.lat + ', ' + c.lng : ''}">
<label>Observações</label><textarea name="obs" rows="2">${esc(c.obs)}</textarea></details>
<div class="row"><button class="p">Salvar</button><button type="button" onclick="close()">Fechar</button>${id ? `<button type="button" class="d" onclick="xCliente('${id}')">Excluir</button>` : ''}</div></form>`);
}
async function sCliente(e, id) {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target)), old = C(id) || {};
  let coord = f.coord.trim(), changed = (old.endereco || '') !== f.endereco || (old.bairro || '') !== f.bairro;
  const oldCoord = hasGeo(old) ? old.lat + ', ' + old.lng : '';
  let lat = '', lng = '';
  if (coord && (coord !== oldCoord || !changed)) [lat, lng] = coord.split(/[,;\s]+/);
  else toast('Salvo. A localização é buscada ao tocar em Enviar');
  const { coord: _, ...rest } = f;
  close();
  await put('Clientes', { id: id || uid(), criado: old.criado || new Date().toISOString(), ...rest, lat, lng });
}
async function xCliente(id) {
  if (!confirm('Excluir este cliente?')) return;
  close(); await del('Clientes', C(id));
}

const isTroca = x => x.tipo === 'troca';
const vtxt = x => isTroca(x) ? 'TROCA' : brl(x.valor);
const vc = id => { const ps = pend().filter(p => p.clienteId == id), v = ps.reduce((s, x) => s + +x.valor, 0), t = ps.some(isTroca); return (v || !t ? brl(v) : '') + (v && t ? ' + ' : '') + (t ? 'troca' : ''); };
function setTipo(t) {
  const f = $('#dlg form'); f.tipo.value = t;
  $('#bv').classList.toggle('on', t === 'venda'); $('#bt').classList.toggle('on', t === 'troca');
  $('#pp').hidden = t === 'troca'; f.preco.required = t !== 'troca'; if (t === 'troca') f.preco.value = '';
  tot();
}
const lastPed = cid => D.Pedidos.filter(p => p.clienteId == cid && +p.fardos > 0).sort((a, b) => new Date(b.criado) - new Date(a.criado))[0];
const tot = () => { const f = $('#dlg form'); $('#tt').textContent = f.tipo.value === 'troca' ? 'Troca: sem cobrança' : 'Total: ' + brl(f.fardos.value * f.preco.value); };
const stp = (d, n) => { const i = $('#dlg [name=fardos]'); i.value = Math.max(1, n || (+i.value || 0) + d); tot(); };
function fPedido(cid) {
  if (!D.Clientes.length) return toast('Cadastre um cliente primeiro');
  dlg(`<form onsubmit="sPedido(event)"><h2 style="margin-top:0">Novo pedido</h2>
<input type="hidden" name="clienteId"><input type="hidden" name="tipo" value="venda"><div id="pc"></div>
<div class="seg"><button type="button" id="bv" class="on" onclick="setTipo('venda')">Venda</button><button type="button" id="bt" onclick="setTipo('troca')">Troca</button></div>
<label>Fardos</label><div class="step"><button type="button" onclick="stp(-1)">−</button><input name="fardos" type="number" inputmode="numeric" min="1" value="1" oninput="tot()"><button type="button" onclick="stp(1)">+</button></div>
<div class="chips">${[1, 2, 3, 5, 10].map(n => `<button type="button" onclick="stp(0,${n})">${n}</button>`).join('')}</div>
<div id="pp"><label>Preço do fardo (R$)</label><input name="preco" type="number" inputmode="decimal" step="0.01" min="0" required placeholder="Digite o preço" oninput="tot()"></div>
<div class="total" id="tt"></div>
<details><summary>Observação</summary><input name="obs"></details>
<div class="row"><button class="p big">Salvar pedido</button><button type="button" onclick="close()">Fechar</button></div></form>`);
  pickCli(cid);
}
function pickCli(cid) {
  const f = $('#dlg form'), box = $('#pc');
  if (cid) {
    const c = C(cid), l = lastPed(cid);
    f.clienteId.value = cid;
    if (l) f.fardos.value = l.fardos;
    box.innerHTML = `<div class="card"><div class="t">${esc(c.nome)}</div><div class="m">${addr(c)}</div><button type="button" onclick="pickCli()" style="margin-top:8px">Trocar cliente</button></div>`;
    tot(); return;
  }
  f.clienteId.value = '';
  box.innerHTML = '<label>Cliente</label><input id="cs" placeholder="Digite parte do nome" oninput="csl()" autocomplete="off"><div id="cl"></div>';
  csl(); tot();
}
function csl() {
  const q = ($('#cs').value || '').toLowerCase();
  $('#cl').innerHTML = D.Clientes.filter(c => (c.nome + ' ' + c.bairro).toLowerCase().includes(q))
    .sort((a, b) => (needs(b) - needs(a)) || a.nome.localeCompare(b.nome)).slice(0, 6)
    .map(c => `<button type="button" class="big" onclick="pickCli('${c.id}')">${esc(c.nome)} ${chip(c.id)}</button>`).join('') || '<p class="m">Ninguém encontrado.</p>';
}
async function sPedido(e) {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  if (!f.clienteId) return toast('Escolha o cliente');
  close();
  await put('Pedidos', { id: uid(), clienteId: f.clienteId, fardos: f.fardos, tipo: f.tipo, valor: f.tipo === 'troca' ? '0' : (f.fardos * (f.preco || 0)).toFixed(2), obs: f.obs || '', status: 'Pendente', criado: new Date().toISOString(), entregue: '' });
  toast('Pedido salvo');
}

load().then(() => autoSend(3000));
