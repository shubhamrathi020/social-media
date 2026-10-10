// Moderator console. Everything from users is rendered with textContent, never innerHTML.
(() => {
  const API = location.pathname.replace(/\/admin\/?$/, ''); // e.g. "/v1"
  const $ = (id) => document.getElementById(id);
  const el = (tag, props = {}, ...children) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const c of children) if (c != null) n.append(c);
    return n;
  };
  const when = (iso) => (iso ? new Date(iso).toLocaleString() : '');

  let token = sessionStorage.getItem('modToken');
  let phone = '';
  let tab = 'open';

  async function api(path, opts = {}) {
    const res = await fetch(API + path, {
      ...opts,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    });
    if (res.status === 401) {
      signOut('Your session expired, sign in again.');
      throw new Error('unauthorized');
    }
    const body = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.message ?? 'Request failed (' + res.status + ')');
    return body;
  }

  function showError(msg) {
    $('error').textContent = msg || '';
  }

  function signOut(msg) {
    token = null;
    sessionStorage.removeItem('modToken');
    $('app').classList.add('hidden');
    $('tabs').classList.add('hidden');
    $('login').classList.remove('hidden');
    $('phoneForm').classList.remove('hidden');
    $('codeForm').classList.add('hidden');
    showError(msg);
  }

  $('phoneForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    showError('');
    phone = $('phone').value.trim();
    try {
      await api('/auth/otp/request', { method: 'POST', body: JSON.stringify({ phone }) });
      $('phoneForm').classList.add('hidden');
      $('codeForm').classList.remove('hidden');
      $('code').focus();
    } catch (err) {
      showError(err.message);
    }
  });

  $('codeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    showError('');
    try {
      const r = await api('/auth/otp/verify', {
        method: 'POST',
        body: JSON.stringify({ phone, code: $('code').value.trim(), device: { platform: 'web' } }),
      });
      token = r.accessToken;
      await api('/admin/me');
      sessionStorage.setItem('modToken', token);
      start();
    } catch (err) {
      token = null;
      showError(err.message === 'Moderators only' ? 'This account is not a moderator.' : err.message);
    }
  });

  $('signout').addEventListener('click', () => signOut(''));
  document.querySelectorAll('[data-tab]').forEach((b) =>
    b.addEventListener('click', () => {
      tab = b.dataset.tab;
      document.querySelectorAll('[data-tab]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      load();
    }),
  );

  function start() {
    $('login').classList.add('hidden');
    $('app').classList.remove('hidden');
    $('tabs').classList.remove('hidden');
    load();
  }

  async function load() {
    const list = $('list');
    list.replaceChildren(el('p', { class: 'muted' }, 'Loading…'));
    try {
      if (tab === 'log') return renderLog(await api('/admin/actions'));
      const items = await api('/admin/queue?status=' + tab);
      $('summary').textContent = items.length + (tab === 'open' ? ' item(s) waiting for a decision' : ' closed item(s)');
      list.replaceChildren(...(items.length ? items.map(card) : [el('p', { class: 'muted' }, 'Nothing here.')]));
    } catch (err) {
      if (err.message !== 'unauthorized') list.replaceChildren(el('p', { class: 'muted' }, err.message));
    }
  }

  function renderLog(rows) {
    $('summary').textContent = 'Most recent moderation actions';
    const table = el('table', {},
      el('thead', {}, el('tr', {}, ...['When', 'Action', 'Item', 'By', 'Note'].map((h) => el('th', {}, h)))),
      el('tbody', {}, ...rows.map((r) =>
        el('tr', {},
          el('td', {}, when(r.createdAt)),
          el('td', {}, r.action),
          el('td', {}, r.entityType + ' ' + r.entityId.slice(0, 8)),
          el('td', {}, r.moderator ?? 'system'),
          el('td', {}, r.note ?? ''),
        ))),
    );
    $('list').replaceChildren(el('div', { class: 'card' }, table));
  }

  function thumbs(media) {
    const list = (Array.isArray(media) ? media : media ? [media] : []).filter(Boolean);
    if (!list.length) return null;
    return el('div', { class: 'thumbs' }, ...list.map((m) => {
      const img = el('img', { src: m.thumbUrl ?? m.url ?? '', alt: 'Reported ' + m.kind + ' (blurred, click to reveal)', title: 'Click to reveal' });
      img.addEventListener('click', () => img.classList.toggle('revealed'));
      return img;
    }));
  }

  function card(item) {
    const p = item.preview;
    const author = p?.author ?? (item.entityType === 'user' ? p : null);
    const pills = [
      el('span', { class: 'pill' }, item.entityType),
      el('span', { class: 'pill' }, item.reportCount + ' report(s), ' + item.reporters + ' person(s)'),
      ...item.reasons.map((r) => el('span', { class: 'pill warn' }, r)),
    ];
    if (item.flaggedBySystem) pills.push(el('span', { class: 'pill warn' }, 'flagged by image scan'));
    if (p?.hiddenAt) pills.push(el('span', { class: 'pill' }, 'hidden pending review'));
    if (p?.deletedAt) pills.push(el('span', { class: 'pill' }, 'removed'));
    if (author?.suspendedAt) pills.push(el('span', { class: 'pill warn' }, 'author suspended'));

    const text = p ? (p.caption ?? p.body ?? p.text ?? p.bio ?? '') : '(this item no longer exists)';
    const note = el('textarea', { rows: '2', placeholder: 'Note for the audit log (optional)' });

    const decide = async (decision, label) => {
      if (decision !== 'dismiss' && !confirm(label + '?')) return;
      try {
        await api('/admin/decisions', {
          method: 'POST',
          body: JSON.stringify({ entityType: item.entityType, entityId: item.entityId, decision, note: note.value || undefined }),
        });
        load();
      } catch (err) {
        alert(err.message);
      }
    };

    const actions = tab !== 'open' ? null : el('div', { class: 'row' },
      el('button', { onclick: () => decide('dismiss', 'Keep') }, 'Keep (dismiss reports)'),
      item.entityType === 'user'
        ? el('button', { class: 'danger', onclick: () => decide('remove', 'Suspend this account') }, 'Suspend account')
        : el('button', { class: 'danger', onclick: () => decide('remove', 'Remove this ' + item.entityType) }, 'Remove'),
      item.entityType === 'user' ? null
        : el('button', { class: 'danger', onclick: () => decide('suspend_author', 'Remove and suspend the author') }, 'Remove + suspend author'),
    );

    return el('article', { class: 'card' },
      el('div', { class: 'row' }, ...pills),
      el('p', { class: 'muted' },
        'By ' + (author ? (author.displayName || author.username || author.id) : 'unknown') +
        ' · first report ' + when(item.firstReportAt) + ' · last ' + when(item.lastReportAt)),
      el('div', { class: 'content' }, text),
      thumbs(p?.media),
      (item.details ?? []).length ? el('p', { class: 'muted' }, 'Reporter notes: ' + item.details.join(' | ')) : null,
      tab === 'open' ? note : null,
      actions,
    );
  }

  if (token) {
    api('/admin/me').then(start).catch(() => signOut(''));
  }
})();
