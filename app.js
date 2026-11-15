/*
 * 작은도서관 보조금 증빙 PDF 합치기
 * - 모든 처리는 브라우저 안에서만 합니다. 파일을 어디에도 보내지 않습니다.
 * - 서류 목록은 config/docs-YYYY.json 에서 읽습니다(index.html 의 data-config).
 */
(() => {
  'use strict';

  const CONFIG_URL = document.body.dataset.config || 'config/docs-2026.json';
  const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
  const HEIC_LIB = 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';
  const A4 = { w: 595.28, h: 841.89 };
  const MARGIN = 18;                       // 페이지 여백(pt)
  const SMALL = { maxPixels: 1400, quality: 0.6 }; // '용량 더 줄이기' 설정
  const ACCEPT = 'image/*,.jpg,.jpeg,.png,.heic,.heif,.pdf,application/pdf';

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // 화면이 멈추지 않게 잠깐 쉬어 갑니다(다른 탭을 보고 있어도 계속 진행되도록 rAF는 쓰지 않음).
  const nextFrame = () => new Promise((r) => {
    if (document.hidden) { const ch = new MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(0); }
    else setTimeout(r, 0);
  });

  let config = null;
  let uid = 0;
  let dragId = null;
  let downloadUrls = [];

  const state = {
    step: 1,
    programId: null,
    typeId: null,
    info: { date: '', amount: '', vendor: '' },
    slots: [],            // [{ doc, items: [], busy: 0, msg: '' }]
    checked: false,       // 저장 단계로 넘어가 본 적이 있으면 빈 필수칸을 빨갛게
    fileNameEdited: false,
  };

  /* ---------------- 시작 ---------------- */

  init();

  async function init() {
    try {
      const res = await fetch(CONFIG_URL, { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      try { config = JSON.parse(text); }
      catch (e) { throw Object.assign(new Error(e.message), { jsonError: true }); }
      validateConfig(config);
    } catch (e) {
      const msg = $('#loadingMsg');
      msg.classList.add('error');
      msg.innerHTML = e.jsonError
        ? `서류 목록 설정 파일(<b>${esc(CONFIG_URL)}</b>)에 글자 오류가 있습니다.<br>쉼표(,)·따옴표(")·괄호가 빠졌는지 확인해 주세요.<br><small>${esc(e.message)}</small>`
        : `서류 목록 설정 파일(<b>${esc(CONFIG_URL)}</b>)을 불러오지 못했습니다.<br>인터넷 주소(https://…)로 열었는지 확인해 주세요. 파일을 더블클릭해서 열면 동작하지 않습니다.<br><small>${esc(e.message)}</small>`;
      return;
    }

    if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    if (!window.PDFLib) {
      const msg = $('#loadingMsg');
      msg.classList.add('error');
      msg.textContent = 'PDF 프로그램을 불러오지 못했습니다. 인터넷 연결을 확인하고 새로고침해 주세요.';
      return;
    }

    if (config.title) { $('#appTitle').textContent = config.title; document.title = config.title; }
    const c = config.contact || {};
    $('#contact').textContent = [c.org, c.phone ? '문의 ' + c.phone : ''].filter(Boolean).join(' / ');

    renderPrograms();
    bindEvents();
    $('#loading').hidden = true;
    goStep(1);
  }

  function validateConfig(cfg) {
    if (!Array.isArray(cfg.programs) || !Array.isArray(cfg.types)) {
      throw Object.assign(new Error('"programs" 또는 "types" 목록이 없습니다.'), { jsonError: true });
    }
    cfg.types.forEach((t, i) => {
      if (!t.id || !t.name || !Array.isArray(t.docs)) {
        throw Object.assign(new Error(`types 의 ${i + 1}번째 항목에 id, name, docs 중 빠진 것이 있습니다.`), { jsonError: true });
      }
    });
    cfg.image = Object.assign({ maxPixels: 2000, quality: 0.8 }, cfg.image || {});
  }

  /* ---------------- 단계 이동 ---------------- */

  // '서류 목록 없이 파일만 합치기' 모드: 사업·유형·정보 단계를 건너뛰고 칸 하나에 넣어 합칩니다.
  const FREE_ID = '__free';
  const FREE_PROGRAM = { id: FREE_ID, name: '서류 목록 없이 파일만 합치기' };
  const FREE_TYPE = { id: FREE_ID, name: '파일 합치기', programs: [], budgetItem: '', tip: '', docs: [] };
  const isFree = () => state.typeId === FREE_ID;

  function canGo(n) {
    if (n <= 1) return true;
    if (isFree()) return n >= 4;
    if (n === 2) return !!state.programId;
    return !!state.typeId;
  }

  function goStep(n) {
    if (isFree() && (n === 2 || n === 3)) n = 1;
    if (!canGo(n)) return;
    if (n === 5) {
      state.checked = true;
      renderSlots();
      renderSummary();
    }
    if (n === 4) renderSlots();
    state.step = n;
    $$('.screen[data-screen]').forEach((s) => { s.hidden = Number(s.dataset.screen) !== n; });
    $$('#steps li').forEach((li) => {
      const k = Number(li.dataset.step);
      li.classList.toggle('current', k === n);
      li.classList.toggle('done', k < n && canGo(k + 1));
      $('button', li).disabled = !canGo(k);
    });
    $('#stepsNow').innerHTML = isFree() && n >= 4
      ? `<b>파일만 합치기</b> · ${n === 4 ? '파일 넣기' : '확인하고 저장하기'}`
      : `<b>${n} / 5단계</b> · ${STEP_NAMES[n]}`;
    $('#q4').textContent = isFree() ? '합칠 파일을 넣어 주세요' : '서류를 칸마다 넣어 주세요';
    $('#reqNote').hidden = isFree();
    renderCrumbs();
    window.scrollTo(0, 0);
  }

  const STEP_NAMES = { 1: '사업 고르기', 2: '집행 유형 고르기', 3: '집행 정보 적기', 4: '서류 넣기', 5: '확인하고 저장하기' };

  function renderCrumbs() {
    const p = currentProgram();
    const t = currentType();
    $('#crumb2').textContent = p ? p.name : '';
    const both = p && t ? `${p.name} › ${t.name}` : '';
    $('#crumb3').textContent = both;
    $('#crumb4').textContent = isFree() ? FREE_PROGRAM.name
      : t ? (t.budgetItem ? `${both}  (보탬e 보조세목: ${t.budgetItem})` : both) : '';
    $('#crumb5').textContent = $('#crumb4').textContent;
  }

  const currentProgram = () => (state.programId === FREE_ID ? FREE_PROGRAM : config.programs.find((p) => p.id === state.programId));
  const currentType = () => (isFree() ? FREE_TYPE : config.types.find((t) => t.id === state.typeId));

  function startFree() {
    if (!isFree()) {
      if (hasFiles() && !confirm('지금 넣은 파일이 모두 지워집니다. 파일만 합치기로 바꿀까요?')) return;
      clearFiles();
      state.programId = FREE_ID;
      state.typeId = FREE_ID;
      buildSlots();
      renderPrograms();
    }
    goStep(4);
  }
  const allItems = () => state.slots.flatMap((s) => s.items);
  const hasFiles = () => allItems().length > 0;
  const busyCount = () => state.slots.reduce((n, s) => n + s.busy, 0);

  /* ---------------- 1·2단계: 사업·유형 ---------------- */

  function renderPrograms() {
    $('#programCards').innerHTML = config.programs.map((p) => {
      const n = config.types.filter((t) => (t.programs || []).includes(p.id)).length;
      const picked = p.id === state.programId;
      return `<button type="button" class="card${picked ? ' selected' : ''}" data-program="${esc(p.id)}">
        <span class="c-tab">집행 유형 ${n}가지</span>
        <span class="c-name">${esc(p.name)}</span>
        <span class="c-go">${picked ? '✓ 고른 사업' : '고르기 →'}</span>
      </button>`;
    }).join('');
  }

  function renderTypes() {
    const list = config.types.filter((t) => (t.programs || []).includes(state.programId));
    $('#typeCards').innerHTML = list.map((t) => `
      <button type="button" class="card${t.id === state.typeId ? ' selected' : ''}" data-type="${esc(t.id)}">
        ${t.budgetItem ? `<span class="c-tab" title="보탬e 보조세목">${esc(t.budgetItem)}</span>` : ''}
        <span class="c-name">${esc(t.name)}</span>
        ${t.tip ? `<span class="c-tip">${esc(t.tip)}</span>` : ''}
        <span class="c-go">${t.id === state.typeId ? '✓ 고른 유형' : '고르기 →'}</span>
      </button>`).join('') || '<p>이 사업에 등록된 집행 유형이 없습니다. 설정 파일을 확인해 주세요.</p>';
  }

  function selectProgram(id) {
    if (state.programId !== id && state.typeId) {
      const t = currentType();
      if (t && !(t.programs || []).includes(id)) {
        if (hasFiles() && !confirm('사업을 바꾸면 넣은 파일이 모두 지워집니다. 바꿀까요?')) return;
        clearFiles();
        state.typeId = null;
        state.slots = [];
      }
    }
    state.programId = id;
    renderPrograms();
    renderTypes();
    goStep(2);
  }

  function selectType(id) {
    if (state.typeId !== id) {
      if (hasFiles() && !confirm('유형을 바꾸면 넣은 파일이 모두 지워집니다. 바꿀까요?')) return;
      clearFiles();
      state.typeId = id;
      buildSlots();
    }
    renderTypes();
    goStep(3);
  }

  function buildSlots() {
    const t = currentType();
    state.checked = false;
    state.fileNameEdited = false;
    state.slots = t.docs.map((d) => ({ doc: d, items: [], busy: 0, msg: '' }));
    state.slots.push({
      doc: isFree()
        ? { name: '합칠 파일', required: false, multiple: true, tip: '넣은 순서대로 합쳐집니다. 사진 아래 [◀ 앞으로] [뒤로 ▶]로 순서를 바꿀 수 있어요.', other: true }
        : { name: '기타 서류', required: false, multiple: true, tip: '어느 칸에 넣을지 애매한 서류는 여기에 넣어 주세요', other: true },
      items: [], busy: 0, msg: '',
    });
    $('#typeTip4').hidden = !t.tip;
    $('#typeTip4Text').textContent = t.tip || '';
  }

  function clearFiles() {
    allItems().forEach(releaseItem);
    state.slots.forEach((s) => { s.items = []; s.msg = ''; });
  }

  function releaseItem(it) {
    if (it.thumbUrl) URL.revokeObjectURL(it.thumbUrl);
  }

  /* ---------------- 4단계: 서류 칸 ---------------- */

  function renderSlots() {
    $('#slots').innerHTML = state.slots.map((_, i) => slotHtml(i)).join('');
    updateSizeInfo();
  }

  function renderSlot(i) {
    const el = $(`.slot[data-i="${i}"]`);
    if (!el) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = slotHtml(i);
    el.replaceWith(tmp.firstElementChild);
    updateSizeInfo();
  }

  function slotHtml(i) {
    const s = state.slots[i];
    const d = s.doc;
    const n = s.items.length;
    const cls = ['slot'];
    const missing = !n && d.required && state.checked;
    if (n) cls.push('filled');
    else if (missing) cls.push('missing');
    const badge = d.other ? '' : d.required ? '<span class="badge req">필수</span>' : '<span class="badge opt">해당 시</span>';
    const tip = d.tip || (d.multiple ? '여러 장을 넣을 수 있습니다' : '');
    const thumbs = s.items.map((it, k) => thumbHtml(it, k, n)).join('');
    const num = n ? '✓' : missing ? '?' : d.other ? '+' : i + 1;
    return `<div class="${cls.join(' ')}" data-i="${i}">
      <div class="slot-head">
        <span class="num" aria-hidden="true">${num}</span>
        <span class="name">${d.other ? '' : `${i + 1}. `}${esc(d.name)}</span>
        ${badge}
        ${n ? `<span class="badge cnt">${n}쪽 넣음</span>` : ''}
      </div>
      ${tip ? `<p class="tip">${esc(tip)}</p>` : ''}
      <div class="drop">
        <p class="drop-msg">${n ? '더 넣으려면 끌어다 놓거나' : '여기로 끌어다 놓거나'}</p>
        <label class="btn">파일 고르기<input class="vh" type="file" multiple accept="${ACCEPT}"></label>
        <label class="btn camera">사진 찍기<input class="vh" type="file" accept="image/*" capture="environment"></label>
      </div>
      ${s.busy ? `<p class="slot-busy">파일을 처리하는 중입니다… (${s.busy}개 남음)</p>` : ''}
      ${s.msg ? `<p class="slot-msg">${esc(s.msg)}</p>` : ''}
      ${missing ? '<p class="slot-check">비어 있어요. 다른 파일에 함께 들어 있거나 비슷한 서류로 냈다면 그대로 두셔도 됩니다.</p>' : ''}
      <div class="thumbs">${thumbs}</div>
    </div>`;
  }

  function thumbHtml(it, k, n) {
    const rot = it.rotation ? ` style="transform:rotate(${it.rotation}deg)"` : '';
    const pic = it.thumbUrl ? `<img src="${it.thumbUrl}" alt=""${rot}>` : `<span class="ph">PDF</span>`;
    return `<div class="thumb" draggable="true" data-id="${it.id}">
      <div class="pic" title="끌어서 순서를 바꿀 수 있습니다">${pic}</div>
      <div class="cap" title="${esc(it.name)}">${k + 1}. ${esc(it.label || it.name)}</div>
      <div class="tools">
        <button type="button" data-act="up" ${k === 0 ? 'disabled' : ''}>◀ 앞으로</button>
        <button type="button" data-act="down" ${k === n - 1 ? 'disabled' : ''}>뒤로 ▶</button>
        <button type="button" data-act="rot" title="오른쪽으로 90도">↻ 돌리기</button>
        <button type="button" data-act="del" class="del">빼기</button>
      </div>
    </div>`;
  }

  function findItem(id) {
    for (let si = 0; si < state.slots.length; si++) {
      const k = state.slots[si].items.findIndex((it) => it.id === id);
      if (k >= 0) return { si, k, item: state.slots[si].items[k] };
    }
    return null;
  }

  function onThumbAction(id, act) {
    const f = findItem(id);
    if (!f) return;
    const items = state.slots[f.si].items;
    if (act === 'up' && f.k > 0) [items[f.k - 1], items[f.k]] = [items[f.k], items[f.k - 1]];
    else if (act === 'down' && f.k < items.length - 1) [items[f.k + 1], items[f.k]] = [items[f.k], items[f.k + 1]];
    else if (act === 'rot') f.item.rotation = (f.item.rotation + 90) % 360;
    else if (act === 'del') { releaseItem(f.item); items.splice(f.k, 1); }
    renderSlot(f.si);
  }

  /* ----- 파일 넣기 ----- */

  function detectKind(file) {
    const name = (file.name || '').toLowerCase();
    const ext = name.includes('.') ? name.split('.').pop() : '';
    const type = (file.type || '').toLowerCase();
    if (type === 'application/pdf' || ext === 'pdf') return 'pdf';
    if (type === 'image/heic' || type === 'image/heif' || ext === 'heic' || ext === 'heif') return 'heic';
    if (/^image\/(jpeg|png|webp|gif|bmp)$/.test(type) || ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'jfif'].includes(ext)) return 'image';
    return null;
  }

  async function addFiles(si, files) {
    const slot = state.slots[si];
    if (!slot || !files.length) return;
    const errors = [];
    state.saved = false;
    slot.msg = '';
    slot.busy += files.length;
    renderSlot(si);
    for (const f of files) {
      try {
        const kind = detectKind(f);
        if (!kind) {
          errors.push(`${f.name}: 넣을 수 없는 형식입니다. 한글·엑셀 등은 'PDF로 저장'한 뒤 넣어 주세요.`);
        } else if (kind === 'pdf') {
          slot.items.push(...(await loadPdf(f)));
        } else {
          slot.items.push(await loadImage(f, kind === 'heic'));
        }
      } catch (e) {
        console.error(e);
        errors.push(`${f.name}: ${e.userMsg || '파일을 읽지 못했습니다.'}`);
      }
      slot.busy--;
      slot.msg = errors.join('\n');
      renderSlot(si);
      await nextFrame();
    }
  }

  async function loadImage(file, isHeic) {
    let img;
    try {
      img = await decodeImage(file);
    } catch (e) {
      if (!isHeic) throw Object.assign(e, { userMsg: '사진을 열 수 없습니다. 손상되었거나 지원하지 않는 사진입니다.' });
      // 크롬·엣지 등은 아이폰 HEIC 사진을 직접 못 열어서 변환합니다.
      await loadScript(HEIC_LIB);
      let out;
      try { out = await window.heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 }); }
      catch (e2) { throw Object.assign(e2, { userMsg: '아이폰 사진(HEIC)을 변환하지 못했습니다.' }); }
      img = await decodeImage(Array.isArray(out) ? out[0] : out);
    }
    const { maxPixels, quality } = config.image;
    const main = await drawToJpeg(img, 0, maxPixels, quality);
    const thumb = await drawToJpeg(img, 0, 320, 0.7);
    URL.revokeObjectURL(img.src);
    return {
      id: ++uid, kind: 'image', name: file.name || '사진', rotation: 0,
      bytes: main.bytes, w: main.w, h: main.h,
      thumbUrl: URL.createObjectURL(new Blob([thumb.bytes], { type: 'image/jpeg' })),
    };
  }

  // 브라우저가 사진의 방향(EXIF)을 자동으로 바로잡아 그려 줍니다.
  function decodeImage(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image decode failed')); };
      img.src = url;
    });
  }

  // 이미지를 (회전 후) 최대 크기에 맞춰 줄이고 흰 바탕 JPEG로 만듭니다.
  async function drawToJpeg(img, rotation, maxPixels, quality) {
    const sw = img.naturalWidth || img.width;
    const sh = img.naturalHeight || img.height;
    const scale = Math.min(1, maxPixels / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));
    const swap = rotation % 180 !== 0;
    const canvas = document.createElement('canvas');
    canvas.width = swap ? h : w;
    canvas.height = swap ? w : h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.drawImage(img, -w / 2, -h / 2, w, h);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const out = { bytes, w: canvas.width, h: canvas.height };
    canvas.width = canvas.height = 0;
    return out;
  }

  async function loadPdf(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const src = { id: ++uid, bytes, size: bytes.length, name: file.name, pageCount: 0 };
    const items = [];

    if (!window.pdfjsLib) {
      // 미리보기 프로그램이 없으면 쪽수만 세어서 넣습니다.
      const doc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
      src.pageCount = doc.getPageCount();
      for (let p = 0; p < src.pageCount; p++) items.push(pdfItem(src, p, null));
      return items;
    }

    let doc;
    try {
      doc = await pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
    } catch (e) {
      if (e && e.name === 'PasswordException') throw Object.assign(e, { userMsg: '암호가 걸린 PDF입니다. 암호를 풀고 다시 저장한 뒤 넣어 주세요.' });
      throw Object.assign(e || new Error('pdf'), { userMsg: 'PDF를 열 수 없습니다. 손상된 파일일 수 있습니다.' });
    }
    src.pageCount = doc.numPages;
    for (let p = 1; p <= doc.numPages; p++) {
      let url = null;
      try {
        const page = await doc.getPage(p);
        const vp1 = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: 320 / Math.max(vp1.width, vp1.height) });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(vp.width);
        canvas.height = Math.ceil(vp.height);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.7));
        url = URL.createObjectURL(blob);
        canvas.width = canvas.height = 0;
        page.cleanup();
      } catch (e) { console.warn('thumb fail', e); }
      items.push(pdfItem(src, p - 1, url));
      if (p % 5 === 0) await nextFrame();
    }
    doc.destroy();
    return items;
  }

  function pdfItem(src, pageIndex, thumbUrl) {
    return {
      id: ++uid, kind: 'pdf', name: src.name, src, pageIndex, rotation: 0, thumbUrl,
      label: src.pageCount > 1 ? `${src.name} (${pageIndex + 1}/${src.pageCount}쪽)` : src.name,
    };
  }

  const scriptCache = {};
  function loadScript(url) {
    if (!scriptCache[url]) {
      scriptCache[url] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = url;
        s.onload = resolve;
        s.onerror = () => { delete scriptCache[url]; reject(Object.assign(new Error('script'), { userMsg: '변환 프로그램을 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.' })); };
        document.head.appendChild(s);
      });
    }
    return scriptCache[url];
  }

  /* ----- 용량 ----- */

  // 한 쪽(장)의 예상 용량
  function itemEstimate(it, small) {
    if (it.kind === 'image') return it.bytes.length * (small ? 0.45 : 1);
    return it.src.size / Math.max(1, it.src.pageCount);
  }

  function estimateBytes() {
    return allItems().reduce((a, it) => a + itemEstimate(it, false), 0) + 2000;
  }

  const fmtMB = (b) => (b / 1048576 < 0.1 ? '0.1MB 미만' : (b / 1048576).toFixed(1) + 'MB');
  const limitBytes = () => (Number(config.maxFileSizeMB) || 0) * 1048576;
  const maxFiles = () => Math.max(1, Number(config.maxFiles) || 1);

  /*
   * 한도를 넘으면 여러 파일로 나눕니다(최대 maxFiles 개).
   * 가능하면 서류 칸이 바뀌는 곳에서 나누고, 안 되면 쪽 사이에서 나눕니다.
   * flat: [{ it, si }] / 나눌 수 없으면 null
   */
  function planParts(flat, small) {
    const limit = limitBytes();
    if (!limit) return [flat];
    const cap = limit * 0.92; // 예상치 오차 여유
    const parts = [];
    let cur = [];
    let curSize = 0;
    for (const x of flat) {
      const sz = itemEstimate(x.it, small);
      if (cur.length && curSize + sz > cap) {
        // 현재 묶음 안에서 마지막 '서류 칸 경계'를 찾음
        let cut = cur.length;
        for (let j = cur.length - 1; j > 0; j--) {
          if (cur[j].si !== cur[j - 1].si) { cut = j; break; }
        }
        // 칸 경계가 너무 앞쪽이면(절반 미만) 그냥 쪽 사이에서 나눔
        const head = cur.slice(0, cut);
        const headSize = head.reduce((a, y) => a + itemEstimate(y.it, small), 0);
        if (cut < cur.length && headSize < cap * 0.5) cut = cur.length;
        parts.push(cur.slice(0, cut));
        cur = cur.slice(cut);
        curSize = cur.reduce((a, y) => a + itemEstimate(y.it, small), 0);
      }
      cur.push(x);
      curSize += sz;
    }
    if (cur.length) parts.push(cur);
    if (parts.length > maxFiles()) return null;
    if (parts.some((p) => p.length === 1 && itemEstimate(p[0].it, small) > cap)) return null;
    return parts;
  }

  function updateSizeInfo() {
    const n = allItems().length;
    const est = estimateBytes();
    const limit = limitBytes();
    let note = '';
    if (limit && n) {
      const flat = state.slots.flatMap((s, si) => s.items.map((it) => ({ it, si })));
      const plain = planParts(flat, false);
      const small = plain ? null : planParts(flat, true);
      if (plain && plain.length > 1) {
        note = ` <span class="split-note">(용량이 커서 파일 ${plain.length}개로 나눠 저장됩니다)</span>`;
      } else if (!plain && small) {
        note = ` <span class="split-note">(용량이 커서 사진을 조금 줄이고 파일 ${small.length}개로 나눠 저장됩니다)</span>`;
      } else if (!plain && !small) {
        note = ` <span class="over-limit">(파일 ${maxFiles()}개로 나눠도 너무 큽니다. 사진 수를 줄여 주세요)</span>`;
      }
    }
    const html = n
      ? `넣은 서류 <b>${n}쪽</b> · 예상 용량 약 <b>${fmtMB(est)}</b>${note}`
      : '넣은 서류 0쪽';
    $('#sizeInfo4').innerHTML = html;
    $('#sizeInfo5').innerHTML = html;
  }

  /* ---------------- 5단계: 확인·저장 ---------------- */

  function renderSummary() {
    $('#summary').innerHTML = state.slots.map((s, i) => {
      const n = s.items.length;
      if (s.doc.other && !n) return '';
      let cls, mark, cnt;
      if (n) { cls = 'ok'; mark = '✓'; cnt = `${n}쪽`; }
      else if (s.doc.required) { cls = 'missing'; mark = '?'; cnt = '비어 있음 · 확인'; }
      else { cls = 'skip'; mark = '–'; cnt = '없음 (해당 시)'; }
      return `<li class="${cls}"><span class="mark">${mark}</span><span class="sname">${s.doc.other ? '' : i + 1 + '. '}${esc(s.doc.name)}</span><span class="scount">${cnt}</span></li>`;
    }).join('');
    if (!state.fileNameEdited) $('#fileName').value = makeFileName();
    updateSizeInfo();
    $('#result').hidden = true;
  }

  function cleanPart(s) {
    return String(s || '').replace(/\(.*?\)/g, '').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '').trim();
  }

  function makeFileName() {
    const t = currentType();
    const typeName = cleanPart(t ? t.name : '증빙');
    const date = (state.info.date || '').replace(/-/g, '');
    const vendor = cleanPart(state.info.vendor);
    const amount = String(state.info.amount || '').replace(/[^\d]/g, '');
    if (!date && !vendor && !amount) {
      const d = new Date();
      const p = (x) => String(x).padStart(2, '0');
      return `${typeName}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
    }
    return [date, typeName, vendor, amount].filter(Boolean).join('_');
  }

  async function onSave() {
    if (busyCount() > 0) { alert('아직 파일을 처리하는 중입니다. 잠시 후 다시 눌러 주세요.'); return; }
    if (!hasFiles()) { alert('넣은 서류가 없습니다. 서류를 먼저 넣어 주세요.'); return; }
    const missing = state.slots.filter((s) => s.doc.required && !s.items.length).map((s) => s.doc.name);
    if (missing.length && !confirm(`아래 필수 칸이 비어 있어요.\n· ${missing.join('\n· ')}\n\n다른 파일에 함께 들어 있거나 비슷한 서류로 냈다면 그대로 저장하셔도 됩니다.\n이대로 저장할까요?`)) return;

    const base = cleanFileName($('#fileName').value) || makeFileName();
    $('#fileName').value = base;

    let result;
    showBusy('PDF를 만드는 중입니다…');
    try {
      result = await makeFiles();
    } catch (e) {
      console.error(e);
      hideBusy();
      alert(e.userMsg || 'PDF를 만드는 중 문제가 생겼습니다.\n' + (e.message || ''));
      return;
    }
    hideBusy();
    if (!result) {
      alert(`서류가 너무 많아서 파일 ${maxFiles()}개로 나눠도\n한 파일 ${config.maxFileSizeMB}MB를 넘습니다.\n\n사진 수를 줄이거나, 집행 건을 나눠서 만들어 주세요.`);
      return;
    }

    downloadUrls.forEach((u) => URL.revokeObjectURL(u));
    downloadUrls = [];
    const many = result.outs.length > 1;
    const files = result.outs.map((o, i) => {
      const blob = new Blob([o.bytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      downloadUrls.push(url);
      return { url, name: many ? `${base}_${i + 1}.pdf` : `${base}.pdf`, size: blob.size, pages: o.pages };
    });

    // 첫 번째 파일은 바로 내려받기 (여러 파일을 한꺼번에 받으면 브라우저가 막는 경우가 있어 나머지는 버튼으로)
    triggerDownload(files[0].url, files[0].name);

    $('#resultTitle').textContent = many
      ? `용량이 커서 파일 ${files.length}개로 나눠 저장했습니다`
      : '저장했습니다';
    $('#resultFiles').innerHTML = files.map((f, i) => `
      <a class="btn dl ${i === 0 ? '' : 'primary'}" href="${f.url}" download="${esc(f.name)}">
        <span class="dl-main">↓${many ? `${i + 1}번 파일 ` : ''}${i === 0 ? '다시 ' : ''}내려받기</span>
        <span class="dl-sub">${esc(f.name)} · ${f.pages}쪽 · ${fmtMB(f.size)}</span>
      </a>`).join('');
    const warn = $('#resultWarn');
    const warns = [];
    if (many) warns.push(`1번 파일은 내려받았습니다. 아래 [2번 파일 내려받기]${files.length > 2 ? ' 등' : ''}도 꼭 눌러 주세요.`);
    if (result.small) warns.push('용량을 맞추려고 사진을 조금 더 작게 줄였습니다.');
    warn.hidden = !warns.length;
    warn.innerHTML = warns.map(esc).join('<br>');
    $('#resultGuide').innerHTML = many
      ? `보탬e 첨부란에 <b>이 파일 ${files.length}개</b>를 모두 올려 주세요.<br>(기본서류/증빙서류 칸 구분 없이 한 곳에)`
      : '보탬e 첨부란에 <b>이 파일 하나만</b> 올려 주세요.<br>(기본서류/증빙서류 칸 구분 없이 한 곳에)';
    state.saved = true;
    $('#result').hidden = false;
    $('#result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function triggerDownload(url, name) {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // 한도 안에 들어오도록 나눠서 PDF를 만듭니다. 안 되면 사진을 더 줄여 다시 시도.
  async function makeFiles() {
    const flat = state.slots.flatMap((s, si) => s.items.map((it) => ({ it, si })));
    const toPortrait = false; // 가로 사진은 A4 가로 페이지로. 세로로 넣으려면 서류 칸에서 [돌리기]
    const limit = limitBytes();
    for (const small of [false, true]) {
      const parts = planParts(flat, small);
      if (!parts) continue;
      const total = flat.length;
      let done = 0;
      const outs = [];
      for (const p of parts) {
        const bytes = await buildPdf(p.map((x) => x.it), { small, toPortrait }, () => {
          done++;
          setBusyMsg(`PDF를 만드는 중입니다… (${done}/${total}쪽)${small ? '\n사진 용량을 줄이는 중' : ''}`);
        });
        outs.push({ bytes, pages: p.length });
      }
      if (!limit || outs.every((o) => o.bytes.length <= limit)) return { outs, small };
    }
    return null;
  }

  function cleanFileName(s) {
    return String(s || '').replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]/g, '').trim();
  }

  async function buildPdf(items, { small = false, toPortrait = false } = {}, progress = () => {}) {
    const { PDFDocument, degrees } = PDFLib;
    const out = await PDFDocument.create();
    const loaded = new Map();
    let k = 0;

    for (const it of items) {
      progress(++k, items.length);
      if (it.kind === 'image') {
        let { bytes, w, h } = it;
        let rot = it.rotation;
        const landscapeNow = rot % 180 === 0 ? w > h : h > w;
        if (landscapeNow && toPortrait) rot = (rot + 90) % 360;
        if (rot || small) {
          const img = await decodeImage(new Blob([it.bytes], { type: 'image/jpeg' }));
          const r = await drawToJpeg(img, rot,
            small ? SMALL.maxPixels : Math.max(w, h),
            small ? SMALL.quality : config.image.quality);
          URL.revokeObjectURL(img.src);
          ({ bytes, w, h } = r);
        }
        const emb = await out.embedJpg(bytes);
        const landscape = w > h;
        const pw = landscape ? A4.h : A4.w;
        const ph = landscape ? A4.w : A4.h;
        const s = Math.min((pw - MARGIN * 2) / w, (ph - MARGIN * 2) / h);
        const dw = w * s, dh = h * s;
        const page = out.addPage([pw, ph]);
        page.drawImage(emb, { x: (pw - dw) / 2, y: (ph - dh) / 2, width: dw, height: dh });
      } else {
        let doc = loaded.get(it.src.id);
        if (!doc) {
          try { doc = await PDFDocument.load(it.src.bytes, { ignoreEncryption: true }); }
          catch (e) { throw Object.assign(e, { userMsg: `'${it.name}' 파일을 합칠 수 없습니다.\n그 PDF를 빼거나, 다른 프로그램에서 다시 PDF로 저장한 뒤 넣어 주세요.` }); }
          loaded.set(it.src.id, doc);
        }
        const [pg] = await out.copyPages(doc, [it.pageIndex]);
        if (it.rotation) pg.setRotation(degrees((pg.getRotation().angle + it.rotation) % 360));
        out.addPage(pg);
      }
      if (k % 3 === 0) await nextFrame();
    }
    out.setTitle(cleanFileName($('#fileName').value));
    out.setCreator('작은도서관 보조금 증빙 PDF 합치기');
    out.setProducer('pdf-lib');
    return out.save();
  }

  function newExecution() {
    const keep = $('#keepType').checked;
    clearFiles();
    state.info = { date: '', amount: '', vendor: '' };
    $('#infoDate').value = $('#infoAmount').value = $('#infoVendor').value = '';
    $('#fileName').value = '';
    $('#result').hidden = true;
    state.saved = false;
    downloadUrls.forEach((u) => URL.revokeObjectURL(u));
    downloadUrls = [];
    if (keep && state.typeId) {
      buildSlots();
      goStep(isFree() ? 4 : 3);
    } else {
      state.programId = null;
      state.typeId = null;
      state.slots = [];
      renderPrograms();
      goStep(1);
    }
  }

  /* ---------------- 처리 중 표시 ---------------- */

  function showBusy(msg) { setBusyMsg(msg); $('#busy').hidden = false; }
  function setBusyMsg(msg) { $('#busyMsg').textContent = msg; }
  function hideBusy() { $('#busy').hidden = true; }

  /* ---------------- 이벤트 ---------------- */

  function bindEvents() {
    $('#programCards').addEventListener('click', (e) => {
      const b = e.target.closest('[data-program]');
      if (b) selectProgram(b.dataset.program);
    });
    $('#typeCards').addEventListener('click', (e) => {
      const b = e.target.closest('[data-type]');
      if (b) selectType(b.dataset.type);
    });
    document.addEventListener('click', (e) => {
      const g = e.target.closest('[data-go]');
      if (g) goStep(Number(g.dataset.go));
    });
    $('#steps').addEventListener('click', (e) => {
      const li = e.target.closest('li[data-step]');
      if (li) goStep(Number(li.dataset.step));
    });
    $('#btnFree').addEventListener('click', startFree);
    $('#btnHelp').addEventListener('click', () => {
      const d = $('#helpDialog');
      if (d.showModal) d.showModal(); else d.setAttribute('open', '');
    });

    // 3단계 입력
    $('#infoDate').addEventListener('input', (e) => { state.info.date = e.target.value; });
    $('#infoAmount').addEventListener('input', (e) => {
      const digits = e.target.value.replace(/[^\d]/g, '');
      state.info.amount = digits;
      e.target.value = digits ? Number(digits).toLocaleString('ko-KR') : '';
    });
    $('#infoVendor').addEventListener('input', (e) => { state.info.vendor = e.target.value; });
    $('#infoForm').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); goStep(4); } });

    // 4단계 서류 칸
    const slots = $('#slots');
    slots.addEventListener('change', (e) => {
      const input = e.target;
      if (input.type !== 'file') return;
      const si = Number(input.closest('.slot').dataset.i);
      const files = Array.from(input.files || []);
      input.value = '';
      addFiles(si, files);
    });
    slots.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      onThumbAction(Number(b.closest('.thumb').dataset.id), b.dataset.act);
    });
    slots.addEventListener('dragstart', (e) => {
      const t = e.target.closest && e.target.closest('.thumb');
      if (!t) return;
      dragId = Number(t.dataset.id);
      t.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', String(dragId)); } catch (_) { /* ignore */ }
    });
    slots.addEventListener('dragend', () => {
      dragId = null;
      $$('.thumb.dragging, .slot.over').forEach((el) => el.classList.remove('dragging', 'over'));
    });
    slots.addEventListener('dragover', (e) => {
      const s = e.target.closest('.slot');
      if (!s) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = dragId != null ? 'move' : 'copy';
      $$('.slot.over').forEach((el) => { if (el !== s) el.classList.remove('over'); });
      s.classList.add('over');
    });
    slots.addEventListener('dragleave', (e) => {
      const s = e.target.closest('.slot');
      if (s && !s.contains(e.relatedTarget)) s.classList.remove('over');
    });
    slots.addEventListener('drop', (e) => {
      const s = e.target.closest('.slot');
      if (!s) return;
      e.preventDefault();
      s.classList.remove('over');
      const si = Number(s.dataset.i);
      if (dragId != null) {
        moveItem(dragId, si, e.target.closest('.thumb'), e);
        dragId = null;
      } else if (e.dataTransfer.files && e.dataTransfer.files.length) {
        addFiles(si, Array.from(e.dataTransfer.files));
      }
    });

    // 칸 밖에 파일을 떨어뜨려도 브라우저가 파일을 열지 않게
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());

    // 5단계
    $('#fileName').addEventListener('input', () => { state.fileNameEdited = true; });
    $('#btnSave').addEventListener('click', onSave);
    $('#btnNew').addEventListener('click', newExecution);

    // 새로고침·창 닫기 경고
    window.addEventListener('beforeunload', (e) => {
      if (hasFiles() && !state.saved) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  function moveItem(id, toSi, targetThumb, e) {
    const f = findItem(id);
    if (!f) return;
    const [item] = state.slots[f.si].items.splice(f.k, 1);
    const dest = state.slots[toSi].items;
    let idx = dest.length;
    if (targetThumb && Number(targetThumb.dataset.id) !== id) {
      idx = dest.findIndex((it) => it.id === Number(targetThumb.dataset.id));
      const r = targetThumb.getBoundingClientRect();
      if (e.clientX > r.left + r.width / 2) idx++;
    } else if (targetThumb) {
      idx = f.si === toSi ? f.k : dest.length; // 제자리에 놓음
    }
    dest.splice(idx, 0, item);
    if (f.si !== toSi) renderSlot(f.si);
    renderSlot(toSi);
  }

  // 시험·점검용 (파일을 밖으로 보내는 기능 없음)
  window.__pdfTool = { state, config: () => config, addFiles, goStep, selectProgram, selectType, startFree, makeFiles, planParts, buildPdf: () => buildPdf(allItems()) };
})();
